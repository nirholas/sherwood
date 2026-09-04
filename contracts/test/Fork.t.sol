// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SherwoodOracle} from "../src/SherwoodOracle.sol";
import {SherwoodMarket} from "../src/SherwoodMarket.sol";
import {SherwoodFactory} from "../src/SherwoodFactory.sol";
import {KinkedIrm} from "../src/KinkedIrm.sol";
import {IStockToken} from "../src/interfaces/IStockToken.sol";
import {IUniswapV3PoolOracle} from "../src/interfaces/IUniswapV3PoolOracle.sol";
import {PriceStatus, Session} from "../src/interfaces/ISherwoodOracle.sol";

/// @notice Runs against Robinhood Chain itself. Every address below was read from the live chain, and
///         the point of the suite is that the oracle's arithmetic lands on the price the chain is
///         really quoting rather than on a number a mock was told to return.
///
///         Skipped automatically when no RPC is configured, so `forge test` still works offline:
///         `RHC_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-contract Fork`
contract ForkTest is Test {
    address internal constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// @notice The SPY/USDG 0.05% pool: the deepest venue for the asset on this chain.
    address internal constant SPY_USDG_500 = 0xa7Bb1AC63BBaB0C44316E6c8C455213441689167;
    /// @notice The one beacon every tokenized equity on the chain proxies to.
    address internal constant STOCK_BEACON = 0xe10b6f6B275de231345c20D14Ab812db62151b00;

    SherwoodOracle internal oracle;
    address internal owner = address(0xA11CE);
    uint256 internal repKey1 = 0xA11CE5EED;
    uint256 internal repKey2 = 0xB0B5EED;
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("RHC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        try vm.createSelectFork(rpc) {
            forked = true;
        } catch {
            return;
        }

        address[] memory reporters = new address[](2);
        (reporters[0], reporters[1]) = vm.addr(repKey1) < vm.addr(repKey2)
            ? (vm.addr(repKey1), vm.addr(repKey2))
            : (vm.addr(repKey2), vm.addr(repKey1));

        vm.startPrank(owner);
        oracle = new SherwoodOracle(owner, USDG, reporters, 2);
        oracle.configureAsset(
            SPY,
            SherwoodOracle.AssetConfig({
                pool: SPY_USDG_500,
                assetIsToken0: IUniswapV3PoolOracle(SPY_USDG_500).token0() == SPY,
                quoteToken: USDG,
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
    }

    modifier onlyForked() {
        if (!forked) return;
        _;
    }

    /// @notice The interface this protocol was written against has to be the one the chain actually
    ///         implements. Every member below is called on the live SPY token.
    function test_liveStockTokenExposesTheAssumedSurface() public onlyForked {
        IStockToken t = IStockToken(SPY);
        assertEq(t.decimals(), 18);
        assertEq(keccak256(bytes(t.symbol())), keccak256(bytes("SPY")));
        assertGt(t.totalSupply(), 0);
        assertEq(t.uiMultiplier(), 1e18, "no corporate action is pending on SPY today");
        assertGt(t.newUIMultiplier(), 0);
        t.effectiveAt();
        t.paused();
        t.tokenPaused();
        t.oraclePaused();
        t.balanceOfUI(address(this));
    }

    /// @notice All 254 tokenized equities are beacon proxies onto one implementation, which is why a
    ///         single integration covers the whole listing and why one upgrade would move all of them.
    function test_stockBeaconIsLiveAndShared() public onlyForked {
        (bool ok, bytes memory ret) = STOCK_BEACON.staticcall(abi.encodeWithSignature("implementation()"));
        assertTrue(ok, "beacon must answer");
        address impl = abi.decode(ret, (address));
        assertGt(impl.code.length, 0, "the shared Stock implementation must hold code");
    }

    /// @notice The calibration that matters: the tick the real pool is holding has to decode to a
    ///         believable SPY share price. A decimals or orientation error here is not a small one,
    ///         it is off by twelve orders of magnitude, so this band is a decisive check.
    function test_livePoolDecodesToARealisticSharePrice() public onlyForked {
        (uint256 rawX26, bool ok) = oracle.twapRawX26(SPY);
        assertTrue(ok, "the pool must have 30 minutes of observations");
        uint256 sharePrice1e8 = rawX26; // multiplier is 1e18 and the asset has 18 decimals
        assertGt(sharePrice1e8, 300e8, "SPY below $300 would mean the math is wrong");
        assertLt(sharePrice1e8, 2000e8, "SPY above $2000 would mean the math is wrong");
        emit log_named_decimal_uint("live SPY share price (USD)", sharePrice1e8, 8);
    }

    /// @notice A second, independent derivation of the same price. `slot0.sqrtPriceX96` squared and
    ///         the exponential of the mean tick are different arithmetic over different pool state; if
    ///         they agree, the decimal handling and the pool orientation are both right.
    function test_twapAgreesWithSpotSqrtPrice() public onlyForked {
        (uint256 twapX26,) = oracle.twapRawX26(SPY);
        (bool ok, bytes memory ret) = SPY_USDG_500.staticcall(abi.encodeWithSignature("slot0()"));
        assertTrue(ok);
        uint160 sqrtPriceX96 = abi.decode(ret, (uint160));

        // (sqrtP / 2**96)**2, carried in wad, then restated on the oracle's 1e26 scale.
        uint256 q96 = 2 ** 96;
        uint256 half = uint256(sqrtPriceX96) * uint256(sqrtPriceX96) / q96;
        uint256 ratioWad = half * 1e18 / q96;
        uint256 spotX26 = ratioWad * 1e8 / 1e6;

        assertApproxEqRel(twapX26, spotX26, 0.02e18, "two derivations of the same price must agree");
    }

    /// @notice End to end on live state: attest at the pool's own price, and the feed serves.
    function test_feedServesAgainstLiveChainState() public onlyForked {
        (uint256 twapX26,) = oracle.twapRawX26(SPY);
        _post(SPY, twapX26, Session.Regular);
        (uint256 p, PriceStatus s) = oracle.peek(SPY);
        assertEq(uint8(s), uint8(PriceStatus.OK));
        assertEq(p, twapX26);
        // One whole SPY token is one share.
        assertEq(oracle.valueOf(SPY, 1e18), twapX26);
    }

    /// @notice And a market can be created against the live pair and priced without any mock in path.
    function test_marketOnLivePairIsHealthyAtRest() public onlyForked {
        (uint256 twapX26,) = oracle.twapRawX26(SPY);
        _post(SPY, twapX26, Session.Regular);

        KinkedIrm irm = new KinkedIrm(0.02e18, 0.10e18, 1.5e18, 0.90e18);
        SherwoodFactory factory = new SherwoodFactory();
        SherwoodMarket market = SherwoodMarket(
            factory.createMarket(
                SherwoodMarket.ConstructorParams({
                    collateral: SPY,
                    loanToken: USDG,
                    oracle: address(oracle),
                    irm: address(irm),
                    lltv: 0.70e18,
                    liqBonusBps: 700,
                    closeFactorBps: 5000,
                    graceWindow: 4 hours,
                    fee: 0,
                    feeRecipient: address(0)
                })
            )
        );
        market.accrueInterest();
        assertFalse(market.shielded(), "a live, unpaused SPY market must not be shielded");
        (uint256 rawX26, PriceStatus s) = market.priceStatus();
        assertEq(uint8(s), uint8(PriceStatus.OK));
        assertEq(rawX26, twapX26);
    }

    function _post(address asset, uint256 price1e8, Session session) internal {
        SherwoodOracle.PriceReport memory r = SherwoodOracle.PriceReport({
            asset: asset,
            price: price1e8,
            observedAt: uint64(block.timestamp),
            session: uint8(session),
            nonce: uint64(block.timestamp)
        });
        bytes32 digest = oracle.hashReport(r);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(repKey1, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(repKey2, digest);
        bytes memory a = abi.encodePacked(r1, s1, v1);
        bytes memory b = abi.encodePacked(r2, s2, v2);
        bytes[] memory sigs = new bytes[](2);
        (sigs[0], sigs[1]) = vm.addr(repKey1) < vm.addr(repKey2) ? (a, b) : (b, a);
        oracle.postQuote(r, sigs);
    }
}
