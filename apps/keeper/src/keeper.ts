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
  ERC20_ABI,
  PRICE_STATUS_LABEL,
  PriceStatus,
  SHERWOOD_FACTORY_ABI,
  SHERWOOD_MARKET_ABI,
  isSolvent,
  robinhoodChain,
  seizeForRepay,
  formatUsd,
} from "@sherwood/sdk";
import { BorrowerIndex } from "./borrowers.js";

export type KeeperConfig = {
  rpcUrls: string[];
  factory: Address;
  privateKey?: Hex;
  /** Only act on markets in this list, if given. */
  markets: Address[] | null;
  /** Smallest repayment worth a transaction, in USDG units. */
  minRepayAssets: bigint;
  /** Do not send transactions, only report what would be done. */
  dryRun: boolean;
  intervalSeconds: number;
  fromBlock: bigint;
};

export type Candidate = {
  market: Address;
  borrower: Address;
  debtAssets: bigint;
  collateral: bigint;
  collateralValue1e8: bigint;
  repayAssets: bigint;
  seizeEstimate: bigint;
  bonusBps: bigint;
  /** Value of seized collateral less the repayment, at the current price. */
  grossProfit1e8: bigint;
};

export type MarketSnapshot = {
  address: Address;
  collateral: Address;
  loanToken: Address;
  lltv: bigint;
  closeFactorBps: bigint;
  status: PriceStatus;
  priceRawX26: bigint;
  shielded: boolean;
  graceUntil: bigint;
  bonusBps: bigint;
};

/**
 * The liquidation bot.
 *
 * Its one non-obvious job is to respect the halt shield rather than fight it. A market whose
 * collateral has no price cannot be liquidated at all, and for the grace window after a halt clears
 * the bonus ramps from zero, so the naive keeper behaviour of firing the instant a position looks
 * unhealthy loses money and, worse, races other keepers into a queue of reverting transactions. This
 * one reads the ramp, computes what a liquidation is actually worth right now, and waits when the
 * answer is nothing.
 */
export class Keeper {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient | null;
  readonly account: ReturnType<typeof privateKeyToAccount> | null;
  private readonly indexes = new Map<Address, BorrowerIndex>();

  constructor(readonly config: KeeperConfig) {
    const transport = fallback(config.rpcUrls.map((url) => http(url, { timeout: 20_000 })));
    this.publicClient = createPublicClient({ chain: robinhoodChain, transport });
    this.account = config.privateKey ? privateKeyToAccount(config.privateKey) : null;
    this.walletClient = this.account
      ? createWalletClient({ chain: robinhoodChain, transport, account: this.account })
      : null;
  }

  async markets(): Promise<Address[]> {
    if (this.config.markets) return this.config.markets;
    const count = await this.publicClient.readContract({
      address: this.config.factory,
      abi: SHERWOOD_FACTORY_ABI,
      functionName: "marketCount",
    });
    if (count === 0n) return [];
    const results = await this.publicClient.multicall({
      allowFailure: false,
      contracts: Array.from({ length: Number(count) }, (_, i) => ({
        address: this.config.factory,
        abi: SHERWOOD_FACTORY_ABI,
        functionName: "markets" as const,
        args: [BigInt(i)] as const,
      })),
    });
    return results as Address[];
  }

  async snapshot(market: Address): Promise<MarketSnapshot> {
    const base = { address: market, abi: SHERWOOD_MARKET_ABI } as const;
    const [collateral, loanToken, lltv, closeFactorBps, priceStatus, shielded, graceUntil, bonusBps] =
      await this.publicClient.multicall({
        allowFailure: false,
        contracts: [
          { ...base, functionName: "COLLATERAL" },
          { ...base, functionName: "LOAN_TOKEN" },
          { ...base, functionName: "LLTV" },
          { ...base, functionName: "CLOSE_FACTOR_BPS" },
          { ...base, functionName: "priceStatus" },
          { ...base, functionName: "shielded" },
          { ...base, functionName: "graceUntil" },
          { ...base, functionName: "currentBonusBps" },
        ],
      });
    const [priceRawX26, status] = priceStatus as readonly [bigint, number];
    return {
      address: market,
      collateral: collateral as Address,
      loanToken: loanToken as Address,
      lltv: lltv as bigint,
      closeFactorBps: closeFactorBps as bigint,
      status: status as PriceStatus,
      priceRawX26,
      shielded: shielded as boolean,
      graceUntil: graceUntil as bigint,
      bonusBps: bonusBps as bigint,
    };
  }

  private indexFor(market: Address): BorrowerIndex {
    let index = this.indexes.get(market);
    if (!index) {
      index = new BorrowerIndex(this.publicClient, market, 9_000n, this.config.fromBlock);
      this.indexes.set(market, index);
    }
    return index;
  }

  /** Everything liquidatable in one market, with the economics already worked out. */
  async scanMarket(market: Address): Promise<{ snapshot: MarketSnapshot; candidates: Candidate[] }> {
    const snapshot = await this.snapshot(market);
    // No price means no liquidation is possible, so do not spend requests looking for one.
    if (snapshot.status !== PriceStatus.OK) return { snapshot, candidates: [] };

    const index = this.indexFor(market);
    await index.sync();
    const borrowers = index.addresses();
    if (borrowers.length === 0) return { snapshot, candidates: [] };

    const health = await this.publicClient.multicall({
      allowFailure: true,
      contracts: borrowers.flatMap((b) => [
        { address: market, abi: SHERWOOD_MARKET_ABI, functionName: "healthOf" as const, args: [b] as const },
        { address: market, abi: SHERWOOD_MARKET_ABI, functionName: "positions" as const, args: [b] as const },
      ]),
    });

    const candidates: Candidate[] = [];
    borrowers.forEach((borrower, i) => {
      const h = health[i * 2];
      const p = health[i * 2 + 1];
      if (h.status !== "success" || p.status !== "success") return;
      const [collateralValue1e8, debtAssets, solvent] = h.result as readonly [bigint, bigint, boolean, number];
      const [, , collateral] = p.result as readonly [bigint, bigint, bigint];
      if (debtAssets === 0n || solvent) return;
      if (isSolvent(collateralValue1e8, debtAssets, snapshot.lltv)) return;

      const repayAssets = (debtAssets * snapshot.closeFactorBps) / 10_000n;
      if (repayAssets < this.config.minRepayAssets) return;
      const seizeEstimate = seizeForRepay(repayAssets, snapshot.priceRawX26, snapshot.bonusBps);
      const capped = seizeEstimate > collateral ? collateral : seizeEstimate;
      const seizedValue1e8 = (capped * snapshot.priceRawX26) / 10n ** 18n;
      candidates.push({
        market,
        borrower,
        debtAssets,
        collateral,
        collateralValue1e8,
        repayAssets,
        seizeEstimate: capped,
        bonusBps: snapshot.bonusBps,
        // Repayments are USDG at six decimals; collateral value carries eight.
        grossProfit1e8: seizedValue1e8 - repayAssets * 100n,
      });
    });

    candidates.sort((a, b) => (b.grossProfit1e8 > a.grossProfit1e8 ? 1 : -1));
    return { snapshot, candidates };
  }

  /** Ensures the market may pull the repayment before a liquidation is attempted. */
  async ensureAllowance(loanToken: Address, market: Address, needed: bigint): Promise<void> {
    if (!this.walletClient || !this.account) return;
    const allowance = await this.publicClient.readContract({
      address: loanToken,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [this.account.address, market],
    });
    if (allowance >= needed) return;
    const hash = await this.walletClient.writeContract({
      address: loanToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [market, 2n ** 256n - 1n],
      chain: robinhoodChain,
      account: this.account,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
  }

  /**
   * Executes a liquidation, simulating first.
   * The simulation is not politeness: with several keepers watching the same market, the position is
   * often already gone by the time this runs, and a blind send burns gas on a revert every time.
   */
  async liquidate(candidate: Candidate, loanToken: Address): Promise<Hex | null> {
    if (this.config.dryRun || !this.walletClient || !this.account) return null;
    await this.ensureAllowance(loanToken, candidate.market, candidate.repayAssets);

    const { request } = await this.publicClient.simulateContract({
      address: candidate.market,
      abi: SHERWOOD_MARKET_ABI,
      functionName: "liquidate",
      args: [candidate.borrower, candidate.repayAssets],
      account: this.account,
    });
    const hash = await this.walletClient.writeContract(request);
    await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    return hash;
  }

  /** One pass across every market. */
  async runOnce(): Promise<{ scanned: number; acted: number; lines: string[] }> {
    const lines: string[] = [];
    let acted = 0;
    const markets = await this.markets();

    for (const market of markets) {
      const { snapshot, candidates } = await this.scanMarket(market);
      if (snapshot.status !== PriceStatus.OK) {
        lines.push(
          `${market} shielded: ${PRICE_STATUS_LABEL[snapshot.status]}` +
            ` (no liquidation is possible until this clears)`,
        );
        continue;
      }
      if (snapshot.graceUntil > BigInt(Math.floor(Date.now() / 1000))) {
        lines.push(
          `${market} in grace, bonus ramped to ${snapshot.bonusBps}bps of its full value` +
            ` until ${new Date(Number(snapshot.graceUntil) * 1000).toISOString()}`,
        );
      }
      if (candidates.length === 0) {
        lines.push(`${market} healthy`);
        continue;
      }

      for (const candidate of candidates) {
        // During the grace ramp an early liquidation can be worth less than its own gas.
        if (candidate.grossProfit1e8 <= 0n) {
          lines.push(
            `${market} ${candidate.borrower} liquidatable but the bonus is only ${candidate.bonusBps}bps;` +
              ` waiting for the ramp`,
          );
          continue;
        }
        try {
          const hash = await this.liquidate(candidate, snapshot.loanToken);
          acted++;
          lines.push(
            `${market} liquidated ${candidate.borrower}: repaid ${formatUsd(candidate.repayAssets * 100n)}, ` +
              `seized ${formatUsd(candidate.collateralValue1e8)} of collateral, ` +
              `profit ${formatUsd(candidate.grossProfit1e8)} ${hash ?? "(dry run)"}`,
          );
        } catch (err) {
          lines.push(`${market} ${candidate.borrower} liquidation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return { scanned: markets.length, acted, lines };
  }
}
