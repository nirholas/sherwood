# Deploying and operating Sherwood

Everything here has been run against a fork of Robinhood Chain. Nothing is aspirational.

## Prerequisites

```bash
pnpm install
forge build --root contracts
forge test --root contracts       # 61 pass
pnpm -r test                      # 54 pass
```

You need a funded deployer on Robinhood Chain. Gas is ETH, and the amounts are small: the whole
deployment below costs well under 0.02 ETH.

```bash
export RHC_RPC_URL=https://rpc.mainnet.chain.robinhood.com
export DEPLOYER_KEY=0x...
```

## 1. Reporter keys

At least two, on separate machines. They are the quorum, and a quorum that shares a machine is one
reporter wearing two hats.

```bash
cast wallet new     # repeat per reporter; keep the private keys on their own hosts
```

## 2. Deploy the shared pieces

```bash
OWNER=0x...                                       \
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168   \
REPORTERS=0xRep1,0xRep2,0xRep3                    \
QUORUM=2                                          \
forge script script/Deploy.s.sol:Deploy --root contracts \
  --rpc-url $RHC_RPC_URL --private-key $DEPLOYER_KEY --broadcast
```

This deploys `SherwoodOracle`, one `KinkedIrm` (2% base, +10% to a 90% kink, +150% above it) and
`SherwoodFactory`. Record all three addresses.

The reporter set is fixed at construction because an oracle that exists for even one block with an
unreachable quorum can only be rescued by an owner call, which is exactly the moment an owner key is
most worth attacking.

## 3. Choose which equities to list

Regenerate the registry from the chain, then look at the basis before deciding:

```bash
node scripts/discover-pools.mjs --min-liquidity 250000
pnpm --filter @sherwood/reporter exec tsx src/verify.ts
```

A name qualifies when:

- its USDG pool holds enough observations for the TWAP window you intend (the registry records
  `observationCardinality`; 1800 seconds needs a few hundred);
- the pool is deep enough that a liquidator can actually exit into it;
- its measured deviation sits comfortably inside the band you plan to set.

The last one is a real filter. LULU currently prints an 18% gap between the token and the share. It
should not be listed, and if it were, the oracle would refuse to price it.

## 4. Configure each asset

Orientation and decimals are read from the pool rather than passed in, because getting either wrong
produces a price wrong by twelve orders of magnitude, and a deploy script is where that mistake gets
made.

```bash
ORACLE=0x...                                          \
ASSET=0x117cc2133c37B721F49dE2A7a74833232B3B4C0C      \
POOL=0xa7Bb1AC63BBaB0C44316E6c8C455213441689167       \
QUOTE=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168      \
TWAP_WINDOW=1800 MAX_DEV_BPS=200 OFF_HOURS_DEV_BPS=500 MAX_QUOTE_AGE=3600 \
forge script script/ConfigureAsset.s.sol:ConfigureAsset --root contracts \
  --rpc-url $RHC_RPC_URL --private-key $DEPLOYER_KEY --broadcast
```

The script prints the implied share price after configuring. Check it against the real quote before
moving on; that one line catches every decimal and orientation mistake.

## 5. Start the reporters

On each reporter host:

```bash
export SHERWOOD_ORACLE=0x...
export REPORTER_PRIVATE_KEYS=0x...          # only this host's key
export REPORTER_PEERS=https://reporter-b.example,https://reporter-c.example
export INTERVAL_SECONDS=60
export MIN_CHANGE_BPS=10
export MAX_SILENCE_SECONDS=900

pnpm --filter @sherwood/reporter start
```

Each reporter serves `POST /sign` for its peers and refuses to sign a report whose price it cannot
confirm from its own feed inside 50 basis points. **Without that check a quorum of N reporters is
worth exactly one**, because whoever assembles the round could put any number in front of the others
and collect rubber stamps.

Posting is throttled by movement, not by the clock: a quote goes out when the price has moved past
`MIN_CHANGE_BPS` or when silence approaches the oracle's own staleness limit. Posting every tick burns
gas to say nothing; never posting takes every market offline.

Verify before going further:

```bash
curl -s localhost:8791/health
DRY_RUN=1 pnpm --filter @sherwood/reporter start   # computes and logs, sends nothing
```

## 6. Create markets

A market's address is the hash of its terms, so the address is a commitment anyone can check offline.

```bash
FACTORY=0x...                                          \
COLLATERAL=0x117cc2133c37B721F49dE2A7a74833232B3B4C0C  \
LOAN_TOKEN=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168  \
ORACLE=0x... IRM=0x...                                 \
LLTV=700000000000000000                                \
LIQ_BONUS_BPS=700 CLOSE_FACTOR_BPS=5000 GRACE_WINDOW=14400 \
forge script script/CreateMarket.s.sol:CreateMarket --root contracts \
  --rpc-url $RHC_RPC_URL --private-key $DEPLOYER_KEY --broadcast
```

Choosing terms:

| Parameter | Guidance |
|---|---|
| `LLTV` | Start at 0.70 for a single ticker. `LLTV * (1 + bonus)` must not exceed 1, or every liquidation creates bad debt, and the constructor refuses it |
| `LIQ_BONUS_BPS` | 700 is enough to pay for gas and slippage into these pools. Higher takes more from borrowers for the same service |
| `CLOSE_FACTOR_BPS` | 5000. A full close on the first liquidation is punitive when a partial one restores solvency |
| `GRACE_WINDOW` | 4 hours. Long enough that someone who was frozen out can act, short enough that risk does not sit unmanaged |

## 7. Run keepers

```bash
export SHERWOOD_FACTORY=0x...
export KEEPER_PRIVATE_KEY=0x...
export MIN_REPAY_USDG=1000000        # a dollar
export FROM_BLOCK=<the block the factory was deployed in>

pnpm --filter @sherwood/keeper start
```

`FROM_BLOCK` matters. Without it the borrower index sweeps from genesis, which wastes minutes on every
restart against a rate-limited endpoint.

Read-only first:

```bash
SHERWOOD_FACTORY=0x... pnpm --filter @sherwood/keeper scan
```

The keeper needs USDG to repay with, and approves the market on first use.

## 8. Run the API and the app

```bash
export SHERWOOD_FACTORY=0x...
export SHERWOOD_ORACLE=0x...
export PORT=8790
pnpm --filter @sherwood/api start
```

The API serves `apps/web` directly, so this one process is the whole front end. There is no build
step: the app is plain modules.

Behind a reverse proxy, serve `/api/*` from this process and let it serve everything else.

---

## Operating notes

### Public endpoints rate-limit

Every public Robinhood Chain RPC returns 429 under bursts. The SDK ships a rotation list and every
service uses viem's `fallback` transport across it. Set `RHC_RPC_URL` to a dedicated endpoint if you
have one; it is tried first.

`multicall3` is deployed at the canonical address and is declared in the SDK's chain definition.
Without that declaration viem refuses to batch and every read becomes its own request, which is enough
on its own to get rate-limited.

### What to watch

| Symptom | Cause | Action |
|---|---|---|
| A market is shielded with `QuoteStale` | Reporters are down or cannot reach the chain | Check reporter logs; this is the most common outage |
| Shielded with `TwapDeviation` | The token and the share have genuinely come apart | Usually correct. If it persists for a name, the pool is too thin to lend against |
| Shielded with `TokenPaused` | The issuer paused it | Nothing to do. Interest has stopped and nobody can be liquidated |
| Shielded with `MultiplierTransition` | A corporate action is inside the averaging window | Clears itself one TWAP window after the effective time |
| Keeper reports positions it will not act on | The grace ramp has not paid enough yet | Correct behaviour. It acts once the bonus covers the gas |

### Rotating a reporter

```bash
cast send $ORACLE "setReporter(address,bool)" $NEW true  --rpc-url $RHC_RPC_URL --private-key $OWNER_KEY
cast send $ORACLE "setReporter(address,bool)" $OLD false --rpc-url $RHC_RPC_URL --private-key $OWNER_KEY
```

Add before removing. Removal is refused if it would strand the quorum above the set that can meet it.

### Delisting

```bash
cast send $ORACLE "removeAsset(address)" $ASSET --rpc-url $RHC_RPC_URL --private-key $OWNER_KEY
```

Every market on that collateral shields permanently: no new borrowing, no liquidation, interest
stopped, repayment and withdrawal open. Existing borrowers can unwind at their own pace. **Delisting
cannot seize anyone's collateral or change anyone's terms**, which is the intended limit on the
owner's power. Do it only when an asset is genuinely unsafe to price, because it also disables
liquidation for as long as it lasts.

### Upgrading

There is no upgrade. Deploy new contracts, list assets on the new oracle, create new markets, and let
positions migrate. Old markets keep working exactly as they did on the day they were deployed, which
is the guarantee that makes immutable terms worth having.
