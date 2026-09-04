# Sherwood

**Halt-aware lending against tokenized equities on Robinhood Chain.**

Robinhood Chain (`eip155:4663`) carries 254 tokenized equities with real liquidity: SPY alone holds
$8.5M of on-chain liquidity against $119M of daily volume, alongside NVDA, AAPL, TSLA, GLD, SGOV and
250 others. It carries no price oracle of any kind. Nothing on the chain can lend, margin, or settle
a derivative against a stock, because nothing can safely say what a stock is worth.

Sherwood is that layer, and the lending markets that prove it works.

- **[docs/oracle.md](docs/oracle.md)** how the price is decided, and why neither source can move it alone
- **[docs/halts.md](docs/halts.md)** what happens when the issuer pauses a token, and why it matters more than it sounds
- **[docs/markets.md](docs/markets.md)** supplying, borrowing, liquidating
- **[docs/baskets.md](docs/baskets.md)** diversifying halt risk rather than returns
- **[docs/deployment.md](docs/deployment.md)** deploying and operating the whole thing
- **[docs/architecture.md](docs/architecture.md)** the map

---

## The three things that make this different

### 1. The settlement price is the one a liquidator can realise

A tokenized share is not the share. It trades 24/7 on a chain; the underlying trades for six and a
half hours on a weekday. Every lending protocol has to pick which price it believes, and both obvious
answers are wrong.

Sherwood settles on the **Uniswap TWAP**, because a liquidator seizes tokens and sells them into a
pool on this chain, and what they realise there is what makes a liquidation solvent. A quorum of
reporters attests the real exchange price, and that attestation is used **only as a bound**.

Manipulate the pool and it walks away from the attestation. Compromise the reporters and they walk
away from the pool. Either way the feed goes dark rather than picking a winner. This inverts the usual
oracle: the trustless source decides, and the trusted one can only ever refuse to confirm, so a
compromised signer cannot mint value out of nothing.

The bands are measured, not guessed. Across all 38 listed equities the on-chain token tracks its
underlying to a **median of 65 basis points** and a **90th percentile of 163**:

```
$ pnpm --filter @sherwood/reporter exec tsx src/verify.ts

symbol    on-chain     exchange     deviation
SGOV        100.43       100.43         0bps
SPY         774.08       773.17       +12bps
AAPL        327.72       328.21       -15bps
NVDA        229.94       228.45       +65bps
TSLA        369.71       376.37      -177bps
LULU        100.12       121.77     -1778bps   outside both bands
...
37 priced, median deviation 65bps, 90th percentile 163bps
```

LULU is the case the rule exists for: a genuine 18% dislocation between the token and the share. The
oracle refuses to price it, and no market can lend against it, which is the correct answer.

### 2. A halted token cannot be liquidated at any price, so the market stops charging for the time

Every Robinhood stock token can be paused by its issuer. While it is, `transfer` reverts, so
collateral cannot be seized. A liquidation is not discouraged, it is impossible.

A lending protocol built for assets that never stop accrues interest through a two-day halt against
borrowers who could not repay or top up, clears nothing because nobody can liquidate, and then at the
unpause has its entire book underwater at once, at a price that gapped while nobody could act. The
first liquidator in the block takes all of it.

While collateral is unpriceable, a Sherwood market:

- **stops accruing interest entirely**, so a halt costs the borrower nothing;
- **refuses new borrows and collateral withdrawals**, because health cannot be evaluated;
- **keeps repayment and supply open**, because they only ever reduce risk;
- **lets depositors withdraw**, because a halt is not a reason to trap people who are owed money.

When the price returns, the **liquidation bonus ramps from zero** over the grace window. At the first
second there is no profit in liquidating anyone, so nobody does, and a borrower who was locked out
gets a real chance to cure at the new price. By the end of the window the full incentive is back.

### 3. Corporate actions are read off the token, not from a human

Robinhood's stock tokens publish a `uiMultiplier`, and publish the *next* one along with the second it
takes effect. That is advance, on-chain notice of a stock split, which no mainnet price feed has. It
is used twice:

- **Before it lands.** A scheduled *fall* in the multiplier is a scheduled fall in what a raw token is
  worth, so it is applied to collateral the moment it is announced. Nobody borrows against value
  already booked to disappear. A scheduled rise is not credited early.
- **Just after it lands.** For one TWAP window the moving average straddles the jump and is wrong by
  up to the split ratio. The feed serves nothing at all. A protocol that missed this would liquidate
  its entire book at a tenth of fair value the morning after a reverse split.

---

## Verification

Everything below runs against the live chain or a fork of it. No mocks in the integration path.

```
$ forge test --root contracts                     61 passed
$ RHC_RPC_URL=... forge test --match-contract Fork  6 passed
$ pnpm -r test                                    54 passed
$ node scripts/e2e.mjs                            end to end on a fork
```

The fork suite reads the real SPY token, the real beacon every tokenized equity proxies to, and the
real SPY/USDG pool, and asserts the oracle's arithmetic lands on the price the chain is quoting:

```
[PASS] test_livePoolDecodesToARealisticSharePrice()
  live SPY share price (USD): 774.23082700
[PASS] test_twapAgreesWithSpotSqrtPrice()
[PASS] test_liveStockTokenExposesTheAssumedSurface()
[PASS] test_marketOnLivePairIsHealthyAtRest()
```

`scripts/e2e.mjs` forks the chain and drives the whole protocol against real tokens: it brings the
feed live with a quorum-signed quote, proves an out-of-band quote disables rather than reprices,
borrows against real SPY, halts the token by writing the same storage slot `pause()` writes, verifies
that three days of halt move the debt by zero, confirms borrowing and liquidation are both refused,
watches the bonus ramp 0 to 175 to 700 basis points, moves the real pool with real swaps, and
liquidates the position that makes unhealthy.

---

## Layout

| Path | What it is |
|---|---|
| `contracts/` | Foundry project: oracle, market, factory, basket, rate model |
| `packages/sdk/` | Typed client, the generated asset registry, and risk math that mirrors the contracts |
| `apps/reporter/` | Fetches real equity quotes, signs them, posts a quorum |
| `apps/keeper/` | Liquidation bot that understands the halt shield |
| `apps/api/` | Read API, and it serves the app |
| `apps/web/` | Landing page and the working platform, no bundler |
| `scripts/` | Pool discovery, ABI generation, end-to-end |

### Contracts

| Contract | Responsibility |
|---|---|
| `SherwoodOracle` | Pool TWAP bounded by attested quotes, halt and corporate-action aware |
| `SherwoodMarket` | One isolated market. No owner, no upgrade path, no pause |
| `SherwoodFactory` | Deterministic deployment; a market's address is a commitment to its terms |
| `KinkedIrm` | Two-slope rate curve, immutable once deployed |
| `SherwoodBasket` | Fixed-weight equity basket whose redemptions survive a halted constituent |
| `SherwoodBasketOracle` | Prices a basket on what is visible, and says how much has gone dark |

---

## Running it

```bash
pnpm install
forge build --root contracts
forge test --root contracts

# live equity quotes for every listed asset
pnpm --filter @sherwood/reporter quote

# how far each token sits from its underlying, right now
pnpm --filter @sherwood/reporter exec tsx src/verify.ts

# the whole protocol, end to end, on a fork of the real chain
pnpm e2e
```

Deploying and operating: **[docs/deployment.md](docs/deployment.md)**.

### Creating a market

A market's address is the hash of its terms, so anyone can compute where a given set of risk
parameters must live before putting a dollar into it, and the same terms cannot be deployed twice.

```bash
FACTORY=0x... COLLATERAL=0x117cc2133c37B721F49dE2A7a74833232B3B4C0C \
LOAN_TOKEN=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 \
ORACLE=0x... IRM=0x... LLTV=700000000000000000 \
forge script script/CreateMarket.s.sol:CreateMarket --root contracts \
  --rpc-url $RHC_RPC_URL --broadcast
```

There is no allowlist. A permissioned factory would let whoever holds the key decide what the world is
allowed to borrow against; curation belongs in front ends and in vaults that choose markets.

---

## What is deliberately not here

- **No governance token, no treasury, no fee switch turned on.** The fee parameter exists per market
  and every market shipped so far sets it to zero.
- **No admin on a market.** Parameters are immutable from construction. The only way to change terms
  is to deploy a new market, which has a different address, which nobody is moved into silently.
- **No rebalancing inside baskets.** They never trade, so they cannot be sandwiched or drained through
  a rebalance, and they need no oracle to mint or redeem.
- **No cross-collateral.** Isolation is the point: one halted ticker's frozen bad debt should not
  reach depositors who never wanted exposure to it.

The oracle does have an owner, and that is a real trust assumption: it can configure assets and rotate
reporters. It cannot set a price, cannot bypass the deviation band, and cannot touch a market's terms
or anyone's position. See [docs/oracle.md](docs/oracle.md#trust).

## Licence

MIT.
