// "Settles at" (replaces "Horizon"): the three fixed settlement times of a ticket on the playground clock,
// each with its wall-clock ETA. Today's close (horizon 0, the next 21:00 UTC) is the default; In 24 h (horizon 1)
// becomes the default when the close is under 15 wall seconds away, so a ticket never opens a few seconds before its
// own print. Expiries mirror TicketBook.expiryFor through lib/horizon.ts. Pure.
//
// Wall ETAs come from the bell's GET /markets/:symbol etaWall when it is known: the replay plays only the recorded
// bars of a session (13:30 to 19:55 UTC) and jumps each night in one tick, so the playground clock is not linear in
// wall time and (expiry - now) / rate overstates every ETA past a close. The bell counts the ticks to each of its three
// expiries; an expiry between two of them is interpolated in played seconds (fork time with each night between the last
// bar and the next open taken out, the night read off the Today's close and In 24 h ETAs), and the values count down
// from the wall time they arrived. Without them (no market answer yet, an older bell) the ETA is linear at the clock
// rate. The expiries themselves follow the market's clock when it is ahead of the App clock (marketNow).
import { expiryOf, HORIZONS, type Horizon } from '../horizon';
import { TCOPY } from './copy';

/** Under this many wall seconds to Today's close, In 24 h is the default. */
export const DAY_SWITCH_WALL_S = 15;

/** The bell's tick-counted wall ETAs: `points` maps fork expiries to wall seconds as of wall ms `atMs`, when the bell's
 * clock read `clock`. */
export interface EtaAnchors { clock: number; atMs: number; points: ReadonlyArray<{ expiry: number; eta: number }> }

/** The anchors of a GET /markets/:symbol answer, or null when it carries no clock or no ETA. */
export function anchorsOf(m: { clockUnix: number | null; atMs: number; expiries: { session: number; day: number; week: number } | null; etaWall: { session: number | null; day: number | null; week: number | null } | null } | null | undefined): EtaAnchors | null {
  if (!m || m.clockUnix === null || !m.expiries || !m.etaWall) return null;
  const points: { expiry: number; eta: number }[] = [];
  for (const k of ['session', 'day', 'week'] as const) {
    const expiry = m.expiries[k];
    const eta = m.etaWall[k];
    if (eta !== null && Number.isFinite(eta) && eta >= 0 && Number.isFinite(expiry) && expiry > m.clockUnix) points.push({ expiry, eta });
  }
  return points.length ? { clock: m.clockUnix, atMs: m.atMs, points } : null;
}

const DAY = 86_400;

/** The first replay night after the anchors' clock, in fork time: from the end of the last bar before Today's close
 * (the clock plus that ETA in played seconds) to the next open (In 24 h minus its ETA after the jump). Null when the
 * anchors lack either point or the rate is unknown; the next nights repeat it a day apart. */
function firstNight(a: EtaAnchors, rate: number): { start: number; len: number } | null {
  if (!(rate > 0)) return null;
  const s = a.points.find((p) => p.expiry === expiryOf(0, a.clock));
  const d = a.points.find((p) => p.expiry === expiryOf(1, a.clock));
  if (!s || !d || d.eta < s.eta) return null;
  const start = Math.min(s.expiry, a.clock + s.eta * rate);
  const end = Math.max(s.expiry, d.expiry - (d.eta - s.eta) * rate);
  const len = end - start;
  return len > 0 && len < DAY ? { start, len } : null;
}

/** Fork seconds the replay plays from `from` to `t`: every night taken out (the whole span when `night` is null). */
function played(t: number, from: number, night: { start: number; len: number } | null): number {
  if (!night || t <= night.start) return t - from;
  const k = Math.floor((t - night.start) / DAY);
  return t - from - k * night.len - Math.min(t - night.start - k * DAY, night.len);
}

/** Wall seconds from the anchors' read time until the clock reaches `expiry`: exact at an anchor, linear in played
 * seconds between two, extended along the last segment beyond them; null when the anchors cannot place it. An expiry
 * inside a night is reached by the jump, at the ETA of the close before it. */
function anchoredEta(expiry: number, a: EtaAnchors, rate: number): number | null {
  if (expiry <= a.clock) return 0;
  const night = firstNight(a, rate);
  const x = (t: number) => played(t, a.clock, night);
  const pts = [{ expiry: a.clock, eta: 0 }, ...a.points].sort((p, q) => p.expiry - q.expiry);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1]!;
    const q = pts[i]!;
    if (expiry <= q.expiry || i === pts.length - 1) {
      const span = x(q.expiry) - x(p.expiry);
      if (!(span > 0)) return q.eta;
      return Math.max(0, p.eta + ((x(expiry) - x(p.expiry)) / span) * (q.eta - p.eta));
    }
  }
  return null;
}

/** Wall seconds until the playground clock reaches `expiry`: from the bell's anchors when given (counted down since
 * they arrived), else at `rate` playground seconds per wall second; null when the clock holds (rate 0) or neither is
 * known. */
export function etaWall(expiry: number, now: number, rate: number, anchors?: EtaAnchors | null, wallMs = Date.now()): number | null {
  if (!Number.isFinite(expiry) || !Number.isFinite(now)) return null;
  if (anchors && rate > 0) {
    const eta = anchoredEta(expiry, anchors, rate);
    if (eta !== null) return Math.max(0, eta - Math.max(0, (wallMs - anchors.atMs) / 1000));
  }
  if (!(rate > 0)) return null;
  return Math.max(0, (expiry - now) / rate);
}

/** The playground time the three expiries derive from: the later of the App clock (GET /state, polled on its own, so it
 * can still read the evening after the replay jumped to the next open) and the market's clock of the anchors, which
 * moves past Today's close once the anchors' own ETA to it has run out. */
export function marketNow(now: number, anchors?: EtaAnchors | null, wallMs = Date.now()): number {
  if (!anchors) return now;
  const close = expiryOf(0, anchors.clock);
  const s = anchors.points.find((p) => p.expiry === close);
  const market = s && (wallMs - anchors.atMs) / 1000 >= s.eta ? close : anchors.clock;
  return Number.isFinite(now) ? Math.max(now, market) : market;
}

export function defaultHorizon(now: number, rate: number, anchors?: EtaAnchors | null, wallMs = Date.now()): Horizon {
  const at = marketNow(now, anchors, wallMs);
  const eta = etaWall(expiryOf(0, at), at, rate, anchors, wallMs);
  return eta !== null && eta < DAY_SWITCH_WALL_S ? 1 : 0;
}

/** Wall ETA as "52 s", "3 min 7 s", "2 h 14 min". */
export function fmtEta(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/** The C0 countdown: "Settles in 3 min 7 s", under a minute "Settles in 42 s", due "Settling"; hours as "2 h 14 min". */
export function fmtCountdownWall(sec: number | null): string {
  if (sec === null) return '';
  const s = Math.ceil(sec);
  if (s <= 0) return TCOPY.settling;
  if (s < 60) return TCOPY.countdownSec(s);
  if (s < 3600) return TCOPY.countdown(Math.floor(s / 60), s % 60);
  return TCOPY.countdownLong(fmtEta(s));
}

const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');

/** Playground settlement time, UTC: "21:00" on the same playground day, "Sat 21:00" within a week, "Oct 30 21:00". */
export function fmtSettleTime(expiry: number, now: number): string {
  const d = new Date(expiry * 1000);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  const n = new Date(now * 1000);
  if (d.getUTCFullYear() === n.getUTCFullYear() && d.getUTCMonth() === n.getUTCMonth() && d.getUTCDate() === n.getUTCDate()) return hm;
  if (expiry - now < 6 * 86400) return `${d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })} ${hm}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} ${hm}`;
}

export interface SettleOption {
  horizon: Horizon;
  expiry: number;
  etaWall: number | null;
  /** Settlement time on the playground clock. */
  time: string;
  /** The C0 option line, "Today's close, 21:00 (52 s)". */
  label: string;
}

export function settleOptions(now: number, rate: number, anchors?: EtaAnchors | null, wallMs = Date.now()): SettleOption[] {
  const at = marketNow(now, anchors, wallMs);
  return HORIZONS.map((h) => {
    const expiry = expiryOf(h, at);
    const eta = etaWall(expiry, at, rate, anchors, wallMs);
    const time = fmtSettleTime(expiry, at);
    return { horizon: h, expiry, etaWall: eta, time, label: eta === null ? TCOPY.optionNoEta(TCOPY.horizonNames[h], time) : TCOPY.option[h](time, fmtEta(eta)) };
  });
}

/** Short name of a horizon for rows and cards: "Today's close", "In 24 h", "In 7 d"; null for anything else. */
export function settlesName(h: number | null): string | null {
  return h === 0 || h === 1 || h === 2 ? TCOPY.horizonNames[h] : null;
}
