// FeedService: the Feed contract (types.ts) over the replay recording, the tick timeline and the print set.
// Reads store.data.tickets, .rounds and .markets read-only.
import { COVERAGE_MIN, COVERAGE_RULE, DAY, eligibleOf, seriesKey, tickMs as tickMsOf, type ReplaySeries, type TickResult } from '../replay';
import type { StateData } from '../store';
import { dueSymbols, mergePrintSet, PRINT_CAP, Watchdog, WarmSet, type PrintSet } from './printset';
import { Backfill, buildCandles, sessionStarts, ticksUntil, Timeline } from './timeline';
import type { Candle, Feed, SymbolNow, Tf } from './types';

export type { Candle, Feed, SymbolNow, Tf } from './types';

export interface FeedDeps {
  series(): ReplaySeries | null;
  data(): Pick<StateData, 'tickets' | 'rounds' | 'markets'>;
  /** Listed markets that read the demo signer. */
  listed(): string[];
  /** Core symbols (always printed while listed). */
  core(): string[];
  /** Catalog symbols, upper case. */
  catalog(): string[];
  /** The cursor the next replay tick posts in series `s` (remapped when `s` replaced the replay's series), with the
   *  fork clock at `clock`. */
  cursor(s: ReplaySeries | null, clock: number): number;
  speed(): number;
  paused(): boolean;
  /** True while the recording is frozen (no refetch before BELL_REPLAY_REFRESH_S). */
  frozen(): boolean;
  closeHourUtc: number;
  timelinePath: string | null;
  coverageMin?: number;
  nowMs?: () => number;
  log?: (...a: unknown[]) => void;
}

const TFS: readonly Tf[] = ['5m', '15m', '1h', '4h', '1d'];
const LOG_EVERY = 60;
/** Memoized candle answers (requests without `before`), cleared every tick and when the series changes. */
export const CANDLE_MEMO_MAX = 256;
const mod = (a: number, n: number) => ((a % n) + n) % n;

export class FeedService implements Feed {
  readonly timeline: Timeline;
  readonly warmSet = new WarmSet();
  readonly watchdog = new Watchdog();
  private bf = new Backfill();
  private nowMap = new Map<string, SymbolNow>();
  private nowDirty = true;
  /** The series object the caches below were built from (a refresh, a fallback or a range change is a new object). */
  private src: ReplaySeries | null | undefined = undefined;
  private starts: { src: ReplaySeries | null; s: Int32Array } = { src: null, s: new Int32Array(0) };
  private candleMemo = new Map<string, Candle[]>();
  private listedCache: { at: number; n: number; set: Set<string> } = { at: 0, n: -1, set: new Set() };
  private eligibleCache: { src: ReplaySeries | null | undefined; n: number; set: Set<string>; eligible: string[]; missing: string[] } = { src: undefined, n: -1, set: new Set(), eligible: [], missing: [] };
  private last: PrintSet = { symbols: [], due: [], watchdog: [], core: [], warm: [] };
  private clock = 0;
  private lastTickStart = 0;
  private lastTickDur = 0;
  private lastTickAt = 0;
  private rowsLastPost = 0;
  private durs: number[] = [];
  private rows: number[] = [];
  private ticks = 0;

  constructor(readonly deps: FeedDeps) {
    this.timeline = new Timeline(deps.timelinePath);
    const lb = this.timeline.lastBar();
    if (lb) this.clock = lb.t;
  }

  private nowMs(): number {
    return this.deps.nowMs ? this.deps.nowMs() : Date.now();
  }

  /** Listed set, rebuilt at most once a second or when the market count changes. */
  listedSet(): Set<string> {
    const n = Object.keys(this.deps.data().markets).length;
    const at = this.nowMs();
    if (n !== this.listedCache.n || at - this.listedCache.at > 1000) this.listedCache = { at, n, set: new Set(this.deps.listed()) };
    return this.listedCache.set;
  }

  /** Drops what was built from another series object (same axis or not: a refresh can change coverage or prices on
   *  an identical axis). */
  private sync(s: ReplaySeries | null): void {
    if (s === this.src) return;
    this.src = s;
    this.nowDirty = true;
    this.candleMemo.clear();
  }

  private eligible(): { set: Set<string>; eligible: string[]; missing: string[] } {
    const s = this.deps.series();
    const cat = this.deps.catalog();
    if (s !== this.eligibleCache.src || cat.length !== this.eligibleCache.n) {
      const r = eligibleOfMin(s, cat, this.deps.coverageMin);
      this.eligibleCache = { src: s, n: cat.length, set: new Set(r.eligible), ...r };
    }
    return this.eligibleCache;
  }

  /** Anchor of the backfill: the first recorded bar, else the bar the next tick will post at the clock. */
  private anchor(s: ReplaySeries): { t: number; i: number } {
    const fb = this.timeline.key === seriesKey(s) ? this.timeline.firstBar() : null;
    if (fb) return { t: fb.t, i: fb.i };
    const t = this.clock || Math.floor(this.nowMs() / 1000);
    return { t, i: this.deps.cursor(s, t) };
  }

  // ---------------------------------------------------------------- print set
  /** Symbols to print at fork time `at` (the tick or the daily-close re-post). */
  printSet(at: number, _close = false): string[] {
    const d = this.deps.data();
    const listed = this.listedSet();
    const set = mergePrintSet(listed, dueSymbols(d, at), this.watchdog.symbols(d), this.deps.core(), this.warmSet.active(this.nowMs()), PRINT_CAP);
    this.last = set;
    return set.symbols;
  }

  /** A settle preflight for ticket `id` on `symbol` reverted: print the symbol until the ticket settles. */
  watch(id: string, symbol: string): void {
    this.watchdog.add(id, symbol.toUpperCase());
  }

  /** Ticks recorded so far (a clock read started before a tick and finished after it is stale). */
  tickSeq(): number {
    return this.ticks;
  }

  /** Due symbols of the latest print set (the rows a post must land). */
  lastDue(): string[] {
    return this.last.due;
  }

  /** A clock read from the chain. `seq` is tickSeq() when the read started; a read that a tick overtook is ignored.
   *  Entries after the chain clock come from a rolled-back or older fork (snapshot revert, reseed): dropped at once,
   *  so candles and prices do not show bars the chain has not reached. */
  setClock(c: number, seq?: number): void {
    if (!Number.isFinite(c) || c <= 0) return;
    if (seq !== undefined && seq !== this.ticks) return;
    if (c !== this.clock) this.nowDirty = true;
    this.clock = c;
    const lb = this.timeline.entries[this.timeline.entries.length - 1];
    if (lb && lb.t > c) {
      this.timeline.clampTo(c);
      this.nowDirty = true;
      this.candleMemo.clear();
    }
  }

  /** Records one replay tick: timeline entries, metrics, and the log line every 60 ticks. */
  onTick(r: TickResult, startedMs: number, durMs: number): void {
    if (r.idle || r.bar === undefined || r.postedAt === undefined || !r.key) return;
    this.timeline.useKey(r.key);
    this.timeline.record(r.postedAt, r.bar, false);
    if (r.closeAt !== null && r.closeAt !== undefined) this.timeline.record(r.closeAt, r.bar, true);
    this.clock = r.at;
    this.lastTickStart = startedMs;
    this.lastTickDur = durMs;
    this.lastTickAt = startedMs + durMs;
    this.rowsLastPost = r.posted;
    this.durs.push(durMs);
    this.rows.push(r.posted + (r.closePosted ?? 0));
    if (this.durs.length > 300) this.durs.shift();
    if (this.rows.length > 300) this.rows.shift();
    this.nowDirty = true;
    this.candleMemo.clear();
    this.ticks++;
    if (this.ticks % LOG_EVERY === 0) this.deps.log?.(this.logLine());
  }

  logLine(): string {
    const last = this.rows.slice(-LOG_EVERY);
    const ds = this.durs.slice(-LOG_EVERY);
    const avg = last.length ? last.reduce((a, b) => a + b, 0) / last.length : 0;
    return `feed: rows per post last ${this.rowsLastPost} avg ${avg.toFixed(1)} max ${Math.max(0, ...last)}; tick ms p50 ${pct(ds, 0.5)} p95 ${pct(ds, 0.95)} max ${Math.round(Math.max(0, ...ds))}; core ${this.last.core.length} warm ${this.last.warm.length} due ${this.last.due.length} watchdog ${this.last.watchdog.length}`;
  }

  save(force = false): void {
    this.timeline.save(force);
  }

  // ---------------------------------------------------------------- Feed
  /** price = the value the next print carries: the cursor's bar, which the next tick posts at the clock (barT). Session
   *  stats run through that bar. */
  nowAll(): ReadonlyMap<string, SymbolNow> {
    const s = this.deps.series();
    this.sync(s);
    if (!this.nowDirty) return this.nowMap;
    const m = new Map<string, SymbolNow>();
    const { set } = this.eligible();
    if (!s) {
      for (const sym of this.deps.catalog()) m.set(sym, empty(sym, this.clock));
    } else {
      const n = s.t.length;
      if (this.starts.src !== s) this.starts = { src: s, s: sessionStarts(s) };
      const i = mod(this.deps.cursor(s, this.clock), n);
      const t = this.clock;
      const s0 = this.starts.s[i]!;
      for (const sym of this.deps.catalog()) {
        const p = s.prices[sym];
        const price = p?.[i];
        if (!p || typeof price !== 'number') {
          m.set(sym, empty(sym, t));
          continue;
        }
        const spark: number[] = [];
        let hi = -Infinity;
        let lo = Infinity;
        for (let k = s0; k <= i; k++) {
          const v = p[k];
          if (typeof v !== 'number') continue;
          spark.push(v);
          if (v > hi) hi = v;
          if (v < lo) lo = v;
        }
        const pc = p[(s0 - 1 + n) % n];
        m.set(sym, { symbol: sym, covered: set.has(sym), price, barT: t, prevClose: typeof pc === 'number' ? pc : null, sessionOpen: spark[0] ?? null, sessionHigh: spark.length ? hi : null, sessionLow: spark.length ? lo : null, spark: spark.slice(-80) });
      }
    }
    this.nowMap = m;
    this.nowDirty = false;
    return m;
  }

  now(symbol: string): SymbolNow | null {
    return this.nowAll().get(symbol.toUpperCase()) ?? null;
  }

  candles(symbol: string, tf: Tf, limit: number, before?: number): Candle[] {
    const s = this.deps.series();
    const sym = symbol.toUpperCase();
    const p = s?.prices[sym];
    if (!s || !p || !TFS.includes(tf)) return [];
    this.sync(s);
    const lim = Math.max(1, Math.min(1000, Math.floor(limit) || 300));
    const a = this.anchor(s);
    // Keyed by the backfill anchor (it moves with the clock until the first tick); paging requests (`before`) are not
    // memoized: their keys are open-ended.
    const mk = before === undefined ? `${sym}|${tf}|${lim}|${a.t}|${a.i}` : null;
    const hit = mk ? this.candleMemo.get(mk) : undefined;
    if (hit) return hit;
    const tl = this.timeline.key === seriesKey(s) ? this.timeline.entries : [];
    const out = buildCandles(s, p, tl, this.bf, a, tf, lim, before);
    if (mk) {
      if (this.candleMemo.size >= CANDLE_MEMO_MAX) this.candleMemo.clear();
      this.candleMemo.set(mk, out);
    }
    return out;
  }

  warm(symbol: string, clientKey: string, ttlS?: number): { ok: boolean; warmUntil?: number; reason?: 'not-listed' | 'no-series' | 'rate' | 'full' } {
    const sym = symbol.toUpperCase();
    if (!this.listedSet().has(sym)) return { ok: false, reason: 'not-listed' };
    const s = this.deps.series();
    if (!s?.prices[sym]) return { ok: false, reason: 'no-series' };
    return this.warmSet.touch(sym, clientKey || 'local', ttlS, this.nowMs(), this.deps.core().includes(sym));
  }

  coverage(): { bars: number; symbols: number; eligible: string[]; missing: string[]; rule: string } {
    const s = this.deps.series();
    const e = this.eligible();
    return { bars: s?.t.length ?? 0, symbols: this.deps.catalog().length, eligible: e.eligible, missing: e.missing, rule: this.deps.coverageMin !== undefined && this.deps.coverageMin !== 0.9 ? COVERAGE_RULE.replace('0.90', this.deps.coverageMin.toFixed(2)) : COVERAGE_RULE };
  }

  etaWall(forkTs: number): number | null {
    const s = this.deps.series();
    if (!s || s.t.length < 2 || this.deps.paused() || !Number.isFinite(forkTs)) return null;
    if (forkTs <= this.clock) return 0;
    const k = ticksUntil(s, this.clock, this.deps.cursor(s, this.clock), forkTs);
    if (k === null) return null;
    const ms = tickMsOf(this.deps.speed());
    const now = this.nowMs();
    const nextStart = this.lastTickStart ? Math.max(now, this.lastTickStart + ms) : now + ms;
    const at = nextStart + (k - 1) * ms + this.lastTickDur;
    return Math.max(0, Math.round((at - now) / 100) / 10);
  }

  nextClose(): number {
    const c = this.clock || Math.floor(this.nowMs() / 1000);
    const e = c - (((c % DAY) + DAY) % DAY) + this.deps.closeHourUtc * 3600;
    return e > c ? e : e + DAY;
  }

  status(): { core: string[]; warm: string[]; due: string[]; watchdog: string[]; rowsLastPost: number; tickMs: number; tickP95Ms: number; source: string; frozen: boolean; lastTickAt: number } {
    const listed = this.listedSet();
    return {
      core: this.deps.core().filter((x) => listed.has(x)),
      warm: this.warmSet.active(this.nowMs()),
      due: this.last.due,
      watchdog: this.watchdog.symbols(this.deps.data()),
      rowsLastPost: this.rowsLastPost,
      tickMs: Math.round(this.lastTickDur),
      tickP95Ms: pct(this.durs, 0.95),
      source: this.deps.series()?.source ?? 'none',
      frozen: this.deps.frozen(),
      lastTickAt: this.lastTickAt,
    };
  }

  /** Fork clock as last seen by a tick or a clock read. */
  clockNow(): number {
    return this.clock;
  }
}

function empty(symbol: string, barT: number): SymbolNow {
  return { symbol, covered: false, price: null, barT, prevClose: null, sessionOpen: null, sessionHigh: null, sessionLow: null, spark: [] };
}

function pct(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const a = xs.slice().sort((x, y) => x - y);
  return Math.round(a[Math.min(a.length - 1, Math.floor(q * a.length))]!);
}

/** eligibleOf with a configurable threshold (default COVERAGE_MIN). */
export function eligibleOfMin(s: ReplaySeries | null, catalog: string[], min?: number): { eligible: string[]; missing: string[] } {
  return eligibleOf(s, catalog, min ?? COVERAGE_MIN);
}
