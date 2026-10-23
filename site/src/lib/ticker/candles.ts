// Candles of the ticker chart: the feed builds 5-minute candles from the replay timeline with o = previous
// close, c = bar close, h and l = max and min of the two; 15m, 1h, 4h and 1d aggregate the 5-minute candles. The chart
// loads a window once per interval and then polls the last three candles; mergeTail folds that tail in place, so the
// forming candle updates and a new one appends without a full redraw (and without resetting the zoom). Pure.

export type Tf = '5m' | '15m' | '1h' | '4h' | '1d';
export const TFS: readonly Tf[] = ['5m', '15m', '1h', '4h', '1d'];
export const TF_SECONDS: Readonly<Record<Tf, number>> = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 };
export const BAR_SECONDS = 300;

/** t = bucket start, fork unix seconds (the frozen feed contract, plan 3.1). */
export interface Candle { t: number; o: number; h: number; l: number; c: number }

export function isTf(v: unknown): v is Tf {
  return typeof v === 'string' && (TFS as readonly string[]).includes(v);
}

/** 5-minute candles from bar closes (oldest first): the open is the previous close, the first bar opens at `firstOpen`
 * (its own close when absent), and high and low are the max and min of open and close. */
export function fromCloses(closes: readonly { t: number; c: number }[], firstOpen?: number): Candle[] {
  const out: Candle[] = [];
  let prev = firstOpen ?? closes[0]?.c ?? 0;
  for (const { t, c } of closes) {
    out.push({ t, o: prev, h: Math.max(prev, c), l: Math.min(prev, c), c });
    prev = c;
  }
  return out;
}

/** Aggregate candles (oldest first) into `tf` buckets aligned to the unix epoch: open of the first, close of the
 * last, max of the highs, min of the lows. The last bucket may be forming. */
export function aggregate(src: readonly Candle[], tf: Tf): Candle[] {
  const size = TF_SECONDS[tf];
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const k of src) {
    const t = Math.floor(k.t / size) * size;
    if (cur && cur.t === t) {
      cur.h = Math.max(cur.h, k.h);
      cur.l = Math.min(cur.l, k.l);
      cur.c = k.c;
    } else {
      if (cur) out.push(cur);
      cur = { t, o: k.o, h: k.h, l: k.l, c: k.c };
    }
  }
  if (cur) out.push(cur);
  return out;
}

const same = (a: Candle, b: Candle) => a.t === b.t && a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c;

export interface Merge {
  candles: Candle[];
  /** Candles to pass to series.update in this order (each at or after the series' last time). */
  updates: Candle[];
  /** The tail does not connect to the loaded window (candles may be missing) or an older candle changed: reload. */
  reset: boolean;
}

/** Fold a polled tail (oldest first, the last few candles) into the loaded window (oldest first). */
export function mergeTail(cur: readonly Candle[], tail: readonly Candle[]): Merge {
  const sorted = [...tail].filter((k) => Number.isFinite(k.t) && Number.isFinite(k.c)).sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return { candles: [...cur], updates: [], reset: false };
  const last = cur[cur.length - 1];
  if (!last) return { candles: sorted, updates: [], reset: true };
  // No overlap with the window: candles between the two may be missing, so the caller reloads the window.
  if (sorted[0]!.t > last.t) return { candles: [...cur], updates: [], reset: true };
  const out = [...cur];
  const updates: Candle[] = [];
  const index = new Map<number, number>();
  out.forEach((k, i) => index.set(k.t, i));
  for (const k of sorted) {
    const i = index.get(k.t);
    if (i === undefined) {
      if (k.t < last.t) continue; // older than the window's end and not in it: outside the loaded range
      out.push(k);
      index.set(k.t, out.length - 1);
      updates.push(k);
    } else if (!same(out[i]!, k)) {
      // Only the last loaded candle may still change (the forming one); a closed candle that changed means the
      // window is out of date.
      if (k.t < last.t) return { candles: [...cur], updates: [], reset: true };
      out[i] = k;
      updates.push(k);
    }
  }
  return { candles: out, updates, reset: false };
}

/** The candle under the crosshair, else the last one, with the move from its open in percent. */
export function legendOf(candles: readonly Candle[], t: number | null): (Candle & { movePct: number }) | null {
  const k = (t === null ? undefined : candles.find((x) => x.t === t)) ?? candles[candles.length - 1];
  if (!k) return null;
  return { ...k, movePct: k.o > 0 ? (k.c / k.o - 1) * 100 : 0 };
}

/** A visible logical range of the chart (candle indices, fractional, may run past either end). */
export interface LogicalRange { from: number; to: number }

/** Carries a visible range from one candle window to its replacement (a recovery reload, the trim of the oldest
 * candles), so the viewer keeps the same zoom on the same candles. A range that reaches the newest candle stays on the
 * newest candle; one on older candles moves to where the candle at its right edge sits now; when those candles are no
 * longer in the window it shows the oldest ones kept. Null when either window is empty (the caller's default view). */
export function rebaseRange(range: LogicalRange, prev: readonly Pick<Candle, 't'>[], next: readonly Pick<Candle, 't'>[]): LogicalRange | null {
  if (prev.length === 0 || next.length === 0 || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return null;
  const width = range.to - range.from;
  if (range.to >= prev.length - 1) {
    const shift = next.length - prev.length;
    return { from: range.from + shift, to: range.to + shift };
  }
  const edge = Math.max(0, Math.floor(range.to));
  const t = prev[edge]!.t;
  // the last candle of the new window at or before the right edge's time
  let lo = 0;
  let hi = next.length - 1;
  if (next[0]!.t > t) return { from: 0, to: width };
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (next[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  const shift = lo - edge;
  return { from: range.from + shift, to: range.to + shift };
}
