// Sparkline paths of the board, reused from the launchpad demo (site/src/pages/wall/spark-paths.ts): one normalised box of 240 x 100 with 2 px padding, so
// the card, the table cell and the heatmap tooltip share one path string (the SVG uses viewBox="0 0 240 100",
// preserveAspectRatio="none" and a non-scaling stroke). The line and area strings are built once per HomeSeries object
// and kept in a WeakMap; use-charts.ts gives every bulk new HomeSeries objects (memoised per range, asOf and fetchedAt,
// one object per symbol), so the memo is in effect keyed by range plus asOf plus symbol and a refreshed bulk always
// gets new paths. The reference moves between /state polls, so its y is computed per call from the cached
// extent (cheap) and is not part of the memo. No DOM: bun test drives it directly.
import { areaPath, extent, linePath, type Box, type Extent } from './sparkline';

/** One symbol's chart, at most 60 points. New objects for every bulk (the path memo is keyed by object). */
export interface HomeSeries {
  pts: readonly (number | null)[];
  /** Range change in percent; null without a base. */
  chgPct: number | null;
  last: number | null;
  base: number | null;
  k: number;
}

export const SPARK_BOX: Readonly<Required<Pick<Box, 'width' | 'height' | 'pad'>>> = { width: 240, height: 100, pad: 2 };
export const SPARK_VIEWBOX = `0 0 ${SPARK_BOX.width} ${SPARK_BOX.height}`;
/** y of the dashed line when there is no series to scale it against (missing chart, loading). */
export const SPARK_MID = SPARK_BOX.height / 2;

export interface SparkPaths {
  /** "M x y L x y ..." of the line; empty when nothing is drawable. */
  line: string;
  /** The closed area under the line down to the box bottom. */
  area: string;
  /** y of the reference inside the box; null without a reference, a drawable series, or when it falls outside. */
  refY: number | null;
  /** The reference is above the series maximum (top) or below its minimum (bottom): a tick at that edge instead. */
  refEdge: 'top' | 'bottom' | null;
  /** Colour of the fill and the line: by the sign of chgPct, else by the first and last point. */
  dir: 'up' | 'down';
}

interface Cached {
  line: string;
  area: string;
  ext: Extent | null;
  dir: 'up' | 'down';
}

const memo = new WeakMap<HomeSeries, Cached>();
let builds = 0;

/** Number of path builds since load (tests: a memo hit does not build again). */
export function sparkBuilds(): number {
  return builds;
}

function dirOf(series: HomeSeries): 'up' | 'down' {
  if (series.chgPct !== null && Number.isFinite(series.chgPct)) return series.chgPct < 0 ? 'down' : 'up';
  let first: number | null = null;
  let last: number | null = null;
  for (const v of series.pts) {
    if (v === null || !Number.isFinite(v)) continue;
    if (first === null) first = v;
    last = v;
  }
  return first !== null && last !== null && last < first ? 'down' : 'up';
}

function cached(series: HomeSeries): Cached {
  const hit = memo.get(series);
  if (hit) return hit;
  builds += 1;
  const c: Cached = { line: linePath(series.pts, SPARK_BOX), area: areaPath(series.pts, SPARK_BOX), ext: extent(series.pts), dir: dirOf(series) };
  memo.set(series, c);
  return c;
}

/** y of `value` on the series' own scale in the 240 x 100 box (lib/sparkline.ts yOf with the cached extent). */
function yIn(value: number, ext: Extent): number {
  const { height, pad } = SPARK_BOX;
  const h = height - 2 * pad;
  return ext.max > ext.min ? pad + (1 - (value - ext.min) / (ext.max - ext.min)) * h : pad + h / 2;
}

/** The paths of `series` (memoised per object) and the reference line position for `reference`. */
export function sparkPaths(series: HomeSeries, reference: number | null): SparkPaths {
  const c = cached(series);
  let refY: number | null = null;
  let refEdge: SparkPaths['refEdge'] = null;
  if (reference !== null && Number.isFinite(reference) && c.ext) {
    // A flat series (max === min) still gets the edge tick when the reference lies outside it (spec 3.1).
    if (reference > c.ext.max) refEdge = 'top';
    else if (reference < c.ext.min) refEdge = 'bottom';
    else refY = Math.round(yIn(reference, c.ext) * 100) / 100;
  }
  return { line: c.line, area: c.area, refY, refEdge, dir: c.dir };
}

/** Number of M plus L commands of a path string (the e2e check: at most 60 per line). */
export function pathCommands(d: string): number {
  return (d.match(/[ML]/g) ?? []).length;
}
