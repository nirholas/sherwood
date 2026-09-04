# @sherwood/keeper

Watches Sherwood markets and liquidates positions that cross their limit.

## What makes this one different

A liquidation bot written for ordinary collateral loses money here, for two reasons.

**A shielded market cannot be liquidated at any incentive.** When the collateral has no usable price,
`liquidate` reverts by design, and if the token is paused it would revert anyway because the seizure
transfer cannot settle. Scanning such a market for candidates is wasted effort; sending into it is
wasted gas.

**After a halt clears, the bonus ramps from zero.** For the length of the grace window a liquidation
is worth less than it looks, and at the first second it is worth nothing at all. A keeper that fires
the moment a position looks unhealthy pays gas to receive less collateral than it repaid.

This keeper reads both, computes what a liquidation is actually worth right now, and waits when the
answer is nothing:

```
0xMarket… shielded: the issuer has paused transfers (no liquidation is possible until this clears)
0xMarket… in grace, bonus ramped to 175bps of its full value until 2026-09-04T11:00:00Z
0xMarket… 0xBorrower… liquidatable but the bonus is only 175bps; waiting for the ramp
0xMarket… liquidated 0xBorrower…: repaid $12,750.00, seized $13,642.89 of collateral, profit $892.89
```

## Running

```bash
export SHERWOOD_FACTORY=0x...
export KEEPER_PRIVATE_KEY=0x...
export FROM_BLOCK=<the block the factory was deployed in>
export MIN_REPAY_USDG=1000000        # a dollar

pnpm start
```

Read-only, no key required:

```bash
SHERWOOD_FACTORY=0x... pnpm scan
```

| Variable | Default | Meaning |
|---|---|---|
| `SHERWOOD_FACTORY` | required | Factory to enumerate markets from |
| `KEEPER_PRIVATE_KEY` | none | Without it the keeper reports and never sends |
| `MARKETS` | all | Restrict to specific markets |
| `MIN_REPAY_USDG` | 1000000 | Smallest repayment worth a transaction |
| `FROM_BLOCK` | 0 | Where the borrower index starts |
| `INTERVAL_SECONDS` | 30 | Seconds between passes |
| `DRY_RUN` | false when a key is set | Report only |

**Set `FROM_BLOCK`.** There is no on-chain enumeration of positions, so the borrower set is built from
`Borrow` and `SupplyCollateral` logs. Without a starting block the index sweeps from genesis on every
restart, which wastes minutes against a rate-limited endpoint. After the first sweep the index is
incremental.

## Behaviour

- Markets are enumerated from the factory each pass, so a new one is picked up without a restart.
- A market whose price status is not `OK` is skipped before any position is read.
- Candidates are ranked by profit at the **current** bonus, not the configured maximum.
- Every liquidation is simulated first. With several keepers on one market the position is often gone
  by the time a transaction lands, and a blind send burns gas on a revert every time.
- The market is approved for USDG on first use.

The keeper needs USDG to repay with and ETH for gas. It keeps the collateral it seizes; selling it is
out of scope, deliberately, because the right venue and timing for that is a strategy decision rather
than infrastructure.

```bash
pnpm test    # 4 tests covering the economics: the ramp, the seizure cap, the threshold
```
