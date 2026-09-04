import { loadConfig } from "./config.js";
import { Keeper } from "./keeper.js";
import { PRICE_STATUS_LABEL, formatUsd } from "@sherwood/sdk";

/**
 * One read-only pass, printed. The fastest way to see what a keeper would do without giving it a key.
 *
 *   SHERWOOD_FACTORY=0x... pnpm --filter @sherwood/keeper scan
 */
async function main() {
  const keeper = new Keeper({ ...loadConfig(), dryRun: true });
  const markets = await keeper.markets();
  if (markets.length === 0) {
    console.log("no markets have been created by this factory yet");
    return;
  }

  for (const market of markets) {
    const { snapshot, candidates } = await keeper.scanMarket(market);
    console.log(`\n${market}`);
    console.log(`  collateral ${snapshot.collateral}`);
    console.log(`  price      ${PRICE_STATUS_LABEL[snapshot.status]}`);
    console.log(`  shielded   ${snapshot.shielded}`);
    console.log(`  bonus      ${snapshot.bonusBps}bps of the configured maximum`);
    if (candidates.length === 0) {
      console.log("  nothing liquidatable");
      continue;
    }
    for (const c of candidates) {
      console.log(
        `  ${c.borrower}: debt ${formatUsd(c.debtAssets * 100n)}, ` +
          `collateral ${formatUsd(c.collateralValue1e8)}, ` +
          `repay ${formatUsd(c.repayAssets * 100n)} for ${formatUsd(c.grossProfit1e8)} of profit`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
