// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {Ownable} from "solady/auth/Ownable.sol";

import {SherwoodBasket} from "./SherwoodBasket.sol";
import {ISherwoodOracle, PriceStatus, Session} from "./interfaces/ISherwoodOracle.sol";

/// @title SherwoodBasketOracle
/// @notice Prices a `SherwoodBasket` from the per-constituent feed, and prices it honestly when part
///         of the basket has gone dark.
///
/// @dev The naive answer to "one constituent halted" is to refuse to price the basket at all. That is
///      exactly backwards: it makes a ten-name basket ten times more likely to freeze than a single
///      ticker, and destroys the reason to hold one. The other naive answer, carrying the halted name
///      at its last price, is worse: it is the assumption that broke every lending protocol that ever
///      trusted a stale feed through a gap.
///
///      This oracle takes the only remaining honest position. A halted constituent is worth zero to
///      this valuation. The basket is priced on what can be seen and sold right now, so the number it
///      reports is always a floor on what the basket is really worth, and a borrower can never gain
///      from a halt. The stored weights exist to answer the separate question of how much of the
///      basket has gone dark: when that share crosses the configured tolerance, too little of the
///      collateral is observable to lend against and the basket is reported degraded, which puts the
///      market into the same halt shield a single-asset market uses.
///
///      Weights are checkpointed by `poke`, which markets call on every state-changing entry point.
///      Sixteen constituents at sixteen bits each fit in one word, so a checkpoint is one store.
contract SherwoodBasketOracle is ISherwoodOracle, Ownable {
    using FixedPointMathLib for uint256;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    /// @notice The per-asset feed that prices constituents.
    ISherwoodOracle public immutable BASE;

    struct BasketConfig {
        /// @notice Share of basket value, in bps, that may be dark before lending is suspended.
        uint16 maxDarkBps;
        /// @notice Age past which a weight checkpoint is too old to cost a halt against.
        uint32 maxCheckpointAge;
        bool enabled;
    }

    struct Checkpoint {
        /// @notice Value weight of each constituent in bps, packed 16 bits per constituent.
        uint256 packedWeightsBps;
        uint64 at;
    }

    mapping(address => BasketConfig) internal _configs;
    mapping(address => Checkpoint) internal _checkpoints;

    event BasketConfigured(address indexed basket, BasketConfig config);
    event BasketRemoved(address indexed basket);
    event CheckpointWritten(address indexed basket, uint256 packedWeightsBps, uint64 at);

    error NotConfigured(address basket);
    error PriceUnusable(address basket, PriceStatus status);
    error BadConfig();

    constructor(address owner_, address base) {
        if (base == address(0)) revert BadConfig();
        _initializeOwner(owner_);
        BASE = ISherwoodOracle(base);
    }

    function configureBasket(address basket, BasketConfig calldata cfg) external onlyOwner {
        if (cfg.maxDarkBps > BPS / 2) revert BadConfig();
        if (cfg.maxCheckpointAge == 0) revert BadConfig();
        if (SherwoodBasket(basket).constituentCount() == 0) revert BadConfig();
        _configs[basket] = cfg;
        emit BasketConfigured(basket, cfg);
    }

    function removeBasket(address basket) external onlyOwner {
        delete _configs[basket];
        emit BasketRemoved(basket);
    }

    function config(address basket) external view returns (BasketConfig memory) {
        return _configs[basket];
    }

    function checkpoint(address basket) external view returns (Checkpoint memory) {
        return _checkpoints[basket];
    }

    /// @notice Record the current value split across constituents, if all of them are priceable.
    /// @dev Silently does nothing when any constituent is dark. A checkpoint taken during a halt would
    ///      record the halted name at zero weight and then declare that nothing is dark, which is the
    ///      one failure that would let a degraded basket keep borrowing.
    function poke(address basket) public {
        BasketConfig memory cfg = _configs[basket];
        if (!cfg.enabled) return;
        SherwoodBasket b = SherwoodBasket(basket);
        uint256 n = b.constituentCount();

        uint256[] memory values = new uint256[](n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            address token = b.tokenAt(i);
            (uint256 v, bool ok,) = BASE.tryValueOf(token, b.backing(token));
            if (!ok) return;
            values[i] = v;
            total += v;
        }
        if (total == 0) return;

        uint256 packed;
        for (uint256 i; i < n; ++i) {
            uint256 w = values[i].mulDiv(BPS, total);
            if (w > type(uint16).max) w = type(uint16).max;
            packed |= w << (i * 16);
        }
        _checkpoints[basket] = Checkpoint({packedWeightsBps: packed, at: uint64(block.timestamp)});
        emit CheckpointWritten(basket, packed, uint64(block.timestamp));
    }

    function peek(address basket) public view returns (uint256 rawX26, PriceStatus status) {
        BasketConfig memory cfg = _configs[basket];
        if (!cfg.enabled) return (0, PriceStatus.NoConfig);

        SherwoodBasket b = SherwoodBasket(basket);
        uint256 supply = b.totalSupply();
        if (supply == 0) return (0, PriceStatus.NoQuote);

        Checkpoint memory cp = _checkpoints[basket];
        if (cp.at == 0) return (0, PriceStatus.NoQuote);
        if (block.timestamp > cp.at + cfg.maxCheckpointAge) return (0, PriceStatus.QuoteStale);

        uint256 n = b.constituentCount();
        uint256 liveValue;
        uint256 darkBps;
        PriceStatus firstDark = PriceStatus.OK;
        for (uint256 i; i < n; ++i) {
            address token = b.tokenAt(i);
            (uint256 v, bool ok, PriceStatus s) = BASE.tryValueOf(token, b.backing(token));
            if (ok) {
                liveValue += v;
            } else {
                darkBps += (cp.packedWeightsBps >> (i * 16)) & 0xffff;
                if (firstDark == PriceStatus.OK) firstDark = s;
            }
        }

        if (darkBps > cfg.maxDarkBps) return (0, PriceStatus.BasketDegraded);
        if (liveValue == 0) return (0, firstDark == PriceStatus.OK ? PriceStatus.NoQuote : firstDark);

        // Value per raw basket unit, scaled to the 1e26 convention the single-asset feed uses.
        return (liveValue.mulDiv(WAD, supply), PriceStatus.OK);
    }

    function priceRawX26(address basket) public view returns (uint256) {
        (uint256 p, PriceStatus s) = peek(basket);
        if (s != PriceStatus.OK) revert PriceUnusable(basket, s);
        return p;
    }

    function valueOf(address basket, uint256 rawAmount) external view returns (uint256) {
        return FixedPointMathLib.fullMulDiv(rawAmount, priceRawX26(basket), WAD);
    }

    function tryValueOf(address basket, uint256 rawAmount)
        external
        view
        returns (uint256 usd1e8, bool ok, PriceStatus status)
    {
        uint256 p;
        (p, status) = peek(basket);
        ok = status == PriceStatus.OK;
        if (ok) usd1e8 = FixedPointMathLib.fullMulDiv(rawAmount, p, WAD);
    }

    /// @notice The least advanced session across the basket's constituents.
    /// @dev A basket is only as open as its most closed name, which is what a risk engine wants to
    ///      know before it widens a deviation band.
    function sessionOf(address basket) external view returns (Session) {
        SherwoodBasket b = SherwoodBasket(basket);
        uint256 n = b.constituentCount();
        Session worst = Session.Regular;
        for (uint256 i; i < n; ++i) {
            Session s = BASE.sessionOf(b.tokenAt(i));
            if (s == Session.Halted) return Session.Halted;
            if (uint8(s) < uint8(worst)) worst = s;
        }
        return worst;
    }

    /// @notice Share of basket value that currently has no usable price, in bps.
    function darkBpsOf(address basket) external view returns (uint256 darkBps) {
        SherwoodBasket b = SherwoodBasket(basket);
        Checkpoint memory cp = _checkpoints[basket];
        uint256 n = b.constituentCount();
        for (uint256 i; i < n; ++i) {
            address token = b.tokenAt(i);
            (,, PriceStatus s) = BASE.tryValueOf(token, b.backing(token));
            if (s != PriceStatus.OK) darkBps += (cp.packedWeightsBps >> (i * 16)) & 0xffff;
        }
    }
}
