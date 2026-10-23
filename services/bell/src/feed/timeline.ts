// Replay timeline: every tick records (fork ts, bar index, isClose). Candles are symbol independent
// in time and take each symbol's recorded close at the bar index, so a candle close equals the posted round by
// construction. History before the first recorded tick is backfilled by running the replay mapping backwards (one
// playground day per recorded session, wrapping before bar 0).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DAY, deltaTo, sessionsOf, type ReplaySeries } from '../replay';
import type { Candle, Tf } from './types';

export const TIMELINE_CAP = 50_000;
/** Backfilled bars at most (about 1,500 playground days of 78 bars). */
export const BACKFILL_MAX = 120_000;
export const TF_S: Record<Tf, number> = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1d': DAY };

export interface TlEntry {
  t: number;
  i: number;
  c: boolean;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Fork seconds the replay moves the clock from bar j to the bar after it, without wall drift: the forward distance
 *  between the two recorded times of day (one bar inside a session, the jump to the next open across a night). */
export function stepAfter(s: ReplaySeries, j: number): number {
  const n = s.t.length;
  const d = mod(s.t[(j + 1) % n]! - s.t[j]!, DAY);
  return d === 0 ? DAY : d;
}

/** Bar index of the first bar of each bar's recorded session. */
export function sessionStarts(s: ReplaySeries): Int32Array {
  const out = new Int32Array(s.t.length);
  for (const [a, b] of sessionsOf(s.t)) for (let k = a; k < b; k++) out[k] = a;
  return out;
}

export class Timeline {
  entries: TlEntry[] = [];
  /** Identity of the series the bar indices belong to. */
  key = '';
  private dirty = false;
  constructor(readonly path: string | null, readonly cap = TIMELINE_CAP) {
    if (path && existsSync(path)) {
      try {
        const d = JSON.parse(readFileSync(path, 'utf8')) as { v: number; key: string; e: [number, number, number][] };
        if (d.v === 1 && Array.isArray(d.e)) {
          this.key = d.key;
          this.entries = d.e.map(([t, i, c]) => ({ t, i, c: c === 1 }));
        }
      } catch {
        this.entries = [];
      }
    }
  }

  /** Keeps the entries only while they belong to series `key`; a new series restarts the timeline. */
  useKey(key: string): void {
    if (key === this.key) return;
    this.key = key;
    this.entries = [];
    this.dirty = true;
  }

  record(t: number, i: number, c: boolean): void {
    // A clock below the last entry means a fresh fork: everything recorded at or after it is from the old one.
    while (this.entries.length && this.entries[this.entries.length - 1]!.t >= t) this.entries.pop();
    this.entries.push({ t, i, c });
    if (this.entries.length > this.cap) this.entries.splice(0, this.entries.length - this.cap);
    this.dirty = true;
  }

  /** Drops entries dated after the chain clock (fork reset to an earlier time). */
  clampTo(clock: number): void {
    let k = this.entries.length;
    while (k > 0 && this.entries[k - 1]!.t > clock) k--;
    if (k < this.entries.length) {
      this.entries.length = k;
      this.dirty = true;
    }
  }

  /** Last non-close entry. */
  lastBar(): TlEntry | null {
    for (let k = this.entries.length - 1; k >= 0; k--) if (!this.entries[k]!.c) return this.entries[k]!;
    return null;
  }

  firstBar(): TlEntry | null {
    for (const e of this.entries) if (!e.c) return e;
    return null;
  }

  save(force = false): void {
    if (!this.path || (!this.dirty && !force)) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, key: this.key, e: this.entries.map((e) => [e.t, e.i, e.c ? 1 : 0]) }));
    renameSync(tmp, this.path);
    this.dirty = false;
  }
}

/** Backward bars before an anchor (fork ts t, bar i): newest first. The anchor's time is first moved back to the
 *  recorded time of day of bar i, so the backfill sits on the session grid even when the first tick did not. */
export class Backfill {
  ts = new Float64Array(0);
  idx = new Int32Array(0);
  len = 0;
  private key = '';
  private src: ReplaySeries | null = null;
  /** Extends the backfill to `count` bars; a new series or anchor first drops what was built for the old one
   *  (ensure(s, anchor, 0) only does that check). */
  ensure(s: ReplaySeries, anchor: { t: number; i: number }, count: number): void {
    const key = `${anchor.t}:${anchor.i}`;
    if (key !== this.key || s !== this.src) {
      this.key = key;
      this.src = s;
      this.len = 0;
    }
    const want = Math.min(BACKFILL_MAX, count);
    if (this.len >= want) return;
    if (this.ts.length < want) {
      const ts = new Float64Array(Math.min(BACKFILL_MAX, Math.max(want, this.ts.length * 2, 1024)));
      const idx = new Int32Array(ts.length);
      ts.set(this.ts.subarray(0, this.len));
      idx.set(this.idx.subarray(0, this.len));
      this.ts = ts;
      this.idx = idx;
    }
    const n = s.t.length;
    let t: number;
    let i: number;
    if (this.len === 0) {
      t = anchor.t - mod(anchor.t - s.t[mod(anchor.i, n)]!, DAY);
      i = mod(anchor.i, n);
    } else {
      t = this.ts[this.len - 1]!;
      i = this.idx[this.len - 1]!;
    }
    while (this.len < want) {
      const j = mod(i - 1, n);
      t -= stepAfter(s, j);
      i = j;
      this.ts[this.len] = t;
      this.idx[this.len] = i;
      this.len++;
    }
  }
}

/** Candles of one symbol (oldest first): bars newest to oldest are the timeline's non-close entries, then the
 *  backfill. 5m: o = previous bar's close, c = bar close, h/l = max/min of the two (two bars in one 5-minute bucket
 *  merge); larger intervals aggregate the 5m candles. Only buckets starting before `before` count. */
export function buildCandles(s: ReplaySeries, prices: (number | null)[], tl: TlEntry[], bf: Backfill, anchor: { t: number; i: number }, tf: Tf, limit: number, before?: number): Candle[] {
  const tfS = TF_S[tf];
  const n = s.t.length;
  const perBucket = tf === '1d' ? 80 : Math.ceil(tfS / 300) + 1;
  // Gather newest to oldest until limit + 1 buckets are seen; the extra bar is the open of the oldest candle.
  const gt: number[] = [];
  const gi: number[] = [];
  let buckets = 0;
  let lastB = Number.NaN;
  let done = false;
  const visit = (t: number, i: number): boolean => {
    const b = Math.floor(Math.floor(t / 300) * 300 / tfS) * tfS;
    if (before !== undefined && b >= before) return true;
    if (b !== lastB) {
      buckets++;
      lastB = b;
    }
    gt.push(t);
    gi.push(i);
    return buckets <= limit;
  };
  for (let k = tl.length - 1; k >= 0 && !done; k--) if (!tl[k]!.c && !visit(tl[k]!.t, tl[k]!.i)) done = true;
  if (!done) {
    bf.ensure(s, anchor, 0); // a backfill built for another anchor (clock reset, new timeline) is never reused
    let need = Math.max(256, (limit + 2) * perBucket);
    for (let k = 0; !done; k++) {
      if (k >= bf.len) {
        if (bf.len >= BACKFILL_MAX) break;
        bf.ensure(s, anchor, Math.max(need, bf.len * 2));
        need *= 2;
        if (k >= bf.len) break;
      }
      if (!visit(bf.ts[k]!, bf.idx[k]!)) done = true;
    }
  }
  // gt/gi newest first; when stopped by the bucket count the last element belongs to the bucket past the limit.
  const extra = done ? { t: gt.pop()!, i: gi.pop()! } : null;
  const c5: Candle[] = [];
  let prev: number | null = extra ? prices[mod(extra.i, n)] ?? null : null;
  for (let k = gt.length - 1; k >= 0; k--) {
    const c = prices[mod(gi[k]!, n)];
    if (typeof c !== 'number') continue;
    const o = prev ?? prices[mod(gi[k]! - 1, n)] ?? c;
    const t5 = Math.floor(gt[k]! / 300) * 300;
    const last = c5[c5.length - 1];
    if (last && last.t === t5) {
      last.c = c;
      last.h = Math.max(last.h, c);
      last.l = Math.min(last.l, c);
    } else c5.push({ t: t5, o, h: Math.max(o, c), l: Math.min(o, c), c });
    prev = c;
  }
  if (tf === '5m') return c5.slice(-limit);
  const out: Candle[] = [];
  for (const x of c5) {
    const b = Math.floor(x.t / tfS) * tfS;
    const last = out[out.length - 1];
    if (last && last.t === b) {
      last.c = x.c;
      last.h = Math.max(last.h, x.h);
      last.l = Math.min(last.l, x.l);
    } else out.push({ t: b, o: x.o, h: x.h, l: x.l, c: x.c });
  }
  return out.slice(-limit);
}

/** Ticks until the clock reaches forkTs, walking the replay mapping forward from (clock, cursor): each tick moves the
 *  clock from c to c + deltaTo(c, next bar) (the close re-post and the night jump happen inside one tick). Null past
 *  `maxTicks`. */
export function ticksUntil(s: ReplaySeries, clock: number, cursor: number, forkTs: number, maxTicks = 200_000): number | null {
  const n = s.t.length;
  let c = clock;
  let i = mod(cursor, n);
  let k = 0;
  while (c < forkTs) {
    if (k >= maxTicks) return null;
    const next = (i + 1) % n;
    c += deltaTo(c, s.t[next]!, s.bar);
    i = next;
    k++;
  }
  return k;
}
