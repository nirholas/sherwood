// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {ECDSA} from "solady/utils/ECDSA.sol";
import {EIP712} from "solady/utils/EIP712.sol";
import {Ownable} from "solady/auth/Ownable.sol";

import {IStockToken} from "./interfaces/IStockToken.sol";
import {IUniswapV3PoolOracle} from "./interfaces/IUniswapV3PoolOracle.sol";
import {ISherwoodOracle, PriceStatus, Session} from "./interfaces/ISherwoodOracle.sol";

/// @title SherwoodOracle
/// @notice A price feed for Robinhood Chain's tokenized equities that is safe to liquidate against.
///
/// @dev Three ideas, in order of importance.
///
///      1. THE TRADABLE PRICE IS THE PRIMARY SOURCE. A liquidator seizes stock tokens and sells them
///         into a Uniswap pool on this chain. What they can realize there, not what the share prints
///         for on the NYSE, is what makes a liquidation solvent. So the settlement price is the pool
///         TWAP, and the attested off-chain equity quote is only a bound on it. That ordering is the
///         opposite of the usual "trusted signer publishes, chain believes" oracle, and it means a
///         compromised reporter cannot mint value out of nothing: it can only refuse to confirm.
///
///      2. TWO INDEPENDENT SOURCES MUST AGREE OR NOTHING IS SERVED. Manipulating the pool moves the
///         TWAP away from the attested quote and the feed goes dark; compromising the reporters moves
///         the quote away from the TWAP and the feed goes dark. Neither alone can move the price. The
///         tolerated gap widens outside US market hours, because a token that trades 24/7 legitimately
///         reprices ahead of an open that has not happened yet.
///
///      3. CORPORATE ACTIONS ARE READ FROM THE TOKEN, NOT FROM A HUMAN. Every Robinhood stock token
///         publishes a `uiMultiplier`, and publishes the *next* one with the second it takes effect.
///         That gives this oracle something no mainnet feed has: advance, on-chain notice of a split.
///         It is used twice. Before the change, the price is haircut by the pending ratio whenever the
///         multiplier is about to fall, so nobody borrows against value that is scheduled to vanish.
///         For one TWAP window after the change, the feed reports `MultiplierTransition` and serves
///         nothing at all, because a moving average that straddles a 10-for-1 split is a blend of two
///         incompatible prices and is wrong by up to the split ratio. A protocol that missed this
///         would liquidate its entire book at a tenth of fair value the morning after a reverse split.
contract SherwoodOracle is ISherwoodOracle, EIP712, Ownable {
    using FixedPointMathLib for uint256;
    using FixedPointMathLib for int256;

    /// @dev ln(1.0001) in wad. Ticks are converted with exp(tick * ln(1.0001)) rather than by
    ///      vendoring Uniswap's tick tables, which are GPL-licensed.
    int256 internal constant LN_TICK_BASE = 99995000333308;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    struct AssetConfig {
        /// @notice Uniswap v3 pool quoting this asset against `quoteToken`.
        address pool;
        /// @notice True when the asset is the pool's token0.
        bool assetIsToken0;
        /// @notice Must be the stable this oracle denominates in.
        address quoteToken;
        uint8 quoteDecimals;
        uint8 assetDecimals;
        /// @notice TWAP look-back in seconds. Also the blackout length after a corporate action.
        uint32 twapWindow;
        /// @notice Tolerated TWAP-versus-quote gap while the US equity session is open.
        uint16 maxDeviationBps;
        /// @notice Tolerated gap while it is closed, pre-market or post-market.
        uint16 offHoursDeviationBps;
        /// @notice Age past which an attested quote no longer bounds anything.
        uint32 maxQuoteAge;
        bool enabled;
    }

    struct Quote {
        /// @notice USD per whole share, 1e8. This is the share price, not the token price.
        uint128 price;
        /// @notice Exchange timestamp the quote was observed at.
        uint64 observedAt;
        /// @notice Chain timestamp the quote landed at.
        uint64 publishedAt;
        /// @notice Strictly increasing per asset; replays and reorderings are rejected.
        uint64 nonce;
        uint8 session;
    }

    /// @notice The stable every price is denominated in. Markets lend it, so a depeg moves both
    ///         sides of a loan-to-value ratio together and cancels out.
    address public immutable QUOTE_STABLE;

    mapping(address => AssetConfig) internal _configs;
    mapping(address => Quote) internal _quotes;
    mapping(address => bool) public isReporter;
    uint256 public reporterCount;
    /// @notice Distinct reporter signatures required to accept a quote.
    uint256 public quorum;

    bytes32 internal constant PRICE_REPORT_TYPEHASH = keccak256(
        "PriceReport(address asset,uint256 price,uint64 observedAt,uint8 session,uint64 nonce,uint256 chainId)"
    );

    event AssetConfigured(address indexed asset, AssetConfig config);
    event AssetRemoved(address indexed asset);
    event ReporterSet(address indexed reporter, bool allowed);
    event QuorumSet(uint256 quorum);
    event QuotePosted(address indexed asset, uint256 price, uint64 observedAt, uint8 session, uint64 nonce);

    error NotConfigured(address asset);
    error PriceUnusable(address asset, PriceStatus status);
    error QuorumNotMet(uint256 got, uint256 want);
    error SignaturesUnsorted();
    error NotAReporter(address signer);
    error StaleNonce(address asset, uint64 got, uint64 have);
    error QuoteInFuture();
    error BadConfig();
    error QuorumTooHigh();

    /// @dev The reporter set is supplied at construction rather than added afterwards. An oracle that
    ///      exists for even one block with a quorum larger than its reporter set is an oracle that
    ///      cannot be reached, and the only way out of that state would be an owner call, which is
    ///      exactly the moment an owner key is most worth attacking.
    constructor(address owner_, address quoteStable, address[] memory reporters, uint256 quorum_) {
        if (quoteStable == address(0) || quorum_ == 0) revert BadConfig();
        if (quorum_ > reporters.length) revert QuorumTooHigh();
        _initializeOwner(owner_);
        QUOTE_STABLE = quoteStable;
        uint256 n = reporters.length;
        for (uint256 i; i < n; ++i) {
            address r = reporters[i];
            if (r == address(0) || isReporter[r]) revert BadConfig();
            isReporter[r] = true;
            emit ReporterSet(r, true);
        }
        reporterCount = n;
        quorum = quorum_;
        emit QuorumSet(quorum_);
    }

    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("SherwoodOracle", "1");
    }

    // ---------------------------------------------------------------- admin

    function configureAsset(address asset, AssetConfig calldata cfg) external onlyOwner {
        if (cfg.pool == address(0) || cfg.quoteToken != QUOTE_STABLE) revert BadConfig();
        if (cfg.twapWindow == 0 || cfg.maxQuoteAge == 0) revert BadConfig();
        if (cfg.maxDeviationBps == 0 || cfg.maxDeviationBps > BPS) revert BadConfig();
        if (cfg.offHoursDeviationBps < cfg.maxDeviationBps || cfg.offHoursDeviationBps > BPS) revert BadConfig();
        address t0 = IUniswapV3PoolOracle(cfg.pool).token0();
        address t1 = IUniswapV3PoolOracle(cfg.pool).token1();
        // The declared orientation has to match the pool, or every price would be inverted.
        if (cfg.assetIsToken0) {
            if (t0 != asset || t1 != cfg.quoteToken) revert BadConfig();
        } else {
            if (t1 != asset || t0 != cfg.quoteToken) revert BadConfig();
        }
        if (cfg.assetDecimals != IStockToken(asset).decimals()) revert BadConfig();
        _configs[asset] = cfg;
        emit AssetConfigured(asset, cfg);
    }

    function removeAsset(address asset) external onlyOwner {
        delete _configs[asset];
        emit AssetRemoved(asset);
    }

    function setReporter(address reporter, bool allowed) external onlyOwner {
        if (reporter == address(0)) revert BadConfig();
        if (isReporter[reporter] == allowed) return;
        isReporter[reporter] = allowed;
        unchecked {
            reporterCount = allowed ? reporterCount + 1 : reporterCount - 1;
        }
        // Adding is always safe; removing must not strand the quorum above the set that can meet it.
        if (!allowed && reporterCount < quorum) revert QuorumTooHigh();
        emit ReporterSet(reporter, allowed);
    }

    function setQuorum(uint256 quorum_) external onlyOwner {
        if (quorum_ == 0 || quorum_ > reporterCount) revert QuorumTooHigh();
        quorum = quorum_;
        emit QuorumSet(quorum_);
    }

    function config(address asset) external view returns (AssetConfig memory) {
        return _configs[asset];
    }

    function quote(address asset) external view returns (Quote memory) {
        return _quotes[asset];
    }

    // ------------------------------------------------------------- quote in

    struct PriceReport {
        address asset;
        uint256 price;
        uint64 observedAt;
        uint8 session;
        uint64 nonce;
    }

    function hashReport(PriceReport calldata r) public view returns (bytes32) {
        return _hashTypedData(
            keccak256(
                abi.encode(PRICE_REPORT_TYPEHASH, r.asset, r.price, r.observedAt, r.session, r.nonce, block.chainid)
            )
        );
    }

    /// @notice Accept a quote carrying at least `quorum` distinct reporter signatures.
    /// @dev Signatures must be ordered by ascending recovered address. That makes duplicate-signer
    ///      detection a single comparison per signature instead of a nested loop, so a large reporter
    ///      set stays cheap, and it makes the ordering a caller responsibility rather than a gas cost
    ///      every poster pays forever.
    function postQuote(PriceReport calldata r, bytes[] calldata signatures) public {
        AssetConfig memory cfg = _configs[r.asset];
        if (!cfg.enabled) revert NotConfigured(r.asset);
        if (r.observedAt > block.timestamp) revert QuoteInFuture();
        Quote memory prev = _quotes[r.asset];
        if (r.nonce <= prev.nonce) revert StaleNonce(r.asset, r.nonce, prev.nonce);
        if (r.price == 0 || r.price > type(uint128).max) revert BadConfig();
        if (r.session > uint8(Session.Halted)) revert BadConfig();

        bytes32 digest = hashReport(r);
        address last;
        uint256 n = signatures.length;
        for (uint256 i; i < n; ++i) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (signer <= last) revert SignaturesUnsorted();
            if (!isReporter[signer]) revert NotAReporter(signer);
            last = signer;
        }
        if (n < quorum) revert QuorumNotMet(n, quorum);

        _quotes[r.asset] = Quote({
            price: uint128(r.price),
            observedAt: r.observedAt,
            publishedAt: uint64(block.timestamp),
            nonce: r.nonce,
            session: r.session
        });
        emit QuotePosted(r.asset, r.price, r.observedAt, r.session, r.nonce);
    }

    /// @notice Post several assets in one transaction. Reporters run on a schedule, so batching is
    ///         the normal path and per-asset posting is the exception.
    function postQuotes(PriceReport[] calldata reports, bytes[][] calldata signatures) external {
        uint256 n = reports.length;
        if (n != signatures.length) revert BadConfig();
        for (uint256 i; i < n; ++i) {
            postQuote(reports[i], signatures[i]);
        }
    }

    // --------------------------------------------------------------- prices

    function priceRawX26(address asset) public view returns (uint256) {
        (uint256 p, PriceStatus s) = peek(asset);
        if (s != PriceStatus.OK) revert PriceUnusable(asset, s);
        return p;
    }

    function valueOf(address asset, uint256 rawAmount) external view returns (uint256) {
        return FixedPointMathLib.fullMulDiv(rawAmount, priceRawX26(asset), WAD);
    }

    function tryValueOf(address asset, uint256 rawAmount)
        external
        view
        returns (uint256 usd1e8, bool ok, PriceStatus status)
    {
        uint256 p;
        (p, status) = peek(asset);
        ok = status == PriceStatus.OK;
        if (ok) usd1e8 = FixedPointMathLib.fullMulDiv(rawAmount, p, WAD);
    }

    function sessionOf(address asset) external view returns (Session) {
        return Session(_quotes[asset].session);
    }

    /// @notice Nothing to record: every input to a single-asset price is readable in a view.
    function poke(address) external pure {}

    /// @notice The full price decision, with the reason attached. Never reverts.
    function peek(address asset) public view returns (uint256 rawX26, PriceStatus status) {
        AssetConfig memory cfg = _configs[asset];
        if (!cfg.enabled) return (0, PriceStatus.NoConfig);

        Quote memory q = _quotes[asset];
        if (q.publishedAt == 0) return (0, PriceStatus.NoQuote);
        if (block.timestamp > q.publishedAt + cfg.maxQuoteAge) return (0, PriceStatus.QuoteStale);

        IStockToken tok = IStockToken(asset);
        // A frozen token cannot be seized, so a price for it would only invite a liquidation that
        // reverts. An issuer that has disavowed its own price gets taken at its word.
        if (tok.paused()) return (0, PriceStatus.TokenPaused);
        if (tok.oraclePaused()) return (0, PriceStatus.IssuerOraclePaused);

        uint256 multiplier = tok.uiMultiplier();
        uint256 pending = tok.newUIMultiplier();
        uint256 effAt = tok.effectiveAt();

        // A corporate action inside the look-back leaves the average straddling the jump. Serve
        // nothing until the window has rolled past it.
        //
        // Note the condition deliberately does not compare the live and pending multipliers. Once
        // `effectiveAt` passes, `uiMultiplier()` already returns the new value and the two are equal,
        // so a check for "they differ" is false during precisely the window it is meant to cover.
        // A non-zero `effectiveAt` inside the last window is the whole signal.
        if (effAt != 0 && block.timestamp >= effAt && block.timestamp < effAt + cfg.twapWindow) {
            return (0, PriceStatus.MultiplierTransition);
        }

        (uint256 twapX26, bool twapOk) = _twapRawX26(cfg);
        if (!twapOk) return (0, PriceStatus.TwapUnavailable);

        // Attested share price restated per raw token unit, so the two sources are comparable.
        uint256 attestedX26 = FixedPointMathLib.fullMulDiv(q.price, multiplier, 10 ** cfg.assetDecimals);
        if (attestedX26 == 0) return (0, PriceStatus.TwapDeviation);

        uint16 band = Session(q.session) == Session.Regular ? cfg.maxDeviationBps : cfg.offHoursDeviationBps;
        uint256 diff = twapX26 > attestedX26 ? twapX26 - attestedX26 : attestedX26 - twapX26;
        if (diff * BPS > attestedX26 * band) return (0, PriceStatus.TwapDeviation);

        // A scheduled fall in the multiplier is a scheduled fall in what a raw unit is worth. Apply
        // it the moment it is announced rather than the moment it lands.
        if (effAt > block.timestamp && pending != 0 && pending < multiplier) {
            twapX26 = FixedPointMathLib.fullMulDiv(twapX26, pending, multiplier);
        }
        return (twapX26, PriceStatus.OK);
    }

    /// @notice The raw pool TWAP with no attestation check applied, for interfaces and for anyone
    ///         wanting to see how far the two sources currently sit apart.
    function twapRawX26(address asset) external view returns (uint256 rawX26, bool ok) {
        AssetConfig memory cfg = _configs[asset];
        if (!cfg.enabled) return (0, false);
        return _twapRawX26(cfg);
    }

    /// @notice The pool TWAP as USDG per raw asset unit, scaled 1e26.
    function _twapRawX26(AssetConfig memory cfg) internal view returns (uint256, bool) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = cfg.twapWindow;
        ago[1] = 0;
        int56[] memory cums;
        try IUniswapV3PoolOracle(cfg.pool).observe(ago) returns (int56[] memory c, uint160[] memory) {
            cums = c;
        } catch {
            // The pool has not retained enough observations for this window.
            return (0, false);
        }

        int56 delta = cums[1] - cums[0];
        int56 window = int56(uint56(cfg.twapWindow));
        int56 mean = delta / window;
        // Uniswap's convention: always round the average tick toward negative infinity.
        if (delta < 0 && (delta % window != 0)) mean--;
        // A pool returning cumulatives outside the real tick range is malfunctioning or hostile;
        // truncating into int24 would wrap it into a plausible-looking price.
        if (mean > 887272 || mean < -887272) return (0, false);
        // forge-lint: disable-next-line(unsafe-typecast) bounded to the tick range immediately above
        int24 tick = int24(mean);

        // quote raw units per asset raw unit, in wad.
        uint256 ratioWad = uint256(FixedPointMathLib.expWad(int256(tick) * LN_TICK_BASE));
        if (!cfg.assetIsToken0) {
            if (ratioWad == 0) return (0, false);
            ratioWad = FixedPointMathLib.fullMulDiv(WAD, WAD, ratioWad);
        }
        if (ratioWad == 0) return (0, false);
        return (FixedPointMathLib.fullMulDiv(ratioWad, 1e8, 10 ** cfg.quoteDecimals), true);
    }

    /// @notice Price of one whole share at 1e8, for interfaces. Risk math uses `priceRawX26`.
    function pricePerShare1e8(address asset) external view returns (uint256) {
        AssetConfig memory cfg = _configs[asset];
        if (!cfg.enabled) revert NotConfigured(asset);
        uint256 raw = priceRawX26(asset);
        uint256 multiplier = IStockToken(asset).uiMultiplier();
        return FixedPointMathLib.fullMulDiv(raw, 10 ** cfg.assetDecimals, multiplier);
    }

    /// @notice The multiplier a risk engine should use: the pending one as soon as it is lower.
    function conservativeMultiplier(address asset) public view returns (uint256) {
        IStockToken tok = IStockToken(asset);
        uint256 m = tok.uiMultiplier();
        uint256 n = tok.newUIMultiplier();
        uint256 e = tok.effectiveAt();
        if (e > block.timestamp && n != 0 && n < m) return n;
        return m;
    }
}
