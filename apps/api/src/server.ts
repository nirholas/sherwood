import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import type { Address } from "viem";
import { isAddress } from "viem";
import { SherwoodService } from "./service.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** BigInt is not JSON, and losing precision on a token amount is not acceptable. */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function createApiServer(service: SherwoodService, staticRoot?: string) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, body: unknown, headers: Record<string, string> = {}) => {
      const text = toJson(body);
      res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=5",
        ...headers,
      });
      res.end(text);
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      return res.end();
    }
    if (req.method !== "GET") return send(405, { error: "method not allowed" });

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/api/health") {
        return send(200, { ok: true, factory: service.config.factory, oracle: service.config.oracle });
      }

      if (path === "/api/markets") {
        return send(200, { markets: await service.markets() });
      }

      if (path.startsWith("/api/markets/")) {
        const rest = path.slice("/api/markets/".length).split("/");
        const market = rest[0];
        if (!isAddress(market)) return send(400, { error: "not an address" });

        if (rest.length === 1) return send(200, await service.market(market as Address));

        if (rest[1] === "position") {
          const user = rest[2];
          if (!user || !isAddress(user)) return send(400, { error: "not an address" });
          return send(200, await service.position(market as Address, user as Address));
        }
        return send(404, { error: "not found" });
      }

      if (path === "/api/assets") {
        return send(200, { assets: await service.assets() });
      }

      if (path.startsWith("/api/oracle/")) {
        const asset = path.slice("/api/oracle/".length);
        if (!isAddress(asset)) return send(400, { error: "not an address" });
        return send(200, await service.oracleView(asset as Address));
      }

      if (path.startsWith("/api/corporate-action/")) {
        const asset = path.slice("/api/corporate-action/".length);
        if (!isAddress(asset)) return send(400, { error: "not an address" });
        return send(200, await service.corporateAction(asset as Address));
      }

      if (staticRoot) return await serveStatic(staticRoot, path, res);
      return send(404, { error: "not found" });
    } catch (err) {
      return send(502, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

async function serveStatic(root: string, path: string, res: ServerResponse) {
  // Normalising first is what stops `..` from escaping the served directory.
  const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, rel);
  if (!file.startsWith(root)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!existsSync(file) && !extname(file)) file = join(root, `${rel}.html`);
  if (!existsSync(file)) {
    // Unknown paths fall back to the app shell, which routes client side.
    file = join(root, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
      return;
    }
  }
  const body = await readFile(file);
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": extname(file) === ".html" ? "no-cache" : "public, max-age=300",
  });
  res.end(body);
}
