// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The two Uniswap v3 pool methods this protocol reads. Kept as a local interface so the
///         repository carries no GPL-licensed Uniswap sources.
interface IUniswapV3PoolOracle {
    /// @param secondsAgos Look-back offsets, newest last.
    /// @return tickCumulatives Cumulative tick at each offset.
    /// @return secondsPerLiquidityCumulativeX128s Cumulative seconds-per-liquidity at each offset.
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);

    function token0() external view returns (address);
    function token1() external view returns (address);
    function liquidity() external view returns (uint128);
}
