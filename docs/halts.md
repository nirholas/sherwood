# Halts

This is the part of Sherwood that does not exist in any lending protocol built for assets that never
stop trading, and it is the reason a naive fork of one would be insolvent on this chain.

## The mechanism

Every tokenized equity on Robinhood Chain is a beacon proxy onto one shared `Stock` implementation at
[`0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2`](https://robinhoodchain.blockscout.com/address/0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2).
Its pause is not decorative:

```solidity
function paused() public view returns (bool) {
    return $.paused || IAccessControlsRegistry(ACCESS_CONTROLLED_REGISTRY).paused();
}

function transfer(address to, uint256 value)
    public override onlyNotPaused onlyNotBlocked(to) onlyNotBlocked(_msgSender())
    returns (bool) { ... }
```

`transfer`, `transferFrom`, `approve`, `permit`, `mint` and `burn` all carry `onlyNotPaused`. While a
token is paused, **collateral cannot be seized**. A liquidation is not merely unattractive; the
transaction cannot succeed at any incentive.

There are two levels. `tokenPaused()` is that one token. The registry's own `paused()` halts **every
tokenized equity on the chain at once**, which is a single switch across all 254 names.

Separately, `oraclePaused()` lets the issuer disavow a token's price without freezing transfers.
Sherwood takes that at its word: nothing is liquidated against a price the issuer will not stand
behind.

## What goes wrong without a shield

Follow a two-day halt through a protocol that ignores it.

1. The issuer pauses the token. Nobody can transfer it.
2. Interest keeps compounding. Borrowers are charged for two days during which they could not have
   repaid or topped up even if they had wanted to.
3. Nobody can liquidate, so nothing clears and no risk is reduced.
4. The token unpauses. The equity reopened somewhere else, and the pool immediately reprices to it.
5. Every position that drifted past its limit is now underwater **simultaneously**, at a gapped price,
   with two days of interest on top.
6. Whoever is watching most closely liquidates the entire book in the first block, at the full bonus.

Every step is a direct consequence of treating a halt as if it were an ordinary market. The borrowers
did nothing wrong and had no available action.

## What Sherwood does

`accrueInterest()` runs at the top of every state-changing entry point and drives a small state
machine:

```solidity
(, PriceStatus status) = ORACLE.peek(COLLATERAL);
bool halted = status != PriceStatus.OK;

if (halted) {
    if (!shielded) { shielded = true; graceUntil = 0; emit Shielded(status); }
    lastAccrual = uint64(block.timestamp);   // the clock advances, nothing is charged
    return;
}

if (shielded) {
    shielded = false;
    graceUntil = uint64(block.timestamp + GRACE_WINDOW);
    lastAccrual = uint64(block.timestamp);
    emit Unshielded(graceUntil);
    return;
}
```

While shielded:

| Action | Allowed | Why |
|---|---|---|
| `supply` | yes | Adds liquidity, reduces risk |
| `withdraw` (supplied USDG) | yes | A depositor's claim does not depend on the collateral price. Freezing it converts an issuer's halt into a run on people who are owed money |
| `supplyCollateral` | yes | Reduces risk, and the token would reject the transfer anyway |
| `repay` | yes | Only ever reduces risk. A borrower locked out of curing their own position is the failure this design exists to avoid |
| `borrow` | **no** | Solvency cannot be evaluated without a price |
| `withdrawCollateral` | **no** | Same |
| `liquidate` | **no** | Impossible by construction as well as by policy |

And **no interest accrues at all**. Proven on a fork of the real chain:

```
[9] Halting the token the way its issuer would, and checking the shield
  ✓ three days halted and the debt did not move by one unit
  ✓ borrowing and liquidation are both refused
  ✓ repayment still works, which is the point
```

## The grace ramp

Lifting the shield does not simply resume normal service. Doing so would hand the whole book to
whoever was fastest, at a price nobody had a chance to react to.

Instead a grace window opens in which the liquidation bonus ramps linearly from zero:

```solidity
function currentBonusBps() public view returns (uint256) {
    uint64 until = graceUntil;
    if (until == 0 || block.timestamp >= until) return LIQ_BONUS_BPS;
    uint256 remaining = until - block.timestamp;
    return LIQ_BONUS_BPS.mulDiv(GRACE_WINDOW - remaining, GRACE_WINDOW);
}
```

At the instant the halt clears the bonus is zero, so a liquidation is worth nothing and, after
rounding, is strictly unprofitable. Nobody does it. A borrower who was frozen out has real time to
repay or add collateral at the new price. By the end of the window the full incentive is back and the
market clears normally.

On a four-hour window, verified on a fork:

```
[10] Unhalting, and watching the liquidation bonus ramp from zero
  bonus at the moment of reopening: 0bps
  one hour into a four hour window: 175bps
  ✓ zero, then a quarter, then whole: the ramp behaves exactly as specified
```

**The trade being made is explicit**: the protocol gives up some liquidation speed in exchange for not
confiscating positions over an event the borrower could not respond to. A market that wants the
opposite can be deployed with a short window; it will have a different address, so nobody is moved
into it silently.

## What a keeper must do about it

A liquidation bot written for ordinary collateral loses money here. `apps/keeper` reads the ramp,
computes what a liquidation is actually worth at the current bonus, and waits when the answer is
nothing:

```
0xMarket… shielded: the issuer has paused transfers (no liquidation is possible until this clears)
0xMarket… in grace, bonus ramped to 175bps of its full value until 2026-09-04T11:00:00Z
0xMarket… 0xBorrower… liquidatable but the bonus is only 175bps; waiting for the ramp
```

It also simulates before sending. With several keepers watching one market the position is often gone
by the time a transaction lands, and a blind send burns gas on a revert every time.

## Halts that are not the issuer's doing

The shield engages on **any** unusable price, not only a pause. A stale attestation, a pool without
enough history, a deviation past the band, or a corporate action inside the averaging window all
produce the same protective behaviour. The distinction matters to a person, so the API and the app
report the reason and what it means:

```
The issuer has paused this token. Transfers revert, so collateral cannot be seized and nobody can
be liquidated. Interest has stopped.

The on-chain price and the exchange price have moved apart by more than this asset's band. One of
the two is wrong and the feed will not guess which.
```

## Diversifying it away

One halted name freezing a whole position is exactly what baskets fix, and the improvement is
mechanical rather than an assumption about correlation. See [docs/baskets.md](baskets.md).
