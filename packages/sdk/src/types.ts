/** Why a price is or is not usable. Mirrors `PriceStatus` in ISherwoodOracle.sol, in order. */
export enum PriceStatus {
  OK = 0,
  NoConfig = 1,
  NoQuote = 2,
  QuoteStale = 3,
  TokenPaused = 4,
  IssuerOraclePaused = 5,
  TwapUnavailable = 6,
  TwapDeviation = 7,
  MultiplierTransition = 8,
  BasketDegraded = 9,
}

/** Mirrors `Session` in ISherwoodOracle.sol. `Closed` is ordinary; `Halted` is not. */
export enum Session {
  Closed = 0,
  Pre = 1,
  Regular = 2,
  Post = 3,
  Halted = 4,
}

export const PRICE_STATUS_LABEL: Record<PriceStatus, string> = {
  [PriceStatus.OK]: "live",
  [PriceStatus.NoConfig]: "not configured",
  [PriceStatus.NoQuote]: "no attested quote yet",
  [PriceStatus.QuoteStale]: "attested quote is stale",
  [PriceStatus.TokenPaused]: "the issuer has paused transfers",
  [PriceStatus.IssuerOraclePaused]: "the issuer has disavowed the price",
  [PriceStatus.TwapUnavailable]: "the pool has too little history",
  [PriceStatus.TwapDeviation]: "the pool and the attested quote disagree",
  [PriceStatus.MultiplierTransition]: "a corporate action is inside the TWAP window",
  [PriceStatus.BasketDegraded]: "too much of the basket has no price",
};

/**
 * What a status means for a borrower, which is not the same as what it means for the protocol.
 * Everything other than `OK` shields the market, but only some of them are the issuer's doing.
 */
export function isIssuerHalt(status: PriceStatus): boolean {
  return status === PriceStatus.TokenPaused || status === PriceStatus.IssuerOraclePaused;
}

export type MarketState = {
  address: `0x${string}`;
  collateral: `0x${string}`;
  loanToken: `0x${string}`;
  lltv: bigint;
  liqBonusBps: bigint;
  closeFactorBps: bigint;
  graceWindow: bigint;
  totalSupplyAssets: bigint;
  totalBorrowAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowShares: bigint;
  shielded: boolean;
  graceUntil: bigint;
  currentBonusBps: bigint;
  priceRawX26: bigint;
  status: PriceStatus;
};

export type PositionState = {
  supplyShares: bigint;
  borrowShares: bigint;
  collateral: bigint;
  supplyAssets: bigint;
  borrowAssets: bigint;
  collateralValue1e8: bigint;
  solvent: boolean;
  status: PriceStatus;
};
