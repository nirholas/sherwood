import { Session } from "@sherwood/sdk";
import { currentSession } from "./session.js";

/**
 * Live US equity quotes for the attestation layer.
 *
 * Two independent providers, both keyless:
 *
 *   * CNBC's quote service is the primary. It batches the entire registry into one request, which
 *     matters more than it sounds: the obvious alternative rate-limits at a handful of symbols and
 *     a reporter that cannot finish a round lets every quote go stale, which takes every market
 *     offline. One request per round removes that failure mode.
 *   * Yahoo's chart endpoint is the failover, per symbol, with backoff.
 *
 * The session is never taken from either of them; it is computed from the exchange calendar in
 * `session.ts`, because it selects the oracle's deviation band and the providers get it wrong.
 *
 * None of these prices is what the protocol settles at. They only bound the on-chain TWAP, so a bad
 * print can take the feed offline and can never move a price. That is what makes a public data
 * source acceptable here.
 */

const CNBC_ENDPOINT = "https://quote.cnbc.com/quote-html-webservice/quote.htm";
const YAHOO_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/** CNBC truncates very long symbol lists, so rounds are chunked. */
const CNBC_BATCH_SIZE = 25;

export type EquityQuote = {
  symbol: string;
  /** USD per whole share, 1e8. */
  price1e8: bigint;
  /** Exchange timestamp of the print, in seconds. */
  observedAt: bigint;
  session: Session;
  price: number;
  previousClose: number | null;
  currency: string;
  exchange: string;
  source: "cnbc" | "yahoo";
};

class TransientError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Converts a decimal price into the oracle's 1e8 fixed point without floating-point drift. */
export function toPrice1e8(price: number): bigint {
  if (!Number.isFinite(price) || price <= 0) throw new Error(`unusable price ${price}`);
  const [whole, frac = ""] = price.toFixed(8).split(".");
  return BigInt(whole) * 100_000_000n + BigInt(frac.padEnd(8, "0").slice(0, 8));
}

/** CNBC renders prices with thousands separators once a name crosses $1,000. */
export function parsePrice(raw: unknown): number {
  const n = Number(String(raw ?? "").replace(/,/g, "").trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error(`unparseable price ${String(raw)}`);
  return n;
}

// ------------------------------------------------------------------------ CNBC

type CnbcQuote = {
  symbol?: string;
  last?: string;
  previous_day_closing?: string;
  currencyCode?: string;
  exchange?: string;
  name?: string;
  code?: string;
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchCnbcBatch(symbols: readonly string[], signal: AbortSignal): Promise<EquityQuote[]> {
  const url =
    `${CNBC_ENDPOINT}?symbols=${symbols.map(encodeURIComponent).join("%7C")}` +
    `&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal });
  if (res.status === 429 || res.status >= 500) throw new TransientError(`cnbc returned ${res.status}`);
  if (!res.ok) throw new Error(`cnbc returned ${res.status}`);

  const json = (await res.json()) as { ITVQuoteResult?: { ITVQuote?: CnbcQuote | CnbcQuote[] } };
  const raw = json.ITVQuoteResult?.ITVQuote;
  if (!raw) throw new TransientError("cnbc returned no quotes");
  const list = Array.isArray(raw) ? raw : [raw];

  const session = currentSession();
  const observedAt = BigInt(Math.floor(Date.now() / 1000));
  const out: EquityQuote[] = [];
  for (const q of list) {
    // A non-zero `code` is CNBC's per-symbol error channel.
    if (!q.symbol || (q.code && q.code !== "0")) continue;
    let price: number;
    try {
      price = parsePrice(q.last);
    } catch {
      continue;
    }
    out.push({
      symbol: q.symbol.toUpperCase(),
      price,
      price1e8: toPrice1e8(price),
      observedAt,
      session,
      previousClose: (() => {
        try {
          return parsePrice(q.previous_day_closing);
        } catch {
          return null;
        }
      })(),
      currency: q.currencyCode ?? "USD",
      exchange: q.exchange ?? "unknown",
      source: "cnbc",
    });
  }
  return out;
}

// ----------------------------------------------------------------------- Yahoo

async function fetchYahooOne(host: string, symbol: string, signal: AbortSignal): Promise<EquityQuote> {
  const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal });
  if (res.status === 429 || res.status >= 500) {
    const header = res.headers.get("retry-after");
    const hinted = header ? Number(header) * 1000 : NaN;
    throw new TransientError(`${host} returned ${res.status} for ${symbol}`, Number.isFinite(hinted) ? hinted : null);
  }
  if (!res.ok) throw new Error(`${host} returned ${res.status} for ${symbol}`);
  const json = (await res.json()) as {
    chart?: { result?: Array<{ meta?: Record<string, unknown> }>; error?: { description?: string } };
  };
  if (json.chart?.error) throw new Error(json.chart.error.description ?? "chart error");
  const meta = json.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`no data for ${symbol}`);

  const price = parsePrice(meta.regularMarketPrice);
  const marketTime = Number(meta.regularMarketTime);
  return {
    symbol: String(meta.symbol ?? symbol).toUpperCase(),
    price,
    price1e8: toPrice1e8(price),
    observedAt: BigInt(Number.isFinite(marketTime) ? Math.floor(marketTime) : Math.floor(Date.now() / 1000)),
    session: currentSession(),
    previousClose: Number.isFinite(Number(meta.previousClose)) ? Number(meta.previousClose) : null,
    currency: String(meta.currency ?? "USD"),
    exchange: String(meta.fullExchangeName ?? meta.exchangeName ?? "unknown"),
    source: "yahoo",
  };
}

/** One symbol from Yahoo, rotating hosts and backing off through the rate limit. */
export async function fetchYahooQuote(symbol: string, timeoutMs = 15_000, attempts = 3): Promise<EquityQuote> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const host of YAHOO_HOSTS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetchYahooOne(host, symbol, controller.signal);
      } catch (err) {
        lastError = err;
        const retryable = err instanceof TransientError || (err instanceof Error && err.name === "AbortError");
        if (!retryable) throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    if (attempt < attempts - 1) {
      const hinted = lastError instanceof TransientError ? lastError.retryAfterMs : null;
      // Jitter keeps a fleet of reporters from retrying in lockstep and re-triggering the limit.
      await sleep(hinted ?? Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 400));
    }
  }
  throw new Error(`no yahoo host could quote ${symbol}: ${String(lastError)}`);
}

// ------------------------------------------------------------------- combined

/** One symbol, primary source first. */
export async function fetchQuote(symbol: string, timeoutMs = 15_000): Promise<EquityQuote> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const [quote] = await fetchCnbcBatch([symbol], controller.signal);
    if (quote) return quote;
  } catch {
    // Fall through to the independent provider.
  } finally {
    clearTimeout(timer);
  }
  return fetchYahooQuote(symbol, timeoutMs);
}

/**
 * The whole registry in as few requests as possible: batched from the primary, then anything it
 * missed retried individually against the failover.
 */
export async function fetchQuotes(
  symbols: readonly string[],
  timeoutMs = 20_000,
): Promise<{ quotes: EquityQuote[]; failures: { symbol: string; error: string }[] }> {
  const wanted = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const found = new Map<string, EquityQuote>();
  const errors = new Map<string, string>();

  for (const group of chunk(wanted, CNBC_BATCH_SIZE)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for (const quote of await fetchCnbcBatch(group, controller.signal)) {
        if (wanted.includes(quote.symbol)) found.set(quote.symbol, quote);
      }
    } catch (err) {
      for (const symbol of group) errors.set(symbol, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  const missing = wanted.filter((s) => !found.has(s));
  for (const symbol of missing) {
    try {
      found.set(symbol, await fetchYahooQuote(symbol, timeoutMs));
      errors.delete(symbol);
    } catch (err) {
      errors.set(symbol, err instanceof Error ? err.message : String(err));
    }
    if (missing.length > 1) await sleep(150);
  }

  return {
    quotes: wanted.filter((s) => found.has(s)).map((s) => found.get(s)!),
    failures: [...errors.entries()].map(([symbol, error]) => ({ symbol, error })),
  };
}
