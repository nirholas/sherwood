# @sherwood/reporter

Fetches real US equity quotes, signs them, assembles a quorum, and posts them to `SherwoodOracle`.

The attested quote is **never the price Sherwood settles at**. It only bounds the on-chain TWAP, so a
bad print can take the feed offline and can never move a price. That is what makes a public data
source acceptable here, and it would not be if the number were used directly.

## Running

```bash
export SHERWOOD_ORACLE=0x...
export REPORTER_PRIVATE_KEYS=0x...              # only this host's key
export REPORTER_PEERS=https://b.example,https://c.example
export INTERVAL_SECONDS=60
export MIN_CHANGE_BPS=10
export MAX_SILENCE_SECONDS=900

pnpm start
```

| Variable | Default | Meaning |
|---|---|---|
| `SHERWOOD_ORACLE` | required | Oracle address |
| `REPORTER_PRIVATE_KEYS` | required | Comma separated; normally one |
| `REPORTER_PEERS` | none | Peer co-signing endpoints |
| `RHC_RPC_URL` | public list | Tried before the public endpoints |
| `INTERVAL_SECONDS` | 60 | Seconds between rounds |
| `MIN_CHANGE_BPS` | 10 | Movement that justifies a transaction |
| `MAX_SILENCE_SECONDS` | 900 | Post anyway after this long |
| `SYMBOLS` | every configured asset | Restrict coverage |
| `DRY_RUN` | false | Compute and log, send nothing |
| `PORT` | 8791 | Co-signing endpoint |

## Two tools worth running on their own

**Live quotes for every listed equity:**

```bash
$ pnpm quote

symbol   price        session   exchange   source observed
SPY          773.17   closed    NYSE Arca  cnbc   2026-09-04T07:03:33.000Z
NVDA         228.45   closed    NASDAQ     cnbc   2026-09-04T07:03:33.000Z
...
38 quoted, 0 failed
```

**How far each token sits from its underlying,** which is what calibrates the oracle's bands:

```bash
$ pnpm exec tsx src/verify.ts

US equity session: closed at 03:05 New York

symbol    on-chain     exchange     deviation   note
SGOV        100.43       100.43         0bps    inside the intraday band
SPY         774.08       773.17       +12bps    inside the intraday band
NVDA        229.94       228.45       +65bps    inside the intraday band
LULU        100.12       121.77     -1778bps    outside both bands

37 priced, median deviation 65bps, 90th percentile 163bps
```

Run this before setting a band on a new asset, and again when one keeps going offline.

## Where the data comes from

Two independent, keyless providers:

- **CNBC's quote service** is primary. It batches the whole registry into one request, which matters
  more than it sounds: the obvious alternative rate-limits at a handful of symbols, and a reporter
  that cannot finish a round lets every quote go stale, which takes every market offline.
- **Yahoo's chart endpoint** is the failover, per symbol, with host rotation and backoff.

## The session is computed, not fetched

The session decides which deviation band the oracle applies, which makes it a security-relevant input.
[`src/session.ts`](src/session.ts) derives it from the NYSE calendar rather than trusting a provider,
because the providers get it wrong: one reports `REG_MKT` at three in the morning.

It computes every full-day closure from the date, including Good Friday via the Gregorian computus and
the weekend-observance shifts on fixed-date holidays, and handles the 13:00 half days around
Thanksgiving, Christmas Eve and Independence Day. A hardcoded list would silently expire.

`Halted` is never inferred from missing data. An absent print during regular hours is far more often a
provider outage than a real halt, and a real halt reaches the protocol through the token's own
`paused()` flag, which is authoritative.

## Co-signing, and why it is the whole point

`POST /sign` lets peers request this reporter's signature on a report. It **refuses to sign a price it
cannot independently confirm** from its own feed inside 50 basis points:

```json
{
  "error": "price does not match this reporter's own feed",
  "proposed": "80000000000",
  "observed": "77317000000",
  "divergenceBps": "348"
}
```

Without that check a quorum of N reporters is worth exactly one: whoever assembles the round could put
any number in front of the others and collect rubber stamps.

`GET /health` returns the addresses this process signs with.

## Posting policy

A quote goes out when the price has moved past `MIN_CHANGE_BPS`, or when silence approaches the
oracle's own staleness limit. Posting every tick burns gas to say nothing; never posting lets the
quote go stale and takes every market offline.

Nonces come from the wall clock, because the exchange timestamp does not move outside trading hours
and the oracle requires strict monotonicity.

```bash
pnpm test    # 14 tests: the calendar, session boundaries, daylight saving, price parsing
```
