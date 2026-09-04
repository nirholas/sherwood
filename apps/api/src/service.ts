import { createPublicClient, http, fallback, type Address, type PublicClient } from "viem";
import {
  EQUITY_ASSETS,
  PRICE_STATUS_LABEL,
  PriceStatus,
  PUBLIC_RPC_URLS,
  SHERWOOD_FACTORY_ABI,
  SHERWOOD_MARKET_ABI,
  SHERWOOD_ORACLE_ABI,
  STOCK_TOKEN_ABI,
  Session,
  assetByAddress,
  borrowRatePerYear,
  healthFactor,
  maxBorrow,
  maxWithdrawCollateral,
  robinhoodChain,
  supplyRatePerYear,
  utilization,
} from "@sherwood/sdk";

const WAD = 10n ** 18n;

export type ServiceConfig = {
  rpcUrls?: string[];
  factory: Address;
  oracle: Address;
  irm?: Address;
  /** Seconds a cached response stays fresh. The chain moves faster than a UI needs to. */
  cacheSeconds?: number;
};

type CacheEntry = { at: number; value: unknown };

/**
 * The read layer behind the app.
 *
 * Everything it returns is derived from the same functions the contracts use, so the interface can
 * never tell someone they are safe while the chain would liquidate them. It also surfaces the two
 * things a normal lending front end has no concept of and a user here absolutely needs: why a market
 * is shielded, and whether a corporate action is scheduled against their collateral.
 */
export class SherwoodService {
  readonly client: PublicClient;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheMs: number;

  constructor(readonly config: ServiceConfig) {
    this.client = createPublicClient({
      chain: robinhoodChain,
      transport: fallback((config.rpcUrls ?? PUBLIC_RPC_URLS).map((url) => http(url, { timeout: 20_000 }))),
    });
    this.cacheMs = (config.cacheSeconds ?? 10) * 1_000;
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheMs) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async marketAddresses(): Promise<Address[]> {
    return this.cached("markets", async () => {
      const count = await this.client.readContract({
        address: this.config.factory,
        abi: SHERWOOD_FACTORY_ABI,
        functionName: "marketCount",
      });
      if (count === 0n) return [];
      return (await this.client.multicall({
        allowFailure: false,
        contracts: Array.from({ length: Number(count) }, (_, i) => ({
          address: this.config.factory,
          abi: SHERWOOD_FACTORY_ABI,
          functionName: "markets" as const,
          args: [BigInt(i)] as const,
        })),
      })) as Address[];
    });
  }

  async market(address: Address) {
    return this.cached(`market:${address}`, async () => {
      const base = { address, abi: SHERWOOD_MARKET_ABI } as const;
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
        bonusBps,
        priceStatus,
        irm,
      ] = await this.client.multicall({
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
          { ...base, functionName: "IRM" },
        ],
      });

      const [priceRawX26, status] = priceStatus as readonly [bigint, number];
      const supply = totalSupplyAssets as bigint;
      const borrow = totalBorrowAssets as bigint;
      const util = utilization(supply, borrow);
      const asset = assetByAddress(collateral as Address);

      // The curve is read from the deployed IRM so a redeployed model cannot silently desync the UI.
      const curve = await this.irmCurve(irm as Address);
      const borrowRate = curve ? borrowRatePerYear(supply, borrow, curve) : 0n;

      return {
        address,
        collateral: collateral as Address,
        collateralSymbol: asset?.symbol ?? null,
        collateralName: asset?.name ?? null,
        loanToken: loanToken as Address,
        irm: irm as Address,
        lltv: (lltv as bigint).toString(),
        lltvPercent: Number(lltv as bigint) / 1e16,
        liqBonusBps: Number(liqBonusBps as bigint),
        closeFactorBps: Number(closeFactorBps as bigint),
        graceWindowSeconds: Number(graceWindow as bigint),
        totalSupplyAssets: supply.toString(),
        totalBorrowAssets: borrow.toString(),
        totalSupplyShares: (totalSupplyShares as bigint).toString(),
        totalBorrowShares: (totalBorrowShares as bigint).toString(),
        available: (supply > borrow ? supply - borrow : 0n).toString(),
        utilizationPercent: Number(util) / 1e16,
        borrowApr: Number(borrowRate) / 1e16,
        supplyApr: Number(supplyRatePerYear(borrowRate, util)) / 1e16,
        shielded: shielded as boolean,
        graceUntil: Number(graceUntil as bigint),
        currentBonusBps: Number(bonusBps as bigint),
        priceRawX26: priceRawX26.toString(),
        status: status as PriceStatus,
        statusLabel: PRICE_STATUS_LABEL[status as PriceStatus],
        /** Dollar price of one whole share, for display. */
        sharePrice: asset ? Number(priceRawX26) / 1e8 : null,
      };
    });
  }

  private async irmCurve(irm: Address) {
    return this.cached(`irm:${irm}`, async () => {
      try {
        const [baseRate, slope1, slope2, kink] = await this.client.multicall({
          allowFailure: false,
          contracts: [
            { address: irm, abi: KINKED_IRM_MINIMAL, functionName: "BASE_RATE" as const },
            { address: irm, abi: KINKED_IRM_MINIMAL, functionName: "SLOPE_1" as const },
            { address: irm, abi: KINKED_IRM_MINIMAL, functionName: "SLOPE_2" as const },
            { address: irm, abi: KINKED_IRM_MINIMAL, functionName: "KINK" as const },
          ],
        });
        return { baseRate: baseRate as bigint, slope1: slope1 as bigint, slope2: slope2 as bigint, kink: kink as bigint };
      } catch {
        // A market may use a rate model this API does not know how to read; that is not fatal.
        return null;
      }
    });
  }

  async markets() {
    const addresses = await this.marketAddresses();
    return Promise.all(addresses.map((a) => this.market(a)));
  }

  async position(market: Address, user: Address) {
    const base = { address: market, abi: SHERWOOD_MARKET_ABI } as const;
    const [m, position, supplyAssets, borrowAssets, health] = await Promise.all([
      this.market(market),
      this.client.readContract({ ...base, functionName: "positions", args: [user] }),
      this.client.readContract({ ...base, functionName: "supplyAssetsOf", args: [user] }),
      this.client.readContract({ ...base, functionName: "borrowAssetsOf", args: [user] }),
      this.client.readContract({ ...base, functionName: "healthOf", args: [user] }),
    ]);

    const [supplyShares, borrowShares, collateral] = position as readonly [bigint, bigint, bigint];
    const [collateralValue1e8, , solvent, status] = health as readonly [bigint, bigint, boolean, number];
    const lltv = BigInt(m.lltv);
    const debt = borrowAssets as bigint;

    return {
      market,
      user,
      supplyShares: supplyShares.toString(),
      borrowShares: borrowShares.toString(),
      collateral: collateral.toString(),
      supplyAssets: (supplyAssets as bigint).toString(),
      borrowAssets: debt.toString(),
      collateralValue1e8: collateralValue1e8.toString(),
      collateralValueUsd: Number(collateralValue1e8) / 1e8,
      debtUsd: Number(debt) / 1e6,
      solvent: solvent as boolean,
      status: status as PriceStatus,
      statusLabel: PRICE_STATUS_LABEL[status as PriceStatus],
      healthFactor: healthFactor(collateralValue1e8, debt, lltv),
      maxBorrow: maxBorrow(collateralValue1e8, debt, lltv).toString(),
      maxWithdrawCollateral: maxWithdrawCollateral(collateral, debt, BigInt(m.priceRawX26), lltv).toString(),
      /** Liquidatable only when a price exists; a shielded market cannot be liquidated at all. */
      liquidatable: (status as PriceStatus) === PriceStatus.OK && !solvent && debt > 0n,
    };
  }

  /** The oracle's view of one asset, including how far its two sources currently sit apart. */
  async oracleView(asset: Address) {
    return this.cached(`oracle:${asset}`, async () => {
      const base = { address: this.config.oracle, abi: SHERWOOD_ORACLE_ABI } as const;
      const [peek, twap, quote] = await this.client.multicall({
        allowFailure: false,
        contracts: [
          { ...base, functionName: "peek", args: [asset] },
          { ...base, functionName: "twapRawX26", args: [asset] },
          { ...base, functionName: "quote", args: [asset] },
        ],
      });
      const [rawX26, status] = peek as readonly [bigint, number];
      const [twapX26, twapOk] = twap as readonly [bigint, boolean];
      const q = quote as { price: bigint; observedAt: bigint; publishedAt: bigint; nonce: bigint; session: number };
      const meta = assetByAddress(asset);

      // Both restated per whole share so the comparison is the one a person would make.
      const attestedShare = Number(q.price) / 1e8;
      const twapShare = twapOk && meta ? Number(twapX26) / 1e8 : null;
      return {
        asset,
        symbol: meta?.symbol ?? null,
        status: status as PriceStatus,
        statusLabel: PRICE_STATUS_LABEL[status as PriceStatus],
        priceRawX26: rawX26.toString(),
        sharePrice: status === PriceStatus.OK ? Number(rawX26) / 1e8 : null,
        twapSharePrice: twapShare,
        attestedSharePrice: attestedShare || null,
        deviationBps:
          twapShare && attestedShare ? Math.round(((twapShare - attestedShare) / attestedShare) * 10_000) : null,
        session: q.session as Session,
        quoteObservedAt: Number(q.observedAt),
        quotePublishedAt: Number(q.publishedAt),
        quoteAgeSeconds: q.publishedAt === 0n ? null : Math.floor(Date.now() / 1000) - Number(q.publishedAt),
      };
    });
  }

  /** The corporate-action state a market's collateral publishes about itself. */
  async corporateAction(asset: Address) {
    return this.cached(`corp:${asset}`, async () => {
      const base = { address: asset, abi: STOCK_TOKEN_ABI } as const;
      const [uiMultiplier, newUIMultiplier, effectiveAt, paused, oraclePaused] = await this.client.multicall({
        allowFailure: false,
        contracts: [
          { ...base, functionName: "uiMultiplier" },
          { ...base, functionName: "newUIMultiplier" },
          { ...base, functionName: "effectiveAt" },
          { ...base, functionName: "paused" },
          { ...base, functionName: "oraclePaused" },
        ],
      });
      const live = uiMultiplier as bigint;
      const pending = newUIMultiplier as bigint;
      const eff = Number(effectiveAt as bigint);
      const now = Math.floor(Date.now() / 1000);
      return {
        asset,
        symbol: assetByAddress(asset)?.symbol ?? null,
        uiMultiplier: live.toString(),
        newUIMultiplier: pending.toString(),
        effectiveAt: eff,
        paused: paused as boolean,
        oraclePaused: oraclePaused as boolean,
        pending: eff > now && pending !== live,
        /** A scheduled fall is priced into collateral the moment it is announced. */
        dilutive: pending < live,
        ratio: live === 0n ? null : Number((pending * WAD) / live) / 1e18,
      };
    });
  }

  /** Every equity the protocol knows about, with the oracle's current opinion of it. */
  async assets() {
    return this.cached("assets", async () =>
      Promise.all(
        EQUITY_ASSETS.map(async (a) => ({
          ...a,
          chainLiquidityUsd: a.chainLiquidityUsd,
          oracle: await this.oracleView(a.address).catch(() => null),
        })),
      ),
    );
  }
}

const KINKED_IRM_MINIMAL = [
  { type: "function", name: "BASE_RATE", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "SLOPE_1", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "SLOPE_2", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "KINK", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;
