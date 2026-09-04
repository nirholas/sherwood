import { Session } from "@sherwood/sdk";

/**
 * The US equity session, computed locally.
 *
 * This is deliberately not taken from a quote provider. The session picks which deviation band the
 * oracle applies, so it is a security-relevant input, and the providers disagree with reality: CNBC
 * reports `REG_MKT` at two in the morning. The exchange calendar is fully determined by the date, so
 * it is computed here and depends on nothing.
 *
 * Windows are NYSE and Nasdaq regular hours in America/New_York: pre-market from 04:00, regular
 * 09:30 to 16:00, post-market to 20:00. Early closes on the half-days around Independence Day,
 * Thanksgiving and Christmas are handled, because a 13:00 close with the oracle still on the tight
 * intraday band would take the feed offline for three hours every one of those afternoons.
 */

export type NyTime = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
};

const NY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hour12: false,
});

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function toNewYork(date: Date): NyTime {
  const parts = Object.fromEntries(NY_FORMATTER.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl renders midnight as hour 24 under hour12:false.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday as string] ?? 0,
  };
}

/** Day of the month for the `n`th `weekday` of a month, 1-indexed. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = (weekday - first + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

function lastWeekday(year: number, month: number, weekday: number): number {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, daysInMonth)).getUTCDay();
  return daysInMonth - ((last - weekday + 7) % 7);
}

/** Anonymous Gregorian computus. Good Friday is the only movable market holiday. */
function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function addDays(year: number, month: number, day: number, delta: number) {
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * A fixed-date holiday moves to Friday when it lands on Saturday and to Monday when it lands on
 * Sunday, which is why the observed date has to be derived rather than looked up.
 */
function observed(year: number, month: number, day: number) {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (weekday === 6) return addDays(year, month, day, -1);
  if (weekday === 0) return addDays(year, month, day, 1);
  return { year, month, day };
}

/** Every full-day NYSE and Nasdaq closure in a year, as `MM-DD` strings. */
export function marketHolidays(year: number): Set<string> {
  const key = (m: number, d: number) => `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const out = new Set<string>();
  const push = (m: number, d: number) => {
    const o = observed(year, m, d);
    if (o.year === year) out.add(key(o.month, o.day));
  };

  push(1, 1); // New Year's Day
  out.add(key(1, nthWeekday(year, 1, 1, 3))); // Martin Luther King Jr Day
  out.add(key(2, nthWeekday(year, 2, 1, 3))); // Washington's Birthday
  const easter = easterSunday(year);
  const goodFriday = addDays(year, easter.month, easter.day, -2);
  out.add(key(goodFriday.month, goodFriday.day));
  out.add(key(5, lastWeekday(year, 5, 1))); // Memorial Day
  push(6, 19); // Juneteenth
  push(7, 4); // Independence Day
  out.add(key(9, nthWeekday(year, 9, 1, 1))); // Labor Day
  out.add(key(11, nthWeekday(year, 11, 4, 4))); // Thanksgiving
  push(12, 25); // Christmas
  return out;
}

/** Days the exchange closes at 13:00 ET. */
export function earlyCloseDays(year: number): Set<string> {
  const key = (m: number, d: number) => `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const out = new Set<string>();
  // The day after Thanksgiving.
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  const blackFriday = addDays(year, 11, thanksgiving, 1);
  out.add(key(blackFriday.month, blackFriday.day));
  // Christmas Eve and the third of July, only when they fall on a weekday and the holiday itself
  // is observed on its own date.
  for (const [m, d] of [
    [12, 24],
    [7, 3],
  ] as const) {
    const weekday = new Date(Date.UTC(year, m - 1, d)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) out.add(key(m, d));
  }
  return out;
}

const PRE_OPEN = 4 * 60;
const REGULAR_OPEN = 9 * 60 + 30;
const REGULAR_CLOSE = 16 * 60;
const EARLY_CLOSE = 13 * 60;
const POST_CLOSE = 20 * 60;

export type SessionDetail = {
  session: Session;
  /** True when the exchange is shut for the whole day. */
  holiday: boolean;
  earlyClose: boolean;
  newYork: NyTime;
};

/** The session at `date`, with the reasoning attached. */
export function sessionAt(date: Date = new Date()): SessionDetail {
  const ny = toNewYork(date);
  const key = `${String(ny.month).padStart(2, "0")}-${String(ny.day).padStart(2, "0")}`;
  const weekend = ny.weekday === 0 || ny.weekday === 6;
  const holiday = marketHolidays(ny.year).has(key);
  const earlyClose = earlyCloseDays(ny.year).has(key);

  if (weekend || holiday) {
    return { session: Session.Closed, holiday, earlyClose: false, newYork: ny };
  }

  const minutes = ny.hour * 60 + ny.minute;
  const close = earlyClose ? EARLY_CLOSE : REGULAR_CLOSE;
  // After an early close the post-market runs for the usual three hours, not until 20:00.
  const postClose = earlyClose ? EARLY_CLOSE + 3 * 60 : POST_CLOSE;

  let session: Session;
  if (minutes >= REGULAR_OPEN && minutes < close) session = Session.Regular;
  else if (minutes >= PRE_OPEN && minutes < REGULAR_OPEN) session = Session.Pre;
  else if (minutes >= close && minutes < postClose) session = Session.Post;
  else session = Session.Closed;

  return { session, holiday: false, earlyClose, newYork: ny };
}

export function currentSession(date: Date = new Date()): Session {
  return sessionAt(date).session;
}
