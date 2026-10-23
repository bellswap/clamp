// Price replay: recorded five-minute bars (Yahoo five-day series, display data for the playground only) posted as
// demo signer rounds for every listed market, one bar per tick, while the fork clock moves by the bar's market
// seconds. Off-hours in the recorded series are skipped: the playground clock keeps the recorded time of day, so the
// overnight and weekend gaps become one jump to the next session's open. When a jump crosses the daily close
// (21:00 UTC) the last close is posted again at that instant, so a session ticket settles on the session's close.
// Speed: bars per wall minute (60: one bar per second, one recorded session of 78 bars in about 78 s).
// The recording covers the whole catalog (not only listed markets), is frozen for BELL_REPLAY_REFRESH_S (a week by
// default) once it covers the catalog, and a refetch replaces it only when it covers every symbol the current
// recording covers.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { alignTo, parseSpark, round4, sharedAxis, YAHOO_BATCH, YAHOO_UA, type ChartBulk, type FetchLike, type RawSeries } from './charts';

export const DAY = 86_400;

export interface ReplaySeries {
  /** Bar size in seconds. */
  bar: number;
  /** Recorded bar times (unix s), ascending, regular hours only. */
  t: number[];
  /** Closes per catalog symbol aligned to t (forward-filled; null before the first trade). */
  prices: Record<string, (number | null)[]>;
  source: string;
  fetchedAt: number;
  /** Raw five-minute bars on the shared axis divided by the axis length, per catalog symbol (absent in recordings
   *  from before the coverage rule; then every symbol with prices counts as covered). */
  coverage?: Record<string, number>;
  /** Recorded sessions (UTC days) on the axis. */
  sessions?: number;
  /** Catalog symbols the fetch asked for and got at least one valid bar for. With the coverage keys it tells whether
   *  the recording covers the whole catalog (absent in recordings from before this field). */
  requested?: string[];
}

/** A symbol is eligible for listing when its raw bars cover at least this share of the recording's axis. */
export const COVERAGE_MIN = 0.9;
export const COVERAGE_RULE = 'raw 5-minute bars on the shared axis / axis length >= 0.90';

export function price8Of(p: number): bigint {
  return BigInt(Math.round(p * 1e8));
}

export interface BuildOptions {
  /** Keep only the last N complete sessions (UTC days of the axis). */
  sessions?: number;
  /** Drop a trailing session with fewer than 90 percent of the longest session's bars (still trading at fetch). */
  dropPartial?: boolean;
}

/** Leading nulls (before the first trade) take the series' last value: the replay wraps, so the bar before index 0
 *  is the last bar. Returns a new array; an all-null series stays all null. */
export function fillLeading(p: (number | null)[]): (number | null)[] {
  let last: number | null = null;
  for (let i = p.length - 1; i >= 0; i--) if (typeof p[i] === 'number') { last = p[i]!; break; }
  if (last === null) return p.slice();
  const out = p.slice();
  for (let i = 0; i < out.length && out[i] === null; i++) out[i] = last;
  return out;
}

/** Axis split into sessions by UTC day: [start, end) index pairs. */
export function sessionsOf(t: number[]): [number, number][] {
  const out: [number, number][] = [];
  let a = 0;
  for (let i = 1; i <= t.length; i++) {
    if (i === t.length || Math.floor(t[i]! / DAY) !== Math.floor(t[i - 1]! / DAY)) {
      out.push([a, i]);
      a = i;
    }
  }
  return out;
}

/** Builds the replay series from parsed spark answers (keyed by Yahoo symbol): shared axis, optional trim to the
 *  last complete sessions, per-symbol raw coverage, as-of alignment and the leading fill. */
export function buildSeries(parsed: Map<string, RawSeries>, symbols: { symbol: string; yahoo: string }[], bar: number, source: string, fetchedAt: number, o: BuildOptions = {}): ReplaySeries | null {
  const mine = symbols.map((s) => [s, parsed.get(s.yahoo)] as const).filter(([, r]) => r && r.t.length);
  let t = sharedAxis(mine.map(([, r]) => r!));
  let sess = sessionsOf(t);
  if (o.dropPartial && sess.length > 1) {
    const longest = Math.max(...sess.map(([a, b]) => b - a));
    const [a, b] = sess[sess.length - 1]!;
    if (b - a < 0.9 * longest) sess = sess.slice(0, -1);
  }
  if (o.sessions && sess.length > o.sessions) sess = sess.slice(sess.length - o.sessions);
  if (sess.length) t = t.slice(sess[0]![0], sess[sess.length - 1]![1]);
  if (t.length < 2) return null;
  const prices: Record<string, (number | null)[]> = {};
  const coverage: Record<string, number> = {};
  for (const [s, r] of mine) {
    const p = alignTo(t, r!.t, r!.c);
    if (!p.some((x) => x !== null)) continue;
    const raw = new Set<number>();
    for (let k = 0; k < r!.t.length; k++) if (typeof r!.c[k] === 'number') raw.add(r!.t[k]!);
    let hit = 0;
    for (const x of t) if (raw.has(x)) hit++;
    prices[s.symbol] = fillLeading(p);
    coverage[s.symbol] = round4(hit / t.length);
  }
  return Object.keys(prices).length ? { bar, t, prices, source, fetchedAt, coverage, sessions: sessionsOf(t).length } : null;
}

/** Eligible and missing catalog symbols of a recording (coverage at least `min`, default COVERAGE_MIN; a recording
 *  without coverage counts every symbol with prices). */
export function eligibleOf(s: ReplaySeries | null, catalog: string[], min = COVERAGE_MIN): { eligible: string[]; missing: string[] } {
  const eligible: string[] = [];
  const missing: string[] = [];
  for (const sym of catalog) {
    const ok = !!s?.prices[sym] && (s.coverage ? (s.coverage[sym] ?? 0) >= min : true);
    (ok ? eligible : missing).push(sym);
  }
  return { eligible, missing };
}

/** A recording loaded from disk: leading nulls filled (recordings from before the fill rule). */
export function normalizeSeries(s: ReplaySeries): ReplaySeries {
  const prices: Record<string, (number | null)[]> = {};
  for (const [k, p] of Object.entries(s.prices)) prices[k] = p[0] === null ? fillLeading(p) : p;
  return { ...s, prices };
}

/** The charts layer's five-day bulk as a replay series (fallback when the five-minute fetch fails), leading gaps
 *  filled like a recording's. */
export function seriesFromBulk(b: ChartBulk): ReplaySeries | null {
  if (b.t.length < 2) return null;
  const prices: Record<string, (number | null)[]> = {};
  for (const [k, s] of Object.entries(b.series)) prices[k] = fillLeading(s.p);
  return { bar: b.interval, t: b.t, prices, source: `${b.source} (charts ${b.range})`, fetchedAt: b.fetchedAt };
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** The series restricted to a replay range: '5d' is the whole recording, '1d' its last recorded session (UTC day).
 *  A last session of fewer than two bars keeps the whole series. */
export function seriesForRange(s: ReplaySeries | null, range: '5d' | '1d'): ReplaySeries | null {
  if (!s || range === '5d' || s.t.length < 2) return s;
  const day = Math.floor(s.t[s.t.length - 1]! / DAY);
  let i = s.t.length - 1;
  while (i > 0 && Math.floor(s.t[i - 1]! / DAY) === day) i--;
  if (s.t.length - i < 2) return s;
  const prices: Record<string, (number | null)[]> = {};
  for (const [k, p] of Object.entries(s.prices)) prices[k] = p.slice(i);
  return { ...s, t: s.t.slice(i), prices, source: `${s.source}, last session` };
}

/** Identity of a series for cursor bookkeeping (the fallback builds a new object on every read). */
export function seriesKey(s: ReplaySeries): string {
  return `${s.bar}:${s.t.length}:${s.t[0]}:${s.t[s.t.length - 1]}`;
}

/** Cursor in series `s` for a replay that stood at bar `oldCursor` of series `old` with the playground clock at P:
 *  the first bar at or after the old bar's recorded time when the new series covers it, else the first bar whose time
 *  of day is at or after P's (0 when none is). */
export function remapCursor(old: ReplaySeries | null, oldCursor: number, s: ReplaySeries, P: number): number {
  return remapTime(old && old.t.length ? old.t[mod(oldCursor, old.t.length)]! : null, s, P);
}

/** Cursor in series `s` for the bar recorded at T0 (null: unknown) with the playground clock at P (see remapCursor). */
export function remapTime(T0: number | null, s: ReplaySeries, P: number): number {
  if (T0 !== null && T0 >= s.t[0]! && T0 <= s.t[s.t.length - 1]!) {
    const i = s.t.findIndex((t) => t >= T0);
    if (i >= 0) return i;
  }
  const tod = mod(P, DAY);
  const j = s.t.findIndex((t) => mod(t, DAY) >= tod);
  return j >= 0 ? j : 0;
}

/** Market seconds from playground time P to the next bar at recorded time nextT: the forward distance between the
 *  two times of day. Within a session that is the bar gap; across a night or a weekend it is the jump to the next
 *  open. When P ran slightly past the target time of day (wall-time drift of the fork clock, under three bars) the
 *  tick only mines one second ahead instead of jumping a whole day. */
export function deltaTo(P: number, nextT: number, bar: number): number {
  const d = mod(nextT - P, DAY);
  if (d === 0 || d > DAY - 3 * bar) return 1;
  return d;
}

/** The first daily-close instant (closeHour UTC) strictly inside (from, to), or null. */
export function closeBetween(from: number, to: number, closeHourUtc: number): number | null {
  const c = closeHourUtc * 3600;
  const x = from - mod(from, DAY) + c;
  const first = x > from ? x : x + DAY;
  return first < to ? first : null;
}

/** Wall ms between ticks for a speed in bars per wall minute. */
export function tickMs(speed: number): number {
  return Math.round(60_000 / Math.max(1, speed));
}

/** Next due time of the tick loop: one interval after the last due time; when the loop fell more than one interval
 *  behind (a slow tick or a pause) it restarts from now instead of firing a burst of catch-up ticks. */
export function nextDue(lastDue: number, nowMs: number, speed: number): number {
  const ms = tickMs(speed);
  const due = lastDue + ms;
  return due < nowMs - ms ? nowMs + ms : due;
}

export interface RoundPost {
  symbol: string;
  price8: bigint;
  t: number;
}

export interface ReplayDeps {
  /** Playground clock: the latest block timestamp. */
  now(): Promise<number>;
  /** Moves the clock by `seconds` and mines; returns the new block timestamp (used when advanceTo is absent). */
  advance(seconds: number): Promise<number>;
  /** Mines a block at fork time `target` (absolute, so a repeated call never moves the clock twice); returns the new
   *  block timestamp. */
  advanceTo?(target: number): Promise<number>;
  /** Posts demo signer rounds; returns the number of rows that landed (void: all). A throw (transport error, a due row
   *  that did not land) stops the step, and the next step resumes it where it stopped. */
  post(rows: RoundPost[]): Promise<number | void>;
  /** Called whenever the interrupted-step state changes (set after the bar's post, updated after the close re-post,
   *  null once the step completes), so the app can persist it with the rounds and resume it after a restart. */
  onPending?(p: PendingStep | null): void;
  /** Runs right before the daily-close re-post picks its rows (the app indexes, so a ticket opened just before the
   *  close is due at the re-post). A throw stops the step; the next step retries the re-post. */
  beforeClose?(): Promise<void>;
  /** Symbols of the listed markets that read the demo signer (the replay idles while there are none). */
  markets(): string[];
  /** Symbols to print at fork time `at` (the tick, or the daily-close re-post when `close`), in priority order and
   *  already capped. Without it every listed market prints at every post. */
  printSet?(at: number, close: boolean): string[];
  series(): ReplaySeries | null;
  closeHourUtc: number;
}

export interface TickResult {
  idle?: string;
  cursor: number;
  posted: number;
  delta: number;
  close: number | null;
  at: number;
  /** Bar index posted by this tick, the fork time it was posted at (round t), the series identity. */
  bar?: number;
  postedAt?: number;
  key?: string;
  /** Fork time of the daily-close re-post (round t) and its row count, when the tick crossed the close. */
  closeAt?: number | null;
  closePosted?: number;
}

/** A step that stopped after its first post: what is left is the close re-post (when the jump crosses one) and the
 *  move to the next bar. Plain JSON, so it survives a restart in the state file. */
export interface PendingStep {
  key: string;
  i: number;
  next: number;
  /** Recorded times of bar i and of the next bar (to remap the cursor when the series is replaced mid-step). */
  barT: number;
  nextT: number;
  /** Bar i's price per symbol, kept while the close re-post is pending (it posts these even if the series changes). */
  px?: Record<string, number>;
  P: number;
  d: number;
  X: number | null;
  target: number;
  posted: number;
  closeAt: number | null;
  closePosted: number;
  closeDone: boolean;
}

/** One replay tick per step(): post bar `cursor` at the playground clock, then move the clock to the next bar. A step
 *  that throws after its first post is resumed by the next step from the clock it finds (a clock move that landed is
 *  not repeated, a post that landed is not repeated), so the cursor never falls behind the chain. The resume survives
 *  a restart (restore() with the state onPending reported) and a series replaced mid-step: the step still finishes
 *  with the interrupted bar's close prices and move, and only then is the cursor remapped into the new series. */
export class Replay {
  cursor = 0;
  ticks = 0;
  /** The series the cursor was last measured against (null until the first tick after a start). */
  private last: ReplaySeries | null = null;
  private lastKey = '';
  private pending: PendingStep | null = null;
  constructor(readonly deps: ReplayDeps) {}

  /** The interrupted step, if any (bar posted, close re-post done, target of the move). */
  pendingStep(): Readonly<PendingStep> | null {
    return this.pending;
  }

  /** Restores an interrupted step persisted before a restart (ignored when malformed). */
  restore(p: PendingStep | null | undefined): void {
    const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
    if (!p || typeof p.key !== 'string' || !num(p.i) || !num(p.next) || !num(p.P) || !num(p.d) || !num(p.target) || !num(p.barT) || !num(p.nextT) || typeof p.closeDone !== 'boolean' || (!p.closeDone && (!num(p.X) || !p.px || typeof p.px !== 'object'))) {
      this.pending = null;
      return;
    }
    this.pending = { ...p };
    this.cursor = p.i;
  }

  private setPending(p: PendingStep | null): void {
    this.pending = p;
    this.deps.onPending?.(p ? { ...p } : null);
  }

  /** The cursor the next step will post in series `s` with the playground clock at P: remapped the way step() remaps
   *  it when `s` replaced the series the cursor (or the interrupted step) was measured against. */
  cursorIn(s: ReplaySeries, P: number): number {
    const key = seriesKey(s);
    const pd = this.pending;
    if (pd) return pd.key === key ? pd.i : remapTime(pd.barT, s, P);
    if (this.last && key !== this.lastKey) return remapCursor(this.last, this.cursor, s, P);
    return this.cursor;
  }

  private moveTo(cur: number, target: number): Promise<number> {
    return this.deps.advanceTo ? this.deps.advanceTo(target) : this.deps.advance(target - cur);
  }

  private async postRows(rows: RoundPost[]): Promise<number> {
    const n = await this.deps.post(rows);
    return typeof n === 'number' ? n : rows.length;
  }

  private rows(s: ReplaySeries, syms: string[], i: number, t: number): RoundPost[] {
    const out: RoundPost[] = [];
    for (const sym of syms) {
      const p = s.prices[sym]?.[i];
      if (typeof p === 'number' && p > 0) out.push({ symbol: sym, price8: price8Of(p), t });
    }
    return out;
  }

  async step(): Promise<TickResult> {
    const s = this.deps.series();
    const syms = this.deps.markets();
    if (!s || s.t.length < 2) return { idle: 'no recorded series', cursor: this.cursor, posted: 0, delta: 0, close: null, at: 0 };
    if (!syms.length) return { idle: 'no listed markets', cursor: this.cursor, posted: 0, delta: 0, close: null, at: 0 };
    const n = s.t.length;
    const P = await this.deps.now();
    const key = seriesKey(s);
    const pick = (at: number, close: boolean) => (this.deps.printSet ? this.deps.printSet(at, close) : syms);
    let pd = this.pending;
    if (!pd) {
      // A replaced series (fresh fetch, fallback to primary, range change) gets the cursor remapped, never reused.
      if (this.last && key !== this.lastKey) this.cursor = remapCursor(this.last, this.cursor, s, P);
      this.last = s;
      this.lastKey = key;
      const i = mod(this.cursor, n);
      const posted = await this.postRows(this.rows(s, pick(P, false), i, P));
      const next = (i + 1) % n;
      const d = deltaTo(P, s.t[next]!, s.bar);
      const X = closeBetween(P, P + d, this.deps.closeHourUtc);
      let px: Record<string, number> | undefined;
      if (X !== null) {
        px = {};
        for (const [sym, p] of Object.entries(s.prices)) if (typeof p[i] === 'number' && p[i]! > 0) px[sym] = p[i]!;
      }
      pd = { key, i, next, barT: s.t[i]!, nextT: s.t[next]!, px, P, d, X, target: P + d, posted, closeAt: null, closePosted: 0, closeDone: X === null };
      this.setPending(pd);
    }
    // P is the clock now: right after the bar's post, or (resuming) wherever an interrupted move left it.
    let cur = P;
    if (!pd.closeDone) {
      const closeAt = cur >= pd.X! ? cur : await this.moveTo(cur, pd.X!);
      await this.deps.beforeClose?.();
      // The interrupted bar's prices, also when the series was replaced since its post.
      const px = pd.px ?? {};
      const rows: RoundPost[] = [];
      for (const sym of pick(closeAt, true)) if (px[sym] !== undefined) rows.push({ symbol: sym, price8: price8Of(px[sym]!), t: closeAt });
      pd.closePosted = await this.postRows(rows);
      pd.closeAt = closeAt;
      pd.closeDone = true;
      pd.px = undefined;
      this.setPending(pd);
      cur = closeAt;
    }
    const at = cur >= pd.target ? cur : await this.moveTo(cur, pd.target);
    this.setPending(null);
    // A series replaced mid-step: the cursor goes to the new series' bar for the next recorded time, never pd.next.
    this.cursor = pd.key === key ? pd.next : remapTime(pd.nextT, s, at);
    this.last = s;
    this.lastKey = key;
    this.ticks += 1;
    // The posted bar index belongs to the series it was posted from (pd.key): the timeline records it under that key.
    return { cursor: this.cursor, posted: pd.posted, delta: pd.d, close: pd.X, at, bar: pd.i, postedAt: pd.P, key: pd.key, closeAt: pd.closeAt, closePosted: pd.closePosted };
  }
}

// ---------------------------------------------------------------- source: Yahoo five-minute bars, whole catalog
export interface FetchOptions {
  fetch?: FetchLike;
  /** Yahoo range: 7d holds five complete sessions plus the one still trading. */
  range?: string;
  /** Complete sessions kept. */
  sessions?: number;
  timeoutMs?: number;
  /** Wait between batches, ms. */
  gapMs?: number;
  /** First wait after a 429, doubled per retry, ms. */
  backoffMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (...a: unknown[]) => void;
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One spark call with retries: a 429 waits backoffMs, then twice that, and so on; 5xx and network errors wait one
 *  second. Throws after the last attempt. */
async function sparkBatch(o: FetchOptions, ys: string[]): Promise<Map<string, RawSeries>> {
  const f = o.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const sleep = o.sleep ?? sleepMs;
  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${ys.map(encodeURIComponent).join(',')}&range=${o.range ?? '7d'}&interval=5m`;
  let wait = o.backoffMs ?? 5000;
  let last: unknown = null;
  for (let attempt = 0; attempt <= (o.retries ?? 5); attempt++) {
    try {
      const r = await f(url, { headers: { 'user-agent': YAHOO_UA, accept: 'application/json' }, signal: AbortSignal.timeout(o.timeoutMs ?? 20_000) });
      if (r.status === 429) {
        last = new Error('429 from Yahoo');
        o.log?.(`replay fetch: 429, waiting ${wait} ms`);
        await sleep(wait);
        wait *= 2;
        continue;
      }
      if (!r.ok) throw new Error(`${r.status} from Yahoo`);
      return parseSpark(await r.json());
    } catch (e) {
      last = e;
      await sleep(1000);
    }
  }
  throw last ?? new Error('spark failed');
}

/** Fetches the five-minute recording for `symbols` in batches of 20 (UA Mozilla/5.0), one batch at a time, and builds
 *  the series (last complete sessions, partial trailing session dropped). Throws when more than half the batches
 *  fail or nothing parses. */
export async function fetchRecording(symbols: { symbol: string; yahoo: string }[], o: FetchOptions = {}): Promise<ReplaySeries> {
  const ys = [...new Set(symbols.map((s) => s.yahoo))];
  const parsed = new Map<string, RawSeries>();
  const answered = new Set<string>();
  let failed = 0;
  let batches = 0;
  for (let k = 0; k < ys.length; k += YAHOO_BATCH) {
    batches++;
    if (k > 0) await (o.sleep ?? sleepMs)(o.gapMs ?? 400);
    try {
      const part = ys.slice(k, k + YAHOO_BATCH);
      for (const [y, r] of await sparkBatch(o, part)) {
        parsed.set(y, r);
        // Answered only with at least one valid bar: a 200 that leaves a symbol out (or without bars) is partial.
        if (r.c.some((x) => typeof x === 'number')) answered.add(y);
      }
    } catch (e) {
      failed++;
      o.log?.(`replay fetch: batch ${batches} failed: ${(e as Error).message}`);
    }
  }
  if (failed * 2 > batches) throw new Error(`${failed} of ${batches} batches failed`);
  const now = o.now ? o.now() : Math.floor(Date.now() / 1000);
  const sessions = o.sessions ?? 5;
  const s = buildSeries(parsed, symbols, 300, `Yahoo Finance 5m, ${sessions} sessions (recorded)`, now, { sessions, dropPartial: true });
  if (!s) throw new Error('no series in the answer');
  s.requested = [...new Set(symbols.filter((x) => answered.has(x.yahoo)).map((x) => x.symbol))];
  return s;
}

/** True when `next` covers (coverage at least `min`) every symbol `cur` covers: a refetch may never take a market away.
 *  A recording from before the coverage rule counted every symbol with prices; the refetch then only has to keep a
 *  series for each of them. */
export function coversAll(cur: ReplaySeries, next: ReplaySeries, min = COVERAGE_MIN): boolean {
  const syms = Object.keys(cur.prices);
  const { eligible } = eligibleOf(cur, syms, min);
  const ok = new Set(cur.coverage ? eligibleOf(next, syms, min).eligible : syms.filter((x) => next.prices[x]));
  return eligible.every((x) => ok.has(x));
}

/** Wait after a failed fetch, and after a fetch that was refused or left catalog symbols unanswered, seconds. */
export const RETRY_FAILED_S = 300;
export const RETRY_PARTIAL_S = 3600;

export interface SourceOptions extends FetchOptions {
  dir?: string | null;
  /** Age (s) after which the recording is fetched again; frozen until then. */
  refreshS?: number;
  /** Coverage threshold of the refetch rule (BELL_COVERAGE_MIN; default COVERAGE_MIN). */
  coverageMin?: number;
}

/** The recorded series: the disk copy (replay-5d-5m.json in the charts dir), fetched for the whole catalog when
 *  missing or older than refreshS; a refetch is kept only when it covers every symbol already covered. Falls back to
 *  the charts layer's five-day bulk while nothing is recorded. */
export class ReplaySource {
  private cur: ReplaySeries | null = null;
  private busy = false;
  private retryAt = 0;
  /** Catalog symbols of the last ensure() (what the recording has to cover to stay frozen). */
  private want: string[] = [];
  private fb: { bulk: ChartBulk; s: ReplaySeries | null } | null = null;
  constructor(readonly o: SourceOptions, readonly fallback: () => ChartBulk | null) {
    if (o.dir) {
      const f = join(o.dir, 'replay-5d-5m.json');
      if (existsSync(f)) {
        try {
          this.cur = normalizeSeries(JSON.parse(readFileSync(f, 'utf8')) as ReplaySeries);
        } catch {
          this.cur = null;
        }
      }
    }
  }
  private now(): number {
    return this.o.now ? this.o.now() : Math.floor(Date.now() / 1000);
  }
  get(): ReplaySeries | null {
    if (this.cur) return this.cur;
    const b = this.fallback();
    if (!b) return null;
    if (this.fb?.bulk !== b) this.fb = { bulk: b, s: seriesFromBulk(b) };
    return this.fb.s;
  }
  /** The recording itself (null while only the fallback exists). */
  recorded(): ReplaySeries | null {
    return this.cur;
  }
  /** True while the recording is younger than refreshS and covers the catalog (every catalog symbol has a coverage
   *  entry or was asked for): no refetch will run. A recording from before the coverage rule (listed markets only) or
   *  one that misses catalog symbols is never frozen. */
  frozen(): boolean {
    const c = this.cur;
    if (!c || !c.coverage || this.now() - c.fetchedAt >= (this.o.refreshS ?? 604_800)) return false;
    const asked = new Set([...Object.keys(c.coverage), ...(c.requested ?? [])]);
    return this.want.every((x) => asked.has(x));
  }
  /** Fetches the recording for `symbols` when there is none, it is older than refreshS, or it does not cover them;
   *  never throws. */
  async ensure(symbols: { symbol: string; yahoo: string }[]): Promise<void> {
    if (!symbols.length || this.busy) return;
    this.want = symbols.map((x) => x.symbol);
    if (this.frozen() || this.now() < this.retryAt) return;
    this.busy = true;
    try {
      const s = await fetchRecording(symbols, { ...this.o, now: () => this.now() });
      if (this.cur && !coversAll(this.cur, s, this.o.coverageMin)) {
        this.retryAt = this.now() + RETRY_PARTIAL_S;
        this.o.log?.('replay source: refetch drops covered symbols; the recording stays');
        return;
      }
      this.cur = s;
      if (!this.frozen()) this.retryAt = this.now() + RETRY_PARTIAL_S; // some batches did not answer
      if (this.o.dir) {
        mkdirSync(this.o.dir, { recursive: true });
        const f = join(this.o.dir, 'replay-5d-5m.json');
        writeFileSync(`${f}.tmp`, JSON.stringify(s));
        renameSync(`${f}.tmp`, f);
      }
      this.o.log?.(`replay: ${Object.keys(s.prices).length} symbols, ${s.t.length} bars of ${s.bar} s`);
    } catch (e) {
      this.retryAt = this.now() + RETRY_FAILED_S;
      this.o.log?.(`replay source: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
