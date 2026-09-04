// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice A Uniswap v3 pool stub that serves a settable arithmetic-mean tick over any window, and
///         can be told to revert like a pool whose observation buffer does not reach that far back.
contract MockV3Pool {
    address public token0;
    address public token1;
    int24 public tick;
    bool public tooOld;
    uint128 public liquidity = 1e18;

    error OLD();

    constructor(address t0, address t1, int24 tick_) {
        token0 = t0;
        token1 = t1;
        tick = tick_;
    }

    function setTick(int24 t) external {
        tick = t;
    }

    function setTooOld(bool v) external {
        tooOld = v;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        if (tooOld) revert OLD();
        uint256 n = secondsAgos.length;
        tickCumulatives = new int56[](n);
        secondsPerLiquidityCumulativeX128s = new uint160[](n);
        // Cumulative tick grows by `tick` every second, so any pair of offsets averages to `tick`.
        int56 base = int56(1_000_000_000);
        for (uint256 i; i < n; ++i) {
            tickCumulatives[i] = base + int56(tick) * int56(int256(uint256(1_000_000 - secondsAgos[i])));
        }
    }
}
