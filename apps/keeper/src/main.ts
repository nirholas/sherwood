import { loadConfig } from "./config.js";
import { Keeper } from "./keeper.js";

async function main() {
  const config = loadConfig();
  const keeper = new Keeper(config);
  console.log(
    `[keeper] factory ${config.factory} every ${config.intervalSeconds}s` +
      (config.dryRun ? " (dry run: reporting only)" : ` as ${keeper.account?.address}`),
  );

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (running) {
    const started = Date.now();
    try {
      const { scanned, acted, lines } = await keeper.runOnce();
      for (const line of lines) console.log(`[keeper] ${line}`);
      console.log(`[keeper] ${scanned} markets, ${acted} liquidated, ${Date.now() - started}ms`);
    } catch (err) {
      console.error("[keeper] pass failed:", err);
    }
    const elapsed = Date.now() - started;
    await new Promise((r) => setTimeout(r, Math.max(1_000, config.intervalSeconds * 1_000 - elapsed)));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
