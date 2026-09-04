# Baskets

A `SherwoodBasket` is a fixed-weight, fully backed basket of tokenized equities that is itself an
ERC-20 and can be used as collateral.

**The reason to hold one is not diversified return. It is diversified halt risk.**

## The argument

Any single Robinhood stock token can be paused by its issuer, and while it is, nobody can liquidate a
loan backed by it at any price. That risk is why single-ticker markets have to be conservative: the
LLTV has to leave room for a position that cannot be closed for days.

Spread the same collateral across ten names and one halt no longer freezes the position. It removes
one name's weight. The improvement is a **mechanical property of the collateral** rather than an
assumption about correlation, which is why basket markets can run at a higher loan-to-value than any
of their constituents would justify alone.

## Pricing what you can see

There are three possible answers when a constituent goes dark, and two of them are wrong.

**Refusing to price the basket** is exactly backwards. It makes a ten-name basket ten times more
likely to freeze than a single ticker and destroys the entire reason to hold one.

**Carrying the halted name at its last price** is worse. That is the assumption that has broken every
lending protocol that ever trusted a stale feed through a gap.

**Carrying it at zero** is the only honest position, and it is what `SherwoodBasketOracle` does. The
basket is priced on what can be seen and sold right now, so the reported number is always a **floor**
on what the basket is really worth, and a borrower can never gain from a halt.

Separately, the oracle answers *how much* of the basket has gone dark. When that share crosses the
configured tolerance, too little of the collateral is observable to lend against and the basket
reports `BasketDegraded`, which puts the market into the same halt shield a single asset uses.

```
A three-name basket: 10 SPY, 34 NVDA, 28 AAPL

  all live         value = sum of all three            status OK
  SPY halts        value = NVDA + AAPL  (62/72)        status OK,  13.9% dark
  NVDA halts       value would be 38/72                status BasketDegraded, 47% dark
```

## Weights, and why `poke` exists

Costing a halt at its real weight requires knowing what that weight was **while the name was still
priceable**. So the oracle checkpoints the value split across constituents whenever all of them are
live, packed sixteen bits per constituent into a single storage word.

`poke(basket)` writes that checkpoint, and markets call it at the top of every state-changing entry
point, which keeps it as fresh as the protocol's own activity without anyone running a keeper for it.
`ISherwoodOracle.poke` is a no-op for single assets, whose inputs are all readable in a view.

`poke` **silently refuses to checkpoint while any constituent is dark**. A checkpoint taken during a
halt would record the halted name at zero weight and then declare that nothing is dark, which is the
one failure that would let a degraded basket keep borrowing.

## Exits have to survive a partial halt

A pro-rata redemption that transfers every constituent reverts if even one is frozen. That hands back
exactly the problem the basket exists to solve, at the worst possible moment: a liquidator holding
seized shares could not get out, so nobody would liquidate.

So `redeem` pays out every constituent it can move and books the rest as a claim on specific token
amounts, reserved inside the basket and no longer backing anyone else's shares:

```solidity
if (IStockToken(token).paused()) {
    claimable[to][token] += amount;
    reserved[token] += amount;
    emit Deferred(to, token, amount);
} else {
    token.safeTransfer(to, amount);
}
```

The shares are burned either way, nothing is double counted, and the redeemer collects the rest with
`claim(token)` once the issuer unpauses. A halt delays a payout instead of blocking a redemption.

`backing(token)` nets out reserved units, so a later redeemer cannot be paid out of someone else's
deferred claim. `test_reservedUnitsNoLongerBackOtherShares` holds that: two holders, one halt, and the
vault empties to exactly zero.

## What baskets deliberately do not do

- **They never trade.** Constituents and weights are fixed at construction. No rebalancing means
  nothing to sandwich, nothing to drain through a rebalance, and no oracle needed to mint or redeem.
- **They have no admin.** No owner, no upgrade, no fee.
- **Duplicates are rejected** at construction, because the same name occupying two weights would
  defeat the diversification argument silently.
- **At most sixteen constituents**, which is the number of 16-bit weights that pack into one storage
  word, and past a dozen names the marginal halt diversification is gone anyway.

## Creating one

```solidity
address[] memory tokens = new address[](3);
tokens[0] = SPY; tokens[1] = NVDA; tokens[2] = AAPL;

uint256[] memory weights = new uint256[](3);   // raw units per 1e18 basket shares
weights[0] = 0.1e18;
weights[1] = 0.34e18;
weights[2] = 0.28e18;

SherwoodBasket basket = new SherwoodBasket("Sherwood Mega Cap 3", "SW3", tokens, weights);
```

Weights are raw units, not percentages, so a roughly equal-dollar basket is built from the prices at
the time you create it. `previewMint(shares)` returns exactly what will be pulled.

Then register it and create a market against it:

```solidity
basketOracle.configureBasket(address(basket), BasketConfig({
    maxDarkBps: 2000,          // a fifth of the basket may go dark before lending suspends
    maxCheckpointAge: 1 days,
    enabled: true
}));

params.oracle = address(basketOracle);
params.lltv = 0.80e18;         // higher than any single ticker, which is the point
factory.createMarket(params);
```

## The claim, tested

`test_borrowAgainstBasketSurvivesOneHalt` is the end of the argument: borrow against a three-name
basket, halt SPY, and the market keeps running with a solvent position and an unshielded market. A
SPY-collateral market under the same halt is frozen solid.
