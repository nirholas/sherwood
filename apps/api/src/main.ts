import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Address } from "viem";
import { SherwoodService } from "./service.js";
import { createApiServer } from "./server.js";
import { PUBLIC_RPC_URLS } from "@sherwood/sdk";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

const service = new SherwoodService({
  rpcUrls: (process.env.RHC_RPC_URL ? [process.env.RHC_RPC_URL] : []).concat(PUBLIC_RPC_URLS),
  factory: required("SHERWOOD_FACTORY") as Address,
  oracle: required("SHERWOOD_ORACLE") as Address,
  cacheSeconds: Number(process.env.CACHE_SECONDS ?? 10),
});

// The web app is plain static files, so the API serves it directly rather than needing a second
// process and a proxy in front of both.
const webRoot = resolve(process.env.WEB_ROOT ?? new URL("../../web", import.meta.url).pathname);
const staticRoot = existsSync(webRoot) ? webRoot : undefined;

const port = Number(process.env.PORT ?? 8790);
createApiServer(service, staticRoot).listen(port, () => {
  console.log(`[api] listening on :${port}`);
  console.log(`[api] factory ${service.config.factory}`);
  console.log(`[api] oracle  ${service.config.oracle}`);
  if (staticRoot) console.log(`[api] serving the app from ${staticRoot}`);
});
