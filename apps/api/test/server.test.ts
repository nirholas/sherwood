import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server.js";
import { PriceStatus } from "@sherwood/sdk";

const MARKET = "0x1111111111111111111111111111111111111111";
const USER = "0x2222222222222222222222222222222222222222";
const ASSET = "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C";

/**
 * A stand-in for the chain-reading service. The routing, validation, encoding and static-file
 * behaviour are what this suite is about; the chain reads have their own coverage in the SDK and the
 * fork tests.
 */
const service = {
  config: { factory: "0xfac", oracle: "0x0ac" },
  markets: async () => [{ address: MARKET, totalSupplyAssets: "500000000000", status: PriceStatus.OK }],
  market: async (address: string) => ({ address, status: PriceStatus.TokenPaused, shielded: true }),
  position: async (market: string, user: string) => ({ market, user, healthFactor: 0.42, liquidatable: false }),
  assets: async () => [{ symbol: "SPY", address: ASSET }],
  oracleView: async (asset: string) => ({ asset, deviationBps: 12 }),
  corporateAction: async (asset: string) => ({ asset, pending: false, uiMultiplier: 10n ** 18n }),
} as never;

let base: string;
let server: ReturnType<typeof createApiServer>;
let webRoot: string;

beforeAll(async () => {
  webRoot = mkdtempSync(join(tmpdir(), "sherwood-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>app shell</title>");
  writeFileSync(join(webRoot, "secret.txt"), "not served as html");
  server = createApiServer(service, webRoot);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

const get = (path: string) => fetch(`${base}${path}`);

describe("routing", () => {
  it("reports health with the configured addresses", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, factory: "0xfac", oracle: "0x0ac" });
  });

  it("lists markets", async () => {
    const { markets } = await (await get("/api/markets")).json();
    expect(markets).toHaveLength(1);
    expect(markets[0].address).toBe(MARKET);
  });

  it("returns one market, carrying the shield reason", async () => {
    const body = await (await get(`/api/markets/${MARKET}`)).json();
    expect(body.shielded).toBe(true);
    expect(body.status).toBe(PriceStatus.TokenPaused);
  });

  it("returns a position", async () => {
    const body = await (await get(`/api/markets/${MARKET}/position/${USER}`)).json();
    expect(body).toMatchObject({ market: MARKET, user: USER, healthFactor: 0.42 });
  });

  it("serves the oracle view and the corporate-action state", async () => {
    expect((await (await get(`/api/oracle/${ASSET}`)).json()).deviationBps).toBe(12);
    expect((await (await get(`/api/corporate-action/${ASSET}`)).json()).pending).toBe(false);
  });
});

describe("validation", () => {
  it("rejects anything that is not an address", async () => {
    for (const path of [
      "/api/markets/not-an-address",
      `/api/markets/${MARKET}/position/nope`,
      "/api/oracle/0x123",
      "/api/corporate-action/hello",
    ]) {
      expect((await get(path)).status).toBe(400);
    }
  });

  it("refuses methods other than GET", async () => {
    const res = await fetch(`${base}/api/markets`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("answers preflight", async () => {
    const res = await fetch(`${base}/api/markets`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("encoding", () => {
  it("renders BigInt as a string rather than throwing", async () => {
    // JSON has no BigInt, and losing precision on a token amount is not acceptable, so every
    // response goes through a replacer instead.
    const text = await (await get(`/api/corporate-action/${ASSET}`)).text();
    expect(text).toContain('"uiMultiplier":"1000000000000000000"');
  });
});

describe("static files", () => {
  it("serves the app shell at the root", async () => {
    const res = await get("/");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("app shell");
  });

  it("falls back to the shell for unknown paths", async () => {
    expect(await (await get("/some/client/route")).text()).toContain("app shell");
  });

  it("does not let a traversal escape the served directory", async () => {
    // The normalised path must stay inside the root, whatever the request looks like.
    const res = await fetch(`${base}/../../../../etc/passwd`, { redirect: "manual" });
    const text = await res.text();
    expect(text).not.toContain("root:");
  });
});
