import { describe, expect, it } from "vitest";
import { Session } from "@sherwood/sdk";
import { currentSession, marketHolidays, earlyCloseDays, sessionAt, toNewYork } from "../src/session.js";
import { parsePrice, toPrice1e8 } from "../src/marketdata.js";

/** Helper: a UTC instant, so the tests state exactly which moment they mean. */
const at = (iso: string) => new Date(iso);

describe("the exchange calendar", () => {
  it("places the fixed holidays, with weekend observance", () => {
    const h2026 = marketHolidays(2026);
    expect(h2026.has("01-01")).toBe(true); // New Year's Day, a Thursday
    expect(h2026.has("06-19")).toBe(true); // Juneteenth
    expect(h2026.has("07-03")).toBe(true); // the fourth falls on a Saturday, observed Friday
    expect(h2026.has("12-25")).toBe(true);
  });

  it("places the floating holidays", () => {
    const h = marketHolidays(2026);
    expect(h.has("01-19")).toBe(true); // third Monday of January
    expect(h.has("02-16")).toBe(true); // third Monday of February
    expect(h.has("05-25")).toBe(true); // last Monday of May
    expect(h.has("09-07")).toBe(true); // first Monday of September
    expect(h.has("11-26")).toBe(true); // fourth Thursday of November
  });

  it("computes Good Friday from Easter", () => {
    // Easter 2026 falls on 5 April, so Good Friday is the third.
    expect(marketHolidays(2026).has("04-03")).toBe(true);
    // Easter 2027 falls on 28 March, so Good Friday is the twenty-sixth.
    expect(marketHolidays(2027).has("03-26")).toBe(true);
  });

  it("knows the half days", () => {
    const e = earlyCloseDays(2026);
    expect(e.has("11-27")).toBe(true); // the day after Thanksgiving
    expect(e.has("12-24")).toBe(true); // Christmas Eve, a Thursday in 2026
  });
});

describe("the session", () => {
  it("is regular during the trading day", () => {
    // 14:30 UTC is 10:30 in New York on a Thursday in September, so daylight time.
    expect(currentSession(at("2026-09-03T14:30:00Z"))).toBe(Session.Regular);
  });

  it("is pre-market before the open and post-market after the close", () => {
    expect(currentSession(at("2026-09-03T12:00:00Z"))).toBe(Session.Pre); // 08:00 New York
    expect(currentSession(at("2026-09-03T21:00:00Z"))).toBe(Session.Post); // 17:00 New York
  });

  it("is closed overnight, at weekends and on holidays", () => {
    expect(currentSession(at("2026-09-04T07:00:00Z"))).toBe(Session.Closed); // 03:00 New York
    expect(currentSession(at("2026-09-05T15:00:00Z"))).toBe(Session.Closed); // a Saturday
    expect(currentSession(at("2026-12-25T15:00:00Z"))).toBe(Session.Closed); // Christmas
  });

  it("opens at 09:30 and not a minute earlier", () => {
    expect(currentSession(at("2026-09-03T13:29:00Z"))).toBe(Session.Pre);
    expect(currentSession(at("2026-09-03T13:30:00Z"))).toBe(Session.Regular);
  });

  it("closes at 13:00 on a half day", () => {
    // The day after Thanksgiving 2026 is 27 November; 18:30 UTC is 13:30 in New York.
    const detail = sessionAt(at("2026-11-27T18:30:00Z"));
    expect(detail.earlyClose).toBe(true);
    expect(detail.session).toBe(Session.Post);
    expect(currentSession(at("2026-11-27T17:30:00Z"))).toBe(Session.Regular);
  });

  it("follows New York across the daylight-saving boundary", () => {
    // 14:30 UTC is 10:30 in New York in September and 09:30 in December.
    expect(currentSession(at("2026-12-03T14:30:00Z"))).toBe(Session.Regular);
    expect(currentSession(at("2026-12-03T14:00:00Z"))).toBe(Session.Pre);
    expect(toNewYork(at("2026-12-03T14:30:00Z")).hour).toBe(9);
    expect(toNewYork(at("2026-09-03T14:30:00Z")).hour).toBe(10);
  });

  it("renders midnight as hour zero, not twenty-four", () => {
    expect(toNewYork(at("2026-09-04T04:00:00Z")).hour).toBe(0);
  });
});

describe("price parsing", () => {
  it("handles the thousands separator the provider uses above $1,000", () => {
    expect(parsePrice("1,554.99")).toBe(1554.99);
    expect(parsePrice("773.17")).toBe(773.17);
  });

  it("rejects anything that is not a usable price", () => {
    expect(() => parsePrice("")).toThrow();
    expect(() => parsePrice("n/a")).toThrow();
    expect(() => parsePrice("0")).toThrow();
    expect(() => parsePrice("-5")).toThrow();
  });

  it("converts to 1e8 without floating-point drift", () => {
    expect(toPrice1e8(773.17)).toBe(77_317_000_000n);
    expect(toPrice1e8(0.01)).toBe(1_000_000n);
    expect(toPrice1e8(1554.99)).toBe(155_499_000_000n);
    // 0.1 + 0.2 is the classic case; the string path must not inherit it.
    expect(toPrice1e8(0.30000000000000004)).toBe(30_000_000n);
  });
});
