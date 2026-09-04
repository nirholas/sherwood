import { defineChain } from "viem";

/// Robinhood Chain mainnet. An Arbitrum Orbit rollup that settles in ETH.
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: {
    // Deployed at the canonical address; verified to hold code on 2026-09-04. Without this, viem
    // refuses to batch and every read becomes its own request against an endpoint that rate-limits.
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

export const robinhoodChainTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  testnet: true,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain-testnet.blockscout.com" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

/**
 * Public endpoints that answered on 2026-09-04, official first. All of them rate-limit, and the
 * official one returns 429 under bursts, so anything that polls should rotate.
 */
export const PUBLIC_RPC_URLS: readonly string[] = [
  "https://rpc.mainnet.chain.robinhood.com",
  "https://rpc-robinhood.blockmachine.io",
  "https://robinhood.api.pocket.network",
  "https://robinhood-rpc.publicnode.com",
];
