import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  EQUITY_ASSETS,
  SHERWOOD_ORACLE_ABI,
  Session,
  PriceStatus,
  robinhoodChain,
  reportTypedData,
  sortSignaturesBySigner,
  type PriceReport,
} from "@sherwood/sdk";
import { fetchQuotes, type EquityQuote } from "./marketdata.js";
import type { ReporterConfig } from "./config.js";

export type RoundResult = {
  posted: { symbol: string; asset: Address; price: bigint; session: Session; nonce: bigint; hash?: Hex }[];
  skipped: { symbol: string; reason: string }[];
  failed: { symbol: string; error: string }[];
};

type AssetPlan = {
  symbol: string;
  asset: Address;
  lastPrice: bigint;
  lastPublishedAt: bigint;
  lastNonce: bigint;
};

/**
 * Assembles and posts attested quotes.
 *
 * The reporter holds one or more signing keys and, when the quorum is larger than the keys it holds,
 * collects the remainder from peer reporters over HTTP. A round only reaches the chain when enough
 * independent signatures exist for the exact same report, which is what makes the quorum meaningful
 * rather than decorative.
 */
export class Reporter {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly accounts: ReturnType<typeof privateKeyToAccount>[];

  constructor(readonly config: ReporterConfig) {
    const transport = fallback(config.rpcUrls.map((url) => http(url, { timeout: 20_000 })));
    this.publicClient = createPublicClient({ chain: robinhoodChain, transport });
    this.accounts = config.privateKeys.map((k) => privateKeyToAccount(k));
    this.walletClient = createWalletClient({ chain: robinhoodChain, transport, account: this.accounts[0] });
  }

  /** The addresses this process signs with. */
  get signers(): Address[] {
    return this.accounts.map((a) => a.address);
  }

  /** Signs a report with every key this process holds. */
  async sign(report: PriceReport): Promise<{ signer: Address; signature: Hex }[]> {
    const typedData = reportTypedData(report, this.config.oracle, this.config.chainId);
    return Promise.all(
      this.accounts.map(async (account) => ({
        signer: account.address,
        signature: await account.signTypedData(typedData),
      })),
    );
  }

  /** Asks peers to sign the identical report. A peer that refuses or times out is simply absent. */
  async collectPeerSignatures(report: PriceReport): Promise<{ signer: Address; signature: Hex }[]> {
    if (this.config.peerUrls.length === 0) return [];
    const body = JSON.stringify(
      {
        asset: report.asset,
        price: report.price.toString(),
        observedAt: report.observedAt.toString(),
        session: report.session,
        nonce: report.nonce.toString(),
      },
    );
    const results = await Promise.allSettled(
      this.config.peerUrls.map(async (url) => {
        const res = await fetch(`${url.replace(/\/$/, "")}/sign`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) throw new Error(`peer ${url} returned ${res.status}`);
        const json = (await res.json()) as { signatures: { signer: Address; signature: Hex }[] };
        return json.signatures ?? [];
      }),
    );
    return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  /** Reads the oracle's current view of every asset this reporter covers. */
  async plan(): Promise<AssetPlan[]> {
    const wanted = this.config.symbols
      ? EQUITY_ASSETS.filter((a) => this.config.symbols!.includes(a.symbol))
      : EQUITY_ASSETS;

    const configs = await this.publicClient.multicall({
      allowFailure: true,
      contracts: wanted.map((a) => ({
        address: this.config.oracle,
        abi: SHERWOOD_ORACLE_ABI,
        functionName: "config" as const,
        args: [a.address] as const,
      })),
    });
    const quotes = await this.publicClient.multicall({
      allowFailure: true,
      contracts: wanted.map((a) => ({
        address: this.config.oracle,
        abi: SHERWOOD_ORACLE_ABI,
        functionName: "quote" as const,
        args: [a.address] as const,
      })),
    });

    const plans: AssetPlan[] = [];
    wanted.forEach((asset, i) => {
      const cfg = configs[i];
      // An asset the oracle has not been configured for cannot accept a quote, so do not fetch one.
      if (cfg.status !== "success" || !(cfg.result as { enabled: boolean }).enabled) return;
      const q = quotes[i];
      const prev =
        q.status === "success"
          ? (q.result as { price: bigint; publishedAt: bigint; nonce: bigint })
          : { price: 0n, publishedAt: 0n, nonce: 0n };
      plans.push({
        symbol: asset.symbol,
        asset: asset.address,
        lastPrice: prev.price,
        lastPublishedAt: prev.publishedAt,
        lastNonce: prev.nonce,
      });
    });
    return plans;
  }

  /**
   * Whether a fresh quote is worth a transaction.
   * Posting every tick would burn gas to say nothing; never posting lets the quote go stale and takes
   * the feed offline. The rule is: post on a real move, or when silence is approaching the oracle's
   * own staleness limit.
   */
  shouldPost(plan: AssetPlan, quote: EquityQuote, now: bigint): { post: boolean; reason: string } {
    if (plan.lastPublishedAt === 0n) return { post: true, reason: "no quote on chain yet" };
    const silence = now - plan.lastPublishedAt;
    if (silence >= BigInt(this.config.maxSilenceSeconds)) {
      return { post: true, reason: `silent for ${silence}s` };
    }
    if (plan.lastPrice === 0n) return { post: true, reason: "previous price was zero" };
    const diff = quote.price1e8 > plan.lastPrice ? quote.price1e8 - plan.lastPrice : plan.lastPrice - quote.price1e8;
    const bps = (diff * 10_000n) / plan.lastPrice;
    if (bps >= BigInt(this.config.minChangeBps)) {
      return { post: true, reason: `moved ${bps}bps` };
    }
    return { post: false, reason: `moved ${bps}bps, under threshold` };
  }

  /** One full round: read state, fetch quotes, assemble quorums, post. */
  async runRound(): Promise<RoundResult> {
    const result: RoundResult = { posted: [], skipped: [], failed: [] };
    const plans = await this.plan();
    if (plans.length === 0) return result;

    const { quotes, failures } = await fetchQuotes(plans.map((p) => p.symbol));
    result.failed.push(...failures.map((f) => ({ symbol: f.symbol, error: f.error })));
    const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));
    const now = BigInt(Math.floor(Date.now() / 1000));

    for (const plan of plans) {
      const quote = bySymbol.get(plan.symbol);
      if (!quote) continue;
      const decision = this.shouldPost(plan, quote, now);
      if (!decision.post) {
        result.skipped.push({ symbol: plan.symbol, reason: decision.reason });
        continue;
      }

      // The nonce has to rise on every post and the exchange timestamp does not move outside
      // trading hours, so the wall clock is what guarantees strict monotonicity.
      const nonce = now > plan.lastNonce ? now : plan.lastNonce + 1n;
      const report: PriceReport = {
        asset: plan.asset,
        price: quote.price1e8,
        observedAt: quote.observedAt,
        session: quote.session,
        nonce,
      };

      try {
        const mine = await this.sign(report);
        const peers = await this.collectPeerSignatures(report);
        const all = [...mine, ...peers];
        // Two reporters sharing a key would look like a quorum and be one signer.
        const unique = [...new Map(all.map((s) => [s.signer.toLowerCase(), s])).values()];
        const signatures = sortSignaturesBySigner(unique);

        if (this.config.dryRun) {
          result.posted.push({ ...report, symbol: plan.symbol });
          continue;
        }

        const hash = await this.walletClient.writeContract({
          address: this.config.oracle,
          abi: SHERWOOD_ORACLE_ABI,
          functionName: "postQuote",
          args: [
            {
              asset: report.asset,
              price: report.price,
              observedAt: report.observedAt,
              session: report.session,
              nonce: report.nonce,
            },
            signatures,
          ],
          chain: robinhoodChain,
          account: this.accounts[0],
        });
        await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
        result.posted.push({ ...report, symbol: plan.symbol, hash });
      } catch (err) {
        result.failed.push({ symbol: plan.symbol, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }

  /** Compares each attested quote against the pool, which is the check that keeps the feed alive. */
  async deviationReport() {
    const assets = this.config.symbols
      ? EQUITY_ASSETS.filter((a) => this.config.symbols!.includes(a.symbol))
      : EQUITY_ASSETS;
    const rows = await this.publicClient.multicall({
      allowFailure: true,
      contracts: assets.flatMap((a) => [
        { address: this.config.oracle, abi: SHERWOOD_ORACLE_ABI, functionName: "peek" as const, args: [a.address] as const },
        { address: this.config.oracle, abi: SHERWOOD_ORACLE_ABI, functionName: "twapRawX26" as const, args: [a.address] as const },
      ]),
    });
    return assets.map((a, i) => {
      const peek = rows[i * 2];
      const twap = rows[i * 2 + 1];
      const [rawX26, status] = peek.status === "success" ? (peek.result as readonly [bigint, number]) : [0n, PriceStatus.NoConfig];
      const [twapX26, ok] = twap.status === "success" ? (twap.result as readonly [bigint, boolean]) : [0n, false];
      return { symbol: a.symbol, asset: a.address, rawX26, status: status as PriceStatus, twapX26, twapOk: ok };
    });
  }
}
