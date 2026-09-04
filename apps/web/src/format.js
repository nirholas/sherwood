/** Formatting shared by the landing page and the app. Every number here is derived, never invented. */

export const USDG_DECIMALS = 6;

export function usd(value, opts = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const { decimals = 2, compact = false } = opts;
  if (compact && Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (compact && Math.abs(value) >= 10_000) return `$${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function pct(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(decimals)}%`;
}

/** Renders a raw token amount without going through a float. */
export function units(raw, decimals, places = 4) {
  const value = typeof raw === "bigint" ? raw : BigInt(raw ?? 0);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, "0").slice(0, places);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return places > 0 ? `${grouped}.${frac}` : grouped;
}

/** Parses a typed amount into raw units without floating-point drift. */
export function parseUnits(text, decimals) {
  const cleaned = String(text ?? "").trim().replace(/,/g, "");
  if (!cleaned || !/^\d*\.?\d*$/.test(cleaned)) return null;
  const [whole = "0", frac = ""] = cleaned.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac || "0").padEnd(decimals, "0") || "0");
}

export function shortAddress(address) {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function relativeTime(seconds) {
  if (!seconds) return "never";
  const delta = Math.floor(Date.now() / 1000) - seconds;
  if (delta < 0) return "in the future";
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

export function countdown(untilSeconds) {
  const delta = untilSeconds - Math.floor(Date.now() / 1000);
  if (delta <= 0) return "now";
  const h = Math.floor(delta / 3600);
  const m = Math.floor((delta % 3600) / 60);
  const s = delta % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Health factor drives the colour everywhere it appears, so the mapping lives in one place. */
export function healthTone(healthFactor) {
  if (!Number.isFinite(healthFactor)) return "green";
  if (healthFactor >= 1) return "red";
  if (healthFactor >= 0.85) return "amber";
  return "green";
}

export function statusTone(status) {
  return status === 0 ? "ok" : status === 3 || status === 7 ? "warn" : "bad";
}

/** Escapes text before it goes anywhere near innerHTML. */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
