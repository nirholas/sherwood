import { loadConfig } from "./config.js";
import { Reporter } from "./reporter.js";
import { createReporterServer } from "./server.js";

/** Long-running reporter: serves co-signing requests and posts its own rounds on a schedule. */
async function main() {
  const config = loadConfig();
  const reporter = new Reporter(config);

  const server = createReporterServer(reporter);
  server.listen(config.port, () => {
    console.log(`[reporter] co-signing on :${config.port} as ${reporter.signers.join(", ")}`);
  });

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(
    `[reporter] oracle ${config.oracle} chain ${config.chainId} every ${config.intervalSeconds}s` +
      (config.dryRun ? " (dry run)" : ""),
  );

  for (;;) {
    const started = Date.now();
    try {
      const result = await reporter.runRound();
      for (const p of result.posted) {
        console.log(`[reporter] posted ${p.symbol} at ${Number(p.price) / 1e8} session=${p.session} ${p.hash ?? "(dry run)"}`);
      }
      if (result.failed.length > 0) {
        for (const f of result.failed) console.warn(`[reporter] ${f.symbol}: ${f.error}`);
      }
      console.log(
        `[reporter] round done in ${Date.now() - started}ms: ${result.posted.length} posted, ` +
          `${result.skipped.length} unchanged, ${result.failed.length} failed`,
      );
    } catch (err) {
      console.error(`[reporter] round failed:`, err);
    }
    const elapsed = Date.now() - started;
    await new Promise((r) => setTimeout(r, Math.max(1_000, config.intervalSeconds * 1_000 - elapsed)));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
