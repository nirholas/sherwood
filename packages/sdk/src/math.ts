import { PriceStatus } from "./types.js";

export const WAD = 10n ** 18n;
export const BPS = 10_000n;
/** The oracle's price scale: USD per raw token unit, times 1e26. */
export const PRICE_SCALE = 10n ** 26n;
/** USDG has six decimals; collateral values carry eight. */
export const USD_1E8 = 10n ** 8n;

export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b) / d;
}

export function mulDivUp(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b + d - 1n) / d;
}

/**
 * Dollar value at 1e8 of `rawAmount` units, given the oracle's `priceRawX26`.
 * Identical to `SherwoodMarket`'s own arithmetic, so a front end never disagrees with the chain
 * about whether a position is liquidatable.
 */
export function valueOf(rawAmount: bigint, priceRawX26: bigint): bigint {
  return mulDiv(rawAmount, priceRawX26, WAD);
}

/** Price of one whole share at 1e8, for display only. */
export function pricePerShare1e8(priceRawX26: bigint, decimals: number, uiMultiplier: bigint): bigint {
  return mulDiv(priceRawX26, 10n ** BigInt(decimals), uiMultiplier);
}

/**
 * The health check the market runs. Debt is in USDG (six decimals) and collateral value is at 1e8,
 * which is what the 1e2 lines up.
 */
export function isSolvent(collateralValue1e8: bigint, debtAssets: bigint, lltv: bigint): boolean {
  if (debtAssets === 0n) return true;
  return mulDiv(collateralValue1e8, lltv, WAD) >= debtAssets * 100n;
}

/** Debt-to-collateral as a fraction of the LLTV: 1 is exactly at the liquidation threshold. */
export function healthFactor(collateralValue1e8: bigint, debtAssets: bigint, lltv: bigint): number {
  if (debtAssets === 0n) return Infinity;
  const maxDebt1e8 = mulDiv(collateralValue1e8, lltv, WAD);
  if (maxDebt1e8 === 0n) return 0;
  return Number((debtAssets * 100n * 10000n) / maxDebt1e8) / 10000;
}

/** Largest USDG that can still be borrowed against this collateral before hitting the LLTV. */
export function maxBorrow(collateralValue1e8: bigint, debtAssets: bigint, lltv: bigint): bigint {
  const maxDebt = mulDiv(collateralValue1e8, lltv, WAD) / 100n;
  return maxDebt > debtAssets ? maxDebt - debtAssets : 0n;
}

/** Collateral that can be pulled out while staying solvent, in raw units. */
export function maxWithdrawCollateral(
  collateralRaw: bigint,
  debtAssets: bigint,
  priceRawX26: bigint,
  lltv: bigint,
): bigint {
  if (debtAssets === 0n) return collateralRaw;
  if (priceRawX26 === 0n) return 0n;
  const requiredValue1e8 = mulDivUp(debtAssets * 100n, WAD, lltv);
  const requiredRaw = mulDivUp(requiredValue1e8, WAD, priceRawX26);
  return collateralRaw > requiredRaw ? collateralRaw - requiredRaw : 0n;
}

/**
 * The liquidation bonus in effect, ramped in after a halt. Mirrors `currentBonusBps`.
 * At the instant a halt clears the bonus is zero, which is what gives a frozen-out borrower time.
 */
export function currentBonusBps(
  liqBonusBps: bigint,
  graceUntil: bigint,
  graceWindow: bigint,
  now: bigint,
): bigint {
  if (graceUntil === 0n || now >= graceUntil) return liqBonusBps;
  const remaining = graceUntil - now;
  return mulDiv(liqBonusBps, graceWindow - remaining, graceWindow);
}

/** Collateral a liquidator receives for repaying `repayAssets`, in raw units. */
export function seizeForRepay(repayAssets: bigint, priceRawX26: bigint, bonusBps: bigint): bigint {
  const seizeValue1e8 = mulDiv(repayAssets * 100n, BPS + bonusBps, BPS);
  return mulDiv(seizeValue1e8, WAD, priceRawX26);
}

/** Utilization of a market, in wad. */
export function utilization(totalSupplyAssets: bigint, totalBorrowAssets: bigint): bigint {
  if (totalSupplyAssets === 0n) return 0n;
  const u = mulDiv(totalBorrowAssets, WAD, totalSupplyAssets);
  return u > WAD ? WAD : u;
}

/** Annualized borrow rate for a `KinkedIrm`, in wad. */
export function borrowRatePerYear(
  totalSupplyAssets: bigint,
  totalBorrowAssets: bigint,
  { baseRate, slope1, slope2, kink }: { baseRate: bigint; slope1: bigint; slope2: bigint; kink: bigint },
): bigint {
  const u = utilization(totalSupplyAssets, totalBorrowAssets);
  if (u <= kink) return baseRate + mulDiv(slope1, u, kink);
  return baseRate + slope1 + mulDiv(slope2, u - kink, WAD - kink);
}

/** What lenders earn: the borrow rate scaled by utilization, less any protocol fee. */
export function supplyRatePerYear(borrowRate: bigint, util: bigint, feeWad = 0n): bigint {
  return mulDiv(mulDiv(borrowRate, util, WAD), WAD - feeWad, WAD);
}

/** Shares to assets, matching the market's virtual-share accounting. */
const VIRTUAL_SHARES = 1_000_000n;
const VIRTUAL_ASSETS = 1n;

export function toAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDiv(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}

export function toAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}

export function toSharesDown(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDiv(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
}

/** Formats a 1e8 dollar figure for display. */
export function formatUsd(value1e8: bigint, decimals = 2): string {
  const negative = value1e8 < 0n;
  const abs = negative ? -value1e8 : value1e8;
  const whole = abs / USD_1E8;
  const frac = (abs % USD_1E8).toString().padStart(8, "0").slice(0, decimals);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}${decimals > 0 ? "." + frac : ""}`;
}

export function statusBlocksBorrowing(status: PriceStatus): boolean {
  return status !== PriceStatus.OK;
}
