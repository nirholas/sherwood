import { EQUITY_ASSETS } from "@sherwood/sdk";
import { fetchQuotes } from "./marketdata.js";

/**
 * Prints live quotes for every equity in the registry.
 * Useful on its own, and the fastest way to confirm the market-data path works before wiring keys.
 *
 *   pnpm --filter @sherwood/reporter quote            # every asset
 *   pnpm --filter @sherwood/reporter quote SPY NVDA   # a few
 */
async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const symbols = args.length > 0 ? args : EQUITY_ASSETS.map((a) => a.symbol);
  const { quotes, failures } = await fetchQuotes(symbols);

  quotes.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const sessionName = ["closed", "pre", "regular", "post", "halted"];
  console.log("symbol   price        session   exchange   source observed");
  for (const q of quotes) {
    console.log(
      `${q.symbol.padEnd(8)} ${q.price.toFixed(2).padStart(10)}  ${sessionName[q.session].padEnd(8)} ` +
        `${q.exchange.padEnd(10)} ${q.source.padEnd(6)} ${new Date(Number(q.observedAt) * 1000).toISOString()}`,
    );
  }
  for (const f of failures) console.error(`${f.symbol.padEnd(8)} FAILED: ${f.error}`);
  console.log(`\n${quotes.length} quoted, ${failures.length} failed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
