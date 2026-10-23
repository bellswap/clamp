// Chart series for the home screen (docs/research/chart-data-notes.md): one bulk answer per range with a shared time
// axis, refreshed on a timer and served from memory (and a copy on disk, so a restart serves at once). Browsers never
// call the upstream sources.
//   Primary: Yahoo Finance v7 spark, keyless with the plain 'Mozilla/5.0' user agent, 20 symbols per call.
//   Fallback: the Ondo oracle's PricePosted events on Ethereum (eth_getLogs on the Tenderly public gateway, 50,000
//   blocks per call). Sparse (a post about every 38 h per token), so it is the degraded mode, not the default.
// Display data only: the token's trading reference stays the Ondo price. `p` holds share prices; p * k is in token
// units (k is 1 unless the catalog's Ondo price and the share price differ by more than 15 percent, which marks a
// share multiplier or split, e.g. NFLX 10).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Range = '1d' | '5d' | '1m' | '3m' | '1y';
export const RANGES: readonly Range[] = ['1d', '5d', '1m', '3m', '1y'];

interface RangeSpec {
  /** Yahoo range and interval parameters. */
  yRange: string;
  yInterval: string;
  /** Yahoo bar size in seconds. */
  bar: number;
  /** Refresh interval of the timer in ms. */
  refreshMs: number;
  /** Fallback: calendar span in seconds and bar size of its regular grid. */
  span: number;
  fbBar: number;
}
const MIN = 60_000;
const DAY = 86_400;
export const SPECS: Record<Range, RangeSpec> = {
  '1d': { yRange: '1d', yInterval: '5m', bar: 300, refreshMs: 15 * MIN, span: DAY, fbBar: 1800 },
  '5d': { yRange: '5d', yInterval: '15m', bar: 900, refreshMs: 15 * MIN, span: 7 * DAY, fbBar: 7200 },
  '1m': { yRange: '1mo', yInterval: '1h', bar: 3600, refreshMs: 360 * MIN, span: 30 * DAY, fbBar: 6 * 3600 },
  '3m': { yRange: '3mo', yInterval: '1d', bar: DAY, refreshMs: 360 * MIN, span: 91 * DAY, fbBar: DAY },
  '1y': { yRange: '1y', yInterval: '1d', bar: DAY, refreshMs: 360 * MIN, span: 365 * DAY, fbBar: DAY },
};
export const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=600';
export const YAHOO_UA = 'Mozilla/5.0';
export const YAHOO_BATCH = 20;
export const ORACLE = '0x914d5cb27cb30e80bde8215ff577ed63eb986b79';
/** keccak256("PricePosted(address,uint256,uint256,uint256,uint256)"), checked in test/charts.test.ts. */
export const PRICE_POSTED = '0xe1835c6d053ab96fb521e0b87fcdb281ca989d57558df21dde4f093b50e8a20e';
export const ETH_LOGS_RPC = 'https://gateway.tenderly.co/public/mainnet';
const LOG_CHUNK = 50_000;
/** Fallback lookback before the range start, so tokens without a post in the range still get a base (heartbeat
 *  about 38 h, maximum delay 48 h). */
const LOOKBACK = 3 * DAY;
/** Last good data younger than this is served stale on an upstream failure; older data gives way to the fallback. */
export const MAX_STALE_MS = 24 * 3_600_000;
const YAHOO_SOURCE = 'Yahoo Finance';
const ORACLE_SOURCE = 'Ondo price feed';

export interface ChartSymbol {
  symbol: string;
  yahoo: string;
  /** Lowercase Ethereum subject of the Ondo oracle, null when none. */
  subject: string | null;
  /** Catalog Ondo price (token units), for k. */
  ref: number | null;
}
export interface Series {
  /** Closes aligned to t, forward-filled; null before the first trade. */
  p: (number | null)[];
  /** Close before the range. */
  base: number | null;
  last: number | null;
  /** last / base - 1. */
  chg: number | null;
  /** Token units per share. */
  k: number;
}
export interface ChartBulk {
  asOf: number;
  fetchedAt: number;
  range: Range;
  interval: number;
  source: string;
  delayMin: number;
  stale: boolean;
  count: number;
  t: number[];
  series: Record<string, Series>;
  missing: string[];
}

// ---------------------------------------------------------------- symbols (site/public/catalog.json)
const YAHOO_MAP: Record<string, string> = { XAU: 'GC=F', XAG: 'SI=F' };
export function yahooOf(symbol: string): string {
  return YAHOO_MAP[symbol] ?? symbol.replace(/\./g, '-');
}
export function parseChartSymbols(entries: unknown): ChartSymbol[] {
  if (!Array.isArray(entries)) throw new Error('chart catalog: not an array');
  const out: ChartSymbol[] = [];
  const seen = new Set<string>();
  for (const e of entries as Record<string, unknown>[]) {
    const symbol = typeof e?.symbol === 'string' ? e.symbol.toUpperCase() : '';
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    const ys = typeof e.yahooSymbol === 'string' && e.yahooSymbol ? e.yahooSymbol : yahooOf(symbol);
    const subject = typeof e.subject === 'string' && /^0x[0-9a-fA-F]{40}$/.test(e.subject) && !e.elsewhere ? e.subject.toLowerCase() : null;
    const ref = typeof e.lastPrice === 'number' && e.lastPrice > 0 ? e.lastPrice : null;
    out.push({ symbol, yahoo: ys, subject, ref });
  }
  return out;
}
export function loadChartSymbols(path: string): ChartSymbol[] {
  if (!existsSync(path)) return [];
  return parseChartSymbols(JSON.parse(readFileSync(path, 'utf8')));
}

// ---------------------------------------------------------------- upstream fetch: limit and retry
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** At most `max` tasks in flight. */
export class Limit {
  private active = 0;
  private q: (() => void)[] = [];
  peak = 0;
  constructor(readonly max: number) {}
  async run<T>(f: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.q.push(r));
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try {
      return await f();
    } finally {
      this.active -= 1;
      this.q.shift()?.();
    }
  }
}

export interface Upstream {
  fetch: FetchLike;
  limit: Limit;
  /** Wait before the one retry, ms. */
  retryMs: number;
  timeoutMs: number;
}

/** GET or POST through the limit; one retry on a network error, a timeout, 429 or 5xx. Returns parsed JSON. */
export async function getJson(up: Upstream, url: string, init: RequestInit = {}): Promise<unknown> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && up.retryMs > 0) await new Promise((r) => setTimeout(r, up.retryMs));
    try {
      return await up.limit.run(async () => {
        const r = await up.fetch(url, { ...init, signal: AbortSignal.timeout(up.timeoutMs) });
        if (!r.ok) {
          const err = new Error(`${r.status} from ${new URL(url).host}`) as Error & { retry?: boolean };
          err.retry = r.status === 429 || r.status >= 500;
          throw err;
        }
        return r.json();
      });
    } catch (e) {
      last = e;
      if ((e as { retry?: boolean }).retry === false) break;
    }
  }
  throw last;
}

// ---------------------------------------------------------------- Yahoo spark
export interface RawSeries {
  t: number[];
  c: (number | null)[];
  base: number | null;
  last: number | null;
}

/** Parses one v7 spark answer: {spark:{result:[{symbol, response:[{meta, timestamp, indicators.quote[0].close}]}]}}. */
export function parseSpark(doc: unknown): Map<string, RawSeries> {
  const out = new Map<string, RawSeries>();
  const result = (doc as { spark?: { result?: unknown } })?.spark?.result;
  if (!Array.isArray(result)) throw new Error('spark: no result array');
  for (const r of result as { symbol?: string; response?: unknown[] }[]) {
    const resp = Array.isArray(r?.response) ? (r.response[0] as Record<string, any> | undefined) : undefined;
    if (!r?.symbol || !resp) continue;
    const ts: unknown[] = Array.isArray(resp.timestamp) ? resp.timestamp : [];
    const raw: unknown[] = Array.isArray(resp.indicators?.quote?.[0]?.close) ? resp.indicators.quote[0].close : [];
    // Keep a bar only when its timestamp is a finite number above the previous kept one: a null, non-numeric or
    // out-of-order timestamp drops the bar with its close (alignTo assumes ascending t, and null <= x is true in JS).
    const t: number[] = [];
    const c: (number | null)[] = [];
    for (let i = 0; i < Math.min(ts.length, raw.length); i++) {
      const x = ts[i];
      if (typeof x !== 'number' || !Number.isFinite(x) || (t.length && x <= t[t.length - 1]!)) continue;
      const v = raw[i];
      t.push(x);
      c.push(typeof v === 'number' && Number.isFinite(v) ? v : null);
    }
    const meta = resp.meta ?? {};
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);
    let lastClose: number | null = null;
    for (let i = c.length - 1; i >= 0; i--) if (c[i] !== null) { lastClose = c[i]!; break; }
    out.set(r.symbol, { t, c, base: num(meta.chartPreviousClose) ?? num(meta.previousClose), last: num(meta.regularMarketPrice) ?? lastClose });
  }
  return out;
}

export const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Token units per share: 1 unless ref/last is off by more than 15 percent, then the nearest integer ratio (or its
 *  reciprocal below 1, e.g. ETHA one third). */
export function kOf(ref: number | null, last: number | null): number {
  if (!ref || !last) return 1;
  const r = ref / last;
  if (r >= 0.85 && r <= 1.15) return 1;
  const k = r >= 1 ? Math.round(r) : 1 / Math.max(1, Math.round(1 / r));
  return round6(k);
}

/** The shared axis: every timestamp that at least 10 percent of the series with data carry (drops the extra bars of
 *  24 h futures and odd single bars), sorted. */
export function sharedAxis(raw: Iterable<RawSeries>): number[] {
  const count = new Map<number, number>();
  let n = 0;
  for (const s of raw) {
    if (!s.t.length) continue;
    n += 1;
    for (const t of new Set(s.t)) count.set(t, (count.get(t) ?? 0) + 1);
  }
  const min = Math.max(n >= 2 ? 2 : 1, Math.ceil(n * 0.1));
  return [...count].filter(([, c]) => c >= min).map(([t]) => t).sort((a, b) => a - b);
}

/** As-of join: p[i] = the last non-null close at or before axis[i]; null before the first. */
export function alignTo(axis: number[], t: number[], c: (number | null)[]): (number | null)[] {
  const out: (number | null)[] = new Array(axis.length).fill(null);
  let j = 0;
  let cur: number | null = null;
  for (let i = 0; i < axis.length; i++) {
    while (j < t.length && t[j]! <= axis[i]!) {
      if (c[j] !== null && c[j] !== undefined) cur = c[j]!;
      j++;
    }
    out[i] = cur === null ? null : round4(cur);
  }
  return out;
}

/** Builds the bulk from parsed spark data (keyed by Yahoo symbol) for the catalog symbols. */
export function buildYahooBulk(range: Range, parsed: Map<string, RawSeries>, symbols: ChartSymbol[], fetchedAt: number): ChartBulk {
  const mine = symbols.map((s) => [s, parsed.get(s.yahoo)] as const);
  const t = sharedAxis(mine.map(([, r]) => r).filter((r): r is RawSeries => !!r));
  const series: Record<string, Series> = {};
  const missing: string[] = [];
  for (const [s, r] of mine) {
    if (!r || !r.t.length || r.c.every((x) => x === null)) {
      missing.push(s.symbol);
      continue;
    }
    const p = alignTo(t, r.t, r.c);
    if (p.every((x) => x === null)) {
      missing.push(s.symbol);
      continue;
    }
    const last = r.last;
    series[s.symbol] = { p, base: r.base === null ? null : round4(r.base), last: last === null ? null : round4(last), chg: r.base && last ? round6(last / r.base - 1) : null, k: kOf(s.ref, last) };
  }
  return { asOf: t.length ? t[t.length - 1]! : fetchedAt, fetchedAt, range, interval: SPECS[range].bar, source: YAHOO_SOURCE, delayMin: 15, stale: false, count: Object.keys(series).length, t, series, missing };
}

/** All catalog symbols for one range in batches of 20. Throws when more than half of the batches fail. */
export async function fetchYahoo(range: Range, symbols: ChartSymbol[], up: Upstream, now: number): Promise<ChartBulk> {
  const sp = SPECS[range];
  const ys = [...new Set(symbols.map((s) => s.yahoo))];
  const batches: string[][] = [];
  for (let i = 0; i < ys.length; i += YAHOO_BATCH) batches.push(ys.slice(i, i + YAHOO_BATCH));
  const parsed = new Map<string, RawSeries>();
  let failed = 0;
  let firstErr: unknown = null;
  await Promise.all(
    batches.map(async (b) => {
      const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${b.map(encodeURIComponent).join(',')}&range=${sp.yRange}&interval=${sp.yInterval}`;
      try {
        const doc = await getJson(up, url, { headers: { 'user-agent': YAHOO_UA, accept: 'application/json' } });
        for (const [k, v] of parseSpark(doc)) parsed.set(k, v);
      } catch (e) {
        failed += 1;
        firstErr ??= e;
      }
    }),
  );
  if (!batches.length) throw new Error('no symbols');
  if (failed * 2 > batches.length) throw new Error(`yahoo: ${failed} of ${batches.length} batches failed (${(firstErr as Error)?.message ?? firstErr})`);
  const bulk = buildYahooBulk(range, parsed, symbols, now);
  if (!bulk.count) throw new Error('yahoo: no series');
  return bulk;
}

// ---------------------------------------------------------------- fallback: Ondo oracle PricePosted logs
export interface RawLog {
  address: string;
  topics: string[];
  data: string;
}
export interface Post {
  ts: number;
  price: number;
  oldTs: number;
  oldPrice: number;
}

/** Decodes PricePosted(address indexed token, oldPrice, oldTs, newPrice, newTs), prices with 18 decimals. */
export function parsePosts(logs: RawLog[]): Map<string, Post[]> {
  const out = new Map<string, Post[]>();
  for (const l of logs) {
    if (l.address?.toLowerCase() !== ORACLE || l.topics?.[0]?.toLowerCase() !== PRICE_POSTED || !l.topics[1]) continue;
    const d = l.data.startsWith('0x') ? l.data.slice(2) : l.data;
    if (d.length < 256) continue;
    const w = (i: number) => BigInt('0x' + d.slice(i * 64, i * 64 + 64));
    const subject = ('0x' + l.topics[1].slice(-40)).toLowerCase();
    const post = { oldPrice: Number(w(0)) / 1e18, oldTs: Number(w(1)), price: Number(w(2)) / 1e18, ts: Number(w(3)) };
    if (!(post.price > 0) || !post.ts) continue;
    (out.get(subject) ?? out.set(subject, []).get(subject)!).push(post);
  }
  for (const v of out.values()) v.sort((a, b) => a.ts - b.ts);
  return out;
}

/** The bulk on a regular grid of the range's fallback bar from the posts (step series, token units, k = 1). */
export function buildOracleBulk(range: Range, posts: Map<string, Post[]>, symbols: ChartSymbol[], now: number): ChartBulk {
  const sp = SPECS[range];
  const start = Math.floor((now - sp.span) / sp.fbBar) * sp.fbBar;
  const t: number[] = [];
  for (let x = start; x <= now; x += sp.fbBar) t.push(x);
  const series: Record<string, Series> = {};
  const missing: string[] = [];
  for (const s of symbols) {
    const ps = s.subject ? posts.get(s.subject) : undefined;
    if (!ps?.length) {
      missing.push(s.symbol);
      continue;
    }
    // Base: the price in force at the range start (a post at or before it, else the old price of the first post).
    let base: number | null = null;
    for (const x of ps) if (x.ts <= start) base = x.price;
    if (base === null && ps[0]!.oldTs <= start && ps[0]!.oldPrice > 0) base = ps[0]!.oldPrice;
    const p: (number | null)[] = [];
    let j = 0;
    let cur = base;
    for (const x of t) {
      while (j < ps.length && ps[j]!.ts <= x) cur = ps[j++]!.price;
      p.push(cur === null ? null : round4(cur));
    }
    const last = ps[ps.length - 1]!.price;
    series[s.symbol] = { p, base: base === null ? null : round4(base), last: round4(last), chg: base ? round6(last / base - 1) : null, k: 1 };
  }
  let asOf = 0;
  for (const s of symbols) {
    const ps = s.subject ? posts.get(s.subject) : undefined;
    if (ps?.length) asOf = Math.max(asOf, ps[ps.length - 1]!.ts);
  }
  return { asOf: asOf || now, fetchedAt: now, range, interval: sp.fbBar, source: ORACLE_SOURCE, delayMin: 0, stale: false, count: Object.keys(series).length, t, series, missing };
}

async function rpc(up: Upstream, url: string, method: string, params: unknown[]): Promise<unknown> {
  const doc = (await getJson(up, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })) as { result?: unknown; error?: { message?: string } };
  if (doc?.error) throw new Error(`${method}: ${doc.error.message ?? 'rpc error'}`);
  return doc?.result;
}

/** The eth_blockNumber result as a safe integer; throws on anything else (a huge or malformed head would make the
 *  chunk loop below spin without advancing). */
export function parseHead(x: unknown): number {
  if (typeof x !== 'string' || !/^0x[0-9a-fA-F]{1,14}$/.test(x)) throw new Error('eth_blockNumber: bad head');
  const n = Number(BigInt(x));
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('eth_blockNumber: out of range');
  return n;
}

/** PricePosted logs over the range span plus the lookback, in chunks of 50,000 blocks (12 s per block). */
export async function fetchOracle(range: Range, symbols: ChartSymbol[], up: Upstream, rpcUrl: string, now: number): Promise<ChartBulk> {
  const head = parseHead(await rpc(up, rpcUrl, 'eth_blockNumber', []));
  const blocks = Math.ceil((SPECS[range].span + LOOKBACK) / 12) + 600;
  const from = Math.max(0, head - blocks);
  const maxChunks = Math.ceil(blocks / LOG_CHUNK) + 1;
  const chunks: [number, number][] = [];
  for (let a = from; a <= head && chunks.length < maxChunks; a += LOG_CHUNK) chunks.push([a, Math.min(head, a + LOG_CHUNK - 1)]);
  const all: RawLog[] = [];
  await Promise.all(
    chunks.map(async ([a, b]) => {
      const logs = (await rpc(up, rpcUrl, 'eth_getLogs', [{ address: ORACLE, topics: [PRICE_POSTED], fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }])) as RawLog[];
      if (!Array.isArray(logs)) throw new Error('eth_getLogs: no array');
      for (const l of logs) all.push({ address: l.address, topics: l.topics, data: l.data });
    }),
  );
  const bulk = buildOracleBulk(range, parsePosts(all), symbols, now);
  if (!bulk.count) throw new Error('oracle: no series');
  return bulk;
}

// ---------------------------------------------------------------- service: store, refresh loop, HTTP answers
interface Entry {
  bulk: ChartBulk;
  body: string;
  gz: Uint8Array;
  etag: string;
}
export interface ChartStatus {
  range: Range;
  source: string | null;
  fetchedAt: number | null;
  count: number;
  stale: boolean;
  lastError: string | null;
  lastAttempt: number | null;
}
export interface ChartOptions {
  symbols: ChartSymbol[];
  fetch?: FetchLike;
  ethRpc?: string;
  /** Directory for the last good bulk per range; null keeps memory only. */
  dir?: string | null;
  maxInFlight?: number;
  retryMs?: number;
  timeoutMs?: number;
  now?: () => number;
  log?: (...a: unknown[]) => void;
}

export class ChartService {
  readonly symbols: ChartSymbol[];
  private store = new Map<Range, Entry>();
  private status = new Map<Range, { lastError: string | null; lastAttempt: number | null; failed: boolean }>();
  private up: Upstream;
  private ethRpc: string;
  private dir: string | null;
  private now: () => number;
  private log: (...a: unknown[]) => void;
  private queue: Promise<void> = Promise.resolve();
  private queued = new Set<Range>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private once: ReturnType<typeof setTimeout>[] = [];
  private first: ReturnType<typeof setTimeout> | null = null;

  constructor(o: ChartOptions) {
    this.symbols = o.symbols;
    this.up = { fetch: o.fetch ?? ((u, i) => fetch(u, i)), limit: new Limit(o.maxInFlight ?? 4), retryMs: o.retryMs ?? 1500, timeoutMs: o.timeoutMs ?? 20_000 };
    this.ethRpc = o.ethRpc ?? ETH_LOGS_RPC;
    this.dir = o.dir ?? null;
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = o.log ?? (() => undefined);
  }

  get limit(): Limit {
    return this.up.limit;
  }

  private put(bulk: ChartBulk, persist: boolean): void {
    const body = JSON.stringify(bulk);
    this.store.set(bulk.range, { bulk, body, gz: Bun.gzipSync(body), etag: `W/"${bulk.range}-${bulk.fetchedAt}-${bulk.source === YAHOO_SOURCE ? 'y' : 'o'}${bulk.stale ? 's' : ''}"` });
    if (persist && this.dir) {
      try {
        mkdirSync(this.dir, { recursive: true });
        const f = join(this.dir, `${bulk.range}.json`);
        writeFileSync(`${f}.tmp`, body);
        renameSync(`${f}.tmp`, f);
      } catch (e) {
        this.log(`charts: could not save ${bulk.range}: ${(e as Error).message}`);
      }
    }
  }

  /** Loads the saved bulks; they count as stale until a refresh succeeds. */
  loadDisk(): void {
    if (!this.dir) return;
    for (const r of RANGES) {
      const f = join(this.dir, `${r}.json`);
      if (!existsSync(f)) continue;
      try {
        const b = JSON.parse(readFileSync(f, 'utf8')) as ChartBulk;
        if (b.range === r && Array.isArray(b.t) && b.series) this.put({ ...b, stale: true }, false);
      } catch (e) {
        this.log(`charts: bad saved ${r}: ${(e as Error).message}`);
      }
    }
  }

  private setStale(range: Range): void {
    const e = this.store.get(range);
    if (e && !e.bulk.stale) this.put({ ...e.bulk, stale: true }, false);
  }

  /** One refresh: Yahoo; on failure keep the last good bulk (stale) while it is under 24 h old, else the oracle
   *  fallback; when that fails too, keep whatever is there, marked stale. Never throws. */
  async refresh(range: Range): Promise<void> {
    const st = { lastError: null as string | null, lastAttempt: this.now(), failed: false };
    this.status.set(range, st);
    try {
      this.put(await fetchYahoo(range, this.symbols, this.up, this.now()), true);
      return;
    } catch (e) {
      st.lastError = `yahoo: ${(e as Error).message}`;
      this.log(`charts ${range}: ${st.lastError}`);
    }
    const prev = this.store.get(range);
    if (prev && prev.bulk.source === YAHOO_SOURCE && (this.now() - prev.bulk.fetchedAt) * 1000 < MAX_STALE_MS) {
      st.failed = true;
      this.setStale(range);
      return;
    }
    try {
      this.put(await fetchOracle(range, this.symbols, this.up, this.ethRpc, this.now()), true);
      this.log(`charts ${range}: served from the oracle fallback`);
    } catch (e) {
      st.failed = true;
      st.lastError += `; oracle: ${(e as Error).message}`;
      this.log(`charts ${range}: oracle fallback failed: ${(e as Error).message}`);
      this.setStale(range);
    }
  }

  /** Queues a refresh; ranges run one after another so the limit of 4 in flight holds over all of them. */
  enqueue(range: Range): Promise<void> {
    if (this.queued.has(range)) return this.queue;
    this.queued.add(range);
    this.queue = this.queue.then(async () => {
      this.queued.delete(range);
      try {
        await this.refresh(range);
      } catch (e) {
        this.log(`charts ${range}: ${(e as Error).message}`);
      }
    });
    return this.queue;
  }

  /** Disk copy first; after firstDelayMs every range whose data is missing, not from Yahoo or older than its interval
   *  refreshes at once and then on its interval; a range with younger saved data waits only for the rest of its
   *  interval (refreshMs minus the data's age), so data age stays under one interval across a restart. */
  start(firstDelayMs = 5_000): void {
    this.loadDisk();
    this.first = setTimeout(() => {
      this.first = null;
      for (const r of RANGES) {
        const wait = firstRefreshMs(this.store.get(r)?.bulk, r, this.now());
        const every = () => {
          void this.enqueue(r);
          this.timers.push(setInterval(() => void this.enqueue(r), SPECS[r].refreshMs));
        };
        if (wait === 0) every();
        else this.once.push(setTimeout(every, wait));
      }
    }, firstDelayMs);
  }
  stop(): void {
    if (this.first) clearTimeout(this.first);
    this.first = null;
    for (const t of this.once) clearTimeout(t);
    for (const t of this.timers) clearInterval(t);
    this.once = [];
    this.timers = [];
  }

  get(range: Range): ChartBulk | null {
    return this.store.get(range)?.bulk ?? null;
  }

  statusOf(): ChartStatus[] {
    return RANGES.map((r) => {
      const b = this.store.get(r)?.bulk;
      const s = this.status.get(r);
      return { range: r, source: b?.source ?? null, fetchedAt: b?.fetchedAt ?? null, count: b?.count ?? 0, stale: b?.stale ?? false, lastError: s?.lastError ?? null, lastAttempt: s?.lastAttempt ?? null };
    });
  }

  /** GET /charts/:range. */
  respond(req: Request, range: string): Response {
    if (!(RANGES as readonly string[]).includes(range)) return plain({ error: `range must be one of ${RANGES.join(', ')}` }, 400);
    const e = this.store.get(range as Range);
    if (!e) return plain({ error: 'chart data is loading; try again in a minute', range }, 503, { 'retry-after': '30' });
    const headers: Record<string, string> = { 'cache-control': CACHE_CONTROL, etag: e.etag, vary: 'Accept-Encoding', 'content-type': 'application/json; charset=utf-8' };
    if (req.headers.get('if-none-match') === e.etag) return new Response(null, { status: 304, headers });
    if (acceptsGzip(req.headers.get('accept-encoding'))) return new Response(e.gz, { status: 200, headers: { ...headers, 'content-encoding': 'gzip' } });
    return new Response(e.body, { status: 200, headers });
  }

  /** GET /charts/:range/:symbol (ticker or s-ticker). */
  respondOne(range: string, symbol: string): Response {
    if (!(RANGES as readonly string[]).includes(range)) return plain({ error: `range must be one of ${RANGES.join(', ')}` }, 400);
    const e = this.store.get(range as Range);
    if (!e) return plain({ error: 'chart data is loading; try again in a minute', range }, 503, { 'retry-after': '30' });
    const q = decodeURIComponent(symbol).toUpperCase();
    const key = e.bulk.series[q] ? q : q.startsWith('S') && e.bulk.series[q.slice(1)] ? q.slice(1) : null;
    if (!key) return plain({ error: e.bulk.missing.includes(q) || e.bulk.missing.includes(q.slice(1)) ? 'no chart data for this symbol' : 'unknown symbol', symbol: q }, 404, { 'cache-control': CACHE_CONTROL });
    const b = e.bulk;
    return plain({ asOf: b.asOf, fetchedAt: b.fetchedAt, range: b.range, interval: b.interval, source: b.source, delayMin: b.delayMin, stale: b.stale, t: b.t, symbol: key, series: { [key]: b.series[key] } }, 200, { 'cache-control': CACHE_CONTROL });
  }
}

/** ms until a range's first refresh after the startup delay: 0 when the data is missing, not from Yahoo or at least one
 *  interval old, else the rest of the interval. */
export function firstRefreshMs(bulk: ChartBulk | undefined, range: Range, now: number): number {
  if (!bulk || bulk.source !== YAHOO_SOURCE) return 0;
  const ageMs = Math.max(0, (now - bulk.fetchedAt) * 1000);
  return ageMs >= SPECS[range].refreshMs ? 0 : SPECS[range].refreshMs - ageMs;
}

/** True when Accept-Encoding allows gzip: a gzip token (else *) with q above 0 (RFC 9110 section 12.5.3). */
export function acceptsGzip(header: string | null): boolean {
  let gzip: number | null = null;
  let star: number | null = null;
  for (const part of (header ?? '').split(',')) {
    const [name, ...params] = part.split(';').map((x) => x.trim().toLowerCase());
    if (!name) continue;
    let q = 1;
    for (const p of params) {
      const m = /^q\s*=\s*([0-9.]+)$/.exec(p);
      if (m) q = Number(m[1]);
    }
    if (!Number.isFinite(q)) q = 0;
    if (name === 'gzip' || name === 'x-gzip') gzip = Math.max(gzip ?? 0, q);
    else if (name === '*') star = q;
  }
  return (gzip ?? star ?? 0) > 0;
}

function plain(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
