// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SherwoodFactory} from "../src/SherwoodFactory.sol";
import {SherwoodMarket} from "../src/SherwoodMarket.sol";

/// @notice Creates one isolated market. Prints the deterministic address first, so the terms can be
///         checked against the address anyone else would compute for them.
///
/// Env: FACTORY, COLLATERAL, LOAN_TOKEN, ORACLE, IRM, LLTV, LIQ_BONUS_BPS, CLOSE_FACTOR_BPS,
///      GRACE_WINDOW, FEE, FEE_RECIPIENT
contract CreateMarket is Script {
    function run() external {
        SherwoodFactory factory = SherwoodFactory(vm.envAddress("FACTORY"));
        SherwoodMarket.ConstructorParams memory p = SherwoodMarket.ConstructorParams({
            collateral: vm.envAddress("COLLATERAL"),
            loanToken: vm.envAddress("LOAN_TOKEN"),
            oracle: vm.envAddress("ORACLE"),
            irm: vm.envAddress("IRM"),
            lltv: vm.envOr("LLTV", uint256(0.70e18)),
            liqBonusBps: vm.envOr("LIQ_BONUS_BPS", uint256(700)),
            closeFactorBps: vm.envOr("CLOSE_FACTOR_BPS", uint256(5000)),
            graceWindow: vm.envOr("GRACE_WINDOW", uint256(4 hours)),
            fee: vm.envOr("FEE", uint256(0)),
            feeRecipient: vm.envOr("FEE_RECIPIENT", address(0))
        });

        console2.log("predicted", factory.predict(p));
        vm.startBroadcast();
        address market = factory.createMarket(p);
        vm.stopBroadcast();
        console2.log("market   ", market);
    }
}
