// Demand-driven print set: which symbols get a demo signer round at a post. Every posted round adds one
// storage slot to DemoSignerReference forever, so only what someone needs is printed:
//   due      open tickets with expiry <= the post time whose symbol has no round at or after that expiry
//   watchdog symbols whose settle preflight reverted, until those tickets settle
//   core     BELL_CORE_SYMBOLS (default: the markets in book.json)
//   warm     symbols someone is looking at (POST /warm, and implicitly GET /markets/:s, /candles/:s, /prices/:s)
// in that priority order, capped at PRINT_CAP rows; due is never dropped.
import type { StateData } from '../store';

export const PRINT_CAP = 128;
export const WARM_MAX = 64;
export const WARM_TTL_S = 90;
export const WARM_TTL_MAX_S = 120;
/** New warms per client key per minute (refreshing a warm symbol does not count). */
export const WARM_NEW_PER_MIN = 60;
/** At the cap, the least recently touched warm entry is evicted only when idle at least this long; else 'full'. */
export const WARM_EVICT_IDLE_MS = 15_000;

export type WarmResult = { ok: boolean; warmUntil?: number; reason?: 'not-listed' | 'no-series' | 'rate' | 'full' };

interface WarmEntry {
  until: number; // wall ms
  touched: number; // wall ms
}

/** Warm set: LRU (Map insertion order, least recently touched first) with a TTL in wall time and a per-client limit
 *  on new entries. */
export class WarmSet {
  private m = new Map<string, WarmEntry>();
  private perKey = new Map<string, number[]>();
  constructor(readonly max = WARM_MAX) {}

  /** Marks `symbol` warm for ttlS wall seconds; `isCore` symbols always print and need no entry. */
  touch(symbol: string, key: string, ttlS: number | undefined, nowMs: number, isCore: boolean): WarmResult {
    const ttl = Math.max(1, Math.min(WARM_TTL_MAX_S, Number.isFinite(ttlS) && ttlS! > 0 ? ttlS! : WARM_TTL_S));
    const until = nowMs + ttl * 1000;
    if (isCore) return { ok: true, warmUntil: Math.floor(until / 1000) };
    const cur = this.m.get(symbol);
    if (cur && cur.until > nowMs) {
      this.m.delete(symbol);
      this.m.set(symbol, { until: Math.max(cur.until, until), touched: nowMs });
      return { ok: true, warmUntil: Math.floor(Math.max(cur.until, until) / 1000) };
    }
    const hist = (this.perKey.get(key) ?? []).filter((t) => t > nowMs - 60_000);
    if (hist.length >= WARM_NEW_PER_MIN) {
      this.perKey.set(key, hist);
      return { ok: false, reason: 'rate' };
    }
    this.prune(nowMs);
    if (this.m.size >= this.max) {
      const [lru, e] = this.m.entries().next().value as [string, WarmEntry];
      if (nowMs - e.touched < WARM_EVICT_IDLE_MS) return { ok: false, reason: 'full' };
      this.m.delete(lru);
    }
    this.m.delete(symbol);
    this.m.set(symbol, { until, touched: nowMs });
    hist.push(nowMs);
    this.perKey.set(key, hist);
    if (this.perKey.size > 5000) for (const [k, v] of this.perKey) if (!v.some((t) => t > nowMs - 60_000)) this.perKey.delete(k);
    return { ok: true, warmUntil: Math.floor(until / 1000) };
  }

  prune(nowMs: number): void {
    for (const [k, e] of this.m) if (e.until <= nowMs) this.m.delete(k);
  }

  /** Active warm symbols, most recently touched first. */
  active(nowMs: number): string[] {
    this.prune(nowMs);
    return [...this.m.keys()].reverse();
  }
}

/** Watchdog: symbol -> ticket ids whose settle preflight reverted; a symbol leaves when none of its tickets is open. */
export class Watchdog {
  private m = new Map<string, Set<string>>();
  add(id: string, symbol: string): void {
    (this.m.get(symbol) ?? this.m.set(symbol, new Set()).get(symbol)!).add(id);
  }
  symbols(d: Pick<StateData, 'tickets'>): string[] {
    for (const [sym, ids] of this.m) {
      for (const id of ids) if (d.tickets[id]?.status !== 'open') ids.delete(id);
      if (!ids.size) this.m.delete(sym);
    }
    return [...this.m.keys()];
  }
}

/** Symbols with an open ticket that expired at or before `at` and no round at or after its expiry, earliest expiry
 *  first. A stored round dated after `at` cannot be on this chain (state from an older fork) and counts as none. */
export function dueSymbols(d: Pick<StateData, 'tickets' | 'rounds'>, at: number): string[] {
  const first = new Map<string, number>();
  for (const t of Object.values(d.tickets)) {
    if (t.status !== 'open' || t.expiry > at) continue;
    const rs = d.rounds[t.symbol];
    const last = rs?.length ? rs[rs.length - 1]! : null;
    if (last && last.t >= t.expiry && last.t <= at) continue;
    const e = first.get(t.symbol);
    if (e === undefined || t.expiry < e) first.set(t.symbol, t.expiry);
  }
  return [...first].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([s]) => s);
}

export interface PrintSet {
  symbols: string[];
  due: string[];
  watchdog: string[];
  core: string[];
  warm: string[];
}

/** Priority merge: due, watchdog, core, warm; only listed symbols; capped at `cap` with every due symbol kept. */
export function mergePrintSet(listed: ReadonlySet<string>, due: string[], watchdog: string[], core: string[], warm: string[], cap = PRINT_CAP): PrintSet {
  const seen = new Set<string>();
  const out: string[] = [];
  const take = (xs: string[], always: boolean) => {
    const kept: string[] = [];
    for (const s of xs) {
      if (!listed.has(s) || seen.has(s)) continue;
      if (!always && out.length >= cap) break;
      seen.add(s);
      out.push(s);
      kept.push(s);
    }
    return kept;
  };
  const d = take(due, true);
  const w = take(watchdog, false);
  const c = take(core, false);
  const h = take(warm, false);
  return { symbols: out, due: d, watchdog: w, core: c, warm: h };
}
