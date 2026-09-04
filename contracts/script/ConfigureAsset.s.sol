// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SherwoodOracle} from "../src/SherwoodOracle.sol";
import {IUniswapV3PoolOracle} from "../src/interfaces/IUniswapV3PoolOracle.sol";
import {IStockToken} from "../src/interfaces/IStockToken.sol";

/// @notice Points the oracle at one tokenized equity and the pool that prices it.
/// @dev Orientation and decimals are read from the chain rather than passed in, because getting
///      either wrong does not produce a slightly wrong price, it produces one off by twelve orders
///      of magnitude, and a deploy script is exactly where that mistake gets made.
///
/// Env: ORACLE, ASSET, POOL, QUOTE, TWAP_WINDOW, MAX_DEV_BPS, OFF_HOURS_DEV_BPS, MAX_QUOTE_AGE
contract ConfigureAsset is Script {
    function run() external {
        SherwoodOracle oracle = SherwoodOracle(vm.envAddress("ORACLE"));
        address asset = vm.envAddress("ASSET");
        address pool = vm.envAddress("POOL");
        address quote = vm.envAddress("QUOTE");

        address token0 = IUniswapV3PoolOracle(pool).token0();
        address token1 = IUniswapV3PoolOracle(pool).token1();
        require(
            (token0 == asset && token1 == quote) || (token1 == asset && token0 == quote),
            "pool does not price this pair"
        );

        SherwoodOracle.AssetConfig memory cfg = SherwoodOracle.AssetConfig({
            pool: pool,
            assetIsToken0: token0 == asset,
            quoteToken: quote,
            quoteDecimals: IStockToken(quote).decimals(),
            assetDecimals: IStockToken(asset).decimals(),
            twapWindow: uint32(vm.envOr("TWAP_WINDOW", uint256(1800))),
            maxDeviationBps: uint16(vm.envOr("MAX_DEV_BPS", uint256(200))),
            offHoursDeviationBps: uint16(vm.envOr("OFF_HOURS_DEV_BPS", uint256(500))),
            maxQuoteAge: uint32(vm.envOr("MAX_QUOTE_AGE", uint256(3600))),
            enabled: true
        });

        vm.startBroadcast();
        oracle.configureAsset(asset, cfg);
        vm.stopBroadcast();

        (uint256 twap, bool ok) = oracle.twapRawX26(asset);
        console2.log("configured", IStockToken(asset).symbol());
        console2.log("twap available", ok);
        console2.log("implied share price (1e8)", twap * (10 ** cfg.assetDecimals) / IStockToken(asset).uiMultiplier());
    }
}
