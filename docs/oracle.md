# The oracle

Sherwood's price feed answers one question: **what is a tokenized equity worth, right now, to someone
who has to sell it on this chain in the next few minutes?** Everything about its design follows from
taking that question literally.

## Why the obvious designs fail here

A tokenized share is not the share. `SPY` on Robinhood Chain trades continuously against USDG in
Uniswap pools; SPY on NYSE Arca trades from 09:30 to 16:00 New York on weekdays. Any lending protocol
must decide which price it believes.

**Believing the exchange alone** is what most tokenized-equity designs do, and it makes liquidations
insolvent. If the token trades 5% below the exchange print, a liquidator who repays $100 of debt and
seizes "$107" of collateral realises $101.65 when they sell, and the protocol has handed out a bonus
that does not exist. Over a weekend gap the gulf is much larger.

**Believing the pool alone** makes the protocol a function of a single Uniswap pool's depth. On this
chain that is between $500k and $8.5M per name, and a determined actor with a flash loan can move a
TWAP far enough, for long enough, to liquidate a book.

## What Sherwood does instead

**The pool TWAP is the settlement price. The attested exchange quote is a bound on it.**

```
                    ┌──────────────────────┐
   Uniswap v3 pool  │  30-minute TWAP      │──┐
   on this chain    └──────────────────────┘  │
                                              ├──▶  agree within the band?  ──▶ serve the TWAP
   Reporter quorum  ┌──────────────────────┐  │            no ──▶ serve nothing
   (EIP-712)        │  exchange print      │──┘
                    └──────────────────────┘
```

The consequences are worth stating plainly:

- **A compromised reporter cannot move the price.** It can only push the attestation outside the band
  and take the feed offline. Offline means no borrowing and no liquidation, which is safe.
- **A manipulated pool cannot move the price either.** Moving the TWAP walks it away from the
  attestation, with the same result.
- **Both sources must be wrong in the same direction, by the same amount, at the same time.** That
  requires compromising a reporter quorum *and* moving a pool, in concert.

This is the opposite of the usual arrangement, where a trusted signer publishes and the chain
believes. Here the trustless source decides and the trusted one can only ever refuse to confirm.

## The bands, and where they come from

`maxDeviationBps` applies while the US equity session is open. `offHoursDeviationBps` applies the rest
of the time, because a token that trades all night legitimately reprices ahead of an open that has not
happened yet. Punishing that would take the feed down every evening.

The defaults are 200bps and 500bps. They are set from measurement, not intuition. Run it yourself:

```
$ pnpm --filter @sherwood/reporter exec tsx src/verify.ts

US equity session: closed at 03:05 New York

symbol    on-chain     exchange     deviation   note
SGOV        100.43       100.43         0bps    inside the intraday band
TTWO        213.95       214.13        -8bps    inside the intraday band
SPY         774.08       773.17       +12bps    inside the intraday band
AAPL        327.72       328.21       -15bps    inside the intraday band
NVDA        229.94       228.45       +65bps    inside the intraday band
TSLA        369.71       376.37      -177bps    inside the intraday band
GME          19.67        19.23      +228bps    inside the off-hours band
LULU        100.12       121.77     -1778bps    outside both bands

37 priced, median deviation 65bps, 90th percentile 163bps, worst 1778bps
```

36 of 38 sit inside the intraday band. GME needs the off-hours band. **LULU is genuinely dislocated**
by 18%, and the correct response is that no market can price it, which is what happens.

Set a band from this table when listing an asset. A name that keeps going offline is telling you its
pool is too thin to liquidate into, which is a reason not to lend against it rather than a reason to
widen the band.

## The session

The band depends on whether the US equity market is open, which makes the session a security-relevant
input. It is **computed locally** in [`apps/reporter/src/session.ts`](../apps/reporter/src/session.ts)
from the NYSE calendar, not taken from a quote provider: one of the providers reports `REG_MKT` at
three in the morning.

The calendar derives every full-day closure from the date, including Good Friday via the Gregorian
computus and the weekend-observance shifts on fixed-date holidays, and handles the 13:00 half days
around Thanksgiving, Christmas Eve and Independence Day. A hardcoded list would silently expire.

`Halted` is deliberately never inferred from missing data. An absent print during regular hours is far
more often a provider outage than a real halt, and calling it a halt would take the feed down. A real
halt reaches the protocol through the token's own `paused()` flag, which is authoritative.

## Corporate actions

Every Robinhood stock token exposes a `uiMultiplier`: economic shares per 1e18 raw units. A split,
reverse split or distribution moves it, and `updateMultiplier(next, effectiveAt)` **schedules it in
the future**, publishing both the new value and the second it takes over.

Nothing else in DeFi gets that warning, and it is used twice.

**Before it lands.** A scheduled fall in the multiplier means each raw token is about to be worth less.
It is applied to collateral the moment it is announced:

```solidity
if (effAt > block.timestamp && pending != 0 && pending < multiplier) {
    twapX26 = FixedPointMathLib.fullMulDiv(twapX26, pending, multiplier);
}
```

Nobody borrows against value already booked to disappear. A scheduled *rise* is not credited early,
because an unrealised gain is not collateral.

**Just after it lands.** For one TWAP window the average straddles the jump and is a blend of two
incompatible prices, wrong by up to the split ratio. The feed reports `MultiplierTransition` and
serves nothing until the window has rolled past the event.

The condition deliberately does **not** compare the live and pending multipliers:

```solidity
if (effAt != 0 && block.timestamp >= effAt && block.timestamp < effAt + cfg.twapWindow) {
    return (0, PriceStatus.MultiplierTransition);
}
```

Once `effectiveAt` passes, `uiMultiplier()` already returns the new value and the two are equal, so a
check for "they differ" is false during precisely the window it is meant to cover. This was caught by
[`test_twapBlackoutAcrossTheSplitItself`](../contracts/test/SherwoodOracle.t.sol).

## Statuses

`peek(asset)` never reverts. It returns a price and a reason, so a risk engine can branch on why.

| Status | Meaning | Effect on a market |
|---|---|---|
| `OK` | Both sources agree, nothing is halted | Normal operation |
| `NoConfig` | The asset has not been configured | Shielded |
| `NoQuote` | No reporter has attested yet | Shielded |
| `QuoteStale` | The attestation aged past `maxQuoteAge` | Shielded |
| `TokenPaused` | The issuer paused transfers | Shielded; seizure is impossible anyway |
| `IssuerOraclePaused` | The issuer disavowed the price | Shielded |
| `TwapUnavailable` | The pool lacks history for the window | Shielded |
| `TwapDeviation` | The two sources disagree beyond the band | Shielded |
| `MultiplierTransition` | A corporate action is inside the window | Shielded |
| `BasketDegraded` | Too much of a basket has no price | Shielded |

Only `OK` permits borrowing or liquidation. Everything else engages the halt shield described in
[docs/halts.md](halts.md).

## Reporters

A quote is a signed EIP-712 `PriceReport` carrying the asset, a price in USD per whole share at 1e8,
the exchange timestamp, the session, and a strictly increasing nonce. `postQuote` accepts it with at
least `quorum` signatures from distinct authorised reporters.

Signatures must be **ordered by ascending recovered address**. That makes duplicate-signer detection
one comparison per signature instead of a nested loop, so a large reporter set stays cheap, and it
makes the ordering a caller's responsibility rather than a gas cost every poster pays forever.

The reporter set is supplied at construction rather than added afterwards. An oracle that exists for
even one block with a quorum larger than its reporter set cannot be reached, and the only way out
would be an owner call, which is exactly the moment an owner key is most worth attacking.

**A quorum only means something if the reporters check each other.** `apps/reporter`'s co-signing
endpoint refuses to sign a report whose price it cannot independently confirm from its own feed inside
50 basis points. Without that check, N reporters are worth exactly one: whoever assembles the round
could put any number in front of the others and collect rubber stamps.

## Tick arithmetic

The TWAP is converted from the pool's mean tick with `exp(tick * ln(1.0001))` using solady's `expWad`,
rather than by vendoring Uniswap's tick tables, which are GPL-2.0 and would relicense this repository.

The mean tick is rounded toward negative infinity to match Uniswap's convention, and bounded to the
real tick range before truncation to `int24`. A pool returning cumulatives outside that range is
malfunctioning or hostile, and truncating would wrap it into a plausible-looking price.

Two independent derivations are checked against each other on the live chain in
[`test_twapAgreesWithSpotSqrtPrice`](../contracts/test/Fork.t.sol): the exponential of the mean tick,
and `slot0.sqrtPriceX96` squared. They agree, which is what confirms the decimal handling and the pool
orientation are both right.

## Trust

What the oracle owner **can** do: configure assets, set deviation bands and TWAP windows, rotate
reporters, and change the quorum. Choosing a shallow pool or an absurdly wide band for an asset is the
real risk, and it is visible on chain in `config(asset)`.

What the owner **cannot** do: set a price, bypass the deviation band, serve a price for a paused
token, change a market's terms, or touch anyone's position. Markets read the oracle; the oracle never
reads a market.

Reporters can take the feed offline by attesting nonsense. They cannot move the price.

## Reference

Configuring an asset reads the pool for orientation and decimals rather than accepting them, because
getting either wrong produces a price wrong by twelve orders of magnitude:

```bash
ORACLE=0x... ASSET=0x117cc2133c37B721F49dE2A7a74833232B3B4C0C \
POOL=0xa7Bb1AC63BBaB0C44316E6c8C455213441689167 \
QUOTE=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 \
forge script script/ConfigureAsset.s.sol:ConfigureAsset --root contracts \
  --rpc-url $RHC_RPC_URL --broadcast
```

Reading it:

```ts
import { SherwoodClient, PriceStatus } from "@sherwood/sdk";

const view = await client.getOracleView("0x117cc2133c37B721F49dE2A7a74833232B3B4C0C");
if (view.status !== PriceStatus.OK) {
  console.log("no usable price:", view.status);
} else {
  console.log("USD per share:", Number(view.rawX26) / 1e8);
}
```

Units: `priceRawX26` is **USDG per raw token unit, scaled by 1e26**. `valueOf(asset, rawAmount)`
returns dollars at 1e8 and is decimals-independent, which is the function every risk calculation
should use.
