/**
 * Wallet plumbing for Robinhood Chain, written against EIP-1193 directly so the app has no bundler
 * and no dependency to drift.
 */

export const CHAIN_ID = 4663;
export const CHAIN_ID_HEX = "0x1237";

const CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
  blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
};

export function provider() {
  return typeof window !== "undefined" ? window.ethereum ?? null : null;
}

export async function connect() {
  const eth = provider();
  if (!eth) throw new Error("No wallet found. Install a browser wallet and reload.");
  const accounts = await eth.request({ method: "eth_requestAccounts" });
  if (!accounts?.length) throw new Error("The wallet returned no accounts.");
  return accounts[0];
}

export async function currentAccount() {
  const eth = provider();
  if (!eth) return null;
  const accounts = await eth.request({ method: "eth_accounts" });
  return accounts?.[0] ?? null;
}

export async function chainId() {
  const eth = provider();
  if (!eth) return null;
  return Number(await eth.request({ method: "eth_chainId" }));
}

/** Switches to Robinhood Chain, adding it first when the wallet has never seen it. */
export async function ensureChain() {
  const eth = provider();
  if (!eth) throw new Error("No wallet found.");
  if ((await chainId()) === CHAIN_ID) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
  } catch (err) {
    // 4902 is the wallet saying it does not know this chain, which is a request to add it.
    if (err?.code === 4902 || err?.data?.originalError?.code === 4902) {
      await eth.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] });
      return;
    }
    throw err;
  }
}

// -------------------------------------------------------------------- encoding

const HEX = "0123456789abcdef";

function toHex(bytes) {
  let out = "0x";
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

/** Minimal keccak-256, so the app can compute selectors without pulling in a library. */
export function keccak256(bytes) {
  const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  const ROT = [
    [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
  ];
  const M = (1n << 64n) - 1n;
  const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M;
  const st = new Array(25).fill(0n);
  const rate = 136;
  const padLen = (rate - ((bytes.length + 1) % rate)) % rate;
  const padded = new Uint8Array(bytes.length + 1 + padLen);
  padded.set(bytes);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] |= 0x80;
  const view = new DataView(padded.buffer);

  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) st[i] ^= view.getBigUint64(off + i * 8, true);
    for (let round = 0; round < 24; round++) {
      const C = [0, 1, 2, 3, 4].map((x) => st[x] ^ st[x + 5] ^ st[x + 10] ^ st[x + 15] ^ st[x + 20]);
      const D = [0, 1, 2, 3, 4].map((x) => C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1));
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) st[x + 5 * y] ^= D[x];
      const B = new Array(25).fill(0n);
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(st[x + 5 * y], ROT[x][y]);
      }
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          st[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & B[((x + 2) % 5) + 5 * y] & M);
        }
      }
      st[0] ^= RC[round];
    }
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) outView.setBigUint64(i * 8, st[i] & M, true);
  return out;
}

export function selector(signature) {
  return toHex(keccak256(new TextEncoder().encode(signature)).slice(0, 4));
}

function word(value) {
  const hex = (typeof value === "bigint" ? value : BigInt(value)).toString(16);
  return hex.padStart(64, "0");
}

function addressWord(address) {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/** Encodes a call for the small set of argument shapes this app uses. */
export function encodeCall(signature, args = []) {
  const types = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")"));
  const parts = types ? types.split(",") : [];
  let data = selector(signature).slice(2);
  parts.forEach((type, i) => {
    const arg = args[i];
    data += type === "address" ? addressWord(arg) : word(arg);
  });
  return `0x${data}`;
}

export async function call(to, data) {
  const eth = provider();
  if (!eth) throw new Error("No wallet found.");
  return eth.request({ method: "eth_call", params: [{ to, data }, "latest"] });
}

export async function send(from, to, data) {
  const eth = provider();
  if (!eth) throw new Error("No wallet found.");
  return eth.request({ method: "eth_sendTransaction", params: [{ from, to, data }] });
}

/** Polls for a receipt, because not every wallet exposes a subscription. */
export async function waitForReceipt(hash, timeoutMs = 120_000) {
  const eth = provider();
  const started = Date.now();
  for (;;) {
    const receipt = await eth.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (receipt) {
      if (BigInt(receipt.status ?? "0x0") === 0n) throw new Error("The transaction reverted.");
      return receipt;
    }
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for the transaction.");
    await new Promise((r) => setTimeout(r, 1_500));
  }
}

export const MAX_UINT256 = (1n << 256n) - 1n;

export async function readUint(to, signature, args = []) {
  const result = await call(to, encodeCall(signature, args));
  return BigInt(result === "0x" ? "0x0" : result);
}

/** Turns a revert into something a person can act on rather than a hex blob. */
export function humanError(err) {
  const message = err?.data?.message ?? err?.message ?? String(err);
  if (/user rejected|User denied/i.test(message)) return "You rejected the transaction.";
  if (/insufficient funds/i.test(message)) return "Not enough ETH to pay for gas.";
  if (/MarketShielded/i.test(message)) return "This market is shielded: its collateral has no usable price right now.";
  if (/Unhealthy/i.test(message)) return "That would push the position past its liquidation limit.";
  if (/InsufficientLiquidity/i.test(message)) return "The market does not have enough idle USDG for that.";
  if (/Healthy/i.test(message)) return "That position is not liquidatable.";
  if (/IsPaused/i.test(message)) return "The issuer has paused this token, so it cannot be transferred.";
  return message.replace(/^Error: /, "");
}
