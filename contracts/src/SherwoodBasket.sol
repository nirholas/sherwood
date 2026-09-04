// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "solady/tokens/ERC20.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";

import {IStockToken} from "./interfaces/IStockToken.sol";

/// @title SherwoodBasket
/// @notice A fixed-weight, fully backed basket of tokenized equities that is itself an ERC-20.
///
/// @dev THE POINT OF A BASKET HERE IS NOT DIVERSIFIED RETURN, IT IS DIVERSIFIED HALT RISK. Any single
///      Robinhood stock token can pause, and while it is paused nobody can liquidate a loan backed by
///      it, at any price. That risk is the reason single-ticker markets have to be conservative. Spread
///      the same collateral across ten names and one halt no longer freezes the position: it removes
///      one name's weight. Sherwood's basket markets can therefore run at a higher loan-to-value than
///      any of their constituents would justify alone, and the improvement is a mechanical property of
///      the collateral rather than an assumption about correlation.
///
/// @dev WHICH MEANS EXITS MUST SURVIVE A PARTIAL HALT. A pro-rata redemption that transfers every
///      constituent reverts if even one of them is frozen, which would hand back exactly the problem
///      the basket exists to solve, and at the worst moment: the liquidator holding seized shares
///      could not get out. So a redemption pays out every constituent it can move and records the rest
///      as a claim on specific token amounts, reserved inside the basket and no longer backing anyone
///      else's shares. The redeemer collects them with `claim` once the issuer unpauses. Shares are
///      burned once; nothing is double-counted; and a halt delays a payout instead of blocking a
///      redemption.
///
/// @dev NO ADMIN, NO REBALANCING, NO SWAPS. Constituents and weights are fixed at construction. The
///      basket never trades, so it cannot be sandwiched, cannot be drained through a rebalance, and
///      needs no price oracle to mint or redeem. It only ever moves tokens in and out in proportion.
contract SherwoodBasket is ERC20, ReentrancyGuard {
    using FixedPointMathLib for uint256;
    using SafeTransferLib for address;

    uint256 internal constant WAD = 1e18;
    /// @dev Sixteen is the number of 16-bit value weights that pack into one storage word in
    ///      `SherwoodBasketOracle`, and past a dozen names the marginal halt diversification is gone.
    uint256 public constant MAX_CONSTITUENTS = 16;

    string internal _name;
    string internal _symbol;

    address[] internal _tokens;
    /// @notice Raw units of each constituent backing 1e18 basket shares, in constituent order.
    uint256[] internal _weights;

    /// @notice Constituent units owed to redeemers because the token was paused at redemption time.
    mapping(address => mapping(address => uint256)) public claimable;
    /// @notice Constituent units set aside for claims, excluded from what backs live shares.
    mapping(address => uint256) public reserved;

    event Minted(address indexed caller, address indexed to, uint256 shares);
    event Redeemed(address indexed caller, address indexed to, uint256 shares);
    event Deferred(address indexed to, address indexed token, uint256 amount);
    event Claimed(address indexed to, address indexed token, uint256 amount);

    error BadBasket();
    error ZeroAmount();
    error NothingToClaim();

    constructor(string memory name_, string memory symbol_, address[] memory tokens_, uint256[] memory weights_) {
        uint256 n = tokens_.length;
        if (n == 0 || n > MAX_CONSTITUENTS || n != weights_.length) revert BadBasket();
        for (uint256 i; i < n; ++i) {
            if (tokens_[i] == address(0) || weights_[i] == 0) revert BadBasket();
            // Duplicates would let one name occupy two weights and defeat the whole diversification
            // argument, silently.
            for (uint256 j; j < i; ++j) {
                if (tokens_[i] == tokens_[j]) revert BadBasket();
            }
        }
        _name = name_;
        _symbol = symbol_;
        _tokens = tokens_;
        _weights = weights_;
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    function weights() external view returns (uint256[] memory) {
        return _weights;
    }

    function constituentCount() external view returns (uint256) {
        return _tokens.length;
    }

    function tokenAt(uint256 i) external view returns (address) {
        return _tokens[i];
    }

    /// @notice Constituent units actually backing live shares, net of anything reserved for claims.
    function backing(address token) public view returns (uint256) {
        return FixedPointMathLib.zeroFloorSub(token.balanceOf(address(this)), reserved[token]);
    }

    /// @notice What `mint` will pull for `shares`, in constituent order.
    function previewMint(uint256 shares) public view returns (uint256[] memory amounts) {
        uint256 n = _tokens.length;
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            amounts[i] = shares.mulDivUp(_weights[i], WAD);
        }
    }

    /// @notice What `redeem` will pay out for `shares`, in constituent order.
    function previewRedeem(uint256 shares) public view returns (uint256[] memory amounts) {
        uint256 n = _tokens.length;
        amounts = new uint256[](n);
        uint256 supply = totalSupply();
        if (supply == 0) return amounts;
        for (uint256 i; i < n; ++i) {
            amounts[i] = backing(_tokens[i]).mulDiv(shares, supply);
        }
    }

    /// @notice Deposit the exact weighted amounts and receive `shares`.
    /// @dev Rounds every pull up, so minting can never dilute existing holders.
    function mint(uint256 shares, address to) external nonReentrant returns (uint256[] memory amounts) {
        if (shares == 0) revert ZeroAmount();
        if (to == address(0)) revert BadBasket();
        amounts = previewMint(shares);
        uint256 n = _tokens.length;
        for (uint256 i; i < n; ++i) {
            _tokens[i].safeTransferFrom(msg.sender, address(this), amounts[i]);
        }
        _mint(to, shares);
        emit Minted(msg.sender, to, shares);
    }

    /// @notice Burn `shares` and take the pro-rata slice of every constituent.
    /// @dev Constituents that are paused at this moment are booked as claims instead of transfers.
    ///      The shares are burned either way, and the deferred units are reserved so they stop backing
    ///      anyone else's shares the instant they are promised.
    function redeem(uint256 shares, address to) external nonReentrant returns (uint256[] memory amounts) {
        if (shares == 0) revert ZeroAmount();
        if (to == address(0)) revert BadBasket();
        amounts = previewRedeem(shares);
        _burn(msg.sender, shares);

        uint256 n = _tokens.length;
        for (uint256 i; i < n; ++i) {
            uint256 amount = amounts[i];
            if (amount == 0) continue;
            address token = _tokens[i];
            if (IStockToken(token).paused()) {
                claimable[to][token] += amount;
                reserved[token] += amount;
                emit Deferred(to, token, amount);
            } else {
                token.safeTransfer(to, amount);
            }
        }
        emit Redeemed(msg.sender, to, shares);
    }

    /// @notice Collect constituent units that were deferred by a halt.
    function claim(address token) external nonReentrant returns (uint256 amount) {
        amount = claimable[msg.sender][token];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender][token] = 0;
        reserved[token] -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, token, amount);
    }
}
