// Pure helpers for the overview sparklines: downsample a series to N points, its min and max, the change percent,
// and SVG path strings (a line and a closed area) in a width x height box. Nulls (no trade yet) break the line; the
// area covers each unbroken run. No DOM, so bun test drives it directly.

export type Values = readonly (number | null | undefined)[];

export interface Extent {
  min: number;
  max: number;
}

/** Min and max over the finite values; null when there are none. */
export function extent(values: Values): Extent | null {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min === Infinity ? null : { min, max };
}

/** First and last finite values. */
export function ends(values: Values): { first: number; last: number } | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (first === null) first = v;
    last = v;
  }
  return first === null || last === null ? null : { first, last };
}

/** Change in percent from `base` (the close before the range, when known) or else the first value to the last
 *  value (or `last` when given). Null without a usable base. */
export function changePct(values: Values, base?: number | null, last?: number | null): number | null {
  const e = ends(values);
  const from = typeof base === 'number' && base > 0 ? base : e?.first;
  const to = typeof last === 'number' && Number.isFinite(last) ? last : e?.last;
  if (from === undefined || from === null || !(from > 0) || to === undefined || to === null) return null;
  return (to / from - 1) * 100;
}

/** Largest-triangle-three-buckets downsampling to at most n points, keeping the first and last point and the shape
 *  (peaks survive, unlike picking every k-th point). Nulls are kept as gaps: a bucket of nulls only gives a null. */
export function downsample(values: Values, n: number): (number | null)[] {
  const src = values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
  if (n >= src.length || n < 3) return n < 1 ? [] : n < 3 && src.length > n ? pickEven(src, n) : src;
  const out: (number | null)[] = [src[0]!];
  const size = (src.length - 2) / (n - 2);
  let a = 0;
  for (let i = 0; i < n - 2; i++) {
    const lo = Math.floor(i * size) + 1;
    const hi = Math.min(Math.floor((i + 1) * size) + 1, src.length - 1);
    // Average of the next bucket (the far point of the triangle).
    const nlo = hi;
    const nhi = Math.min(Math.floor((i + 2) * size) + 1, src.length);
    let ax = 0;
    let ay = 0;
    let cnt = 0;
    for (let j = nlo; j < nhi; j++) if (src[j] !== null) { ax += j; ay += src[j]!; cnt++; }
    if (cnt) { ax /= cnt; ay /= cnt; } else { ax = nlo; ay = src[a] ?? 0; }
    const pa = src[a] ?? null;
    let best = -1;
    let bestArea = -1;
    for (let j = lo; j < hi; j++) {
      const v = src[j] ?? null;
      if (v === null) continue;
      const area = pa === null ? Math.abs(v - ay) : Math.abs((a - ax) * (v - pa) - (a - j) * (ay - pa));
      if (area > bestArea) { bestArea = area; best = j; }
    }
    if (best === -1) { out.push(null); a = lo; continue; }
    out.push(src[best]!);
    a = best;
  }
  out.push(src[src.length - 1]!);
  return out;
}

function pickEven(src: (number | null)[], n: number): (number | null)[] {
  if (n === 1) return [src[src.length - 1]!];
  return [src[0]!, src[src.length - 1]!];
}

export interface Box {
  width: number;
  height: number;
  /** Inner padding in px on every side (keeps the stroke inside the box). Default 1. */
  pad?: number;
  /** Fixed scale (e.g. to share one scale over tiles, or to include a base line); default the values' extent. */
  min?: number;
  max?: number;
}

const f = (x: number) => (Math.round(x * 100) / 100).toString();

/** Point coordinates of the finite values, as runs of consecutive points (nulls end a run). */
export function points(values: Values, box: Box): [number, number][][] {
  const pad = box.pad ?? 1;
  const ex = extent(values);
  if (!ex) return [];
  const min = box.min ?? ex.min;
  const max = box.max ?? ex.max;
  const w = Math.max(0, box.width - 2 * pad);
  const h = Math.max(0, box.height - 2 * pad);
  const span = max - min;
  const n = values.length;
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      if (run.length) runs.push(run);
      run = [];
      continue;
    }
    const x = pad + (n === 1 ? w / 2 : (i / (n - 1)) * w);
    const y = pad + (span > 0 ? (1 - (v - min) / span) * h : h / 2);
    run.push([x, y]);
  }
  if (run.length) runs.push(run);
  return runs;
}

/** SVG path "M x y L x y ..." of the line; one M per unbroken run. Empty string when there is nothing to draw. */
export function linePath(values: Values, box: Box): string {
  return points(values, box)
    .map((run) => run.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join(''))
    .join('');
}

/** SVG path of the area under the line down to the box bottom (minus padding), closed per run. */
export function areaPath(values: Values, box: Box): string {
  const bottom = box.height - (box.pad ?? 1);
  return points(values, box)
    .map((run) => {
      const line = run.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join('');
      return `${line}L${f(run[run.length - 1]![0])} ${f(bottom)}L${f(run[0]![0])} ${f(bottom)}Z`;
    })
    .join('');
}

/** y of a value in the box (for a dotted base or reference line); null outside a drawable scale. */
export function yOf(value: number, values: Values, box: Box): number | null {
  const ex = extent(values);
  if (!ex) return null;
  const pad = box.pad ?? 1;
  const min = box.min ?? ex.min;
  const max = box.max ?? ex.max;
  const h = Math.max(0, box.height - 2 * pad);
  return max > min ? pad + (1 - (value - min) / (max - min)) * h : pad + h / 2;
}
