# Sherwood contracts

Foundry project. Six contracts, no proxies, no upgrade path, and no owner on anything that holds
someone's money.

```bash
forge build                                            # build
forge test                                             # 61 tests, 6 of them no-ops without an RPC
RHC_RPC_URL=https://rpc.mainnet.chain.robinhood.com \
  forge test --match-contract Fork -vv                 # 6 tests against the live chain
```

The fork suite skips itself when `RHC_RPC_URL` is unset, so `forge test` works offline.

## Contracts

| Contract | Owner | Purpose |
|---|---|---|
| [`SherwoodOracle`](src/SherwoodOracle.sol) | yes | Pool TWAP bounded by attested exchange quotes, aware of halts and scheduled corporate actions |
| [`SherwoodMarket`](src/SherwoodMarket.sol) | **no** | One isolated market: one collateral, one loan asset, immutable terms |
| [`SherwoodFactory`](src/SherwoodFactory.sol) | **no** | CREATE2 deployment salted by the terms, so an address commits to its parameters |
| [`KinkedIrm`](src/KinkedIrm.sol) | **no** | Two-slope utilization curve, fixed at construction |
| [`SherwoodBasket`](src/SherwoodBasket.sol) | **no** | Fixed-weight equity basket whose redemptions survive a halted constituent |
| [`SherwoodBasketOracle`](src/SherwoodBasketOracle.sol) | yes | Prices a basket on what is visible and reports how much has gone dark |

Interfaces live in [`src/interfaces`](src/interfaces). [`IStockToken`](src/interfaces/IStockToken.sol)
describes the surface every Robinhood tokenized equity exposes, including the three members no
ordinary ERC-20 has: `uiMultiplier`, `paused` and `oraclePaused`.

## Dependencies

`forge-std` and `solady`, vendored under `lib/` rather than added as submodules so a fresh clone
builds without `--recursive`.

Uniswap's tick tables are **not** vendored: they are GPL-2.0 and would relicense this repository. The
TWAP is converted from the mean tick with `exp(tick * ln(1.0001))` using solady's `expWad`, and the
result is cross-checked against `slot0.sqrtPriceX96` squared on the live chain in
[`test_twapAgreesWithSpotSqrtPrice`](test/Fork.t.sol).

## Tests

| File | Covers |
|---|---|
| [`SherwoodOracle.t.sol`](test/SherwoodOracle.t.sol) | Tick decoding, quorum and signature ordering, the two-source rule in both directions, session bands, every halt status, the pending-split haircut and the post-split blackout |
| [`SherwoodMarket.t.sol`](test/SherwoodMarket.t.sol) | Supply, borrow, repay, interest, the halt shield, the grace ramp, liquidation, bad-debt socialisation, deterministic addresses, and two fuzz invariants |
| [`SherwoodBasket.t.sol`](test/SherwoodBasket.t.sol) | In-kind mint and redeem, deferred claims through a halt, reserved backing, checkpointing, degradation, and borrowing against a basket through a constituent halt |
| [`Fork.t.sol`](test/Fork.t.sol) | The live SPY token, the shared beacon, the real pool, and a market created against the real pair |

[`test/mocks/MockStock.sol`](test/mocks/MockStock.sol) is a behavioural transcription of the real
`Stock` implementation, taken from the verified source at
`0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2`, so the unit tests exercise the real semantics rather
than a convenient approximation.

## Deploying

See [../docs/deployment.md](../docs/deployment.md). Scripts:

| Script | Purpose |
|---|---|
| [`Deploy.s.sol`](script/Deploy.s.sol) | Oracle, rate model and factory |
| [`ConfigureAsset.s.sol`](script/ConfigureAsset.s.sol) | Point the oracle at one equity and its pool. Reads orientation and decimals from the chain rather than accepting them |
| [`CreateMarket.s.sol`](script/CreateMarket.s.sol) | One isolated market. Prints the deterministic address before creating it |
