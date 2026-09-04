// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @notice A behavioural copy of Robinhood's `Stock` implementation, the single beacon target behind
///         all 254 tokenized equities on chain 4663. Transcribed from the verified source at
///         0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2 so the tests exercise the real semantics:
///         the scheduled UI multiplier, the two-level pause, and the separate oracle pause.
contract MockStock is ERC20 {
    string internal _name;
    string internal _symbol;
    uint8 internal _decimals;

    uint256 internal _multiplier;
    uint256 internal _newMultiplier;
    uint256 internal _effectiveAt;

    bool public tokenPaused;
    bool public registryPaused;
    bool public oraclePaused;

    error IsPaused();

    constructor(string memory n, string memory s, uint8 d) {
        _name = n;
        _symbol = s;
        _decimals = d;
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function paused() public view returns (bool) {
        return tokenPaused || registryPaused;
    }

    function pause() external {
        tokenPaused = true;
    }

    function unpause() external {
        tokenPaused = false;
    }

    function pauseRegistry(bool v) external {
        registryPaused = v;
    }

    function pauseOracle() external {
        oraclePaused = true;
    }

    function unpauseOracle() external {
        oraclePaused = false;
    }

    /// @dev Matches `ERC20ScaledUIUpgradeable.uiMultiplier`, including the default of 1e18.
    function uiMultiplier() public view returns (uint256) {
        if (block.timestamp >= _effectiveAt && _newMultiplier != 0) return _newMultiplier;
        if (_multiplier == 0) return 1e18;
        return _multiplier;
    }

    function newUIMultiplier() public view returns (uint256) {
        return _newMultiplier == 0 ? 1e18 : _newMultiplier;
    }

    function effectiveAt() public view returns (uint256) {
        return _effectiveAt;
    }

    function balanceOfUI(address a) external view returns (uint256) {
        return balanceOf(a) * uiMultiplier() / 1e18;
    }

    /// @dev Mirrors `_updateUIMultiplier`: the currently effective value is frozen into `_multiplier`
    ///      and the new one is scheduled.
    function updateMultiplier(uint256 next, uint256 at) external {
        require(next > 0 && at >= block.timestamp, "bad multiplier");
        _multiplier = uiMultiplier();
        _newMultiplier = next;
        _effectiveAt = at;
    }

    function mint(address to, uint256 amt) external {
        if (paused()) revert IsPaused();
        _mint(to, amt);
    }

    function _beforeTokenTransfer(address, address, uint256) internal view override {
        if (paused()) revert IsPaused();
    }

    function approve(address spender, uint256 value) public override returns (bool) {
        if (paused()) revert IsPaused();
        return super.approve(spender, value);
    }
}
