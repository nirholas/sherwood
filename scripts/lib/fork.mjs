/**
 * Shared plumbing for running against a fork of Robinhood Chain.
 *
 * Three things in here are not obvious and each cost real time to find:
 * foundry is intermittently absent from PATH in container shells, `fetch` refuses the WHATWG blocked
 * ports so a random pick in the 4000s intermittently fails as a bare "bad port", and every public
 * endpoint rate-limits anvil's fork backend hard enough to kill a run.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = join(ROOT, "contracts/out");

/** Endpoints that answer archive reads, which anvil needs to serve state at a pinned block. */
export const UPSTREAMS = [
  "https://rpc.mainnet.chain.robinhood.com",
  "https://rpc-robinhood.blockmachine.io",
  "https://robinhood.api.pocket.network",
];

export const ADDRESSES = {
  SPY: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
  NVDA: "0xd0601cE157dB5bDC3162BbaC2A2c8Af5320D9eEC",
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  SPY_USDG_500: "0xa7Bb1AC63BBaB0C44316E6c8C455213441689167",
  SWAP_ROUTER_02: "0xCaf681a66D020601342297493863E78C959E5cb2",
  MULTICALL3: "0xcA11bde05977b3631167028862bE2a173976CA11",
};

/** erc7201 storage roots, read from the verified `Stock` source. */
export const STOCK_STORAGE = 0x8d25ea8ee309999a79f0af498fbab0e424669497170669bd9e93b81a62babc00n;
export const ERC20_STORAGE = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function foundryBin(name) {
  for (const candidate of [name, join(process.env.HOME ?? "", ".foundry/bin", name)]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try the next location.
    }
  }
  throw new Error(`cannot find ${name}; install foundry or add it to PATH`);
}

const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
]);

export function pickPort(base = 8600, span = 300) {
  for (let i = 0; i < 200; i++) {
    const port = base + Math.floor(Math.random() * span);
    if (!BLOCKED_PORTS.has(port)) return port;
  }
  throw new Error("no usable port");
}

export async function pickUpstream() {
  for (const url of UPSTREAMS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(12_000),
      });
      if ((await res.json())?.result) return url;
    } catch {
      // Try the next endpoint.
    }
  }
  throw new Error("no Robinhood Chain endpoint answered");
}

export function artifact(name) {
  const path = join(OUT, `${name}.sol/${name}.json`);
  if (!existsSync(path)) throw new Error(`missing ${path}; run \`forge build --root contracts\` first`);
  const json = JSON.parse(readFileSync(path, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export async function startAnvil(upstream, { port = pickPort() } = {}) {
  const anvil = spawn(
    foundryBin("anvil"),
    [
      "--fork-url", upstream,
      "--port", String(port),
      "--silent",
      "--compute-units-per-second", "120",
      "--fork-retry-backoff", "2000",
      "--retries", "10",
      "--timeout", "45000",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  anvil.stderr.on("data", (d) => (stderr += d));

  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (anvil.exitCode !== null) throw new Error(`anvil exited: ${stderr.slice(0, 400)}`);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(3_000),
      });
      if ((await res.json())?.result) return { anvil, url, port };
    } catch {
      // Not up yet.
    }
    await sleep(700);
  }
  anvil.kill();
  throw new Error(`anvil did not come up: ${stderr.slice(0, 400)}`);
}

export function jsonRpc(url) {
  return async (method, params = []) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
  };
}
