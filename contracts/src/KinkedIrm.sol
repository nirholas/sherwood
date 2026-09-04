// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {IIrm} from "./interfaces/IIrm.sol";

/// @title KinkedIrm
/// @notice A two-slope utilization curve, immutable once deployed.
/// @dev Deliberately boring. The interesting risk behaviour in this protocol lives in the oracle and
///      in the market's halt shield; an interest curve that can be re-parameterised by an owner is a
///      lever an attacker can pull, so this one cannot be changed after deployment. One instance is
///      shared by every market that wants the same curve.
contract KinkedIrm is IIrm {
    using FixedPointMathLib for uint256;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    /// @notice Annual rate at zero utilization, wad.
    uint256 public immutable BASE_RATE;
    /// @notice Additional annual rate accrued between zero utilization and the kink, wad.
    uint256 public immutable SLOPE_1;
    /// @notice Additional annual rate accrued between the kink and full utilization, wad.
    uint256 public immutable SLOPE_2;
    /// @notice Utilization the curve steepens at, wad.
    uint256 public immutable KINK;

    error BadParams();

    constructor(uint256 baseRate, uint256 slope1, uint256 slope2, uint256 kink) {
        if (kink == 0 || kink >= WAD) revert BadParams();
        // A curve that can exceed 1000% APR at the top is a liquidation engine, not a rate model.
        if (baseRate + slope1 + slope2 > 10 * WAD) revert BadParams();
        BASE_RATE = baseRate;
        SLOPE_1 = slope1;
        SLOPE_2 = slope2;
        KINK = kink;
    }

    function utilization(uint256 totalSupplyAssets, uint256 totalBorrowAssets) public pure returns (uint256) {
        if (totalSupplyAssets == 0) return 0;
        uint256 u = totalBorrowAssets.divWad(totalSupplyAssets);
        return u > WAD ? WAD : u;
    }

    /// @notice Annualized borrow rate in wad at the given balances.
    function borrowRatePerYear(uint256 totalSupplyAssets, uint256 totalBorrowAssets) public view returns (uint256) {
        uint256 u = utilization(totalSupplyAssets, totalBorrowAssets);
        if (u <= KINK) {
            return BASE_RATE + SLOPE_1.mulDiv(u, KINK);
        }
        return BASE_RATE + SLOPE_1 + SLOPE_2.mulDiv(u - KINK, WAD - KINK);
    }

    function borrowRatePerSecond(uint256 totalSupplyAssets, uint256 totalBorrowAssets)
        external
        view
        returns (uint256)
    {
        return borrowRatePerYear(totalSupplyAssets, totalBorrowAssets) / SECONDS_PER_YEAR;
    }
}
