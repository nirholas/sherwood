import { PUBLIC_RPC_URLS } from "@sherwood/sdk";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

export type ReporterConfig = {
  rpcUrls: string[];
  chainId: number;
  oracle: `0x${string}`;
  /** Reporter keys held by this process. A quorum is assembled from all of them plus any peers. */
  privateKeys: `0x${string}`[];
  /** Where peer reporters publish signatures for the same round, if any. */
  peerUrls: string[];
  /** Seconds between rounds. */
  intervalSeconds: number;
  /** Only post when the price moved by more than this, or the last post is older than maxSilence. */
  minChangeBps: number;
  maxSilenceSeconds: number;
  /** Symbols to quote. Defaults to every asset the oracle has configured. */
  symbols: string[] | null;
  /** Post transactions, or only compute and log. */
  dryRun: boolean;
  /** Port for this reporter's own signature endpoint. */
  port: number;
};

export function loadConfig(): ReporterConfig {
  const keys = (process.env.REPORTER_PRIVATE_KEYS ?? process.env.REPORTER_PRIVATE_KEY ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`);
  if (keys.length === 0) throw new Error("missing REPORTER_PRIVATE_KEYS");

  return {
    rpcUrls: (process.env.RHC_RPC_URL ? [process.env.RHC_RPC_URL] : []).concat(PUBLIC_RPC_URLS),
    chainId: Number(process.env.CHAIN_ID ?? 4663),
    oracle: required("SHERWOOD_ORACLE") as `0x${string}`,
    privateKeys: keys,
    peerUrls: (process.env.REPORTER_PEERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    intervalSeconds: Number(process.env.INTERVAL_SECONDS ?? 60),
    minChangeBps: Number(process.env.MIN_CHANGE_BPS ?? 10),
    maxSilenceSeconds: Number(process.env.MAX_SILENCE_SECONDS ?? 900),
    symbols: process.env.SYMBOLS ? process.env.SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean) : null,
    dryRun: process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true",
    port: Number(process.env.PORT ?? 8791),
  };
}
