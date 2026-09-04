#!/usr/bin/env node
/**
 * A complete, running Sherwood, locally, in one command.
 *
 * Forks Robinhood Chain, deploys the protocol, points it at the real SPY and NVDA pools, creates two
 * markets with different terms, opens a position in each, and then serves the API and the web app
 * against it. Everything the browser shows is read from a chain that is a copy of the real one, so
 * the prices are the prices the exchange is printing right now.
 *
 *   node scripts/demo.mjs            # then open the URL it prints
 *   node scripts/demo.mjs --halt     # start with SPY halted, to see the shield in the interface
 *   node scripts/demo.mjs --check    # boot it, prove every surface answers, exit
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, keccak256, encodeAbiParameters } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  ADDRESSES, ERC20_STORAGE, ROOT, STOCK_STORAGE, artifact, jsonRpc, pickPort, pickUpstream, sleep, startAnvil,
} from "./lib/fork.mjs";

const HALT_AT_START = process.argv.includes("--halt");
/** Boot everything, prove the API and the app answer, then exit. Used in CI. */
const CHECK_ONLY = process.argv.includes("--check");
const { SPY, USDG, MULTICALL3 } = ADDRESSES;


const log = (msg) => console.log(`  ${msg}`);
const heading = (msg) => console.log(`\n${msg}`);

async function main() {
  heading("Forking Robinhood Chain");
  const upstream = await pickUpstream();
  log(`upstream ${upstream}`);
  const { anvil, url, port: anvilPort } = await startAnvil(upstream);

  const shutdown = [() => anvil.kill("SIGKILL")];
  const stop = () => {
    for (const fn of shutdown.reverse()) {
      try {
        fn();
      } catch {
        // Best effort on the way out.
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    const { oracle, factory, markets } = await bootstrap(url);
    heading("Starting the read API and the app");
    const apiPort = pickPort(8700, 80);
    // tsx rather than node's own type stripping, because the API's imports carry .js specifiers
    // that resolve to .ts files and stripping does not rewrite them.
    const api = spawn(
      join(ROOT, "apps/api/node_modules/.bin/tsx"),
      ["src/main.ts"],
      {
        cwd: join(ROOT, "apps/api"),
        stdio: ["ignore", "inherit", "inherit"],
        env: {
          ...process.env,
          RHC_RPC_URL: url,
          SHERWOOD_FACTORY: factory,
          SHERWOOD_ORACLE: oracle,
          PORT: String(apiPort),
          CACHE_SECONDS: "3",
        },
      },
    );
    shutdown.push(() => api.kill("SIGKILL"));

    // Give the API a moment, then confirm it is actually answering before claiming it is.
    let up = false;
    for (let i = 0; i < 20 && !up; i++) {
      await sleep(700);
      try {
        up = (await (await fetch(`http://127.0.0.1:${apiPort}/api/health`)).json())?.ok === true;
      } catch {
        // Not yet.
      }
    }
    if (!up) throw new Error("the API did not come up");

    const summary = await (await fetch(`http://127.0.0.1:${apiPort}/api/markets`)).json();
    console.log("");
    console.log("  ┌──────────────────────────────────────────────────────────────┐");
    console.log(`  │  Sherwood is running at  http://localhost:${String(apiPort).padEnd(20)}│`);
    console.log("  └──────────────────────────────────────────────────────────────┘");
    console.log("");
    for (const m of summary.markets) {
      console.log(
        `  ${(m.collateralSymbol ?? "?").padEnd(6)} ${m.address}  ` +
          `$${(m.sharePrice ?? 0).toFixed(2).padStart(9)}/share  ` +
          `LTV ${String(Math.round(m.lltvPercent)).padStart(2)}%  ` +
          `${m.statusLabel}`,
      );
    }
    console.log("");
    log(`fork RPC        http://127.0.0.1:${anvilPort}  (chain 4663)`);
    log(`oracle          ${oracle}`);
    log(`factory         ${factory}`);
    log(`markets         ${markets.join(", ")}`);
    console.log("");
    if (CHECK_ONLY) {
      await verify(`http://127.0.0.1:${apiPort}`, markets);
      stop();
      return;
    }

    log("Add the fork RPC to a browser wallet as chain 4663 to transact against it.");
    log("Ctrl-C to stop.");

    await new Promise(() => {});
  } catch (err) {
    stop();
    throw err;
  }
}

async function bootstrap(url) {
  const chain = defineChain({
    id: 4663,
    name: "Robinhood Chain (fork)",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
  const publicClient = createPublicClient({ chain, transport: http(url, { timeout: 60_000 }) });
  const rpc = jsonRpc(url);

  const deployer = privateKeyToAccount(generatePrivateKey());
  const reporterA = privateKeyToAccount(generatePrivateKey());
  const reporterB = privateKeyToAccount(generatePrivateKey());
  const borrower = privateKeyToAccount(generatePrivateKey());
  for (const a of [deployer, reporterA, reporterB, borrower]) {
    await rpc("anvil_setBalance", [a.address, "0x56BC75E2D63100000"]);
  }
  const wallet = (account) => createWalletClient({ account, chain, transport: http(url, { timeout: 60_000 }) });

  const deploy = async (name, args) => {
    const { abi, bytecode } = artifact(name);
    const hash = await wallet(deployer).deployContract({ abi, bytecode, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return { address: receipt.contractAddress, abi };
  };
  const write = async (account, contract, functionName, args) => {
    const { request } = await publicClient.simulateContract({
      address: contract.address, abi: contract.abi, functionName, args, account,
    });
    const hash = await wallet(account).writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
    return receipt;
  };
  const read = (contract, functionName, args = []) =>
    publicClient.readContract({ address: contract.address, abi: contract.abi, functionName, args });

  heading("Deploying");
  const reporters = [reporterA.address, reporterB.address].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const oracle = await deploy("SherwoodOracle", [deployer.address, USDG, reporters, 2n]);
  const irm = await deploy("KinkedIrm", [
    20_000_000_000_000_000n, 100_000_000_000_000_000n, 1_500_000_000_000_000_000n, 900_000_000_000_000_000n,
  ]);
  const factory = await deploy("SherwoodFactory", []);
  log(`oracle ${oracle.address}`);
  log(`factory ${factory.address}`);

  heading("Configuring assets against their real pools");
  // The pools come from the generated registry rather than being rediscovered here. Every entry was
  // already verified to be the deepest USDG pool for its equity with enough observations for a TWAP,
  // and rediscovering costs four rate-limited round trips per asset for an answer already on disk.
  const { EQUITY_ASSETS } = await import("../packages/sdk/dist/assets.js");
  const wanted = ["SPY", "NVDA"];

  const listed = [];
  for (const symbol of wanted) {
    const entry = EQUITY_ASSETS.find((a) => a.symbol === symbol);
    if (!entry) {
      log(`${symbol}: not in the registry, skipping`);
      continue;
    }
    await write(deployer, oracle, "configureAsset", [
      entry.address,
      {
        pool: entry.pool,
        assetIsToken0: entry.assetIsToken0,
        quoteToken: USDG,
        quoteDecimals: 6,
        assetDecimals: entry.decimals,
        twapWindow: 600,
        maxDeviationBps: 200,
        offHoursDeviationBps: 500,
        maxQuoteAge: 86_400,
        enabled: true,
      },
    ]);
    const [twap, ok] = await read(oracle, "twapRawX26", [entry.address]);
    if (!ok) {
      log(`${symbol}: pool has too little history, skipping`);
      continue;
    }
    log(`${symbol} at $${(Number(twap) / 1e8).toFixed(2)} a share, pool ${entry.pool}`);
    listed.push({ symbol, asset: entry.address, twap });
  }

  if (listed.length === 0) throw new Error("no asset could be priced; the upstream may be lagging");

  heading("Attesting prices");
  const now = (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
  for (const { symbol, asset, twap } of listed) {
    const report = { asset, price: twap, observedAt: now, session: 2, nonce: now };
    const typedData = {
      domain: { name: "SherwoodOracle", version: "1", chainId: 4663, verifyingContract: oracle.address },
      types: {
        PriceReport: [
          { name: "asset", type: "address" }, { name: "price", type: "uint256" },
          { name: "observedAt", type: "uint64" }, { name: "session", type: "uint8" },
          { name: "nonce", type: "uint64" }, { name: "chainId", type: "uint256" },
        ],
      },
      primaryType: "PriceReport",
      message: { ...report, chainId: 4663n },
    };
    const signed = await Promise.all(
      [reporterA, reporterB].map(async (a) => ({ signer: a.address, signature: await a.signTypedData(typedData) })),
    );
    signed.sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
    await write(deployer, oracle, "postQuote", [report, signed.map((s) => s.signature)]);
    log(`${symbol} quorum posted`);
  }

  heading("Creating markets and opening a position in each");
  const slotFor = (account, base) =>
    keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, base]));
  const toWord = (v) => `0x${v.toString(16).padStart(64, "0")}`;
  await rpc("anvil_setStorageAt", [USDG, slotFor(deployer.address, 1n), toWord(5_000_000n * 10n ** 6n)]);

  const usdg = {
    address: USDG,
    abi: parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]),
  };
  const markets = [];
  for (const { symbol, asset, twap } of listed) {
    const params = {
      collateral: asset,
      loanToken: USDG,
      oracle: oracle.address,
      irm: irm.address,
      lltv: symbol === "SPY" ? 700_000_000_000_000_000n : 650_000_000_000_000_000n,
      liqBonusBps: 700n,
      closeFactorBps: 5000n,
      graceWindow: 14_400n,
      fee: 0n,
      feeRecipient: "0x0000000000000000000000000000000000000000",
    };
    await write(deployer, factory, "createMarket", [params]);
    const address = await read(factory, "markets", [BigInt(markets.length)]);
    const market = { address, abi: artifact("SherwoodMarket").abi };
    markets.push(address);

    await write(deployer, usdg, "approve", [address, 2n ** 255n]);
    await write(deployer, market, "supply", [400_000n * 10n ** 6n, deployer.address]);

    // Give the borrower real collateral and open a comfortable position, so the interface has
    // something true to show rather than an empty market.
    const token = {
      address: asset,
      abi: parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]),
    };
    await rpc("anvil_setStorageAt", [asset, slotFor(borrower.address, ERC20_STORAGE), toWord(200n * 10n ** 18n)]);
    await write(borrower, token, "approve", [address, 2n ** 255n]);
    await write(borrower, market, "supplyCollateral", [100n * 10n ** 18n, borrower.address]);

    // Half the borrowing power: visibly healthy, and it moves the utilization off zero.
    const collateralValue = (100n * twap) / 1n;
    const borrowAmount = (collateralValue * params.lltv) / 10n ** 18n / 100n / 2n;
    await write(borrower, market, "borrow", [borrowAmount, borrower.address]);
    log(`${symbol} market ${address}, borrowed $${(Number(borrowAmount) / 1e6).toFixed(0)} of $400,000 supplied`);
  }

  if (HALT_AT_START) {
    heading("Halting SPY so the shield is visible in the interface");
    await rpc("anvil_setStorageAt", [SPY, toWord(STOCK_STORAGE + 1n), toWord(1n)]);
    const market = { address: markets[0], abi: artifact("SherwoodMarket").abi };
    await write(deployer, market, "accrueInterest", []);
    log("SPY paused; its market is now shielded, no interest accruing, nothing liquidatable");
  }

  return { oracle: oracle.address, factory: factory.address, markets };
}


/** Every surface a person touches, exercised once, with the answers asserted. */
async function verify(base, markets) {
  heading("Checking every surface answers");
  const get = async (path, expectJson = true) => {
    const res = await fetch(`${base}${path}`);
    if (!res.ok) throw new Error(`${path} returned ${res.status}`);
    return expectJson ? res.json() : res.text();
  };

  const { markets: list } = await get("/api/markets");
  if (list.length !== markets.length) throw new Error(`expected ${markets.length} markets, got ${list.length}`);
  for (const m of list) {
    if (m.status !== 0 && !HALT_AT_START) throw new Error(`${m.collateralSymbol} is not live: ${m.statusLabel}`);
    if (!(m.sharePrice > 0) && m.status === 0) throw new Error(`${m.collateralSymbol} has no share price`);
    if (!(Number(m.totalBorrowAssets) > 0)) throw new Error(`${m.collateralSymbol} has no borrows`);
    log(
      `/api/markets  ${(m.collateralSymbol ?? "?").padEnd(5)} $${(m.sharePrice ?? 0).toFixed(2)}/share  ` +
        `${m.utilizationPercent.toFixed(1)}% used  supply ${m.supplyApr.toFixed(2)}%  borrow ${m.borrowApr.toFixed(2)}%  ${m.statusLabel}`,
    );
  }

  const first = list[0];
  const oracleView = await get(`/api/oracle/${first.collateral}`);
  if (oracleView.deviationBps === null) throw new Error("the oracle view carries no deviation");
  log(`/api/oracle   both sources ${oracleView.deviationBps > 0 ? "+" : ""}${oracleView.deviationBps}bps apart`);

  const corp = await get(`/api/corporate-action/${first.collateral}`);
  if (typeof corp.pending !== "boolean") throw new Error("the corporate-action view is malformed");
  log(`/api/corporate-action  multiplier ${corp.uiMultiplier}, pending ${corp.pending}`);

  const assets = await get("/api/assets");
  log(`/api/assets   ${assets.assets.length} equities in the registry`);

  const landing = await get("/", false);
  if (!landing.includes("Sherwood")) throw new Error("the landing page did not render");
  const app = await get("/app.html", false);
  if (!app.includes("Connect wallet")) throw new Error("the app shell did not render");
  const css = await get("/assets/app.css", false);
  if (!css.includes("--accent")) throw new Error("the stylesheet did not load");
  const script = await get("/src/app.js", false);
  if (!script.includes("supplyCollateral")) throw new Error("the app script did not load");
  log("web           landing page, app shell, stylesheet and modules all served");

  console.log("\n  ✓ the whole stack is up: fork, contracts, oracle, markets, API and app");
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
