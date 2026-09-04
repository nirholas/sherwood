import { encodeAbiParameters, keccak256, toHex, type Hex, getAddress } from "viem";
import type { Session } from "./types.js";

/** The report reporters sign. Mirrors `PriceReport` in SherwoodOracle.sol. */
export type PriceReport = {
  asset: `0x${string}`;
  /** USD per whole share, 1e8. */
  price: bigint;
  /** Exchange timestamp the quote was observed at. */
  observedAt: bigint;
  session: Session;
  /** Strictly increasing per asset. */
  nonce: bigint;
};

export const PRICE_REPORT_TYPE = {
  PriceReport: [
    { name: "asset", type: "address" },
    { name: "price", type: "uint256" },
    { name: "observedAt", type: "uint64" },
    { name: "session", type: "uint8" },
    { name: "nonce", type: "uint64" },
    { name: "chainId", type: "uint256" },
  ],
} as const;

export function oracleDomain(oracle: `0x${string}`, chainId: number) {
  return { name: "SherwoodOracle", version: "1", chainId, verifyingContract: oracle } as const;
}

/** The typed-data payload a reporter signs. */
export function reportTypedData(report: PriceReport, oracle: `0x${string}`, chainId: number) {
  return {
    domain: oracleDomain(oracle, chainId),
    types: PRICE_REPORT_TYPE,
    primaryType: "PriceReport" as const,
    message: {
      asset: report.asset,
      price: report.price,
      observedAt: report.observedAt,
      session: report.session,
      nonce: report.nonce,
      chainId: BigInt(chainId),
    },
  };
}

export const PRICE_REPORT_TYPEHASH: Hex = keccak256(
  toHex("PriceReport(address asset,uint256 price,uint64 observedAt,uint8 session,uint64 nonce,uint256 chainId)"),
);

/**
 * The struct hash, built on viem's ABI encoder rather than by hand.
 * Padding a field the wrong width here would produce a digest the contract never accepts, and the
 * failure would surface as an unexplained `NotAReporter` from a correctly configured signer.
 */
export function hashReportStruct(report: PriceReport, chainId: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint8" },
        { type: "uint64" },
        { type: "uint256" },
      ],
      [
        PRICE_REPORT_TYPEHASH,
        getAddress(report.asset),
        report.price,
        report.observedAt,
        report.session,
        report.nonce,
        BigInt(chainId),
      ],
    ),
  );
}

/**
 * `postQuote` requires signatures ordered by ascending recovered address, which lets the contract
 * detect a duplicate signer with one comparison instead of a nested loop.
 */
export function sortSignaturesBySigner(entries: { signer: `0x${string}`; signature: Hex }[]): Hex[] {
  return [...entries]
    .sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1))
    .map((e) => e.signature);
}
