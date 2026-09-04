// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SherwoodOracle} from "../src/SherwoodOracle.sol";
import {SherwoodMarket} from "../src/SherwoodMarket.sol";
import {SherwoodFactory} from "../src/SherwoodFactory.sol";
import {KinkedIrm} from "../src/KinkedIrm.sol";
import {PriceStatus, Session} from "../src/interfaces/ISherwoodOracle.sol";
import {MockStock} from "./mocks/MockStock.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";
import {MockV3Pool} from "./mocks/MockV3Pool.sol";

/// @notice Shared fixture: one stock, one USDG, one pool, one oracle with two reporters at quorum two.
abstract contract Base is Test {
    SherwoodOracle internal oracle;
    SherwoodFactory internal factory;
    KinkedIrm internal irm;
    MockStock internal spy;
    MockUSDG internal usdg;
    MockV3Pool internal pool;

    address internal owner = address(0xA11CE);
    address internal alice = address(0xA);
    address internal bob = address(0xB);
    address internal liquidator = address(0x11C);

    uint256 internal repKey1 = 0xA11CE5EED;
    uint256 internal repKey2 = 0xB0B5EED;
    address internal rep1;
    address internal rep2;

    /// @dev Tick -209800 on an 18/6-decimal pair is roughly $774 a share, which is where SPY/USDG
    ///      actually sat on Robinhood Chain when this protocol was written.
    int24 internal constant SPY_TICK = -209800;
    uint64 internal nonce;

    function setUpBase() internal {
        rep1 = vm.addr(repKey1);
        rep2 = vm.addr(repKey2);

        usdg = new MockUSDG();
        spy = new MockStock("SPDR S&P 500 ETF Trust - Robinhood Token", "SPY", 18);
        // Pool token order follows address order, exactly as Uniswap enforces it.
        bool spyIsToken0 = address(spy) < address(usdg);
        pool = spyIsToken0
            ? new MockV3Pool(address(spy), address(usdg), SPY_TICK)
            : new MockV3Pool(address(usdg), address(spy), -SPY_TICK);

        address[] memory reporters = new address[](2);
        reporters[0] = rep1;
        reporters[1] = rep2;

        vm.startPrank(owner);
        oracle = new SherwoodOracle(owner, address(usdg), reporters, 2);
        oracle.configureAsset(
            address(spy),
            SherwoodOracle.AssetConfig({
                pool: address(pool),
                assetIsToken0: spyIsToken0,
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
        vm.stopPrank();

        irm = new KinkedIrm(0.02e18, 0.10e18, 1.5e18, 0.90e18);
        factory = new SherwoodFactory();
    }

    function defaultParams(address collateral) internal view returns (SherwoodMarket.ConstructorParams memory) {
        return SherwoodMarket.ConstructorParams({
            collateral: collateral,
            loanToken: address(usdg),
            oracle: address(oracle),
            irm: address(irm),
            lltv: 0.70e18,
            liqBonusBps: 700,
            closeFactorBps: 5000,
            graceWindow: 4 hours,
            fee: 0,
            feeRecipient: address(0)
        });
    }

    /// @notice Post a quote for `asset` at `price1e8` a share, signed by both reporters.
    function postQuote(address asset, uint256 price1e8, Session session) internal {
        nonce++;
        SherwoodOracle.PriceReport memory r = SherwoodOracle.PriceReport({
            asset: asset,
            price: price1e8,
            observedAt: uint64(block.timestamp),
            session: uint8(session),
            nonce: nonce
        });
        bytes32 digest = oracle.hashReport(r);
        bytes[] memory sigs = sortedSigs(digest);
        oracle.postQuote(r, sigs);
    }

    /// @dev `postQuote` requires signatures ordered by recovered address, so sort by signer here.
    function sortedSigs(bytes32 digest) internal view returns (bytes[] memory sigs) {
        sigs = new bytes[](2);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(repKey1, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(repKey2, digest);
        bytes memory a = abi.encodePacked(r1, s1, v1);
        bytes memory b = abi.encodePacked(r2, s2, v2);
        (sigs[0], sigs[1]) = rep1 < rep2 ? (a, b) : (b, a);
    }

    /// @notice The share price the pool tick implies, at 1e8. Quotes in tests are built from this so
    ///         they land inside the deviation band the way a healthy feed would.
    function poolSharePrice1e8(address asset) internal view returns (uint256) {
        (uint256 rawX26, bool ok) = oracle.twapRawX26(asset);
        require(ok, "twap unavailable");
        // Invert `attestedX26 = price * multiplier / 10**decimals`.
        return rawX26 * (10 ** MockStock(asset).decimals()) / MockStock(asset).uiMultiplier();
    }
}
