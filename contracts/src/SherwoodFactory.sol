// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SherwoodMarket} from "./SherwoodMarket.sol";

/// @title SherwoodFactory
/// @notice Deploys isolated markets at addresses derived from their parameters.
/// @dev The salt is the hash of the market's terms, so a given (collateral, loan token, oracle, IRM,
///      LLTV, bonus, close factor, grace window, fee) tuple has exactly one address on every chain,
///      forever. Two consequences worth the design: a market's address is a commitment to its risk
///      parameters that anyone can recompute offline before depositing, and the same market cannot be
///      created twice under different terms. There is no owner and no allowlist, because a permissioned
///      factory would let whoever holds the key decide which collateral the world is allowed to borrow
///      against; curation belongs in front ends and in vaults that choose markets, not in the deployer.
contract SherwoodFactory {
    /// @notice Every market this factory has created, oldest first.
    address[] public markets;
    mapping(address => bool) public isMarket;

    event MarketCreated(
        address indexed market,
        address indexed collateral,
        address indexed loanToken,
        address oracle,
        address irm,
        uint256 lltv,
        bytes32 salt
    );

    error AlreadyDeployed(address market);

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function saltFor(SherwoodMarket.ConstructorParams memory p) public pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    /// @notice The address a market with these terms will occupy, whether or not it exists yet.
    function predict(SherwoodMarket.ConstructorParams memory p) public view returns (address) {
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(SherwoodMarket).creationCode, abi.encode(p)));
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), saltFor(p), initCodeHash))))
        );
    }

    function createMarket(SherwoodMarket.ConstructorParams memory p) external returns (address market) {
        address predicted = predict(p);
        if (predicted.code.length != 0) revert AlreadyDeployed(predicted);
        market = address(new SherwoodMarket{salt: saltFor(p)}(p));
        markets.push(market);
        isMarket[market] = true;
        emit MarketCreated(market, p.collateral, p.loanToken, p.oracle, p.irm, p.lltv, saltFor(p));
    }
}
