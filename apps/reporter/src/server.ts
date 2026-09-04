import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Reporter } from "./reporter.js";
import type { PriceReport } from "@sherwood/sdk";
import { EQUITY_ASSETS, Session } from "@sherwood/sdk";
import { fetchQuote } from "./marketdata.js";

/**
 * The co-signing endpoint peers call.
 *
 * A reporter will only sign a report whose price it can independently confirm from its own data
 * feed, inside a tight tolerance. Without that check a quorum of N reporters is worth exactly one
 * reporter: whoever assembles the round could put any number in front of the others and collect
 * rubber stamps. This is where the quorum earns its keep.
 */
const MAX_PEER_DIVERGENCE_BPS = 50n;
const MAX_PEER_QUOTE_AGE_SECONDS = 900;

export function createReporterServer(reporter: Reporter, tolerateBps = MAX_PEER_DIVERGENCE_BPS) {
  const bySymbol = new Map(EQUITY_ASSETS.map((a) => [a.address.toLowerCase(), a]));

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, body: unknown) => {
      const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };

    if (req.method === "GET" && req.url === "/health") {
      return send(200, { ok: true, signers: reporter.signers });
    }

    if (req.method !== "POST" || req.url !== "/sign") {
      return send(404, { error: "not found" });
    }

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 8_192) req.destroy();
    });
    req.on("end", async () => {
      try {
        const body = JSON.parse(raw) as Record<string, string>;
        const asset = String(body.asset ?? "").toLowerCase();
        const meta = bySymbol.get(asset);
        if (!meta) return send(400, { error: "unknown asset" });

        const report: PriceReport = {
          asset: meta.address,
          price: BigInt(body.price),
          observedAt: BigInt(body.observedAt),
          session: Number(body.session) as Session,
          nonce: BigInt(body.nonce),
        };

        const now = Math.floor(Date.now() / 1000);
        if (Number(report.observedAt) > now + 60) return send(400, { error: "quote is in the future" });
        if (Number(report.nonce) > now + 300) return send(400, { error: "nonce is far in the future" });

        // Confirm the price independently before putting a signature behind it.
        const own = await fetchQuote(meta.symbol);
        if (now - Number(own.observedAt) > MAX_PEER_QUOTE_AGE_SECONDS && own.session === Session.Regular) {
          return send(503, { error: "own feed is stale during regular hours" });
        }
        const diff = own.price1e8 > report.price ? own.price1e8 - report.price : report.price - own.price1e8;
        const bps = own.price1e8 === 0n ? 10_000n : (diff * 10_000n) / own.price1e8;
        if (bps > tolerateBps) {
          return send(409, {
            error: "price does not match this reporter's own feed",
            proposed: report.price.toString(),
            observed: own.price1e8.toString(),
            divergenceBps: bps.toString(),
          });
        }

        const signatures = await reporter.sign(report);
        return send(200, { signatures, observed: own.price1e8.toString(), divergenceBps: bps.toString() });
      } catch (err) {
        return send(400, { error: err instanceof Error ? err.message : String(err) });
      }
    });
  });
}
