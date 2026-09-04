# @sherwood/api

Read API for Sherwood, and the process that serves the app.

```bash
export SHERWOOD_FACTORY=0x...
export SHERWOOD_ORACLE=0x...
export PORT=8790
pnpm start
```

It serves [`apps/web`](../web) directly, so this single process is the whole front end. There is no
build step: the app is plain ES modules.

| Variable | Default | Meaning |
|---|---|---|
| `SHERWOOD_FACTORY` | required | Factory to enumerate markets from |
| `SHERWOOD_ORACLE` | required | Oracle to read price state from |
| `RHC_RPC_URL` | public list | Tried before the public endpoints |
| `CACHE_SECONDS` | 10 | How long a response stays fresh |
| `WEB_ROOT` | `../web` | Static root; unset it to run headless |
| `PORT` | 8790 | Listen port |

## Endpoints

| Route | Returns |
|---|---|
| `GET /api/health` | Liveness and the configured addresses |
| `GET /api/markets` | Every market with balances, rates, utilization and price status |
| `GET /api/markets/:market` | One market |
| `GET /api/markets/:market/position/:user` | A position, with health, borrowing power and whether it is liquidatable |
| `GET /api/assets` | Every listed equity with the oracle's current opinion of it |
| `GET /api/oracle/:asset` | Both price sources and how far apart they sit |
| `GET /api/corporate-action/:asset` | The split state the token publishes about itself |

Numbers that must not lose precision are strings. Anything derived is a number, because it is already
a derived quantity.

```jsonc
{
  "address": "0x…",
  "collateralSymbol": "SPY",
  "totalSupplyAssets": "500000000000",   // raw USDG, six decimals
  "utilizationPercent": 10.4,
  "supplyApr": 0.31,
  "borrowApr": 3.11,
  "shielded": false,
  "currentBonusBps": 700,
  "status": 0,
  "statusLabel": "live",
  "sharePrice": 774.23
}
```

## What it does that an ordinary lending API does not

**It derives every number with `@sherwood/sdk`**, which mirrors the contracts function for function,
so the interface can never tell someone they are safe while the chain would liquidate them.

**It surfaces why a market is shielded**, not merely that it is. `status` and `statusLabel` carry the
oracle's reason, and the app turns each one into a sentence a person can act on.

**It surfaces scheduled corporate actions**, which no other lending front end has a concept of:

```jsonc
{
  "symbol": "SPY",
  "uiMultiplier": "1000000000000000000",
  "newUIMultiplier": "100000000000000000",
  "effectiveAt": 1788700000,
  "pending": true,
  "dilutive": true,       // already priced into collateral by the oracle
  "ratio": 0.1
}
```

## Notes

Responses are cached for `CACHE_SECONDS` and every read is batched through `multicall3`. Both matter:
public Robinhood Chain endpoints rate-limit hard, and an uncached, unbatched API is enough on its own
to earn a 429.

Static serving normalises the path before joining, so `..` cannot escape the served directory, and
unknown paths fall back to the app shell.
