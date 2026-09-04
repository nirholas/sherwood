import { PUBLIC_RPC_URLS } from "@sherwood/sdk";
import type { Address, Hex } from "viem";
import type { KeeperConfig } from "./keeper.js";

export function loadConfig(): KeeperConfig {
  const factory = process.env.SHERWOOD_FACTORY;
  if (!factory) throw new Error("missing required env var SHERWOOD_FACTORY");
  const key = process.env.KEEPER_PRIVATE_KEY;
  return {
    rpcUrls: (process.env.RHC_RPC_URL ? [process.env.RHC_RPC_URL] : []).concat(PUBLIC_RPC_URLS),
    factory: factory as Address,
    privateKey: key ? ((key.startsWith("0x") ? key : `0x${key}`) as Hex) : undefined,
    markets: process.env.MARKETS
      ? (process.env.MARKETS.split(",").map((m) => m.trim()).filter(Boolean) as Address[])
      : null,
    minRepayAssets: BigInt(process.env.MIN_REPAY_USDG ?? 1_000_000), // one dollar
    // Without a key there is nothing to send, so reporting is the only honest mode.
    dryRun: process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true" || !key,
    intervalSeconds: Number(process.env.INTERVAL_SECONDS ?? 30),
    fromBlock: BigInt(process.env.FROM_BLOCK ?? 0),
  };
}
