// Client of the bell service's chart series: GET /charts/:range, one bulk answer for every catalog symbol with a shared
// time axis. Reused from the launchpad demo (site/src/lib/charts-client.ts); the base is BELL_URL (config.ts) and in
// mock mode (VITE_MOCK=1) the fixture layer answers instead of the network. A 5 minute memory cache per range (the service's own Cache-Control is max-age 300), one request in flight
// per range shared by every caller, and an abort per caller: an aborted caller stops waiting, the shared request still
// fills the cache for the next one. chartsEffect is the useEffect body with its cleanup (abort on unmount).
import { useEffect, useState } from 'react';

import { BELL_URL, MOCK } from '../config';
import { mockCharts } from './mock';

export type ChartRange = '1d' | '5d' | '1m' | '3m' | '1y';
export const CHART_RANGES: readonly ChartRange[] = ['1d', '5d', '1m', '3m', '1y'];
export const CHARTS_TTL_MS = 5 * 60_000;

export interface ChartSeries {
  /** Share-price closes aligned to t (Yahoo) or token prices (oracle fallback); null before the first trade. */
  p: (number | null)[];
  /** Close before the range. */
  base: number | null;
  last: number | null;
  /** last / base - 1 (a fraction, not percent). */
  chg: number | null;
  /** Token units per share: p * k reads in token units. */
  k: number;
}
export interface ChartBulk {
  /** Unix seconds of the newest bar. */
  asOf: number;
  /** Unix seconds of the upstream fetch. */
  fetchedAt: number;
  range: ChartRange;
  /** Bar size in seconds. */
  interval: number;
  /** "Yahoo Finance" or "Ondo price feed" (fallback). */
  source: string;
  delayMin: number;
  /** True when the last refresh failed and this is the last good data. */
  stale: boolean;
  count: number;
  /** Shared axis, unix seconds. */
  t: number[];
  series: Record<string, ChartSeries>;
  missing: string[];
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class ChartsError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = 'ChartsError';
  }
}

export function chartsUrl(range: ChartRange, base = BELL_URL): string {
  return `${base.replace(/\/+$/, '')}/charts/${range}`;
}

/** Shape check of an answer (the axis, and every series' p as long as the axis). */
export function isChartBulk(x: unknown): x is ChartBulk {
  const b = x as ChartBulk;
  if (!b || typeof b !== 'object' || !Array.isArray(b.t) || !b.series || typeof b.series !== 'object' || typeof b.asOf !== 'number') return false;
  for (const s of Object.values(b.series)) if (!s || !Array.isArray(s.p) || s.p.length !== b.t.length || typeof s.k !== 'number') return false;
  return true;
}

const cache = new Map<string, { at: number; data: ChartBulk }>();
const inflight = new Map<string, Promise<ChartBulk>>();

export function clearChartsCache(): void {
  cache.clear();
  inflight.clear();
}

export interface ChartsOptions {
  base?: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
  /** Skip the memory cache (still shares a request in flight). */
  force?: boolean;
  now?: () => number;
}

function abortError(): Error {
  return new DOMException('The chart request was aborted', 'AbortError');
}

/** The bulk of one range: from the memory cache when younger than 5 minutes, else one shared request. */
export function fetchCharts(range: ChartRange, o: ChartsOptions = {}): Promise<ChartBulk> {
  const url = chartsUrl(range, o.base);
  const now = o.now ?? Date.now;
  // Abort check before the cache: an already-aborted caller never receives data, cached or not.
  if (o.signal?.aborted) return Promise.reject(abortError());
  const hit = cache.get(url);
  if (!o.force && hit && now() - hit.at < CHARTS_TTL_MS) {
    const signal = o.signal;
    if (!signal) return Promise.resolve(hit.data);
    // Settle on a microtask like the network path, and drop the data when the caller aborted in between (an effect
    // cleanup that runs right after the effect).
    return Promise.resolve().then(() => (signal.aborted ? Promise.reject(abortError()) : hit.data));
  }
  let p = inflight.get(url);
  if (!p && MOCK && !o.fetch) {
    p = mockCharts(range).then((doc) => {
      cache.set(url, { at: now(), data: doc });
      return doc;
    });
  }
  if (!p) {
    const f = o.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
    p = (async () => {
      const r = await f(url, { headers: { accept: 'application/json' } });
      if (!r.ok) {
        let msg = `chart data answered ${r.status}`;
        try {
          const j = (await r.json()) as { error?: string };
          if (j?.error) msg = j.error;
        } catch {
          /* not JSON */
        }
        throw new ChartsError(msg, r.status);
      }
      const doc: unknown = await r.json();
      if (!isChartBulk(doc)) throw new ChartsError('chart data has an unexpected shape', r.status);
      cache.set(url, { at: now(), data: doc });
      return doc;
    })().finally(() => inflight.delete(url));
    inflight.set(url, p);
  }
  const signal = o.signal;
  if (!signal) return p;
  return new Promise<ChartBulk>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p!.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        if (!signal.aborted) resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        if (!signal.aborted) reject(e);
      },
    );
  });
}

export function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/** Body of a useEffect: loads the range and returns the cleanup that aborts, so callbacks never run after unmount. */
export function chartsEffect(range: ChartRange, onData: (b: ChartBulk) => void, onError: (e: Error) => void, o: Omit<ChartsOptions, 'signal'> = {}): () => void {
  const ac = new AbortController();
  fetchCharts(range, { ...o, signal: ac.signal }).then(onData, (e: unknown) => {
    if (!isAbort(e)) onError(e instanceof Error ? e : new Error(String(e)));
  });
  return () => ac.abort();
}

/** React state over chartsEffect; refetches when the range changes, aborts on unmount. */
export function useCharts(range: ChartRange, o: Omit<ChartsOptions, 'signal'> = {}): { data: ChartBulk | null; error: Error | null } {
  const [state, setState] = useState<{ data: ChartBulk | null; error: Error | null }>({ data: null, error: null });
  const base = o.base;
  useEffect(() => chartsEffect(range, (data) => setState({ data, error: null }), (error) => setState((s) => ({ data: s.data, error })), base === undefined ? {} : { base }), [range, base]);
  return state;
}

/** One symbol's series in token units (p * k); null when the bulk has none. */
export function tokenSeries(b: ChartBulk, symbol: string): (number | null)[] | null {
  const s = b.series[symbol.toUpperCase()];
  if (!s) return null;
  return s.k === 1 ? s.p : s.p.map((v) => (v === null ? null : v * s.k));
}
