---
name: read-sherwood-markets
description: Read Sherwood lending markets, positions, oracle status and halt state on Robinhood Chain with the read-side SDK or the local read API. Use when the user asks about a Sherwood market, whether a position is healthy or liquidatable, or why a price feed is dark.
---

# Read Sherwood markets

Sherwood is halt-aware lending against tokenized equities on Robinhood Chain (`eip155:4663`). It is a pnpm monorepo: `contracts/` (Foundry), `packages/sdk` (`@sherwood/sdk`, read-side client), `apps/api` (read API that also serves the web app), `apps/keeper`, `apps/reporter`, `apps/web`. Nothing is published to npm: clone the repo and run `pnpm install && pnpm -r build`. This skill only reads. It never signs or sends transactions: do not deploy, supply, borrow or liquidate for the user without showing the exact action and getting a yes.

## SDK

```ts
import { createPublicClient, http } from "viem";
import { SherwoodClient, PriceStatus, robinhoodChain, PUBLIC_RPC_URLS, formatUsd } from "@sherwood/sdk";

const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(PUBLIC_RPC_URLS[0]) });
const client = new SherwoodClient(publicClient, { oracle: ORACLE, factory: FACTORY });
```

`ORACLE` and `FACTORY` are the deployed `SherwoodOracle` and `SherwoodFactory` addresses (see `docs/deployment.md`).

| Method | Returns |
|---|---|
| `listMarkets()` | Market addresses from the factory. |
| `getMarket(market)` | Market state, including oracle status. |
| `getPosition(market, user)` / `getPositionSummary(market, user)` | Position and health, computed as the contracts compute it (`liquidatable`, health factor). |
| `getOracleView(asset)` | Price status and raw price (`rawX26`, 1e26 scale). |
| `getCorporateAction(asset)` | Pending corporate action for a token. |

Helpers: `healthFactor`, `isSolvent`, `maxBorrow`, `maxWithdrawCollateral`, `utilization`, `borrowRatePerYear`, `formatUsd`, and `EQUITY_ASSETS`, `assetBySymbol(symbol)`, `assetByAddress(address)` for the registry of listed tokens.

Always check `status`: if it is not `PriceStatus.OK` the feed is shielded (halted, or the pool and attestation disagree), and borrowing is blocked. Report that state instead of a price.

## Read API

```bash
RHC_RPC_URL=https://rpc.mainnet.chain.robinhood.com \
SHERWOOD_FACTORY=0x... SHERWOOD_ORACLE=0x... PORT=8790 \
pnpm --filter @sherwood/api start
```

GET only, JSON, bigints as strings: `/api/health`, `/api/markets`, `/api/markets/:market`, `/api/markets/:market/position/:user`, `/api/assets`, `/api/oracle/:asset`, `/api/corporate-action/:asset`. Env: `SHERWOOD_FACTORY` and `SHERWOOD_ORACLE` (required), `RHC_RPC_URL`, `CACHE_SECONDS` (default 10), `WEB_ROOT`, `PORT` (default 8790).

## Worked example

1. `client.listMarkets()` then `client.getMarket(m)` for each to find the market for an equity.
2. `client.getPositionSummary(market, user)`: if `summary.market.status !== PriceStatus.OK`, say the feed is shielded and why (`docs/halts.md`, `docs/oracle.md`). Otherwise report `liquidatable` and the health factor.
