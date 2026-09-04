#!/usr/bin/env node
/**
 * End to end, against a fork of Robinhood Chain itself.
 *
 * Nothing here is simulated except the passage of time. The oracle is pointed at the real SPY/USDG
 * Uniswap pool, prices come out of that pool's real observations, and the collateral is the real
 * beacon-proxied Stock token, halted by writing the same storage slot its own `pause()` writes.
 *
 * What it proves, in order:
 *   1. the tick the live pool holds decodes to the share price the exchange is printing
 *   2. a quorum-signed quote inside the band brings the feed live
 *   3. supply, collateral, borrow and repay all work against real tokens
 *   4. a halt freezes interest, blocks borrowing, and makes liquidation impossible
 *   5. the grace ramp starts the liquidation bonus at zero and restores it over the window
 *   6. a real price move through the real pool makes a position liquidatable, and it liquidates
 *
 *   node scripts/e2e.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, encodeFunctionData } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = join(ROOT, "contracts/out");

/** Endpoints that answer archive reads; anvil needs one that can serve state at a pinned block. */
const UPSTREAMS = [
  "https://rpc.mainnet.chain.robinhood.com",
  "https://rpc-robinhood.blockmachine.io",
  "https://robinhood.api.pocket.network",
];

const SPY = "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const SPY_USDG_500 = "0xa7Bb1AC63BBaB0C44316E6c8C455213441689167";
const UNIVERSAL_ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const SWAP_ROUTER_02 = "0xCaf681a66D020601342297493863E78C959E5cb2";

/** erc7201 storage roots, taken from the verified Stock source. */
const STOCK_STORAGE = 0x8d25ea8ee309999a79f0af498fbab0e424669497170669bd9e93b81a62babc00n;
const ERC20_STORAGE = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;

// ------------------------------------------------------------------ utilities

/** Foundry is intermittently absent from PATH in container shells, so resolve it explicitly. */
function foundryBin(name) {
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

/**
 * `fetch` refuses the WHATWG blocked ports, and a random pick in the 4000s lands on 5060 or 5061
 * often enough to look like an intermittent network fault rather than a port choice.
 */
const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
]);

function pickPort(base = 8600, span = 300) {
  for (let i = 0; i < 200; i++) {
    const port = base + Math.floor(Math.random() * span);
    if (!BLOCKED_PORTS.has(port)) return port;
  }
  throw new Error("no usable port");
}

async function pickUpstream() {
  for (const url of UPSTREAMS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(12_000),
      });
      const json = await res.json();
      if (json?.result) return url;
    } catch {
      // Try the next endpoint.
    }
  }
  throw new Error("no Robinhood Chain endpoint answered");
}

function artifact(name) {
  const path = join(OUT, `${name}.sol/${name}.json`);
  if (!existsSync(path)) throw new Error(`missing ${path}; run \`forge build --root contracts\` first`);
  const json = JSON.parse(readFileSync(path, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const log = (msg) => console.log(`  ${msg}`);
const heading = (msg) => console.log(`\n[${++step}] ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

// --------------------------------------------------------------------- anvil

async function startAnvil(upstream) {
  const port = pickPort();
  const anvil = spawn(
    foundryBin("anvil"),
    [
      "--fork-url", upstream,
      "--port", String(port),
      "--silent",
      // Public endpoints rate-limit the fork backend hard; without throttling the run dies in 429s.
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
      if ((await res.json())?.result) return { anvil, url };
    } catch {
      // Not up yet.
    }
    await sleep(700);
  }
  anvil.kill();
  throw new Error(`anvil did not come up: ${stderr.slice(0, 400)}`);
}

// ---------------------------------------------------------------------- main

async function main() {
  heading("Selecting an upstream and forking Robinhood Chain");
  const upstream = await pickUpstream();
  log(`upstream ${upstream}`);
  const { anvil, url } = await startAnvil(upstream);

  try {
    await run(url);
  } finally {
    anvil.kill("SIGKILL");
  }
}

async function run(url) {
  const chain = defineChain({
    id: 4663,
    name: "Robinhood Chain (fork)",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });
  const publicClient = createPublicClient({ chain, transport: http(url, { timeout: 60_000 }) });

  const rpc = async (method, params = []) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
  };

  // The well-known anvil accounts carry EIP-7702 delegations on this chain, which changes how
  // signature-checking contracts treat them. Fresh keys avoid the whole class of surprise.
  const deployerKey = generatePrivateKey();
  const rep1Key = generatePrivateKey();
  const rep2Key = generatePrivateKey();
  const borrowerKey = generatePrivateKey();
  const liquidatorKey = generatePrivateKey();
  const deployer = privateKeyToAccount(deployerKey);
  const rep1 = privateKeyToAccount(rep1Key);
  const rep2 = privateKeyToAccount(rep2Key);
  const borrower = privateKeyToAccount(borrowerKey);
  const liquidator = privateKeyToAccount(liquidatorKey);

  for (const account of [deployer, borrower, liquidator, rep1, rep2]) {
    await rpc("anvil_setBalance", [account.address, "0x56BC75E2D63100000"]); // 100 ETH
  }

  const wallet = (account) => createWalletClient({ account, chain, transport: http(url, { timeout: 60_000 }) });
  const deployerWallet = wallet(deployer);

  async function deploy(name, args) {
    const { abi, bytecode } = artifact(name);
    const hash = await deployerWallet.deployContract({ abi, bytecode, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert(receipt.contractAddress, `${name} failed to deploy`);
    return { address: receipt.contractAddress, abi };
  }

  async function write(account, contract, functionName, args, value) {
    // Simulating first turns a bare "reverted" receipt into the contract's own named error, which is
    // the difference between a debuggable failure and an afternoon.
    const { request } = await publicClient.simulateContract({
      address: contract.address,
      abi: contract.abi,
      functionName,
      args,
      value,
      account,
    });
    const hash = await wallet(account).writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert(receipt.status === "success", `${functionName} reverted`);
    return receipt;
  }

  const read = (contract, functionName, args = []) =>
    publicClient.readContract({ address: contract.address, abi: contract.abi, functionName, args });

  // ---------------------------------------------------------------- deploy

  heading("Deploying the oracle, rate model and factory");
  const reporters = [rep1.address, rep2.address].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const oracle = await deploy("SherwoodOracle", [deployer.address, USDG, reporters, 2n]);
  const irm = await deploy("KinkedIrm", [20_000_000_000_000_000n, 100_000_000_000_000_000n, 1_500_000_000_000_000_000n, 900_000_000_000_000_000n]);
  const factory = await deploy("SherwoodFactory", []);
  ok(`oracle ${oracle.address}`);
  ok(`factory ${factory.address}`);

  // A short window keeps the run to a few minutes; production uses 1800 seconds.
  const TWAP_WINDOW = 120;
  const poolToken0 = await publicClient.readContract({
    address: SPY_USDG_500,
    abi: parseAbi(["function token0() view returns (address)"]),
    functionName: "token0",
  });
  await write(deployer, oracle, "configureAsset", [
    SPY,
    {
      pool: SPY_USDG_500,
      assetIsToken0: poolToken0.toLowerCase() === SPY.toLowerCase(),
      quoteToken: USDG,
      quoteDecimals: 6,
      assetDecimals: 18,
      twapWindow: TWAP_WINDOW,
      maxDeviationBps: 200,
      offHoursDeviationBps: 500,
      maxQuoteAge: 3600,
      enabled: true,
    },
  ]);
  ok(`SPY configured against the live pool ${SPY_USDG_500}`);

  // ------------------------------------------------------------- the price

  heading("Reading the price out of the real pool");
  const [twapX26, twapOk] = await read(oracle, "twapRawX26", [SPY]);
  assert(twapOk, "the live pool must have enough observations");
  const sharePrice = Number(twapX26) / 1e8;
  log(`pool TWAP implies $${sharePrice.toFixed(2)} a share`);
  assert(sharePrice > 300 && sharePrice < 2000, "SPY outside a believable range means the math is wrong");
  ok("the tick decodes to a real SPY price");

  // A fork starts at the timestamp of the block it forked from, which is behind the wall clock, and
  // `evm_increaseTime` later pushes it ahead. Quotes are stamped from chain time in both directions,
  // because the oracle rejects an observation dated in its own future.
  let nonce = 0n;
  async function chainTime() {
    return (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
  }
  async function postQuote(price1e8, session = 2) {
    const now = await chainTime();
    nonce = now > nonce ? now : nonce + 1n;
    const report = { asset: SPY, price: price1e8, observedAt: now, session, nonce };
    const typedData = {
      domain: { name: "SherwoodOracle", version: "1", chainId: 4663, verifyingContract: oracle.address },
      types: {
        PriceReport: [
          { name: "asset", type: "address" },
          { name: "price", type: "uint256" },
          { name: "observedAt", type: "uint64" },
          { name: "session", type: "uint8" },
          { name: "nonce", type: "uint64" },
          { name: "chainId", type: "uint256" },
        ],
      },
      primaryType: "PriceReport",
      message: { ...report, chainId: 4663n },
    };
    const signed = await Promise.all(
      [rep1, rep2].map(async (a) => ({ signer: a.address, signature: await a.signTypedData(typedData) })),
    );
    signed.sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
    await write(deployer, oracle, "postQuote", [report, signed.map((s) => s.signature)]);
  }

  heading("Bringing the feed live with a quorum-signed quote");
  await postQuote(twapX26);
  let [price, status] = await read(oracle, "peek", [SPY]);
  assert(status === 0, `expected a live price, got status ${status}`);
  assert(price === twapX26, "the served price must be the pool's, not the attested one");
  ok("two signatures inside the band, and the feed serves the pool price");

  // A single reporter must not be able to move it.
  await postQuote(twapX26 * 3n);
  [, status] = await read(oracle, "peek", [SPY]);
  assert(status === 7, `an absurd quote must disable the feed, got status ${status}`);
  ok("an out-of-band quote takes the feed offline instead of repricing it");
  await postQuote(twapX26);

  // ------------------------------------------------------------ the market

  heading("Creating an isolated SPY market");
  const params = {
    collateral: SPY,
    loanToken: USDG,
    oracle: oracle.address,
    irm: irm.address,
    lltv: 700_000_000_000_000_000n,
    liqBonusBps: 700n,
    closeFactorBps: 5000n,
    graceWindow: 14_400n,
    fee: 0n,
    feeRecipient: "0x0000000000000000000000000000000000000000",
  };
  const predicted = await read(factory, "predict", [params]);
  await write(deployer, factory, "createMarket", [params]);
  const marketAddress = await read(factory, "markets", [0n]);
  assert(marketAddress.toLowerCase() === predicted.toLowerCase(), "the market must land where its terms predict");
  const market = { address: marketAddress, abi: artifact("SherwoodMarket").abi };
  ok(`market at ${marketAddress}, the address its parameters predicted`);

  // ------------------------------------------------------------- funding

  heading("Funding accounts by writing the tokens' own balance slots");
  const { keccak256, encodeAbiParameters } = await import("viem");
  const slotFor = (account, base) =>
    keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, base]));
  const toWord = (v) => `0x${v.toString(16).padStart(64, "0")}`;

  // USDG keeps balances in a plain mapping at slot 1; the Stock token uses its erc7201 root.
  for (const [account, amount] of [
    [deployer.address, 2_000_000n * 10n ** 6n],
    [liquidator.address, 1_000_000n * 10n ** 6n],
    [borrower.address, 50_000n * 10n ** 6n],
  ]) {
    await rpc("anvil_setStorageAt", [USDG, slotFor(account, 1n), toWord(amount)]);
  }
  await rpc("anvil_setStorageAt", [SPY, slotFor(borrower.address, ERC20_STORAGE), toWord(1_000n * 10n ** 18n)]);

  const usdg = { address: USDG, abi: parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]) };
  const spy = { address: SPY, abi: parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function paused() view returns (bool)"]) };
  assert((await read(usdg, "balanceOf", [deployer.address])) === 2_000_000n * 10n ** 6n, "USDG funding failed");
  assert((await read(spy, "balanceOf", [borrower.address])) === 1_000n * 10n ** 18n, "SPY funding failed");
  ok("real USDG and real SPY balances in place");

  // ----------------------------------------------------------- the flow

  heading("Supplying, collateralising and borrowing");
  await write(deployer, usdg, "approve", [marketAddress, 2n ** 255n]);
  await write(borrower, usdg, "approve", [marketAddress, 2n ** 255n]);
  await write(liquidator, usdg, "approve", [marketAddress, 2n ** 255n]);
  await write(borrower, spy, "approve", [marketAddress, 2n ** 255n]);

  await write(deployer, market, "supply", [500_000n * 10n ** 6n, deployer.address]);
  await write(borrower, market, "supplyCollateral", [100n * 10n ** 18n, borrower.address]);

  const collateralValue = (100n * twapX26) / 1n; // 100 tokens is 100 shares at 1e8
  const borrowAmount = 52_000n * 10n ** 6n;
  await write(borrower, market, "borrow", [borrowAmount, borrower.address]);
  assert((await read(usdg, "balanceOf", [borrower.address])) === 102_000n * 10n ** 6n, "the borrower did not receive USDG");
  let health = await read(market, "healthOf", [borrower.address]);
  assert(health[2] === true, "the position should be solvent");
  ok(`borrowed $52,000 against ${(Number(collateralValue) / 1e8).toFixed(0)} of SPY, solvent`);

  heading("Refusing a borrow that would breach the limit");
  let refused = false;
  try {
    await write(borrower, market, "borrow", [30_000n * 10n ** 6n, borrower.address]);
  } catch {
    refused = true;
  }
  assert(refused, "a borrow past the LLTV must revert");
  ok("the limit holds");

  // ----------------------------------------------------------- the halt

  heading("Halting the token the way its issuer would, and checking the shield");
  // `pause()` writes `true` into the second word of the Stock storage root.
  await rpc("anvil_setStorageAt", [SPY, toWord(STOCK_STORAGE + 1n), toWord(1n)]);
  assert((await read(spy, "paused")) === true, "the token should now be paused");

  [, status] = await read(oracle, "peek", [SPY]);
  assert(status === 4, `a paused token should have no price, got ${status}`);

  await write(deployer, market, "accrueInterest", []);
  assert((await read(market, "shielded")) === true, "the market should be shielded");
  const debtAtHalt = await read(market, "borrowAssetsOf", [borrower.address]);

  await rpc("evm_increaseTime", [3 * 24 * 3600]);
  await rpc("evm_mine", []);
  await write(deployer, market, "accrueInterest", []);
  const debtAfterHalt = await read(market, "borrowAssetsOf", [borrower.address]);
  assert(debtAfterHalt === debtAtHalt, `interest accrued through a halt: ${debtAtHalt} -> ${debtAfterHalt}`);
  ok("three days halted and the debt did not move by one unit");

  let blocked = false;
  try {
    await write(borrower, market, "borrow", [1n * 10n ** 6n, borrower.address]);
  } catch {
    blocked = true;
  }
  assert(blocked, "borrowing must be refused while shielded");

  blocked = false;
  try {
    await write(liquidator, market, "liquidate", [borrower.address, 1_000n * 10n ** 6n]);
  } catch {
    blocked = true;
  }
  assert(blocked, "liquidation must be impossible while shielded");
  ok("borrowing and liquidation are both refused");

  await write(borrower, market, "repay", [1_000n * 10n ** 6n, 0n, borrower.address]);
  ok("repayment still works, which is the point");

  // ------------------------------------------------------------ the ramp

  heading("Unhalting, and watching the liquidation bonus ramp from zero");
  await rpc("anvil_setStorageAt", [SPY, toWord(STOCK_STORAGE + 1n), toWord(0n)]);
  await postQuote(twapX26);
  await write(deployer, market, "accrueInterest", []);
  assert((await read(market, "shielded")) === false, "the shield should have lifted");
  let bonus = await read(market, "currentBonusBps");
  assert(bonus === 0n, `the bonus must start at zero, got ${bonus}`);
  log("bonus at the moment of reopening: 0bps");

  await rpc("evm_increaseTime", [3600]);
  await rpc("evm_mine", []);
  bonus = await read(market, "currentBonusBps");
  assert(bonus === 175n, `a quarter of the window should give 175bps, got ${bonus}`);
  log("one hour into a four hour window: 175bps");

  await rpc("evm_increaseTime", [3 * 3600 + 60]);
  await rpc("evm_mine", []);
  bonus = await read(market, "currentBonusBps");
  assert(bonus === 700n, `the bonus should be fully restored, got ${bonus}`);
  ok("zero, then a quarter, then whole: the ramp behaves exactly as specified");

  // ------------------------------------------------------ a real price move

  heading("Moving the real pool, and liquidating what that makes unhealthy");
  // With $52k of debt against $77k of collateral at a 70% limit, the position breaks a little under
  // a 10% drawdown. Getting there is not a matter of picking a swap size: this pool's liquidity is a
  // cliff, and 133 SPY is the difference between moving the price by nothing and collapsing it to
  // $1.98. So the swap is bounded by Uniswap's own price limit, which fills only as far as the target
  // and stops, and the result is asserted to look like a market move rather than a manipulated pool.
  await rpc("anvil_setStorageAt", [SPY, slotFor(deployer.address, ERC20_STORAGE), toWord(400_000n * 10n ** 18n)]);
  await write(deployer, spy, "approve", [SWAP_ROUTER_02, 2n ** 255n]);

  const router = {
    address: SWAP_ROUTER_02,
    abi: parseAbi([
      "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
    ]),
  };
  const pool = {
    address: SPY_USDG_500,
    abi: parseAbi(["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"]),
  };
  const spyIsToken0 = poolToken0.toLowerCase() === SPY.toLowerCase();
  const spotShare = async () => {
    const [, tick] = await read(pool, "slot0");
    const ratio = Math.pow(1.0001, Number(tick));
    return (spyIsToken0 ? ratio : 1 / ratio) * 1e12;
  };

  // A tenth off the price. sqrtPrice scales with the square root, and selling the equity moves the
  // pool's price down when the equity is token0 and up when it is token1.
  const [sqrtNow] = await read(pool, "slot0");
  const sqrtLimit = spyIsToken0
    ? (BigInt(sqrtNow) * 9487n) / 10000n // sqrt(0.90)
    : (BigInt(sqrtNow) * 10541n) / 10000n; // 1 / sqrt(0.90)

  await write(deployer, router, "exactInputSingle", [
    {
      tokenIn: SPY,
      tokenOut: USDG,
      fee: 500,
      recipient: deployer.address,
      amountIn: 200_000n * 10n ** 18n,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: sqrtLimit,
    },
  ]);
  const spot = await spotShare();
  log(`sold into the pool up to its price limit, taking spot to $${spot.toFixed(2)} from $${sharePrice.toFixed(2)}`);

  // The average only reflects the new tick once the window has passed at that tick, and an
  // observation is only written when the pool is touched, so nudge it after the wait.
  await rpc("evm_increaseTime", [TWAP_WINDOW + 60]);
  await rpc("evm_mine", []);
  await write(deployer, router, "exactInputSingle", [
    {
      tokenIn: SPY, tokenOut: USDG, fee: 500, recipient: deployer.address,
      amountIn: 10n ** 15n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
    },
  ]);

  const [movedTwap, movedOk] = await read(oracle, "twapRawX26", [SPY]);
  assert(movedOk, "the pool should still price after an ordinary drawdown");
  const movedShare = Number(movedTwap) / 1e8;
  log(`the pool now averages $${movedShare.toFixed(2)} a share, down from $${sharePrice.toFixed(2)}`);
  assert(movedShare < sharePrice, "the swap should have pushed the price down");
  // A drawdown, not a wipeout. If the pool ends up at a tenth of its price the test has proved
  // nothing about ordinary liquidation.
  assert(
    movedShare > sharePrice * 0.8 && movedShare < sharePrice * 0.97,
    `the move should look like a market drawdown, got $${movedShare.toFixed(2)} from $${sharePrice.toFixed(2)}`,
  );

  // Reporters attest the new on-chain reality, which is what keeps the two sources inside the band.
  await postQuote(movedTwap);
  [price, status] = await read(oracle, "peek", [SPY]);
  assert(status === 0, `the feed should be live after both sources moved together, got ${status}`);

  health = await read(market, "healthOf", [borrower.address]);
  const debt = health[1];
  log(`collateral now $${(Number(health[0]) / 1e8).toFixed(0)} against $${(Number(debt) / 1e6).toFixed(0)} of debt`);

  assert(health[2] === false, "the drawdown should have made the position liquidatable");
  const before = await read(spy, "balanceOf", [liquidator.address]);
  await write(liquidator, market, "liquidate", [borrower.address, debt / 4n]);
  const seized = (await read(spy, "balanceOf", [liquidator.address])) - before;
  assert(seized > 0n, "the liquidator should have received collateral");
  const after = await read(market, "borrowAssetsOf", [borrower.address]);
  assert(after < debt, "the debt should have gone down");
  const seizedValue = (Number(seized) / 1e18) * movedShare;
  const repaid = Number(debt / 4n) / 1e6;
  log(`repaid $${repaid.toFixed(0)} and seized $${seizedValue.toFixed(0)} of SPY, a ${(((seizedValue - repaid) / repaid) * 100).toFixed(2)}% bonus`);
  ok(`liquidated: debt $${(Number(debt) / 1e6).toFixed(0)} -> $${(Number(after) / 1e6).toFixed(0)}`);

  heading("Unwinding");
  const finalDebt = await read(market, "borrowAssetsOf", [borrower.address]);
  if (finalDebt > 0n) {
    await rpc("anvil_setStorageAt", [USDG, slotFor(borrower.address, 1n), toWord(finalDebt * 2n)]);
    const [, borrowShares] = await read(market, "positions", [borrower.address]);
    await write(borrower, market, "repay", [0n, borrowShares, borrower.address]);
  }
  assert((await read(market, "borrowAssetsOf", [borrower.address])) === 0n, "the debt should be gone");
  const [, , collateralLeft] = await read(market, "positions", [borrower.address]);
  if (collateralLeft > 0n) await write(borrower, market, "withdrawCollateral", [collateralLeft, borrower.address]);
  ok("debt repaid in full and collateral withdrawn");

  console.log("\n✓ end to end passed against a fork of Robinhood Chain");
  console.log(
    `  real SPY pool, real USDG, real Stock token; ` +
      `price $${sharePrice.toFixed(2)} -> $${movedShare.toFixed(2)}, halt shield and grace ramp both verified`,
  );
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
