// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {SherwoodBasket} from "../src/SherwoodBasket.sol";
import {SherwoodBasketOracle} from "../src/SherwoodBasketOracle.sol";
import {SherwoodOracle} from "../src/SherwoodOracle.sol";
import {SherwoodMarket} from "../src/SherwoodMarket.sol";
import {PriceStatus, Session} from "../src/interfaces/ISherwoodOracle.sol";
import {MockStock} from "./mocks/MockStock.sol";
import {MockV3Pool} from "./mocks/MockV3Pool.sol";

contract SherwoodBasketTest is Base {
    SherwoodBasket internal basket;
    SherwoodBasketOracle internal basketOracle;

    MockStock internal nvda;
    MockStock internal aapl;
    MockV3Pool internal nvdaPool;
    MockV3Pool internal aaplPool;

    uint256 internal constant USDG = 1e6;

    function setUp() public {
        setUpBase();
        vm.warp(1_800_000_000);

        nvda = new MockStock("NVIDIA - Robinhood Token", "NVDA", 18);
        aapl = new MockStock("Apple - Robinhood Token", "AAPL", 18);
        nvdaPool = _pairPool(nvda);
        aaplPool = _pairPool(aapl);

        vm.startPrank(owner);
        _configure(address(nvda), nvdaPool);
        _configure(address(aapl), aaplPool);
        vm.stopPrank();

        address[] memory tokens = new address[](3);
        tokens[0] = address(spy);
        tokens[1] = address(nvda);
        tokens[2] = address(aapl);
        uint256[] memory ws = new uint256[](3);
        // Roughly equal dollar weights at the prices these three actually traded at.
        ws[0] = 0.1e18;
        ws[1] = 0.34e18;
        ws[2] = 0.28e18;
        basket = new SherwoodBasket("Sherwood Mega Cap 3", "SW3", tokens, ws);

        basketOracle = new SherwoodBasketOracle(owner, address(oracle));
        vm.prank(owner);
        basketOracle.configureBasket(
            address(basket),
            SherwoodBasketOracle.BasketConfig({maxDarkBps: 2000, maxCheckpointAge: 1 days, enabled: true})
        );

        _refreshAll();
    }

    function _pairPool(MockStock tok) internal returns (MockV3Pool) {
        bool isToken0 = address(tok) < address(usdg);
        return isToken0
            ? new MockV3Pool(address(tok), address(usdg), SPY_TICK)
            : new MockV3Pool(address(usdg), address(tok), -SPY_TICK);
    }

    function _configure(address tok, MockV3Pool p) internal {
        oracle.configureAsset(
            tok,
            SherwoodOracle.AssetConfig({
                pool: address(p),
                assetIsToken0: tok < address(usdg),
                quoteToken: address(usdg),
                quoteDecimals: 6,
                assetDecimals: 18,
                twapWindow: 1800,
                maxDeviationBps: 200,
                offHoursDeviationBps: 500,
                maxQuoteAge: 3600,
                enabled: true
            })
        );
    }

    function _refreshAll() internal {
        postQuote(address(spy), poolSharePrice1e8(address(spy)), Session.Regular);
        postQuote(address(nvda), poolSharePrice1e8(address(nvda)), Session.Regular);
        postQuote(address(aapl), poolSharePrice1e8(address(aapl)), Session.Regular);
    }

    function _mintBasket(address to, uint256 shares) internal {
        uint256[] memory amounts = basket.previewMint(shares);
        spy.mint(address(this), amounts[0]);
        nvda.mint(address(this), amounts[1]);
        aapl.mint(address(this), amounts[2]);
        spy.approve(address(basket), type(uint256).max);
        nvda.approve(address(basket), type(uint256).max);
        aapl.approve(address(basket), type(uint256).max);
        basket.mint(shares, to);
    }

    // ------------------------------------------------------------- mechanics

    function test_mintPullsExactWeights() public {
        _mintBasket(alice, 100e18);
        assertEq(basket.balanceOf(alice), 100e18);
        assertEq(spy.balanceOf(address(basket)), 10e18);
        assertEq(nvda.balanceOf(address(basket)), 34e18);
        assertEq(aapl.balanceOf(address(basket)), 28e18);
    }

    function test_redeemReturnsProRata() public {
        _mintBasket(alice, 100e18);
        vm.prank(alice);
        basket.redeem(40e18, alice);
        assertEq(basket.balanceOf(alice), 60e18);
        assertEq(spy.balanceOf(alice), 4e18);
        assertEq(nvda.balanceOf(alice), 13.6e18);
        assertEq(aapl.balanceOf(alice), 11.2e18);
    }

    function test_rejectsDuplicateConstituents() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(spy);
        tokens[1] = address(spy);
        uint256[] memory ws = new uint256[](2);
        ws[0] = 1e18;
        ws[1] = 1e18;
        vm.expectRevert(SherwoodBasket.BadBasket.selector);
        new SherwoodBasket("dupe", "DUPE", tokens, ws);
    }

    /// @notice The exit that makes baskets viable. One halted name defers its own slice and pays out
    ///         everything else, instead of reverting the whole redemption.
    function test_redemptionSurvivesAHaltedConstituent() public {
        _mintBasket(alice, 100e18);
        nvda.pause();

        vm.prank(alice);
        basket.redeem(50e18, alice);

        assertEq(spy.balanceOf(alice), 5e18, "live names pay out immediately");
        assertEq(aapl.balanceOf(alice), 14e18);
        assertEq(nvda.balanceOf(alice), 0, "the halted name is owed, not paid");
        assertEq(basket.claimable(alice, address(nvda)), 17e18);
        assertEq(basket.reserved(address(nvda)), 17e18);
        assertEq(basket.balanceOf(alice), 50e18, "shares burn either way");

        nvda.unpause();
        vm.prank(alice);
        basket.claim(address(nvda));
        assertEq(nvda.balanceOf(alice), 17e18);
        assertEq(basket.reserved(address(nvda)), 0);
    }

    /// @notice Reserved units stop backing live shares the instant they are promised, so a later
    ///         redeemer cannot be paid out of someone else's deferred claim.
    function test_reservedUnitsNoLongerBackOtherShares() public {
        _mintBasket(alice, 100e18);
        _mintBasket(bob, 100e18);
        nvda.pause();
        vm.prank(alice);
        basket.redeem(100e18, alice);
        nvda.unpause();

        // 68 NVDA in the vault, 34 of them reserved for alice, 100 of 100 shares left outstanding.
        assertEq(basket.backing(address(nvda)), 34e18);
        vm.prank(bob);
        basket.redeem(100e18, bob);
        assertEq(nvda.balanceOf(bob), 34e18);
        vm.prank(alice);
        basket.claim(address(nvda));
        assertEq(nvda.balanceOf(alice), 34e18);
        assertEq(nvda.balanceOf(address(basket)), 0, "the vault empties exactly");
    }

    // --------------------------------------------------------------- pricing

    function test_basketPricesAsTheSumOfItsParts() public {
        _mintBasket(alice, 100e18);
        basketOracle.poke(address(basket));
        (uint256 rawX26, PriceStatus s) = basketOracle.peek(address(basket));
        assertEq(uint8(s), uint8(PriceStatus.OK));

        uint256 expected = oracle.valueOf(address(spy), 10e18) + oracle.valueOf(address(nvda), 34e18)
            + oracle.valueOf(address(aapl), 28e18);
        assertApproxEqRel(rawX26 * 100e18 / 1e18, expected, 0.0001e18);
    }

    function test_priceUnavailableBeforeAnyCheckpoint() public {
        _mintBasket(alice, 100e18);
        (, PriceStatus s) = basketOracle.peek(address(basket));
        assertEq(uint8(s), uint8(PriceStatus.NoQuote));
    }

    /// @notice A halted name inside tolerance is carried at zero, not at its last price. The basket
    ///         keeps working and the reported value is a floor on the truth.
    function test_smallHaltIsHaircutNotFrozen() public {
        _mintBasket(alice, 100e18);
        basketOracle.poke(address(basket));
        (uint256 before,) = basketOracle.peek(address(basket));

        spy.pause(); // roughly a sixth of the basket by value
        (uint256 during, PriceStatus s) = basketOracle.peek(address(basket));
        assertEq(uint8(s), uint8(PriceStatus.OK), "one halted name must not freeze the basket");
        assertLt(during, before, "and it is carried at zero, never at a stale price");
        // SPY is 10 of the basket's 72 units at a common price, so 62/72 of the value stays visible.
        assertApproxEqRel(during, before * 62 / 72, 0.001e18);
    }

    /// @notice Past the tolerance too little is observable to lend against, and the market shields.
    function test_largeHaltDegradesTheBasket() public {
        _mintBasket(alice, 100e18);
        basketOracle.poke(address(basket));
        nvda.pause(); // the largest weight, over the 20% tolerance
        (, PriceStatus s) = basketOracle.peek(address(basket));
        assertEq(uint8(s), uint8(PriceStatus.BasketDegraded));
    }

    /// @notice A checkpoint taken mid-halt would record the dark name at zero weight and then claim
    ///         nothing is dark. `poke` has to refuse.
    function test_pokeRefusesToCheckpointDuringAHalt() public {
        _mintBasket(alice, 100e18);
        basketOracle.poke(address(basket));
        uint256 at = basketOracle.checkpoint(address(basket)).at;

        vm.warp(block.timestamp + 100);
        nvda.pause();
        basketOracle.poke(address(basket));
        assertEq(basketOracle.checkpoint(address(basket)).at, at, "no checkpoint while a name is dark");
    }

    function test_checkpointGoesStale() public {
        _mintBasket(alice, 100e18);
        basketOracle.poke(address(basket));
        vm.warp(block.timestamp + 2 days);
        _refreshAll();
        (, PriceStatus s) = basketOracle.peek(address(basket));
        assertEq(uint8(s), uint8(PriceStatus.QuoteStale));
    }

    function test_sessionIsTheLeastOpenConstituent() public {
        postQuote(address(spy), poolSharePrice1e8(address(spy)), Session.Regular);
        postQuote(address(nvda), poolSharePrice1e8(address(nvda)), Session.Closed);
        postQuote(address(aapl), poolSharePrice1e8(address(aapl)), Session.Regular);
        assertEq(uint8(basketOracle.sessionOf(address(basket))), uint8(Session.Closed));
    }

    // ---------------------------------------------------- basket as collateral

    /// @notice The end-to-end claim: borrow against a basket, have one constituent halt, and keep a
    ///         working market. The same halt against that name alone would have shielded the market.
    function test_borrowAgainstBasketSurvivesOneHalt() public {
        _mintBasket(bob, 100e18);

        SherwoodMarket.ConstructorParams memory p = defaultParams(address(basket));
        p.oracle = address(basketOracle);
        p.lltv = 0.80e18; // higher than any single ticker, which is the point of the basket
        SherwoodMarket basketMarket = SherwoodMarket(factory.createMarket(p));

        usdg.mint(alice, 1_000_000 * USDG);
        vm.startPrank(alice);
        usdg.approve(address(basketMarket), type(uint256).max);
        basketMarket.supply(500_000 * USDG, alice);
        vm.stopPrank();

        vm.startPrank(bob);
        basket.approve(address(basketMarket), type(uint256).max);
        usdg.approve(address(basketMarket), type(uint256).max);
        basketMarket.supplyCollateral(100e18, bob);
        basketMarket.borrow(10_000 * USDG, bob);
        vm.stopPrank();
        assertEq(usdg.balanceOf(bob), 10_000 * USDG);

        // SPY halts. A SPY-collateral market would be frozen solid; this one keeps running.
        spy.pause();
        (,, bool solvent, PriceStatus s) = basketMarket.healthOf(bob);
        assertEq(uint8(s), uint8(PriceStatus.OK), "the basket absorbs one halt");
        assertTrue(solvent);
        assertFalse(basketMarket.shielded());

        vm.prank(bob);
        basketMarket.repay(1000 * USDG, 0, bob);
    }
}
