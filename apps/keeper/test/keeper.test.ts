import { describe, expect, it } from "vitest";
import { currentBonusBps, isSolvent, seizeForRepay, valueOf, WAD } from "@sherwood/sdk";

/**
 * The economics a keeper has to get right. These are the decisions that make it profitable rather
 * than a machine for burning gas on reverts.
 */
const SPY_RAW_X26 = 77_423_082_700n;
const USDG = 1_000_000n;
const LLTV = 700_000_000_000_000_000n;

/** What the keeper computes before deciding to act. */
function grossProfit1e8(repayAssets: bigint, priceRawX26: bigint, bonusBps: bigint, collateral: bigint) {
  const seize = seizeForRepay(repayAssets, priceRawX26, bonusBps);
  const capped = seize > collateral ? collateral : seize;
  return valueOf(capped, priceRawX26) - repayAssets * 100n;
}

describe("liquidation economics", () => {
  it("is worth nothing at the instant a halt clears", () => {
    const bonus = currentBonusBps(700n, 1_000_000n + 14_400n, 14_400n, 1_000_000n);
    expect(bonus).toBe(0n);
    // Rounding on the seizure goes against the liquidator, so at a zero bonus the trade is strictly
    // unprofitable rather than merely break-even. That is what makes the ramp's first seconds safe.
    expect(grossProfit1e8(1_000n * USDG, SPY_RAW_X26, bonus, 100n * WAD)).toBeLessThanOrEqual(0n);
  });

  it("becomes worth acting on as the ramp progresses", () => {
    const quarter = currentBonusBps(700n, 1_000_000n + 14_400n, 14_400n, 1_000_000n + 3_600n);
    const full = currentBonusBps(700n, 0n, 14_400n, 1_000_000n);
    const atQuarter = grossProfit1e8(1_000n * USDG, SPY_RAW_X26, quarter, 100n * WAD);
    const atFull = grossProfit1e8(1_000n * USDG, SPY_RAW_X26, full, 100n * WAD);
    expect(atQuarter).toBeGreaterThan(0n);
    expect(atFull).toBeGreaterThan(atQuarter);
    // Seven percent of a thousand dollars, at 1e8.
    expect(Number(atFull) / 1e8).toBeCloseTo(70, 0);
  });

  it("caps the seizure at the collateral that exists", () => {
    // A position with almost no collateral cannot pay a full bonus.
    const profit = grossProfit1e8(1_000n * USDG, SPY_RAW_X26, 700n, WAD / 1000n);
    expect(profit).toBeLessThan(0n);
  });

  it("only treats a position as a candidate once it is genuinely over the LLTV", () => {
    const collateralValue = valueOf(10n * WAD, SPY_RAW_X26);
    expect(isSolvent(collateralValue, 5_000n * USDG, LLTV)).toBe(true);
    expect(isSolvent(collateralValue, 5_500n * USDG, LLTV)).toBe(false);
  });
});
