// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Why a price is or is not usable. Anything other than `OK` means consumers must not
///         liquidate and must not let new risk be taken against the asset.
enum PriceStatus {
    OK,
    NoConfig,
    NoQuote,
    QuoteStale,
    TokenPaused,
    IssuerOraclePaused,
    TwapUnavailable,
    TwapDeviation,
    MultiplierTransition,
    BasketDegraded
}

/// @notice The equity session an attested quote was observed in. `Closed` is ordinary (US equities
///         close nightly and on weekends); `Halted` means the listing itself stopped trading.
enum Session {
    Closed,
    Pre,
    Regular,
    Post,
    Halted
}

interface ISherwoodOracle {
    /// @notice USDG per raw token unit, scaled by 1e26. Reverts unless the status is `OK`.
    function priceRawX26(address asset) external view returns (uint256);

    /// @notice Price and status together. Never reverts, so risk engines can branch on the reason.
    function peek(address asset) external view returns (uint256 rawX26, PriceStatus status);

    /// @notice Dollar value of `rawAmount` units of `asset`, at 1e8. Reverts unless the status is `OK`.
    function valueOf(address asset, uint256 rawAmount) external view returns (uint256 usd1e8);

    /// @notice Dollar value that never reverts; `ok` is false when the price is unusable.
    function tryValueOf(address asset, uint256 rawAmount)
        external
        view
        returns (uint256 usd1e8, bool ok, PriceStatus status);

    /// @notice The equity session of the most recent attested quote.
    function sessionOf(address asset) external view returns (Session);

    /// @notice Let the oracle record anything it needs before a risk decision is taken against it.
    /// @dev A no-op for feeds whose price is fully derivable in a view. Basket pricing is not: the
    ///      relative value of each constituent has to be checkpointed while all of them are live, so
    ///      that a later halt can be costed at its real weight rather than guessed at. Consumers call
    ///      this at the top of every state-changing entry point, which keeps the checkpoint as fresh
    ///      as the protocol's own activity without anyone having to run a keeper for it.
    function poke(address asset) external;
}
