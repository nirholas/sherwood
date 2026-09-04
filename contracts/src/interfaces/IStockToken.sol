// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title The surface every Robinhood tokenized equity exposes.
/// @notice All 254 stock tokens on Robinhood Chain (eip155:4663) are beacon proxies pointing at one
///         shared `Stock` implementation, so this interface describes every one of them exactly.
///         Two of its members have no analogue on an ordinary ERC-20 and drive this whole protocol:
///
///         * `uiMultiplier()` scales raw balances into economic shares. A corporate action (split,
///           reverse split, distribution) moves it, so `balanceOf` alone does NOT tell you how much
///           of a company an address owns. `newUIMultiplier()`/`effectiveAt()` publish the *next*
///           multiplier ahead of time, which means a scheduled corporate action is readable on chain
///           before it lands. Nothing else in DeFi gets that warning.
///
///         * `paused()` and `oraclePaused()` are the issuer's halt signals. While `paused()` is true
///           every transfer, approve and permit reverts, so collateral cannot be seized and a
///           liquidation is physically impossible. `oraclePaused()` is the issuer disavowing the
///           price without freezing transfers.
interface IStockToken {
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;

    /// @notice Economic shares per 1e18 raw units. 1e18 means one raw unit is one share.
    function uiMultiplier() external view returns (uint256);
    /// @notice The multiplier that becomes live at `effectiveAt()`. Returns 1e18 when none is scheduled.
    function newUIMultiplier() external view returns (uint256);
    /// @notice Unix second at which `newUIMultiplier()` takes over. Zero when never scheduled.
    function effectiveAt() external view returns (uint256);
    /// @notice `balanceOf` already scaled by the live multiplier.
    function balanceOfUI(address account) external view returns (uint256);

    /// @notice True when transfers are frozen, by this token or by the chain-wide registry.
    function paused() external view returns (bool);
    /// @notice True when only this token is frozen, ignoring the registry-wide switch.
    function tokenPaused() external view returns (bool);
    /// @notice True when the issuer has disavowed this token's price. Transfers may still work.
    function oraclePaused() external view returns (bool);
}
