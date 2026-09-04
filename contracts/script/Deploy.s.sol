// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SherwoodOracle} from "../src/SherwoodOracle.sol";
import {SherwoodFactory} from "../src/SherwoodFactory.sol";
import {KinkedIrm} from "../src/KinkedIrm.sol";

/// @notice Deploys the three pieces every market needs: the oracle, one shared rate curve, and the
///         factory. Markets themselves are created afterwards by `CreateMarket`, so that adding a
///         ticker never involves redeploying anything shared.
///
/// Usage:
///   forge script script/Deploy.s.sol:Deploy --rpc-url $RHC_RPC_URL --broadcast \
///     --private-key $DEPLOYER_KEY
///
/// Env:
///   OWNER          address that may configure assets and rotate reporters
///   USDG           the stable every price is denominated in
///   REPORTERS      comma-separated reporter addresses
///   QUORUM         signatures required per quote
contract Deploy is Script {
    function run() external {
        address owner = vm.envAddress("OWNER");
        address usdg = vm.envAddress("USDG");
        address[] memory reporters = vm.envAddress("REPORTERS", ",");
        uint256 quorum = vm.envUint("QUORUM");

        vm.startBroadcast();
        SherwoodOracle oracle = new SherwoodOracle(owner, usdg, reporters, quorum);
        // 2% base, +10% to a 90% kink, +150% above it: cheap while there is liquidity to borrow and
        // punitive once the last of it is being taken.
        KinkedIrm irm = new KinkedIrm(0.02e18, 0.10e18, 1.5e18, 0.90e18);
        SherwoodFactory factory = new SherwoodFactory();
        vm.stopBroadcast();

        console2.log("SherwoodOracle ", address(oracle));
        console2.log("KinkedIrm      ", address(irm));
        console2.log("SherwoodFactory", address(factory));
    }
}
