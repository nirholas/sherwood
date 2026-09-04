import type { Address, PublicClient } from "viem";
import { SHERWOOD_MARKET_ABI, SHERWOOD_ORACLE_ABI, SHERWOOD_FACTORY_ABI, STOCK_TOKEN_ABI } from "./abis.js";
import { PriceStatus, type MarketState, type PositionState } from "./types.js";
import { currentBonusBps, healthFactor, isSolvent, maxBorrow, maxWithdrawCollateral, valueOf } from "./math.js";

/**
 * Read-side client. Every number it returns is computed the way the contracts compute it, so a UI
 * built on this can never tell a user they are safe while the chain would liquidate them.
 */
export class SherwoodClient {
  constructor(
    readonly publicClient: PublicClient,
    readonly addresses: { oracle: Address; factory: Address },
  ) {}

  async listMarkets(): Promise<Address[]> {
    const count = await this.publicClient.readContract({
      address: this.addresses.factory,
      abi: SHERWOOD_FACTORY_ABI,
      functionName: "marketCount",
    });
    const calls = Array.from({ length: Number(count) }, (_, i) => ({
      address: this.addresses.factory,
      abi: SHERWOOD_FACTORY_ABI,
      functionName: "markets" as const,
      args: [BigInt(i)] as const,
    }));
    if (calls.length === 0) return [];
    const results = await this.publicClient.multicall({ contracts: calls, allowFailure: false });
    return results as Address[];
  }

  async getMarket(market: Address): Promise<MarketState> {
    const base = { address: market, abi: SHERWOOD_MARKET_ABI } as const;
    const [
      collateral,
      loanToken,
      lltv,
      liqBonusBps,
      closeFactorBps,
      graceWindow,
      totalSupplyAssets,
      totalBorrowAssets,
      totalSupplyShares,
      totalBorrowShares,
      shielded,
      graceUntil,
      bonus,
      priceStatus,
    ] = await this.publicClient.multicall({
      allowFailure: false,
      contracts: [
        { ...base, functionName: "COLLATERAL" },
        { ...base, functionName: "LOAN_TOKEN" },
        { ...base, functionName: "LLTV" },
        { ...base, functionName: "LIQ_BONUS_BPS" },
        { ...base, functionName: "CLOSE_FACTOR_BPS" },
        { ...base, functionName: "GRACE_WINDOW" },
        { ...base, functionName: "totalSupplyAssets" },
        { ...base, functionName: "totalBorrowAssets" },
        { ...base, functionName: "totalSupplyShares" },
        { ...base, functionName: "totalBorrowShares" },
        { ...base, functionName: "shielded" },
        { ...base, functionName: "graceUntil" },
        { ...base, functionName: "currentBonusBps" },
        { ...base, functionName: "priceStatus" },
      ],
    });

    const [priceRawX26, status] = priceStatus as readonly [bigint, number];
    return {
      address: market,
      collateral: collateral as Address,
      loanToken: loanToken as Address,
      lltv: lltv as bigint,
      liqBonusBps: liqBonusBps as bigint,
      closeFactorBps: closeFactorBps as bigint,
      graceWindow: graceWindow as bigint,
      totalSupplyAssets: BigInt(totalSupplyAssets as bigint),
      totalBorrowAssets: BigInt(totalBorrowAssets as bigint),
      totalSupplyShares: BigInt(totalSupplyShares as bigint),
      totalBorrowShares: BigInt(totalBorrowShares as bigint),
      shielded: shielded as boolean,
      graceUntil: graceUntil as bigint,
      currentBonusBps: bonus as bigint,
      priceRawX26,
      status: status as PriceStatus,
    };
  }

  async getPosition(market: Address, user: Address): Promise<PositionState> {
    const base = { address: market, abi: SHERWOOD_MARKET_ABI } as const;
    const [position, supplyAssets, borrowAssets, health] = await this.publicClient.multicall({
      allowFailure: false,
      contracts: [
        { ...base, functionName: "positions", args: [user] },
        { ...base, functionName: "supplyAssetsOf", args: [user] },
        { ...base, functionName: "borrowAssetsOf", args: [user] },
        { ...base, functionName: "healthOf", args: [user] },
      ],
    });
    const [supplyShares, borrowShares, collateral] = position as readonly [bigint, bigint, bigint];
    const [collateralValue1e8, , solvent, status] = health as readonly [bigint, bigint, boolean, number];
    return {
      supplyShares,
      borrowShares,
      collateral,
      supplyAssets: supplyAssets as bigint,
      borrowAssets: borrowAssets as bigint,
      collateralValue1e8,
      solvent,
      status: status as PriceStatus,
    };
  }

  /** Everything a position screen needs, derived once so the numbers cannot disagree. */
  async getPositionSummary(market: Address, user: Address) {
    const [m, p] = await Promise.all([this.getMarket(market), this.getPosition(market, user)]);
    return {
      market: m,
      position: p,
      healthFactor: healthFactor(p.collateralValue1e8, p.borrowAssets, m.lltv),
      solvent: isSolvent(p.collateralValue1e8, p.borrowAssets, m.lltv),
      maxBorrow: maxBorrow(p.collateralValue1e8, p.borrowAssets, m.lltv),
      maxWithdrawCollateral: maxWithdrawCollateral(p.collateral, p.borrowAssets, m.priceRawX26, m.lltv),
      liquidatable: m.status === PriceStatus.OK && !isSolvent(p.collateralValue1e8, p.borrowAssets, m.lltv),
    };
  }

  /** The oracle's own view of an asset, including how far the two sources currently sit apart. */
  async getOracleView(asset: Address) {
    const base = { address: this.addresses.oracle, abi: SHERWOOD_ORACLE_ABI } as const;
    const [peek, twap, quote, config] = await this.publicClient.multicall({
      allowFailure: false,
      contracts: [
        { ...base, functionName: "peek", args: [asset] },
        { ...base, functionName: "twapRawX26", args: [asset] },
        { ...base, functionName: "quote", args: [asset] },
        { ...base, functionName: "config", args: [asset] },
      ],
    });
    const [rawX26, status] = peek as readonly [bigint, number];
    const [twapX26, twapOk] = twap as readonly [bigint, boolean];
    return {
      rawX26,
      status: status as PriceStatus,
      twapX26,
      twapOk,
      quote: quote as { price: bigint; observedAt: bigint; publishedAt: bigint; nonce: bigint; session: number },
      config: config as Record<string, unknown>,
    };
  }

  /** The corporate-action state the token itself publishes. */
  async getCorporateAction(asset: Address) {
    const base = { address: asset, abi: STOCK_TOKEN_ABI } as const;
    const [uiMultiplier, newUIMultiplier, effectiveAt, paused, oraclePaused] =
      await this.publicClient.multicall({
        allowFailure: false,
        contracts: [
          { ...base, functionName: "uiMultiplier" },
          { ...base, functionName: "newUIMultiplier" },
          { ...base, functionName: "effectiveAt" },
          { ...base, functionName: "paused" },
          { ...base, functionName: "oraclePaused" },
        ],
      });
    const eff = effectiveAt as bigint;
    const pending = newUIMultiplier as bigint;
    const live = uiMultiplier as bigint;
    return {
      uiMultiplier: live,
      newUIMultiplier: pending,
      effectiveAt: eff,
      paused: paused as boolean,
      oraclePaused: oraclePaused as boolean,
      /** A corporate action is scheduled and has not landed yet. */
      pending: eff > BigInt(Math.floor(Date.now() / 1000)) && pending !== live,
      /** A scheduled fall is already priced into collateral by the oracle. */
      pendingIsDilutive: pending < live,
    };
  }

  bonusNow(m: MarketState, now = BigInt(Math.floor(Date.now() / 1000))): bigint {
    return currentBonusBps(m.liqBonusBps, m.graceUntil, m.graceWindow, now);
  }

  collateralValue(m: MarketState, rawAmount: bigint): bigint {
    return valueOf(rawAmount, m.priceRawX26);
  }
}
