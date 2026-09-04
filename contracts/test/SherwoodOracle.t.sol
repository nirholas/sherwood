// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {SherwoodOracle} from "../src/SherwoodOracle.sol";
import {PriceStatus, Session} from "../src/interfaces/ISherwoodOracle.sol";

contract SherwoodOracleTest is Base {
    function setUp() public {
        setUpBase();
        vm.warp(1_800_000_000);
    }

    // ------------------------------------------------------------ tick math

    /// @notice The tick the SPY/USDG pool actually held on Robinhood Chain must decode to the share
    ///         price that pool was actually quoting. This is the calibration that makes every other
    ///         number in the protocol meaningful.
    function test_tickDecodesToRealSpyPrice() public view {
        (uint256 rawX26, bool ok) = oracle.twapRawX26(address(spy));
        assertTrue(ok, "twap should be available");
        uint256 share1e8 = rawX26 * 1e18 / 1e18;
        // Tick -209800 across an 18-decimal asset and a 6-decimal quote is about $774.39 a share.
        assertApproxEqRel(share1e8, 774_39000000, 0.001e18, "tick should decode to ~$774.39");
    }

    function test_twapUnavailableWhenPoolHistoryTooShort() public {
        pool.setTooOld(true);
        postQuote(address(spy), 774_39000000, Session.Regular);
        (, PriceStatus s) = oracle.peek(address(spy));
        assertEq(uint8(s), uint8(PriceStatus.TwapUnavailable));
    }

    // -------------------------------------------------------------- quorum

    function test_rejectsBelowQuorum() public {
        nonce++;
        SherwoodOracle.PriceReport memory r = SherwoodOracle.PriceReport({
            asset: address(spy),
            price: 774_39000000,
            observedAt: uint64(block.timestamp),
            session: uint8(Session.Regular),
            nonce: nonce
        });
        bytes32 digest = oracle.hashReport(r);
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(repKey1, digest);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = abi.encodePacked(rr, ss, v);
        vm.expectRevert(abi.encodeWithSelector(SherwoodOracle.QuorumNotMet.selector, 1, 2));
        oracle.postQuote(r, sigs);
    }

    function test_rejectsDuplicateSigner() public {
        nonce++;
        SherwoodOracle.PriceReport memory r = SherwoodOracle.PriceReport({
            asset: address(spy),
            price: 774_39000000,
            observedAt: uint64(block.timestamp),
            session: uint8(Session.Regular),
            nonce: nonce
        });
        bytes32 digest = oracle.hashReport(r);
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(repKey1, digest);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = abi.encodePacked(rr, ss, v);
        sigs[1] = abi.encodePacked(rr, ss, v);
        vm.expectRevert(SherwoodOracle.SignaturesUnsorted.selector);
        oracle.postQuote(r, sigs);
    }

    function test_rejectsUnknownSigner() public {
        uint256 rogue = 0xBAD5EED;
        nonce++;
        SherwoodOracle.PriceReport memory r = SherwoodOracle.PriceReport({
            asset: address(spy),
            price: 774_39000000,
            observedAt: uint64(block.timestamp),
            session: uint8(Session.Regular),
            nonce: nonce
        });
        bytes32 digest = oracle.hashReport(r);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(repKey1, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(rogue, digest);
        bytes memory a = abi.encodePacked(r1, s1, v1);
        bytes memory b = abi.encodePacked(r2, s2, v2);
        bytes[] memory sigs = new bytes[](2);
        (sigs[0], sigs[1]) = rep1 < vm.addr(rogue) ? (a, b) : (b, a);
        vm.expectRevert();
        oracle.postQuote(r, sigs);
    }

    function test_rejectsReplayedNonce() public {
        postQuote(address(spy), 774_39000000, Session.Regular);
        SherwoodOracle.PriceReport memory r = SherwoodOracle.PriceReport({
            asset: address(spy),
            price: 700_00000000,
            observedAt: uint64(block.timestamp),
            session: uint8(Session.Regular),
            nonce: nonce
        });
        bytes[] memory sigs = sortedSigs(oracle.hashReport(r));
        vm.expectRevert();
        oracle.postQuote(r, sigs);
    }

    // ------------------------------------------------------ two-source rule

    function test_servesPriceWhenSourcesAgree() public {
        postQuote(address(spy), poolSharePrice1e8(address(spy)), Session.Regular);
        (uint256 p, PriceStatus s) = oracle.peek(address(spy));
        assertEq(uint8(s), uint8(PriceStatus.OK));
        assertGt(p, 0);
        // The served price is the pool's, not the attested one: what a liquidator can realise.
        (uint256 twap,) = oracle.twapRawX26(address(spy));
        assertEq(p, twap);
    }

    /// @notice A compromised reporter cannot move the served price, only take the feed offline.
    function test_reporterCannotMovePrice() public {
        uint256 fair = poolSharePrice1e8(address(spy));
        postQuote(address(spy), fair * 3, Session.Regular);
        (, PriceStatus s) = oracle.peek(address(spy));
        assertEq(uint8(s), uint8(PriceStatus.TwapDeviation), "an absurd quote must disable, not reprice");
    }

    /// @notice And a manipulated pool cannot either, because it walks away from the attestation.
    function test_poolManipulationTakesFeedOfflineNotUp() public {
        postQuote(address(spy), poolSharePrice1e8(address(spy)), Session.Regular);
        (, PriceStatus before) = oracle.peek(address(spy));
        assertEq(uint8(before), uint8(PriceStatus.OK));
        // Push the pool up by roughly 10%: about 953 ticks at 1.0001 per tick.
        pool.setTick(SPY_TICK + 953);
        (, PriceStatus s) = oracle.peek(address(spy));
        assertEq(uint8(s), uint8(PriceStatus.TwapDeviation));
    }

    function test_bandWidensOutsideMarketHours() public {
        // A 3% gap: rejected during the session at 2%, accepted off-hours at 5%.
        pool.setTick(SPY_TICK + 296);
        uint256 attested = poolSharePrice1e8(address(spy)) * 10000 / 10296;
        postQuote(address(spy), attested, Session.Regular);
        (, PriceStatus during) = oracle.peek(address(spy));
        assertEq(uint8(during), uint8(PriceStatus.TwapDeviation));

        postQuote(address(spy), attested, Session.Closed);
        (, PriceStatus closed) = oracle.peek(address(spy));
        assertEq(uint8(closed), uint8(PriceStatus.OK), "a 24/7 token may drift ahead of the open");
    }

    // ------------------------------------------------------------- halting

    function test_pausedTokenHasNoPrice() public {
        postQuote(address(spy), poolSharePrice1e8(address(spy)), Session.Regular);
        spy.pause();
        (, PriceStatus s) = oracle.peek(address(spy));
        assertEq(uint8(s), uint8(PriceStatus.TokenPaused));
    }

    function test_registryPauseHaltsEveryToken() public {
        postQuote(address(spy), poolSharePrice1e8(address(spy)), Session.Regular);
        spy.pauseRegistry(true);
        (, PriceStatus s) = oracle.peek(address(spy));
        assertEq(uint8(s), uint8(PriceStatus.TokenPaused));
    }

    function test_issuerOraclePauseIsHonoured() public {
        postQuote(address(spy), poolSharePrice1e8(address(spy)), Session.Regular);
        spy.pauseOracle();
        (, PriceStatus s) = oracle.peek(address(spy));
        assertEq(uint8(s), uint8(PriceStatus.IssuerOraclePaused));
    }

    function test_quoteGoesStale() public {
        postQuote(address(spy), poolSharePrice1e8(address(spy)), Session.Regular);
        vm.warp(block.timestamp + 3601);
        (, PriceStatus s) = oracle.peek(address(spy));
        assertEq(uint8(s), uint8(PriceStatus.QuoteStale));
    }

    // -------------------------------------------------- corporate actions

    /// @notice A scheduled fall in the multiplier is priced the moment it is announced, so nobody can
    ///         borrow against value that is already scheduled to disappear.
    function test_pendingReverseSplitHaircutsCollateralImmediately() public {
        postQuote(address(spy), poolSharePrice1e8(address(spy)), Session.Regular);
        (uint256 before,) = oracle.peek(address(spy));

        // A one-for-ten reverse split, effective in a day: each raw unit will be worth a tenth.
        spy.updateMultiplier(0.1e18, block.timestamp + 1 days);
        (uint256 after_, PriceStatus s) = oracle.peek(address(spy));
        assertEq(uint8(s), uint8(PriceStatus.OK));
        assertApproxEqRel(after_, before / 10, 0.0001e18, "collateral must be marked down on announcement");
    }

    /// @notice For one TWAP window after the split lands, the moving average straddles the jump and is
    ///         wrong by up to the split ratio. The feed must refuse to serve during that window.
    function test_twapBlackoutAcrossTheSplitItself() public {
        postQuote(address(spy), poolSharePrice1e8(address(spy)), Session.Regular);
        uint256 effAt = block.timestamp + 1 days;
        spy.updateMultiplier(0.1e18, effAt);

        vm.warp(effAt);
        postQuote(address(spy), poolSharePrice1e8(address(spy)) , Session.Regular);
        (, PriceStatus during) = oracle.peek(address(spy));
        assertEq(uint8(during), uint8(PriceStatus.MultiplierTransition), "no price while the average straddles");

        // The pool has repriced by the split ratio and the window has rolled past the event.
        vm.warp(effAt + 1800);
        pool.setTick(SPY_TICK - 23027); // ln(10)/ln(1.0001)
        postQuote(address(spy), poolSharePrice1e8(address(spy)), Session.Regular);
        (, PriceStatus after_) = oracle.peek(address(spy));
        assertEq(uint8(after_), uint8(PriceStatus.OK), "normal service once the window has cleared");
    }

    /// @notice A forward split is not credited early, only recognised once it is live.
    function test_pendingForwardSplitIsNotCreditedEarly() public {
        postQuote(address(spy), poolSharePrice1e8(address(spy)), Session.Regular);
        (uint256 before,) = oracle.peek(address(spy));
        spy.updateMultiplier(10e18, block.timestamp + 1 days);
        (uint256 after_, PriceStatus s) = oracle.peek(address(spy));
        assertEq(uint8(s), uint8(PriceStatus.OK));
        assertEq(after_, before, "an unrealised gain is not collateral");
    }

    function test_conservativeMultiplierPicksThePendingFall() public {
        assertEq(oracle.conservativeMultiplier(address(spy)), 1e18);
        spy.updateMultiplier(0.1e18, block.timestamp + 1 days);
        assertEq(oracle.conservativeMultiplier(address(spy)), 0.1e18);
        spy.updateMultiplier(10e18, block.timestamp + 1 days);
        assertEq(oracle.conservativeMultiplier(address(spy)), 1e18);
    }

    // --------------------------------------------------------------- values

    function test_valueOfMatchesShareMath() public {
        postQuote(address(spy), poolSharePrice1e8(address(spy)), Session.Regular);
        // One whole token, multiplier one, is one share.
        uint256 v = oracle.valueOf(address(spy), 1e18);
        assertApproxEqRel(v, 774_39000000, 0.001e18);
        assertApproxEqRel(oracle.pricePerShare1e8(address(spy)), 774_39000000, 0.001e18);
    }

    function test_unconfiguredAssetHasNoPrice() public view {
        (, PriceStatus s) = oracle.peek(address(usdg));
        assertEq(uint8(s), uint8(PriceStatus.NoConfig));
    }

    function test_configRejectsWrongOrientation() public {
        bool spyIsToken0 = address(spy) < address(usdg);
        vm.prank(owner);
        vm.expectRevert(SherwoodOracle.BadConfig.selector);
        oracle.configureAsset(
            address(spy),
            SherwoodOracle.AssetConfig({
                pool: address(pool),
                assetIsToken0: !spyIsToken0,
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
}
