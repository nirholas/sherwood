import { describe, expect, it } from "vitest";
import { hashTypedData, keccak256, encodeAbiParameters, toHex } from "viem";
import {
  currentBonusBps,
  healthFactor,
  isSolvent,
  maxBorrow,
  maxWithdrawCollateral,
  seizeForRepay,
  valueOf,
  pricePerShare1e8,
  borrowRatePerYear,
  supplyRatePerYear,
  utilization,
  formatUsd,
  WAD,
} from "../src/math.js";
import { hashReportStruct, reportTypedData, sortSignaturesBySigner } from "../src/quote.js";
import { PriceStatus, Session, isIssuerHalt } from "../src/types.js";
import { EQUITY_ASSETS, assetBySymbol, USDG } from "../src/assets.js";

/** The live SPY/USDG TWAP when this protocol was written: $774.23 a share. */
const SPY_RAW_X26 = 77_423_082_700n;
const USDG_ONE = 1_000_000n;

describe("collateral valuation", () => {
  it("values one whole token as one share", () => {
    expect(valueOf(WAD, SPY_RAW_X26)).toBe(SPY_RAW_X26);
    expect(pricePerShare1e8(SPY_RAW_X26, 18, WAD)).toBe(SPY_RAW_X26);
  });

  it("halves the share price when a reverse split halves the multiplier", () => {
    // A raw unit worth half as much, with the multiplier halved, is the same price per share.
    expect(pricePerShare1e8(SPY_RAW_X26 / 2n, 18, WAD / 2n)).toBe(SPY_RAW_X26);
  });

  it("scales linearly with the amount held", () => {
    expect(valueOf(10n * WAD, SPY_RAW_X26)).toBe(10n * SPY_RAW_X26);
  });
});

describe("solvency", () => {
  const lltv = 700_000_000_000_000_000n; // 0.70

  it("agrees with the contract's decimal alignment", () => {
    // Ten SPY is $7,742.31; at 70% that backs $5,419 of USDG debt.
    const value = valueOf(10n * WAD, SPY_RAW_X26);
    expect(isSolvent(value, 5_000n * USDG_ONE, lltv)).toBe(true);
    expect(isSolvent(value, 5_500n * USDG_ONE, lltv)).toBe(false);
  });

  it("treats a debt-free position as solvent at any price", () => {
    expect(isSolvent(0n, 0n, lltv)).toBe(true);
    expect(healthFactor(0n, 0n, lltv)).toBe(Infinity);
  });

  it("reports a health factor of one exactly at the threshold", () => {
    const value = valueOf(10n * WAD, SPY_RAW_X26);
    const atLimit = maxBorrow(value, 0n, lltv);
    expect(healthFactor(value, atLimit, lltv)).toBeCloseTo(1, 4);
    expect(isSolvent(value, atLimit, lltv)).toBe(true);
  });

  it("never lets maxBorrow produce an insolvent position", () => {
    for (const collateral of [1n * WAD, 7n * WAD, 1234n * WAD]) {
      const value = valueOf(collateral, SPY_RAW_X26);
      const borrowable = maxBorrow(value, 0n, lltv);
      expect(isSolvent(value, borrowable, lltv)).toBe(true);
      expect(isSolvent(value, borrowable + 2n, lltv)).toBe(false);
    }
  });

  it("computes withdrawable collateral that leaves the position exactly solvent", () => {
    const collateral = 10n * WAD;
    const debt = 3_000n * USDG_ONE;
    const out = maxWithdrawCollateral(collateral, debt, SPY_RAW_X26, lltv);
    expect(isSolvent(valueOf(collateral - out, SPY_RAW_X26), debt, lltv)).toBe(true);
    expect(isSolvent(valueOf(collateral - out - WAD / 100n, SPY_RAW_X26), debt, lltv)).toBe(false);
  });

  it("allows a full withdrawal only with no debt", () => {
    expect(maxWithdrawCollateral(10n * WAD, 0n, SPY_RAW_X26, lltv)).toBe(10n * WAD);
  });
});

describe("the grace ramp", () => {
  const bonus = 700n;
  const window = 14_400n; // four hours

  it("pays nothing in the first second after a halt clears", () => {
    const graceUntil = 1_000_000n + window;
    expect(currentBonusBps(bonus, graceUntil, window, 1_000_000n)).toBe(0n);
  });

  it("ramps linearly and restores in full at the end", () => {
    const graceUntil = 1_000_000n + window;
    expect(currentBonusBps(bonus, graceUntil, window, 1_000_000n + window / 4n)).toBe(175n);
    expect(currentBonusBps(bonus, graceUntil, window, 1_000_000n + window / 2n)).toBe(350n);
    expect(currentBonusBps(bonus, graceUntil, window, 1_000_000n + window)).toBe(700n);
    expect(currentBonusBps(bonus, graceUntil, window, 2_000_000n)).toBe(700n);
  });

  it("pays the full bonus when no halt has happened", () => {
    expect(currentBonusBps(bonus, 0n, window, 1_000_000n)).toBe(700n);
  });

  it("seizes exactly the repayment grossed up by the live bonus", () => {
    const seized = seizeForRepay(1_000n * USDG_ONE, SPY_RAW_X26, 350n);
    const seizedValue = valueOf(seized, SPY_RAW_X26);
    expect(Number(seizedValue) / Number(1_000n * 10n ** 8n)).toBeCloseTo(1.035, 4);
  });
});

describe("the rate curve", () => {
  const params = {
    baseRate: 20_000_000_000_000_000n, // 2%
    slope1: 100_000_000_000_000_000n, // 10%
    slope2: 1_500_000_000_000_000_000n, // 150%
    kink: 900_000_000_000_000_000n, // 90%
  };

  it("charges the base rate with nothing borrowed", () => {
    expect(borrowRatePerYear(1_000n, 0n, params)).toBe(params.baseRate);
  });

  it("reaches base plus slope1 exactly at the kink", () => {
    expect(borrowRatePerYear(1_000n, 900n, params)).toBe(params.baseRate + params.slope1);
  });

  it("steepens above the kink", () => {
    const atKink = borrowRatePerYear(1_000n, 900n, params);
    const above = borrowRatePerYear(1_000n, 990n, params);
    expect(above).toBeGreaterThan(atKink);
    expect(borrowRatePerYear(1_000n, 1_000n, params)).toBe(
      params.baseRate + params.slope1 + params.slope2,
    );
  });

  it("pays lenders the borrow rate scaled by utilization", () => {
    const util = utilization(1_000n, 500n);
    const rate = borrowRatePerYear(1_000n, 500n, params);
    expect(supplyRatePerYear(rate, util)).toBeLessThan(rate);
    expect(supplyRatePerYear(rate, util, WAD / 10n)).toBeLessThan(supplyRatePerYear(rate, util));
  });
});

describe("price reports", () => {
  const oracle = "0x1111111111111111111111111111111111111111" as const;
  const report = {
    asset: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C" as const,
    price: SPY_RAW_X26,
    observedAt: 1_788_500_000n,
    session: Session.Regular,
    nonce: 42n,
  };

  it("hashes the struct the same way viem's typed-data encoder does", () => {
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [
          keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
          keccak256(toHex("SherwoodOracle")),
          keccak256(toHex("1")),
          4663n,
          oracle,
        ],
      ),
    );
    const structHash = hashReportStruct(report, 4663);
    const manual = keccak256(`0x1901${domainSeparator.slice(2)}${structHash.slice(2)}`);
    expect(hashTypedData(reportTypedData(report, oracle, 4663))).toBe(manual);
  });

  it("orders signatures by signer, which the contract requires", () => {
    const sorted = sortSignaturesBySigner([
      { signer: "0xfffffffffffffffffffffffffffffffffffffffe", signature: "0xbb" },
      { signer: "0x0000000000000000000000000000000000000001", signature: "0xaa" },
    ]);
    expect(sorted).toEqual(["0xaa", "0xbb"]);
  });
});

describe("statuses", () => {
  it("separates an issuer halt from a feed problem", () => {
    expect(isIssuerHalt(PriceStatus.TokenPaused)).toBe(true);
    expect(isIssuerHalt(PriceStatus.IssuerOraclePaused)).toBe(true);
    expect(isIssuerHalt(PriceStatus.TwapDeviation)).toBe(false);
    expect(isIssuerHalt(PriceStatus.OK)).toBe(false);
  });
});

describe("the generated asset registry", () => {
  it("carries real tokenized equities with usable pools", () => {
    expect(EQUITY_ASSETS.length).toBeGreaterThan(20);
    for (const a of EQUITY_ASSETS) {
      expect(a.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(a.pool).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(a.observationCardinality).toBeGreaterThanOrEqual(120);
      expect([100, 500, 3000, 10000]).toContain(a.fee);
      expect(a.decimals).toBe(18);
    }
  });

  it("has no duplicate tickers or pools", () => {
    expect(new Set(EQUITY_ASSETS.map((a) => a.symbol)).size).toBe(EQUITY_ASSETS.length);
    expect(new Set(EQUITY_ASSETS.map((a) => a.pool)).size).toBe(EQUITY_ASSETS.length);
  });

  it("includes the deepest names on the chain", () => {
    expect(assetBySymbol("SPY")).toBeDefined();
    expect(assetBySymbol("NVDA")).toBeDefined();
    expect(assetBySymbol("spy")?.symbol).toBe("SPY");
    expect(USDG).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  });
});

describe("formatting", () => {
  it("groups thousands and keeps two decimals", () => {
    expect(formatUsd(77_423_082_700n)).toBe("$774.23");
    expect(formatUsd(1_234_567_800_000n)).toBe("$12,345.67");
    expect(formatUsd(0n)).toBe("$0.00");
  });
});
