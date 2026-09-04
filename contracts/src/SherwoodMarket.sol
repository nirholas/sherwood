// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";

import {IIrm} from "./interfaces/IIrm.sol";
import {IStockToken} from "./interfaces/IStockToken.sol";
import {ISherwoodOracle, PriceStatus} from "./interfaces/ISherwoodOracle.sol";

/// @title SherwoodMarket
/// @notice One isolated lending market: a single tokenized equity as collateral, USDG as the loan.
///
/// @dev WHY ISOLATED. Tokenized equities do not share a risk profile with each other. Any one ticker
///      can halt on its own, and a halted ticker cannot be liquidated at any price. In a pooled
///      design that one name's frozen bad debt is socialised across every depositor in the protocol,
///      including people who never wanted exposure to it. Here a halt is contained to the market that
///      chose that collateral.
///
/// @dev THE HALT SHIELD. This is the part that does not exist in any lending protocol built for
///      always-on assets, and it is the reason a naive fork of one would be insolvent here.
///
///      When a Robinhood stock token pauses, `transfer` reverts. A liquidator therefore cannot seize
///      collateral, and no amount of incentive changes that: the transaction cannot succeed. Interest,
///      meanwhile, keeps compounding. A market that ignores this accrues debt through a two-day
///      trading halt against borrowers who were never given a chance to repay or to top up, and then
///      at the unpause every one of them is underwater simultaneously, at a price that gapped while
///      nobody could act. The first liquidator in the block takes the whole book at a discount.
///
///      So while the collateral is unpriceable this market:
///        * stops accruing interest entirely, rather than charging for time nobody could act in;
///        * refuses new borrows and collateral withdrawals, because health cannot be evaluated;
///        * keeps supply and repayment open, because those only ever reduce risk.
///
///      And when the price comes back it does not simply resume. A grace window opens in which the
///      liquidation bonus ramps from zero to its configured value. At the first second there is no
///      profit in liquidating, so nobody does, and a borrower who was frozen out gets a real chance
///      to cure at the new price. By the end of the window the full incentive is back and the market
///      clears normally. The protocol gives up some liquidation speed in exchange for not confiscating
///      positions over an event the borrower could not respond to.
///
/// @dev NO ADMIN. Parameters are immutable, set once at construction by the factory. There is no
///      owner, no pause, no upgrade path and no way for anyone to change the rules under a position
///      that is already open. The only way to change terms is to deploy a new market.
contract SherwoodMarket is ReentrancyGuard {
    using FixedPointMathLib for uint256;
    using SafeTransferLib for address;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    /// @dev Virtual shares make the first deposit's exchange rate impossible to skew, which is the
    ///      classic donation attack on an empty share-based pool.
    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    // ------------------------------------------------------------ immutables

    address public immutable COLLATERAL;
    address public immutable LOAN_TOKEN;
    ISherwoodOracle public immutable ORACLE;
    IIrm public immutable IRM;
    /// @notice Loan-to-value at which a position becomes liquidatable, wad.
    uint256 public immutable LLTV;
    /// @notice Discount a liquidator receives on seized collateral, once fully ramped.
    uint256 public immutable LIQ_BONUS_BPS;
    /// @notice Largest share of a position's debt one liquidation may repay.
    uint256 public immutable CLOSE_FACTOR_BPS;
    /// @notice How long the liquidation bonus takes to ramp back after a halt clears.
    uint256 public immutable GRACE_WINDOW;
    /// @notice Share of accrued interest paid to `FEE_RECIPIENT`, in wad.
    uint256 public immutable FEE;
    address public immutable FEE_RECIPIENT;

    // ---------------------------------------------------------------- state

    struct Position {
        uint128 supplyShares;
        uint128 borrowShares;
        uint128 collateral;
    }

    uint128 public totalSupplyAssets;
    uint128 public totalSupplyShares;
    uint128 public totalBorrowAssets;
    uint128 public totalBorrowShares;
    uint64 public lastAccrual;
    /// @notice Timestamp the liquidation bonus finishes ramping back in. Zero when not ramping.
    uint64 public graceUntil;
    /// @notice True while the collateral has no usable price.
    bool public shielded;

    mapping(address => Position) public positions;

    event Supply(address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares);
    event Withdraw(address indexed caller, address indexed onBehalf, address indexed to, uint256 assets, uint256 shares);
    event SupplyCollateral(address indexed caller, address indexed onBehalf, uint256 assets);
    event WithdrawCollateral(address indexed caller, address indexed onBehalf, address indexed to, uint256 assets);
    event Borrow(address indexed caller, address indexed onBehalf, address indexed to, uint256 assets, uint256 shares);
    event Repay(address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares);
    event Liquidate(
        address indexed liquidator,
        address indexed borrower,
        uint256 repaidAssets,
        uint256 repaidShares,
        uint256 seizedCollateral,
        uint256 bonusBps,
        uint256 badDebtAssets
    );
    event AccrueInterest(uint256 interest, uint256 feeShares);
    event Shielded(PriceStatus reason);
    event Unshielded(uint64 graceUntil);
    event BadDebtSocialized(address indexed borrower, uint256 assets);

    error ZeroAmount();
    error InconsistentInput();
    error Unhealthy();
    error Healthy();
    error InsufficientLiquidity();
    error MarketShielded(PriceStatus reason);
    error NotAuthorized();
    error BadParams();
    error Overflow();

    struct ConstructorParams {
        address collateral;
        address loanToken;
        address oracle;
        address irm;
        uint256 lltv;
        uint256 liqBonusBps;
        uint256 closeFactorBps;
        uint256 graceWindow;
        uint256 fee;
        address feeRecipient;
    }

    constructor(ConstructorParams memory p) {
        if (p.collateral == address(0) || p.loanToken == address(0)) revert BadParams();
        if (p.oracle == address(0) || p.irm == address(0)) revert BadParams();
        // Above 98% there is no room left for a liquidation bonus, so the position can only ever be
        // closed at a loss to depositors.
        if (p.lltv == 0 || p.lltv > 0.98e18) revert BadParams();
        if (p.liqBonusBps == 0 || p.liqBonusBps > 2_000) revert BadParams();
        if (p.closeFactorBps == 0 || p.closeFactorBps > BPS) revert BadParams();
        // A bonus that can push a just-liquidatable position underwater turns every liquidation into
        // an immediate bad-debt event. Both sides are multiplied out rather than reduced, because the
        // LLTV is a wad and the bonus is in basis points and mixing the two scales silently compares
        // a five-digit number against 1e18 and passes everything.
        if (p.lltv * (BPS + p.liqBonusBps) > WAD * BPS) revert BadParams();
        if (p.graceWindow == 0 || p.graceWindow > 7 days) revert BadParams();
        if (p.fee > 0.3e18) revert BadParams();
        if (p.fee != 0 && p.feeRecipient == address(0)) revert BadParams();

        COLLATERAL = p.collateral;
        LOAN_TOKEN = p.loanToken;
        ORACLE = ISherwoodOracle(p.oracle);
        IRM = IIrm(p.irm);
        LLTV = p.lltv;
        LIQ_BONUS_BPS = p.liqBonusBps;
        CLOSE_FACTOR_BPS = p.closeFactorBps;
        GRACE_WINDOW = p.graceWindow;
        FEE = p.fee;
        FEE_RECIPIENT = p.feeRecipient;
        lastAccrual = uint64(block.timestamp);
    }

    // ------------------------------------------------------------- accounting

    /// @dev Solidity does not check explicit downcasts, so every uint128 store goes through this.
    ///      The totals here are token amounts and share counts; a value that does not fit is either
    ///      an accounting bug or a token with an absurd supply, and both should stop the transaction
    ///      rather than silently wrap into a small number.
    function _u128(uint256 x) internal pure returns (uint128) {
        if (x > type(uint128).max) revert Overflow();
        // forge-lint: disable-next-line(unsafe-typecast) bounded on the line above
        return uint128(x);
    }


    function _toSharesDown(uint256 assets, uint256 totalAssets, uint256 totalShares)
        internal
        pure
        returns (uint256)
    {
        return assets.mulDiv(totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
    }

    function _toSharesUp(uint256 assets, uint256 totalAssets, uint256 totalShares) internal pure returns (uint256) {
        return assets.mulDivUp(totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
    }

    function _toAssetsDown(uint256 shares, uint256 totalAssets, uint256 totalShares)
        internal
        pure
        returns (uint256)
    {
        return shares.mulDiv(totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
    }

    function _toAssetsUp(uint256 shares, uint256 totalAssets, uint256 totalShares) internal pure returns (uint256) {
        return shares.mulDivUp(totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
    }

    // ------------------------------------------------------------ halt shield

    /// @notice The collateral price and why it is or is not usable, without reverting.
    function priceStatus() public view returns (uint256 rawX26, PriceStatus status) {
        return ORACLE.peek(COLLATERAL);
    }

    /// @notice Interest, the shield state machine, and the protocol fee, in that order.
    /// @dev Every state-changing entry point calls this first. While shielded the clock is advanced
    ///      without charging anything, so a halt costs borrowers nothing.
    function accrueInterest() public {
        // Gives a basket oracle the chance to checkpoint constituent weights while they are all live.
        ORACLE.poke(COLLATERAL);
        (, PriceStatus status) = ORACLE.peek(COLLATERAL);
        bool halted = status != PriceStatus.OK;

        if (halted) {
            if (!shielded) {
                shielded = true;
                graceUntil = 0;
                emit Shielded(status);
            }
            lastAccrual = uint64(block.timestamp);
            return;
        }

        if (shielded) {
            shielded = false;
            // forge-lint: disable-next-line(unsafe-typecast) GRACE_WINDOW is capped at 7 days at construction
            graceUntil = uint64(block.timestamp + GRACE_WINDOW);
            lastAccrual = uint64(block.timestamp);
            emit Unshielded(graceUntil);
            return;
        }

        uint256 elapsed = block.timestamp - lastAccrual;
        if (elapsed == 0) return;
        lastAccrual = uint64(block.timestamp);

        uint256 borrowed = totalBorrowAssets;
        if (borrowed == 0) return;

        uint256 rate = IRM.borrowRatePerSecond(totalSupplyAssets, borrowed);
        if (rate == 0) return;
        uint256 interest = borrowed.mulWad(_compound(rate, elapsed));
        if (interest == 0) return;

        totalBorrowAssets = _u128(borrowed + interest);
        totalSupplyAssets = _u128(totalSupplyAssets + interest);

        uint256 feeShares;
        if (FEE != 0) {
            uint256 feeAssets = interest.mulWad(FEE);
            // The fee is minted as shares against a supply total that already includes it, which is
            // what keeps depositors' share price flat across the mint.
            feeShares = _toSharesDown(feeAssets, totalSupplyAssets - feeAssets, totalSupplyShares);
            positions[FEE_RECIPIENT].supplyShares += _u128(feeShares);
            totalSupplyShares += _u128(feeShares);
        }
        emit AccrueInterest(interest, feeShares);
    }

    /// @dev Three-term Taylor expansion of e^(rate*t)-1. Cheaper than exponentiating and it errs
    ///      downward, so the protocol never over-charges.
    function _compound(uint256 rate, uint256 elapsed) internal pure returns (uint256) {
        uint256 x = rate * elapsed;
        uint256 x2 = x.mulWad(x) / 2;
        uint256 x3 = x2.mulWad(x) / 3;
        return x + x2 + x3;
    }

    function _requireLive() internal view returns (uint256 rawX26) {
        PriceStatus status;
        (rawX26, status) = ORACLE.peek(COLLATERAL);
        if (status != PriceStatus.OK) revert MarketShielded(status);
    }

    /// @notice The liquidation bonus in effect right now, ramped in after a halt.
    function currentBonusBps() public view returns (uint256) {
        uint64 until = graceUntil;
        if (until == 0 || block.timestamp >= until) return LIQ_BONUS_BPS;
        uint256 remaining = until - block.timestamp;
        // remaining == GRACE_WINDOW at the instant the halt cleared, giving a bonus of zero.
        return LIQ_BONUS_BPS.mulDiv(GRACE_WINDOW - remaining, GRACE_WINDOW);
    }

    // ----------------------------------------------------------------- views

    function borrowAssetsOf(address user) public view returns (uint256) {
        return _toAssetsUp(positions[user].borrowShares, totalBorrowAssets, totalBorrowShares);
    }

    function supplyAssetsOf(address user) public view returns (uint256) {
        return _toAssetsDown(positions[user].supplyShares, totalSupplyAssets, totalSupplyShares);
    }

    /// @notice Collateral value at 1e8 and the debt it backs, plus whether the position is solvent.
    function healthOf(address user)
        external
        view
        returns (uint256 collateralValue1e8, uint256 debtAssets, bool solvent, PriceStatus status)
    {
        uint256 rawX26;
        (rawX26, status) = ORACLE.peek(COLLATERAL);
        debtAssets = borrowAssetsOf(user);
        if (status != PriceStatus.OK) return (0, debtAssets, false, status);
        collateralValue1e8 = uint256(positions[user].collateral).mulDiv(rawX26, WAD);
        solvent = _solvent(collateralValue1e8, debtAssets);
    }

    /// @dev Loan assets are USDG with six decimals; collateral value carries eight. The 1e2 lines
    ///      them up.
    function _solvent(uint256 collateralValue1e8, uint256 debtAssets) internal view returns (bool) {
        if (debtAssets == 0) return true;
        uint256 maxDebt1e8 = collateralValue1e8.mulWad(LLTV);
        return maxDebt1e8 >= debtAssets * 1e2;
    }

    function _checkSolvent(address user, uint256 rawX26) internal view {
        uint256 debt = borrowAssetsOf(user);
        if (debt == 0) return;
        uint256 value = uint256(positions[user].collateral).mulDiv(rawX26, WAD);
        if (!_solvent(value, debt)) revert Unhealthy();
    }

    // ------------------------------------------------------------ supply side

    /// @notice Deposit USDG to be lent out.
    function supply(uint256 assets, address onBehalf) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        if (onBehalf == address(0)) revert InconsistentInput();
        accrueInterest();
        shares = _toSharesDown(assets, totalSupplyAssets, totalSupplyShares);
        if (shares == 0) revert ZeroAmount();
        positions[onBehalf].supplyShares += _u128(shares);
        totalSupplyShares += _u128(shares);
        totalSupplyAssets += _u128(assets);
        LOAN_TOKEN.safeTransferFrom(msg.sender, address(this), assets);
        emit Supply(msg.sender, onBehalf, assets, shares);
    }

    /// @notice Withdraw supplied USDG. Allowed during a halt: a depositor's claim does not depend on
    ///         the collateral price, and freezing it would only convert an issuer's halt into a run
    ///         on people who are owed money.
    function withdraw(uint256 shares, address to) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (to == address(0)) revert InconsistentInput();
        accrueInterest();
        assets = _toAssetsDown(shares, totalSupplyAssets, totalSupplyShares);
        positions[msg.sender].supplyShares -= _u128(shares);
        totalSupplyShares -= _u128(shares);
        totalSupplyAssets -= _u128(assets);
        if (totalBorrowAssets > totalSupplyAssets) revert InsufficientLiquidity();
        LOAN_TOKEN.safeTransfer(to, assets);
        emit Withdraw(msg.sender, msg.sender, to, assets, shares);
    }

    // ------------------------------------------------------------ borrow side

    /// @notice Post stock tokens as collateral. Open during a halt only because the collateral token
    ///         itself would reject the transfer anyway; nothing here depends on a price.
    function supplyCollateral(uint256 assets, address onBehalf) external nonReentrant {
        if (assets == 0) revert ZeroAmount();
        if (onBehalf == address(0)) revert InconsistentInput();
        accrueInterest();
        positions[onBehalf].collateral += _u128(assets);
        COLLATERAL.safeTransferFrom(msg.sender, address(this), assets);
        emit SupplyCollateral(msg.sender, onBehalf, assets);
    }

    /// @notice Take collateral back. Requires a live price, since solvency cannot be checked without one.
    function withdrawCollateral(uint256 assets, address to) external nonReentrant {
        if (assets == 0) revert ZeroAmount();
        if (to == address(0)) revert InconsistentInput();
        accrueInterest();
        uint256 rawX26 = _requireLive();
        positions[msg.sender].collateral -= _u128(assets);
        _checkSolvent(msg.sender, rawX26);
        COLLATERAL.safeTransfer(to, assets);
        emit WithdrawCollateral(msg.sender, msg.sender, to, assets);
    }

    /// @notice Borrow USDG against posted collateral.
    function borrow(uint256 assets, address to) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        if (to == address(0)) revert InconsistentInput();
        accrueInterest();
        uint256 rawX26 = _requireLive();
        shares = _toSharesUp(assets, totalBorrowAssets, totalBorrowShares);
        positions[msg.sender].borrowShares += _u128(shares);
        totalBorrowShares += _u128(shares);
        totalBorrowAssets += _u128(assets);
        if (totalBorrowAssets > totalSupplyAssets) revert InsufficientLiquidity();
        _checkSolvent(msg.sender, rawX26);
        LOAN_TOKEN.safeTransfer(to, assets);
        emit Borrow(msg.sender, msg.sender, to, assets, shares);
    }

    /// @notice Repay debt. Always open, including during a halt, because repaying only ever helps.
    /// @param shares Pass zero to repay by asset amount; pass a share count to close an exact debt.
    function repay(uint256 assets, uint256 shares, address onBehalf)
        external
        nonReentrant
        returns (uint256 repaidAssets, uint256 repaidShares)
    {
        if ((assets == 0) == (shares == 0)) revert InconsistentInput();
        if (onBehalf == address(0)) revert InconsistentInput();
        accrueInterest();
        if (assets != 0) {
            repaidAssets = assets;
            repaidShares = _toSharesDown(assets, totalBorrowAssets, totalBorrowShares);
        } else {
            repaidShares = shares;
            repaidAssets = _toAssetsUp(shares, totalBorrowAssets, totalBorrowShares);
        }
        positions[onBehalf].borrowShares -= _u128(repaidShares);
        totalBorrowShares -= _u128(repaidShares);
        // Rounding can leave the tracked asset total a wei below what is being repaid on the final
        // exit; clamping keeps the last repayer from reverting on an accounting artifact.
        totalBorrowAssets = _u128(FixedPointMathLib.zeroFloorSub(totalBorrowAssets, repaidAssets));
        LOAN_TOKEN.safeTransferFrom(msg.sender, address(this), repaidAssets);
        emit Repay(msg.sender, onBehalf, repaidAssets, repaidShares);
    }

    // ------------------------------------------------------------ liquidation

    /// @notice Repay part of an insolvent borrower's debt and seize collateral at a discount.
    /// @dev Impossible while the market is shielded, by construction as much as by policy: a paused
    ///      stock token reverts on transfer, so the seizure could not settle even if this allowed it.
    function liquidate(address borrower, uint256 repayAssets)
        external
        nonReentrant
        returns (uint256 seized, uint256 repaidShares)
    {
        if (repayAssets == 0) revert ZeroAmount();
        accrueInterest();
        uint256 rawX26 = _requireLive();

        Position storage pos = positions[borrower];
        uint256 debt = borrowAssetsOf(borrower);
        uint256 collateralValue = uint256(pos.collateral).mulDiv(rawX26, WAD);
        if (_solvent(collateralValue, debt)) revert Healthy();

        uint256 maxRepay = debt.mulDiv(CLOSE_FACTOR_BPS, BPS);
        if (repayAssets > maxRepay) repayAssets = maxRepay;

        uint256 bonusBps = currentBonusBps();
        // Value seized is the repayment grossed up by the bonus; dividing by the price turns that
        // dollar figure back into raw collateral units.
        uint256 seizeValue1e8 = (repayAssets * 1e2).mulDiv(BPS + bonusBps, BPS);
        seized = seizeValue1e8.mulDiv(WAD, rawX26);

        bool fullSeizure = seized >= pos.collateral;
        if (fullSeizure) {
            // The position cannot cover the discounted repayment, so it is closed out entirely and
            // the repayment is re-derived from what there actually was to take.
            seized = pos.collateral;
            uint256 grossValue1e8 = uint256(seized).mulDiv(rawX26, WAD);
            repayAssets = grossValue1e8.mulDiv(BPS, BPS + bonusBps) / 1e2;
        }
        if (repayAssets == 0 || seized == 0) revert ZeroAmount();

        repaidShares = _toSharesDown(repayAssets, totalBorrowAssets, totalBorrowShares);
        if (repaidShares > pos.borrowShares) repaidShares = pos.borrowShares;

        pos.borrowShares -= _u128(repaidShares);
        pos.collateral -= _u128(seized);
        totalBorrowShares -= _u128(repaidShares);
        totalBorrowAssets = _u128(FixedPointMathLib.zeroFloorSub(totalBorrowAssets, repayAssets));

        uint256 badDebt;
        if (fullSeizure && pos.borrowShares != 0) {
            // Nothing is left to seize, so the shortfall is realised now against depositors rather
            // than left on the books as a phantom asset that inflates everyone's share price.
            uint256 remainingShares = pos.borrowShares;
            badDebt = _toAssetsUp(remainingShares, totalBorrowAssets, totalBorrowShares);
            if (badDebt > totalBorrowAssets) badDebt = totalBorrowAssets;
            pos.borrowShares = 0;
            totalBorrowShares -= _u128(remainingShares);
            totalBorrowAssets = _u128(FixedPointMathLib.zeroFloorSub(totalBorrowAssets, badDebt));
            totalSupplyAssets = _u128(FixedPointMathLib.zeroFloorSub(totalSupplyAssets, badDebt));
            emit BadDebtSocialized(borrower, badDebt);
        }

        LOAN_TOKEN.safeTransferFrom(msg.sender, address(this), repayAssets);
        COLLATERAL.safeTransfer(msg.sender, seized);
        emit Liquidate(msg.sender, borrower, repayAssets, repaidShares, seized, bonusBps, badDebt);
    }
}
