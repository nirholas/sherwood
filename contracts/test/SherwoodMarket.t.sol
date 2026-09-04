// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {SherwoodMarket} from "../src/SherwoodMarket.sol";
import {PriceStatus, Session} from "../src/interfaces/ISherwoodOracle.sol";

contract SherwoodMarketTest is Base {
    SherwoodMarket internal market;

    uint256 internal constant USDG = 1e6;

    function setUp() public {
        setUpBase();
        vm.warp(1_800_000_000);
        market = SherwoodMarket(factory.createMarket(defaultParams(address(spy))));
        _refreshQuote();

        usdg.mint(alice, 1_000_000 * USDG);
        usdg.mint(liquidator, 1_000_000 * USDG);
        spy.mint(bob, 1000e18);

        vm.prank(alice);
        usdg.approve(address(market), type(uint256).max);
        vm.prank(liquidator);
        usdg.approve(address(market), type(uint256).max);
        vm.startPrank(bob);
        spy.approve(address(market), type(uint256).max);
        usdg.approve(address(market), type(uint256).max);
        vm.stopPrank();

        vm.prank(alice);
        market.supply(500_000 * USDG, alice);
    }

    function _refreshQuote() internal {
        postQuote(address(spy), poolSharePrice1e8(address(spy)), Session.Regular);
    }

    /// @dev Bob posts `n` tokens and borrows `usdgAmount`.
    function _openPosition(uint256 n, uint256 usdgAmount) internal {
        vm.startPrank(bob);
        market.supplyCollateral(n, bob);
        if (usdgAmount != 0) market.borrow(usdgAmount, bob);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ mechanics

    function test_supplyAndWithdrawRoundTrip() public {
        (uint128 supplyShares,,) = market.positions(alice);
        assertGt(supplyShares, 0);
        vm.prank(alice);
        uint256 out = market.withdraw(supplyShares, alice);
        assertApproxEqAbs(out, 500_000 * USDG, 1);
    }

    function test_borrowAgainstCollateral() public {
        // One token is one share at about $774, so ten tokens back roughly $7,744 at 70%: ~$5,420.
        _openPosition(10e18, 5000 * USDG);
        assertEq(usdg.balanceOf(bob), 5000 * USDG);
        (uint256 value, uint256 debt, bool solvent,) = market.healthOf(bob);
        assertApproxEqRel(value, 7743_90000000, 0.01e18);
        assertEq(debt, 5000 * USDG);
        assertTrue(solvent);
    }

    function test_borrowBeyondLltvReverts() public {
        vm.startPrank(bob);
        market.supplyCollateral(10e18, bob);
        vm.expectRevert(SherwoodMarket.Unhealthy.selector);
        market.borrow(5500 * USDG, bob);
        vm.stopPrank();
    }

    function test_repayClosesDebtAndFreesCollateral() public {
        _openPosition(10e18, 5000 * USDG);
        vm.warp(block.timestamp + 30 days);
        _refreshQuote();
        vm.startPrank(bob);
        (,uint128 borrowShares,) = market.positions(bob);
        usdg.mint(bob, 1000 * USDG);
        market.repay(0, borrowShares, bob);
        market.withdrawCollateral(10e18, bob);
        vm.stopPrank();
        assertEq(spy.balanceOf(bob), 1000e18);
        (, uint256 debt,,) = market.healthOf(bob);
        assertEq(debt, 0);
    }

    function test_interestAccruesToSuppliers() public {
        _openPosition(10e18, 5000 * USDG);
        uint256 before = market.supplyAssetsOf(alice);
        vm.warp(block.timestamp + 365 days);
        _refreshQuote();
        market.accrueInterest();
        assertGt(market.supplyAssetsOf(alice), before, "lenders must be paid for the year");
        assertGt(market.borrowAssetsOf(bob), 5000 * USDG);
    }

    // ---------------------------------------------------------- halt shield

    /// @notice The defining property. A halted collateral token charges the borrower nothing, because
    ///         during the halt they could not have repaid even if they wanted to.
    function test_noInterestAccruesWhileHalted() public {
        _openPosition(10e18, 5000 * USDG);
        market.accrueInterest();
        uint256 debtBefore = market.borrowAssetsOf(bob);

        spy.pause();
        market.accrueInterest();
        vm.warp(block.timestamp + 3 days);
        market.accrueInterest();
        assertEq(market.borrowAssetsOf(bob), debtBefore, "a halt must be free for the borrower");
        assertTrue(market.shielded());
    }

    function test_cannotBorrowOrWithdrawCollateralWhileHalted() public {
        _openPosition(10e18, 5000 * USDG);
        spy.pause();
        vm.startPrank(bob);
        vm.expectRevert(abi.encodeWithSelector(SherwoodMarket.MarketShielded.selector, PriceStatus.TokenPaused));
        market.borrow(1 * USDG, bob);
        vm.expectRevert(abi.encodeWithSelector(SherwoodMarket.MarketShielded.selector, PriceStatus.TokenPaused));
        market.withdrawCollateral(1e18, bob);
        vm.stopPrank();
    }

    function test_cannotLiquidateWhileHalted() public {
        _openPosition(10e18, 5000 * USDG);
        pool.setTick(SPY_TICK - 3000);
        _refreshQuote();
        spy.pause();
        vm.prank(liquidator);
        vm.expectRevert(abi.encodeWithSelector(SherwoodMarket.MarketShielded.selector, PriceStatus.TokenPaused));
        market.liquidate(bob, 100 * USDG);
    }

    /// @notice Repayment stays open through a halt. It only ever reduces risk, and a borrower locked
    ///         out of curing their own position is the failure this whole design exists to avoid.
    function test_repayStaysOpenWhileHalted() public {
        _openPosition(10e18, 5000 * USDG);
        spy.pause();
        vm.prank(bob);
        market.repay(1000 * USDG, 0, bob);
        assertApproxEqAbs(market.borrowAssetsOf(bob), 4000 * USDG, 1e6);
    }

    /// @notice Depositors are not trapped by someone else's halt.
    function test_supplyWithdrawStaysOpenWhileHalted() public {
        _openPosition(10e18, 5000 * USDG);
        spy.pause();
        (uint128 shares,,) = market.positions(alice);
        vm.prank(alice);
        market.withdraw(shares / 2, alice);
        assertGt(usdg.balanceOf(alice), 500_000 * USDG - 500_000 * USDG);
    }

    /// @notice The grace ramp. At the instant a halt clears there is no profit in liquidating, so the
    ///         borrower gets a real chance to cure at the gapped price instead of being taken in the
    ///         first block by whoever was watching.
    function test_liquidationBonusRampsBackAfterAHalt() public {
        _openPosition(10e18, 5000 * USDG);
        assertEq(market.currentBonusBps(), 700);

        spy.pause();
        market.accrueInterest();
        vm.warp(block.timestamp + 2 days);

        spy.unpause();
        _refreshQuote();
        market.accrueInterest();
        assertEq(market.currentBonusBps(), 0, "no free money in the first second");

        vm.warp(block.timestamp + 1 hours);
        assertEq(market.currentBonusBps(), 175, "a quarter of the window is a quarter of the bonus");
        vm.warp(block.timestamp + 3 hours);
        assertEq(market.currentBonusBps(), 700, "fully restored once the window closes");
    }

    function test_liquidationDuringGraceUsesTheRampedBonus() public {
        _openPosition(10e18, 5000 * USDG);
        spy.pause();
        market.accrueInterest();
        vm.warp(block.timestamp + 1 days);
        // The gap: the pool reopens 20% lower.
        pool.setTick(SPY_TICK - 2231);
        spy.unpause();
        _refreshQuote();
        market.accrueInterest();

        vm.warp(block.timestamp + 2 hours); // half the grace window, so half the bonus
        _refreshQuote();
        assertEq(market.currentBonusBps(), 350);

        uint256 before = spy.balanceOf(liquidator);
        vm.prank(liquidator);
        (uint256 seized,) = market.liquidate(bob, 1000 * USDG);
        assertEq(spy.balanceOf(liquidator) - before, seized);

        // Seized value is the repayment grossed up by exactly the ramped bonus, not the full one.
        uint256 rawX26 = oracle.priceRawX26(address(spy));
        uint256 seizedValue1e8 = seized * rawX26 / 1e18;
        assertApproxEqRel(seizedValue1e8, 1000 * 1e8 * 10350 / 10000, 0.001e18);
    }

    // ---------------------------------------------------------- liquidation

    function test_liquidateUnhealthyPosition() public {
        _openPosition(10e18, 5000 * USDG);
        // Drop the price ~25%: collateral $5,808, debt $5,000, LTV 86% > 70%.
        pool.setTick(SPY_TICK - 2877);
        _refreshQuote();
        vm.warp(block.timestamp + 5 hours); // past any grace
        _refreshQuote(); // a live feed keeps posting; the quote's max age is one hour
        (,, bool solvent,) = market.healthOf(bob);
        assertFalse(solvent);

        vm.prank(liquidator);
        (uint256 seized, uint256 repaidShares) = market.liquidate(bob, 2500 * USDG);
        assertGt(seized, 0);
        assertGt(repaidShares, 0);
        assertApproxEqAbs(market.borrowAssetsOf(bob), 2500 * USDG, 2 * USDG);
    }

    function test_liquidationCappedByCloseFactor() public {
        _openPosition(10e18, 5000 * USDG);
        pool.setTick(SPY_TICK - 2877);
        _refreshQuote();
        vm.warp(block.timestamp + 5 hours);
        _refreshQuote();
        vm.prank(liquidator);
        market.liquidate(bob, 5000 * USDG); // asks for all of it
        // The close factor is 50%, so half the debt must survive.
        assertApproxEqAbs(market.borrowAssetsOf(bob), 2500 * USDG, 2 * USDG);
    }

    function test_cannotLiquidateHealthyPosition() public {
        _openPosition(10e18, 5000 * USDG);
        vm.prank(liquidator);
        vm.expectRevert(SherwoodMarket.Healthy.selector);
        market.liquidate(bob, 100 * USDG);
    }

    /// @notice When collateral cannot cover the debt the shortfall is written down against suppliers
    ///         immediately, rather than left on the books inflating everyone's share price.
    function test_badDebtIsSocializedNotHidden() public {
        _openPosition(10e18, 5000 * USDG);
        // A catastrophic 90% gap leaves the position deeply underwater.
        pool.setTick(SPY_TICK - 23027);
        _refreshQuote();
        vm.warp(block.timestamp + 5 hours);
        _refreshQuote();

        uint256 supplyBefore = market.totalSupplyAssets();
        vm.prank(liquidator);
        market.liquidate(bob, 5000 * USDG);

        (,, uint128 collateral) = market.positions(bob);
        assertEq(collateral, 0, "everything seizable was seized");
        assertEq(market.borrowAssetsOf(bob), 0, "no phantom debt left behind");
        assertLt(market.totalSupplyAssets(), supplyBefore, "the loss lands on suppliers, visibly");
    }

    // ------------------------------------------------------------- factory

    function test_marketAddressIsAPreImageOfItsTerms() public {
        SherwoodMarket.ConstructorParams memory p = defaultParams(address(spy));
        p.lltv = 0.5e18;
        address predicted = factory.predict(p);
        address created = factory.createMarket(p);
        assertEq(created, predicted);
        assertTrue(factory.isMarket(created));
    }

    function test_sameTermsCannotBeDeployedTwice() public {
        vm.expectRevert();
        factory.createMarket(defaultParams(address(spy)));
    }

    function test_marketRejectsBonusThatWouldGuaranteeBadDebt() public {
        SherwoodMarket.ConstructorParams memory p = defaultParams(address(spy));
        p.lltv = 0.95e18;
        p.liqBonusBps = 1500; // 0.95 * 1.15 > 1
        vm.expectRevert(SherwoodMarket.BadParams.selector);
        factory.createMarket(p);
    }

    // ---------------------------------------------------------------- fuzz

    /// @notice No sequence of borrow and repay can leave a solvent-looking position over the LLTV.
    function testFuzz_borrowNeverExceedsLltv(uint96 collateralAmt, uint96 borrowAmt) public {
        collateralAmt = uint96(bound(collateralAmt, 1e15, 500e18));
        borrowAmt = uint96(bound(borrowAmt, 1 * USDG, 200_000 * USDG));
        spy.mint(bob, collateralAmt);
        vm.startPrank(bob);
        market.supplyCollateral(collateralAmt, bob);
        try market.borrow(borrowAmt, bob) {
            (uint256 value, uint256 debt,,) = market.healthOf(bob);
            assertLe(debt * 1e2 * 1e18, value * market.LLTV(), "a successful borrow is always inside the LLTV");
        } catch {}
        vm.stopPrank();
    }

    /// @notice Liquidating can never make a position's debt-to-collateral ratio worse, which is what
    ///         stops a liquidator from farming a position into insolvency one call at a time.
    function testFuzz_liquidationNeverWorsensThePosition(uint96 repayAmt) public {
        _openPosition(10e18, 5000 * USDG);
        pool.setTick(SPY_TICK - 2877);
        _refreshQuote();
        vm.warp(block.timestamp + 5 hours);
        _refreshQuote();
        repayAmt = uint96(bound(repayAmt, 1 * USDG, 2500 * USDG));

        (uint256 valueBefore, uint256 debtBefore,,) = market.healthOf(bob);
        vm.prank(liquidator);
        market.liquidate(bob, repayAmt);
        (uint256 valueAfter, uint256 debtAfter,,) = market.healthOf(bob);

        if (debtAfter == 0 || valueAfter == 0) return;
        // ratio = debt / value, compared without division.
        assertLe(debtAfter * valueBefore, debtBefore * valueAfter + 1e12, "liquidation must not deepen insolvency");
    }
}
