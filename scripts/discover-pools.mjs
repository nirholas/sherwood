#!/usr/bin/env node
/**
 * Builds the Sherwood asset registry by reading Robinhood Chain directly.
 *
 * For every tokenized equity given, it finds each Uniswap v3 pool against USDG, keeps the deepest
 * one that has enough stored observations for a 30-minute TWAP, and records the orientation and
 * decimals the oracle has to be configured with. Nothing here is hand-maintained: getting a pool's
 * token order or a cardinality wrong is not a small error, so the registry is generated.
 *
 *   node scripts/discover-pools.mjs [--out packages/sdk/src/assets.ts] [--min-liquidity 250000]
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const RPCS = [
  "https://rpc.mainnet.chain.robinhood.com",
  "https://rpc-robinhood.blockmachine.io",
  "https://robinhood.api.pocket.network",
  "https://robinhood-rpc.publicnode.com",
];

const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const FEE_TIERS = [100, 500, 3000, 10000];
/** Half an hour of one-second observations is the shortest buffer a 1800s TWAP can survive on. */
const MIN_CARDINALITY = 120;

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const OUT = argOf("--out", "packages/sdk/src/assets.ts");
const MIN_LIQ_USD = Number(argOf("--min-liquidity", "250000"));
const TOKEN_DUMP = argOf("--tokens", "/workspaces/rhc-analysis/robinhood-chain-all-tokens.json");

let rpcIndex = 0;
let id = 1;

/** Rotates endpoints on failure, because every public RPC on this chain rate-limits. */
async function rpc(calls) {
  const body = calls.map((c) => ({ jsonrpc: "2.0", id: id++, ...c }));
  for (let attempt = 0; attempt < RPCS.length * 2; attempt++) {
    const url = RPCS[rpcIndex % RPCS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const json = await res.json();
      const byId = new Map((Array.isArray(json) ? json : [json]).map((r) => [r.id, r]));
      return body.map((b) => byId.get(b.id));
    } catch (err) {
      rpcIndex++;
      if (attempt === RPCS.length * 2 - 1) throw err;
    }
  }
}

const selector = {
  getPool: "0x1698ee82", // getPool(address,address,uint24)
  liquidity: "0x1a686502",
  slot0: "0x3850c7bd",
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
  token0: "0x0dfe1681",
  uiMultiplier: "0xa60bf13d",
  paused: "0x5c975abb",
};

const pad = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
const addrArg = (a) => pad(a.toLowerCase());
const uintArg = (n) => pad(BigInt(n).toString(16));
const call = (to, data) => ({ method: "eth_call", params: [{ to, data }, "latest"] });
const asAddress = (word) => "0x" + word.slice(-40);
const asBigInt = (hex) => BigInt(hex);

function decodeString(hex) {
  const b = hex.replace(/^0x/, "");
  if (b.length <= 64) return "";
  const len = Number(BigInt("0x" + b.slice(64, 128)));
  const raw = b.slice(128, 128 + len * 2);
  return Buffer.from(raw, "hex").toString("utf8");
}

/** The token dump carries HTML-escaped names; the chain does not. */
function unescapeHtml(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

function toChecksum(addr) {
  // EIP-55, implemented here so the generated file needs no dependency to be regenerated.
  const lower = addr.toLowerCase().replace(/^0x/, "");
  const hash = keccak256(Buffer.from(lower, "utf8"));
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

/** Minimal keccak-256, needed only for EIP-55 casing. */
function keccak256(input) {
  const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  const ROT = [
    [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
  ];
  const M = (1n << 64n) - 1n;
  const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M;
  const st = new Array(25).fill(0n);
  const rate = 136;
  const padded = Buffer.concat([input, Buffer.from([0x01]), Buffer.alloc((rate - ((input.length + 1) % rate)) % rate)]);
  padded[padded.length - 1] |= 0x80;
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) st[i] ^= padded.readBigUInt64LE(off + i * 8);
    for (let round = 0; round < 24; round++) {
      const C = [0, 1, 2, 3, 4].map((x) => st[x] ^ st[x + 5] ^ st[x + 10] ^ st[x + 15] ^ st[x + 20]);
      const D = [0, 1, 2, 3, 4].map((x) => C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1));
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) st[x + 5 * y] ^= D[x];
      const B = new Array(25).fill(0n);
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(st[x + 5 * y], ROT[x][y]);
      }
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) st[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & B[((x + 2) % 5) + 5 * y] & M);
      }
      st[0] ^= RC[round];
    }
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(st[i] & M, i * 8);
  return out.toString("hex");
}

async function main() {
  if (!existsSync(TOKEN_DUMP)) {
    console.error(`token dump not found at ${TOKEN_DUMP}; pass --tokens <path>`);
    process.exit(1);
  }
  const all = JSON.parse(readFileSync(TOKEN_DUMP, "utf8"));
  const stocks = all
    .filter((t) => t.class === "tokenized-stock" && (t.chain_liq || 0) >= MIN_LIQ_USD)
    .sort((a, b) => (b.chain_liq || 0) - (a.chain_liq || 0));
  console.error(`${stocks.length} tokenized equities above $${MIN_LIQ_USD.toLocaleString()} of on-chain liquidity`);

  const found = [];
  for (const stock of stocks) {
    const asset = stock.address;
    const poolCalls = FEE_TIERS.map((fee) =>
      call(V3_FACTORY, selector.getPool + addrArg(asset) + addrArg(USDG) + uintArg(fee)),
    );
    const poolRes = await rpc(poolCalls);
    const candidates = [];
    poolRes.forEach((r, i) => {
      if (!r?.result) return;
      const addr = asAddress(r.result);
      if (addr !== "0x0000000000000000000000000000000000000000") {
        candidates.push({ pool: addr, fee: FEE_TIERS[i] });
      }
    });
    if (candidates.length === 0) {
      console.error(`  ${stock.symbol.padEnd(6)} no USDG pool`);
      continue;
    }

    const detail = await rpc([
      call(asset, selector.decimals),
      call(asset, selector.symbol),
      call(asset, selector.uiMultiplier),
      ...candidates.flatMap((c) => [call(c.pool, selector.liquidity), call(c.pool, selector.slot0), call(c.pool, selector.token0)]),
    ]);
    if (!detail[0]?.result || !detail[2]?.result) {
      console.error(`  ${stock.symbol.padEnd(6)} not a Stock token (no uiMultiplier)`);
      continue;
    }
    const decimals = Number(asBigInt(detail[0].result));
    const symbol = decodeString(detail[1].result) || stock.symbol;
    const multiplier = asBigInt(detail[2].result);

    let best = null;
    candidates.forEach((c, i) => {
      const liq = detail[3 + i * 3]?.result;
      const slot0 = detail[4 + i * 3]?.result;
      const token0 = detail[5 + i * 3]?.result;
      if (!liq || !slot0 || !token0) return;
      const liquidity = asBigInt(liq);
      if (liquidity === 0n) return;
      // slot0 words: sqrtPriceX96, tick, observationIndex, observationCardinality, ...
      const cardinality = Number(asBigInt("0x" + slot0.replace(/^0x/, "").slice(64 * 3, 64 * 4)));
      if (cardinality < MIN_CARDINALITY) return;
      if (!best || liquidity > best.liquidity) {
        best = {
          pool: c.pool,
          fee: c.fee,
          liquidity,
          cardinality,
          assetIsToken0: asAddress(token0).toLowerCase() === asset.toLowerCase(),
        };
      }
    });

    if (!best) {
      console.error(`  ${symbol.padEnd(6)} pools exist but none carry ${MIN_CARDINALITY} observations`);
      continue;
    }
    console.error(
      `  ${symbol.padEnd(6)} pool ${best.pool} fee ${String(best.fee).padStart(5)} cardinality ${best.cardinality}`,
    );
    found.push({
      symbol,
      name: unescapeHtml(stock.name),
      address: toChecksum(asset),
      decimals,
      multiplier: multiplier.toString(),
      pool: toChecksum(best.pool),
      fee: best.fee,
      assetIsToken0: best.assetIsToken0,
      observationCardinality: best.cardinality,
      chainLiquidityUsd: Math.round(stock.chain_liq || 0),
      holders: stock.holders ?? null,
    });
  }

  const header = `// Generated by scripts/discover-pools.mjs on ${new Date().toISOString().slice(0, 10)}.
// Every field was read from Robinhood Chain; do not hand-edit. Regenerate with:
//   node scripts/discover-pools.mjs
`;
  const body = `${header}
export type EquityAsset = {
  /** Ticker as the token reports it. */
  symbol: string;
  name: string;
  address: \`0x\${string}\`;
  decimals: number;
  /** Deepest Uniswap v3 pool against USDG that stores enough observations for a 30-minute TWAP. */
  pool: \`0x\${string}\`;
  fee: number;
  /** True when the equity is the pool's token0. Getting this wrong inverts every price. */
  assetIsToken0: boolean;
  observationCardinality: number;
  chainLiquidityUsd: number;
  holders: number | null;
};

export const USDG = "${toChecksum(USDG)}" as const;
export const UNISWAP_V3_FACTORY = "${toChecksum(V3_FACTORY)}" as const;

/** Tokenized equities with a USDG pool deep enough to price and liquidate against. */
export const EQUITY_ASSETS: readonly EquityAsset[] = ${JSON.stringify(
    found.map(({ multiplier, ...rest }) => rest),
    null,
    2,
  )} as const;

export function assetBySymbol(symbol: string): EquityAsset | undefined {
  return EQUITY_ASSETS.find((a) => a.symbol.toLowerCase() === symbol.toLowerCase());
}

export function assetByAddress(address: string): EquityAsset | undefined {
  const needle = address.toLowerCase();
  return EQUITY_ASSETS.find((a) => a.address.toLowerCase() === needle);
}
`;
  writeFileSync(OUT, body);
  console.error(`\nwrote ${found.length} assets to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
