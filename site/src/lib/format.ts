// Number formats (STYLE-SPEC section 3): prices to two decimals (four under 1), moves as signed percent with a real
// minus sign (U+2212), amounts as "20 USDG" (integer when whole), multiples as "5x", times as "14:32:05" or "2h 14m".
import { COPY } from '../copy';
import type { BellEta } from './types';

const MINUS = '−';

export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  const d = Math.abs(v) < 1 ? 4 : 2;
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  const abs = Math.abs(v).toFixed(digits);
  if (Number(abs) === 0) return `${(0).toFixed(digits)} %`;
  return `${v < 0 ? MINUS : '+'}${abs} %`;
}

/** USDG amount: integer when whole, else two decimals; thousands separators. */
export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  const whole = Math.abs(v - Math.round(v)) < 0.005;
  return v.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).replace('-', MINUS);
}

export function fmtSignedUsd(v: number): string {
  const s = fmtUsd(Math.abs(v));
  return v > 0.004 ? `+${s}` : v < -0.004 ? `${MINUS}${s}` : s;
}

export function fmtCap(v: number | null | undefined): string {
  if (!v || !Number.isFinite(v)) return '–';
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  return v.toFixed(0);
}

export function fmtAddr(a: string | null | undefined): string {
  if (!a) return '';
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');

/** Countdown: "mm:ss" under an hour, "h:mm:ss" under a day, "2d 4h" beyond. */
export function fmtCountdown(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
  return `${pad(s / 60)}:${pad(s % 60)}`;
}

/** Clock time of a unix second in UTC, "14:32:05". */
export function fmtClock(unix: number): string {
  const d = new Date(unix * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Short expiry label under a horizon segment: "21:00", "Mon 21:00", "Oct 24". */
export function fmtExpiry(unix: number, now: number): string {
  const d = new Date(unix * 1000);
  const days = (unix - now) / 86400;
  if (days < 1) return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (days < 2) return `${d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Wall-time countdown to a settlement (C0 pick): "Settles in 4 min 12 s", "Settles in 37 s", "Settling" when due. */
export function fmtSettlesIn(wallSec: number): string {
  const s = Math.max(0, Math.ceil(wallSec));
  if (s <= 0) return COPY.play.settling;
  if (s < 60) return COPY.play.countdownSec(s);
  return COPY.play.countdown(Math.floor(s / 60), s % 60);
}

const DAY_S = 86_400;
const modDay = (x: number) => ((x % DAY_S) + DAY_S) % DAY_S;

/** The replay's trading day on the playground clock in seconds of the UTC day: the first and the last recorded bar and
 *  the bar length. Each tick moves the clock one bar inside the session; the night from the last bar to the next open
 *  passes in a single tick (feed timeline ticksUntil), so the clock does not run at one steady rate. */
export interface ReplaySchedule { open: number; last: number; bar: number }

/** New York's offset from UTC in hours at wall time `ms`: 4 from the second Sunday of March to the first Sunday of
 *  November (US daylight time), else 5. */
export function nyOffsetHours(ms: number): number {
  const y = new Date(ms).getUTCFullYear();
  const sunday = (m: number, from: number) => from + ((7 - new Date(Date.UTC(y, m, from)).getUTCDay()) % 7);
  const start = Date.UTC(y, 2, sunday(2, 8), 7);
  const end = Date.UTC(y, 10, sunday(10, 1), 6);
  return ms >= start && ms < end ? 4 : 5;
}

/** The replay schedule from GET /state: US regular hours (09:30 to 16:00 New York, the recording's bars) with the bar
 *  length `bar`. The clock stands on recorded bar times only, so a time of day that fits only daylight or only standard
 *  time decides. Inside both windows (13:30 to 19:55 UTC) the schedule decided at an earlier reading of the same
 *  recording (`prev`) holds, and only without one the wall date picks: a recording from the other half of the year is
 *  then read wrong until the clock first leaves the overlap. A clock outside both windows is not on a US session
 *  recording and gets no schedule (the countdown is then linear). */
export function replaySchedule(bar: unknown, clockUnix: number | null, wallMs: number, prev: ReplaySchedule | null = null): ReplaySchedule | null {
  const b = Number(bar);
  if (!Number.isFinite(b) || b <= 0 || b > 3600) return null;
  const make = (off: number): ReplaySchedule => ({ open: (9.5 + off) * 3600, last: (16 + off) * 3600 - b, bar: b });
  const edt = make(4);
  const est = make(5);
  const held = prev && prev.bar === b ? (prev.open === edt.open ? edt : prev.open === est.open ? est : null) : null;
  const guess = held ?? (nyOffsetHours(wallMs) === 4 ? edt : est);
  if (clockUnix === null || !Number.isFinite(clockUnix)) return guess;
  const tod = modDay(clockUnix);
  const fits = (s: ReplaySchedule) => tod >= s.open && tod <= s.last;
  if (fits(edt) && fits(est)) return guess;
  return fits(edt) ? edt : fits(est) ? est : null;
}

/** The playground clock `ticks` replay ticks (fractional) after a reading `from`: bar by bar inside the session, each
 *  night as one tick, any number of nights. Inside a night tick the clock reads the last bar plus the part of the tick
 *  spent, as replayTicksUntil reads an interpolated clock. */
export function replayClockAfter(from: number, ticks: number, s: ReplaySchedule): number {
  if (!(ticks > 0) || !Number.isFinite(from)) return from;
  const night = modDay(s.open - s.last);
  const cycle = modDay(s.last - s.open) / s.bar + 1;
  let c = from;
  let k = ticks;
  const past = modDay(c - s.last);
  if (past > 0 && past < night) {
    const spent = past / s.bar;
    const open = c - past + night;
    if (spent < 1) {
      if (k < 1 - spent) return c + k * s.bar;
      k -= 1 - spent;
      c = open;
    } else c = open + (spent - 1) * s.bar;
  }
  for (;;) {
    const toLast = modDay(s.last - c) / s.bar;
    if (k <= toLast) return c + k * s.bar;
    k -= toLast;
    c += toLast * s.bar;
    if (k < 1) return c + k * s.bar;
    k -= 1;
    c += night;
    // Whole sessions (open to the next open) at once.
    const n = Math.floor(k / cycle);
    c += n * DAY_S;
    k -= n * cycle;
  }
}

/** Ticks of the replay (fractional at an interpolated clock) until the playground clock reaches `forkTs` from `now`:
 *  bars inside the session, one tick per night. An interpolated clock past the last bar counts the night tick as spent
 *  in part, or once a full tick has passed, as already jumped to the next open. */
export function replayTicksUntil(forkTs: number, now: number, s: ReplaySchedule): number {
  if (!(forkTs > now)) return 0;
  const night = modDay(s.open - s.last);
  let c = now;
  let ticks = 0;
  const past = modDay(c - s.last);
  if (past > 0 && past < night) {
    const spent = past / s.bar;
    const open = c - past + night;
    if (spent < 1) {
      ticks += 1 - spent;
      c = open;
    } else c = open + (spent - 1) * s.bar;
    if (forkTs <= c) return ticks;
  }
  for (let i = 0; i < 400; i++) {
    const end = c + modDay(s.last - c);
    if (forkTs <= end) return ticks + (forkTs - c) / s.bar;
    ticks += (end - c) / s.bar + 1;
    c = end + night;
    if (forkTs <= c) return ticks;
  }
  return ticks;
}

/** Wall seconds left to `forkTs` from the bell's ETA when one of its expiries is `forkTs`, counted down since the answer
 *  arrived; null otherwise or once the answer is older than `maxAgeS`. */
export function bellWallLeft(forkTs: number, eta: BellEta | null | undefined, wallMs: number, maxAgeS = 30): number | null {
  if (!eta) return null;
  const age = (wallMs - eta.atMs) / 1000;
  const p = eta.points.find((x) => x.expiry === forkTs);
  return p && age >= 0 && age <= maxAgeS ? Math.max(0, p.wallS - age) : null;
}

/** Wall seconds until playground time `forkTs` at the clock's rate `speed` (playground seconds per wall second). With
 *  the replay schedule the night jump counts as one tick of `bar / speed` wall seconds; without it (mock mode, no bar
 *  length) the clock runs linearly; a paused clock gives the playground seconds. */
export function wallSecondsUntil(forkTs: number, now: number, speed: number, sched: ReplaySchedule | null = null): number {
  if (sched && speed > 0) return Math.max(0, replayTicksUntil(forkTs, now, sched) * (sched.bar / speed));
  return Math.max(0, (forkTs - now) / (speed > 0 ? Math.max(1, speed) : 1));
}
