// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IIrm {
    /// @notice Per-second borrow rate in wad, from the market's current balances.
    function borrowRatePerSecond(uint256 totalSupplyAssets, uint256 totalBorrowAssets)
        external
        view
        returns (uint256);
}
