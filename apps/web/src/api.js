/** The read API. Every call degrades to a typed error the UI can render rather than throwing raw. */

const BASE = "";

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      message = (await res.json()).error ?? message;
    } catch {
      // A non-JSON body means the API is not the thing answering; the status is all there is.
    }
    throw new Error(message);
  }
  return res.json();
}

export const api = {
  health: () => get("/api/health"),
  markets: () => get("/api/markets").then((r) => r.markets),
  market: (address) => get(`/api/markets/${address}`),
  position: (market, user) => get(`/api/markets/${market}/position/${user}`),
  assets: () => get("/api/assets").then((r) => r.assets),
  oracle: (asset) => get(`/api/oracle/${asset}`),
  corporateAction: (asset) => get(`/api/corporate-action/${asset}`),
};

/** The oracle's reasons, in the order the enum declares them. */
export const STATUS_LABEL = [
  "live",
  "not configured",
  "no attested quote yet",
  "attested quote is stale",
  "the issuer has paused transfers",
  "the issuer has disavowed the price",
  "the pool has too little history",
  "the pool and the exchange disagree",
  "a corporate action is inside the price window",
  "too much of the basket has no price",
];

/** What each reason means for someone with a position open. */
export const STATUS_EXPLANATION = [
  "",
  "This market's collateral has not been configured on the oracle.",
  "No reporter has attested a price yet, so there is nothing to bound the pool against.",
  "The attested quote has aged out. Reporters post on a schedule; this clears on its own.",
  "The issuer has paused this token. Transfers revert, so collateral cannot be seized and nobody can be liquidated. Interest has stopped.",
  "The issuer has disavowed this token's price. Transfers may still work, but nothing will be liquidated against a price its own issuer will not stand behind.",
  "The pool has not stored enough observations to compute a manipulation-resistant average yet.",
  "The on-chain price and the exchange price have moved apart by more than this asset's band. One of the two is wrong and the feed will not guess which.",
  "A stock split or similar is inside the averaging window, so the average is a blend of two incompatible prices. Normal service resumes once the window clears the event.",
  "Too much of this basket has no usable price to lend against the rest.",
];
