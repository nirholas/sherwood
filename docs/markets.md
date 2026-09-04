# Markets

A Sherwood market is one collateral asset, one loan asset, and a fixed set of terms that nobody can
change. There is no owner, no pause, no upgrade path, and no way for anyone to alter the rules under a
position that is already open. The only way to change terms is to deploy a new market.

## Why isolated

Tokenized equities do not share a risk profile. Any one ticker can halt on its own, and a halted
ticker cannot be liquidated at any price. In a pooled design that name's frozen bad debt is socialised
across every depositor in the protocol, including people who never wanted exposure to it.

Isolation contains it. If SPY halts, the SPY market shields and the NVDA market carries on.

## Terms

| Parameter | Meaning | Typical |
|---|---|---|
| `LLTV` | Loan-to-value at which a position becomes liquidatable | 0.70e18 |
| `LIQ_BONUS_BPS` | Discount a liquidator receives, once fully ramped | 700 |
| `CLOSE_FACTOR_BPS` | Most of a debt one liquidation may repay | 5000 |
| `GRACE_WINDOW` | How long the bonus takes to ramp back after a halt | 4 hours |
| `FEE` | Share of accrued interest to `FEE_RECIPIENT` | 0 |

The constructor refuses combinations that guarantee bad debt. If `LLTV * (1 + bonus) > 1`, a position
liquidated the instant it crosses the threshold is already underwater, so every liquidation creates a
shortfall:

```solidity
// Both sides are multiplied out rather than reduced, because the LLTV is a wad and the bonus is in
// basis points, and mixing the two scales silently compares a five-digit number against 1e18 and
// passes everything.
if (p.lltv * (BPS + p.liqBonusBps) > WAD * BPS) revert BadParams();
```

That comment describes a real bug this repository had. The check existed, was written with `mulWad`
across two different scales, and passed every input. `test_marketRejectsBonusThatWouldGuaranteeBadDebt`
caught it.

## The address is a commitment to the terms

`SherwoodFactory` deploys with CREATE2, salted by the hash of the full parameter tuple. A given set of
terms therefore has exactly one address, forever, and the same terms cannot be deployed twice.

```solidity
function saltFor(SherwoodMarket.ConstructorParams memory p) public pure returns (bytes32) {
    return keccak256(abi.encode(p));
}
```

Anyone can recompute where a market with a given LLTV, bonus and oracle must live, offline, before
depositing. A market at an address that does not match its advertised terms is not the market it
claims to be.

There is no allowlist on creation. A permissioned factory would let whoever holds the key decide what
the world is allowed to borrow against; curation belongs in front ends and in vaults that choose
markets, not in the deployer.

## Supplying

```solidity
function supply(uint256 assets, address onBehalf) external returns (uint256 shares);
function withdraw(uint256 shares, address to) external returns (uint256 assets);
```

Deposits earn the borrow rate scaled by utilization. Accounting uses virtual shares and assets, so the
first deposit's exchange rate cannot be skewed by a donation, which is the classic attack on an empty
share-based pool.

Withdrawals are allowed during a halt. A depositor's claim does not depend on the collateral price,
and freezing it would convert an issuer's halt into a run on people who are owed money. They are still
bounded by idle liquidity: you cannot withdraw USDG that is currently lent out.

## Borrowing

```solidity
function supplyCollateral(uint256 assets, address onBehalf) external;
function borrow(uint256 assets, address to) external returns (uint256 shares);
function repay(uint256 assets, uint256 shares, address onBehalf) external returns (uint256, uint256);
function withdrawCollateral(uint256 assets, address to) external;
```

`repay` takes either an asset amount or a share count. Pass shares to close an exact debt: interest
accrues every second, so an asset-denominated repayment can never quite reach zero.

Health is checked against the same arithmetic the SDK exposes, so a front end cannot disagree with the
chain about whether a position is safe:

```solidity
function _solvent(uint256 collateralValue1e8, uint256 debtAssets) internal view returns (bool) {
    if (debtAssets == 0) return true;
    uint256 maxDebt1e8 = collateralValue1e8.mulWad(LLTV);
    return maxDebt1e8 >= debtAssets * 1e2;
}
```

The `1e2` is the decimal alignment: loan assets are USDG with six decimals, collateral values carry
eight.

## Interest

`KinkedIrm` is a two-slope utilization curve, immutable once deployed and shared by every market that
wants the same shape. Deliberately boring: the interesting risk behaviour lives in the oracle and the
halt shield, and a rate model that can be re-parameterised by an owner is a lever an attacker can pull.

Accrual compounds with a three-term Taylor expansion of `e^(rt) - 1`, which errs downward, so the
protocol never over-charges.

The clock is halt-aware. While shielded, `lastAccrual` advances and nothing is added. A halt costs the
borrower nothing.

## Liquidation

```solidity
function liquidate(address borrower, uint256 repayAssets)
    external returns (uint256 seized, uint256 repaidShares);
```

A liquidator repays up to `CLOSE_FACTOR_BPS` of the debt and seizes collateral worth the repayment
grossed up by `currentBonusBps()`, which is the ramped value, not necessarily the configured maximum.

When the collateral cannot cover the discounted repayment, the position is closed out entirely and the
repayment is re-derived from what there actually was to take. Any remaining debt is **written down
against suppliers immediately**:

```solidity
badDebt = _toAssetsUp(remainingShares, totalBorrowAssets, totalBorrowShares);
totalBorrowShares -= _u128(remainingShares);
totalBorrowAssets = _u128(zeroFloorSub(totalBorrowAssets, badDebt));
totalSupplyAssets = _u128(zeroFloorSub(totalSupplyAssets, badDebt));
emit BadDebtSocialized(borrower, badDebt);
```

Realising it now is the honest choice. Leaving unrecoverable debt on the books as an asset inflates
every depositor's share price and pays early exits out of late ones.

Two properties are held by fuzz tests:

- `testFuzz_borrowNeverExceedsLltv`: any borrow that succeeds leaves the position inside the LLTV.
- `testFuzz_liquidationNeverWorsensThePosition`: liquidating never makes debt-to-collateral worse,
  which is what stops a liquidator from farming a position into insolvency one call at a time.

## Reading a market

```ts
import { SherwoodClient, PriceStatus, formatUsd } from "@sherwood/sdk";

const summary = await client.getPositionSummary(market, user);

if (summary.market.status !== PriceStatus.OK) {
  console.log("shielded:", summary.market.status);
} else if (summary.liquidatable) {
  console.log("liquidatable now");
} else {
  console.log("can still borrow", formatUsd(summary.maxBorrow * 100n));
  console.log("health", summary.healthFactor.toFixed(3), "(1.0 is the limit)");
}
```

`getPositionSummary` derives everything in one place so the numbers cannot disagree with each other.

## Events

| Event | When |
|---|---|
| `Supply`, `Withdraw` | Loan-side deposits and exits |
| `SupplyCollateral`, `WithdrawCollateral` | Collateral movement |
| `Borrow`, `Repay` | Debt movement |
| `Liquidate` | Includes the bonus actually applied, so a ramped liquidation is visible |
| `AccrueInterest` | Interest added and fee shares minted |
| `Shielded`, `Unshielded` | The halt shield engaging and lifting, with the reason and the grace end |
| `BadDebtSocialized` | A shortfall written down against suppliers |

`Borrow` and `SupplyCollateral` index `onBehalf`, which is how `apps/keeper` builds its borrower set:
there is no on-chain enumeration of positions, so logs are the only honest source.
