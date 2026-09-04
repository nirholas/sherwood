// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @notice Global Dollar as it exists on Robinhood Chain: six decimals, no EIP-2612, no EIP-3009.
contract MockUSDG is ERC20 {
    function name() public pure override returns (string memory) {
        return "Global Dollar";
    }

    function symbol() public pure override returns (string memory) {
        return "USDG";
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}
