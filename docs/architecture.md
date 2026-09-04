# Architecture

```
                        ┌───────────────────────────────────────────┐
   equity quotes  ─────▶│  apps/reporter                            │
   (two providers)      │  fetch, compute the session, sign, quorum │
                        └───────────────────┬───────────────────────┘
                                            │ postQuote (EIP-712, quorum)
                                            ▼
   Uniswap v3 pool ────────────▶  ┌──────────────────────┐
   (the settlement price)         │   SherwoodOracle     │◀── Stock token
                                  │   peek / valueOf     │    uiMultiplier, paused,
                                  └──────────┬───────────┘    oraclePaused, effectiveAt
                                             │
                     ┌───────────────────────┼───────────────────────┐
                     ▼                       ▼                       ▼
             ┌───────────────┐      ┌───────────────┐       ┌──────────────────┐
             │ SherwoodMarket│      │ SherwoodMarket│       │ SherwoodBasket   │
             │ SPY  / USDG   │      │ NVDA / USDG   │       │ Oracle           │
             └───────┬───────┘      └───────────────┘       └────────┬─────────┘
                     │                                               │
                     │                                      ┌────────▼─────────┐
                     │                                      │ SherwoodBasket   │
                     │                                      │ market           │
                     │                                      └──────────────────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
   apps/keeper               apps/api  ──▶  apps/web
   liquidations              reads          landing + platform
```

## The dependency direction

Markets read the oracle. **The oracle never reads a market.** That is what makes a market's terms
untouchable: there is no path from the oracle's owner to anyone's position.

Markets do not know about each other, so a halt or a bad debt in one is invisible to the rest.

## Contracts

| Contract | Owner | Upgradeable | Responsibility |
|---|---|---|---|
| `SherwoodOracle` | yes | no | Pool TWAP bounded by attested quotes; halt and corporate-action aware |
| `SherwoodMarket` | **no** | no | One isolated market, immutable terms |
| `SherwoodFactory` | **no** | no | Deterministic deployment, permissionless |
| `KinkedIrm` | **no** | no | Two-slope rate curve, fixed at construction |
| `SherwoodBasket` | **no** | no | Fixed-weight equity basket, in-kind only |
| `SherwoodBasketOracle` | yes | no | Prices a basket on what is visible, reports what is dark |

The oracle's owner can configure assets and rotate reporters. It cannot set a price, bypass a band, or
touch a market. See [oracle.md](oracle.md#trust).

## Off chain

| Package | What it does |
|---|---|
| `packages/sdk` | Chain definition, the generated asset registry, ABIs, and risk math that mirrors the contracts function for function |
| `apps/reporter` | Fetches equity quotes from two independent providers, computes the session locally from the NYSE calendar, signs EIP-712 reports, assembles a quorum, and posts. Also co-signs for peers, refusing anything its own feed cannot confirm |
| `apps/keeper` | Builds its borrower set from logs, respects the halt shield and the grace ramp, simulates before sending |
| `apps/api` | Read layer; derives every number with the SDK so the UI cannot disagree with the chain. Also serves the app |
| `apps/web` | Landing page and platform. No bundler, no dependencies; its call encoder computes selectors from a keccak implementation checked against `cast` |

## Generated, not maintained

Two files are generated from ground truth and must not be hand-edited:

| File | Source | Command |
|---|---|---|
| `packages/sdk/src/assets.ts` | Robinhood Chain itself | `node scripts/discover-pools.mjs` |
| `packages/sdk/src/abis.ts` | `contracts/out` | `forge build --root contracts && node scripts/emit-abis.mjs` |

The asset registry records each equity's deepest USDG pool, the pool's orientation, its decimals and
its observation cardinality. Getting an orientation wrong does not produce a slightly wrong price, it
produces one inverted by twelve orders of magnitude, which is why it is read rather than written down.

## Units

Three scales appear, and mixing them is the most likely source of a serious bug.

| Quantity | Scale | Where |
|---|---|---|
| USDG amounts | 1e6 | Loan asset, debt, supply |
| Collateral amounts | 1e18 | Stock tokens, basket shares |
| Dollar values | 1e8 | `valueOf`, `collateralValue1e8` |
| Prices | `priceRawX26` = USDG per **raw unit** x 1e26 | `peek`, `priceRawX26` |
| Ratios (LLTV, multipliers) | 1e18 wad | `LLTV`, `uiMultiplier` |
| Fees and bonuses | basis points | `LIQ_BONUS_BPS`, `maxDeviationBps` |

`valueOf(asset, rawAmount) = rawAmount * priceRawX26 / 1e18` returns dollars at 1e8 and is
decimals-independent. Use it rather than reconstructing the arithmetic.

The one place the scales must be reconciled by hand is solvency, where six-decimal debt meets
eight-decimal value:

```solidity
uint256 maxDebt1e8 = collateralValue1e8.mulWad(LLTV);
return maxDebt1e8 >= debtAssets * 1e2;
```

## Testing

| Suite | Command | Covers |
|---|---|---|
| Unit and fuzz | `forge test --root contracts` | 55 tests: oracle statuses, corporate actions, halt shield, grace ramp, bad debt, basket claims, two fuzz invariants |
| Live chain | `RHC_RPC_URL=... forge test --match-contract Fork` | 6 tests against the real SPY token, the real shared beacon, and the real pool |
| TypeScript | `pnpm -r test` | 54 tests: risk math mirroring, EIP-712 encoding, the NYSE calendar, keeper economics, API routing |
| End to end | `node scripts/e2e.mjs` | The whole protocol on a fork, with real tokens and real swaps |

The fork suites skip themselves when no RPC is configured, so `forge test` still works offline.
