# @sherwood/sdk

Typed client for Sherwood, plus the risk math the contracts use.

```bash
pnpm add @sherwood/sdk viem
```

## Why the math is duplicated here

Every function in [`src/math.ts`](src/math.ts) mirrors its Solidity counterpart exactly, including the
rounding direction and the decimal alignment between six-decimal USDG debt and eight-decimal
collateral values. A front end that recomputes health with floating point will eventually tell someone
they are safe while the chain is about to liquidate them.

```ts
import { isSolvent, healthFactor, maxBorrow, valueOf } from "@sherwood/sdk";

const value = valueOf(collateralRaw, priceRawX26);   // dollars at 1e8
isSolvent(value, debtAssets, lltv);                  // the market's own check
healthFactor(value, debtAssets, lltv);               // 1.0 is the liquidation threshold
maxBorrow(value, debtAssets, lltv);                  // never returns an insolvent amount
```

`test/math.test.ts` asserts the boundary: `maxBorrow` is solvent and `maxBorrow + 2` is not.

## Reading the chain

```ts
import { createPublicClient, http } from "viem";
import { SherwoodClient, robinhoodChain, PriceStatus, formatUsd } from "@sherwood/sdk";

const client = new SherwoodClient(
  createPublicClient({ chain: robinhoodChain, transport: http() }),
  { oracle: "0x...", factory: "0x..." },
);

for (const market of await client.listMarkets()) {
  const m = await client.getMarket(market);
  if (m.status !== PriceStatus.OK) {
    console.log(market, "shielded:", PriceStatus[m.status]);
    continue;
  }
  console.log(market, formatUsd(m.priceRawX26), "per share");
}

const summary = await client.getPositionSummary(market, user);
console.log(summary.healthFactor, summary.liquidatable);
```

`getCorporateAction(asset)` returns the split state the token publishes about itself, including
whether a change is scheduled and whether it is dilutive. A dilutive one is already priced into
collateral by the oracle.

## Signing a price report

```ts
import { reportTypedData, sortSignaturesBySigner, Session } from "@sherwood/sdk";

const report = { asset, price: 77_317_000_000n, observedAt, session: Session.Regular, nonce };
const signature = await account.signTypedData(reportTypedData(report, oracle, 4663));

// postQuote requires signatures ordered by ascending recovered address.
const signatures = sortSignaturesBySigner([{ signer: account.address, signature }, ...peers]);
```

## The asset registry

[`src/assets.ts`](src/assets.ts) is **generated** by `node scripts/discover-pools.mjs` and must not be
hand-edited. It records, for each listed equity, the deepest USDG pool, whether the equity is that
pool's token0, and how many observations the pool stores.

The orientation is read rather than written down because getting it wrong inverts the price by twelve
orders of magnitude.

```ts
import { EQUITY_ASSETS, assetBySymbol } from "@sherwood/sdk";

assetBySymbol("SPY");
//  { symbol: "SPY", address: "0x117cc2…", pool: "0xa7Bb1AC6…",
//    assetIsToken0: true, observationCardinality: 1801, chainLiquidityUsd: 8460839 }
```

## Exports

| Module | Contents |
|---|---|
| `chain` | `robinhoodChain`, `robinhoodChainTestnet`, `PUBLIC_RPC_URLS` |
| `assets` | `EQUITY_ASSETS`, `assetBySymbol`, `assetByAddress`, `USDG` |
| `abis` | Generated contract ABIs plus `STOCK_TOKEN_ABI` and `ERC20_ABI` |
| `types` | `PriceStatus`, `Session`, labels, `isIssuerHalt` |
| `math` | Health, rates, share conversion, formatting |
| `quote` | EIP-712 typed data and signature ordering |
| `client` | `SherwoodClient` |

```bash
pnpm build      # tsc
pnpm test       # 24 tests
```
