import { createPublicClient, http, fallback } from "viem";
import { EQUITY_ASSETS, PUBLIC_RPC_URLS, robinhoodChain, STOCK_TOKEN_ABI } from "@sherwood/sdk";
import { fetchQuotes } from "./marketdata.js";
import { sessionAt } from "./session.js";

/**
 * Compares what each tokenized equity trades at on Robinhood Chain with what the underlying share
 * trades at on its exchange.
 *
 * This is the measurement the whole oracle rests on. Sherwood settles on the pool TWAP and uses the
 * attested equity quote only as a bound, so the deviation band has to be wide enough that the feed
 * stays up through normal basis and tight enough that manipulation trips it. Run this before setting
 * a band on a new asset, and run it again when one keeps going offline.
 *
 *   pnpm --filter @sherwood/reporter exec tsx src/verify.ts
 */

const V3_POOL_ABI = [
  {
    type: "function",
    name: "observe",
    stateMutability: "view",
    inputs: [{ type: "uint32[]", name: "secondsAgos" }],
    outputs: [{ type: "int56[]" }, { type: "uint160[]" }],
  },
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
] as const;

const TWAP_WINDOW = 1800;

/** 1.0001^tick, in floating point. Only used for reporting, never for a protocol decision. */
function tickToRatio(tick: number): number {
  return Math.pow(1.0001, tick);
}

export type DeviationRow = {
  symbol: string;
  /** Share price implied by the pool's 30-minute TWAP. */
  onChain: number | null;
  /** Share price on the underlying exchange. */
  offChain: number | null;
  deviationBps: number | null;
  liquidity: bigint | null;
  note: string;
};

export async function measureDeviations(symbols?: string[]): Promise<DeviationRow[]> {
  const assets = symbols
    ? EQUITY_ASSETS.filter((a) => symbols.map((s) => s.toUpperCase()).includes(a.symbol))
    : EQUITY_ASSETS;

  const client = createPublicClient({
    chain: robinhoodChain,
    transport: fallback(PUBLIC_RPC_URLS.map((url) => http(url, { timeout: 20_000 }))),
  });

  const [{ quotes }, chainData] = await Promise.all([
    fetchQuotes(assets.map((a) => a.symbol)),
    client.multicall({
      allowFailure: true,
      contracts: assets.flatMap((a) => [
        { address: a.pool, abi: V3_POOL_ABI, functionName: "observe" as const, args: [[TWAP_WINDOW, 0]] as const },
        { address: a.pool, abi: V3_POOL_ABI, functionName: "liquidity" as const },
        { address: a.address, abi: STOCK_TOKEN_ABI, functionName: "uiMultiplier" as const },
        { address: a.address, abi: STOCK_TOKEN_ABI, functionName: "paused" as const },
      ]),
    }),
  ]);

  const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));
  return assets.map((a, i) => {
    const observe = chainData[i * 4];
    const liquidity = chainData[i * 4 + 1];
    const multiplier = chainData[i * 4 + 2];
    const paused = chainData[i * 4 + 3];
    const quote = bySymbol.get(a.symbol);

    if (paused.status === "success" && paused.result === true) {
      return { symbol: a.symbol, onChain: null, offChain: quote?.price ?? null, deviationBps: null, liquidity: null, note: "token paused" };
    }
    if (observe.status !== "success") {
      return { symbol: a.symbol, onChain: null, offChain: quote?.price ?? null, deviationBps: null, liquidity: null, note: "no TWAP history" };
    }

    const [cumulatives] = observe.result as readonly [readonly bigint[], readonly bigint[]];
    const delta = cumulatives[1] - cumulatives[0];
    const window = BigInt(TWAP_WINDOW);
    let tick = delta / window;
    if (delta < 0n && delta % window !== 0n) tick -= 1n;

    // The pool quotes raw units against raw units; USDG has six decimals and the equity has 18, and
    // the UI multiplier turns raw units into shares.
    const ratio = tickToRatio(Number(tick));
    const rawRatio = a.assetIsToken0 ? ratio : 1 / ratio;
    const mult = multiplier.status === "success" ? Number(multiplier.result) / 1e18 : 1;
    const onChain = (rawRatio * 10 ** (a.decimals - 6)) / mult;

    const offChain = quote?.price ?? null;
    const deviationBps = offChain ? Math.round(((onChain - offChain) / offChain) * 10_000) : null;
    return {
      symbol: a.symbol,
      onChain,
      offChain,
      deviationBps,
      liquidity: liquidity.status === "success" ? (liquidity.result as bigint) : null,
      note: offChain ? "" : "no off-chain quote",
    };
  });
}

async function main() {
  const symbols = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const detail = sessionAt();
  const sessionName = ["closed", "pre", "regular", "post", "halted"][detail.session];
  console.log(
    `US equity session: ${sessionName}` +
      `${detail.holiday ? " (market holiday)" : ""}${detail.earlyClose ? " (early close)" : ""}` +
      ` at ${String(detail.newYork.hour).padStart(2, "0")}:${String(detail.newYork.minute).padStart(2, "0")} New York\n`,
  );

  const rows = await measureDeviations(symbols.length > 0 ? symbols : undefined);
  const priced = rows.filter((r) => r.deviationBps !== null);
  priced.sort((a, b) => Math.abs(a.deviationBps!) - Math.abs(b.deviationBps!));

  console.log("symbol    on-chain     exchange     deviation   note");
  for (const r of rows.filter((x) => x.deviationBps === null)) {
    console.log(`${r.symbol.padEnd(9)} ${"-".padStart(11)}  ${(r.offChain?.toFixed(2) ?? "-").padStart(11)}  ${"-".padStart(9)}   ${r.note}`);
  }
  for (const r of priced) {
    const bps = r.deviationBps!;
    console.log(
      `${r.symbol.padEnd(9)} ${r.onChain!.toFixed(2).padStart(11)}  ${r.offChain!.toFixed(2).padStart(11)}  ` +
        `${(bps > 0 ? "+" : "") + bps}bps`.padStart(10) +
        `   ${Math.abs(bps) <= 200 ? "inside the intraday band" : Math.abs(bps) <= 500 ? "inside the off-hours band" : "outside both bands"}`,
    );
  }

  if (priced.length > 0) {
    const abs = priced.map((r) => Math.abs(r.deviationBps!)).sort((a, b) => a - b);
    const median = abs[Math.floor(abs.length / 2)];
    const p90 = abs[Math.floor(abs.length * 0.9)];
    console.log(
      `\n${priced.length} priced, median deviation ${median}bps, 90th percentile ${p90}bps, worst ${abs[abs.length - 1]}bps`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
