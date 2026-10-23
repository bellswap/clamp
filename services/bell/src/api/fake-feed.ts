// A deterministic Feed (feed/types.ts) for the route tests and scripts/bench-store.ts: a price per symbol from a
// seed, a session of 78 five-minute bars, warm with an LRU cap, a TTL and a per-client rate limit.
import type { Candle, Feed, SymbolNow, Tf } from '../feed/types';
import { nextCloseAfter } from './feed';

const TF_S: Record<Tf, number> = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 };

export interface FakeFeedOpts {
  symbols: string[];
  /** Symbols without a series (covered false, price null). */
  uncovered?: string[];
  listed: () => Set<string>;
  clock: () => number;
  basePrice?: (symbol: string) => number;
  core?: string[];
  warmCap?: number;
  warmPerMin?: number;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

export class FakeFeed implements Feed {
  private map = new Map<string, SymbolNow>();
  private builtAt = -1;
  private warmSet = new Map<string, number>();
  private rate = new Map<string, { start: number; n: number }>();
  warmCalls: { symbol: string; clientKey: string }[] = [];
  lastTickAt = Date.now();
  constructor(readonly o: FakeFeedOpts) {}

  private price(symbol: string, t: number): number {
    const base = this.o.basePrice?.(symbol) ?? 20 + hash(symbol) * 400;
    return Math.round(base * (1 + 0.02 * Math.sin(t / 3000 + hash(symbol) * 6)) * 1e4) / 1e4;
  }

  /** Rebuilt when the fork clock moves to a new bar (as the real feed rebuilds once per tick). */
  nowAll(): ReadonlyMap<string, SymbolNow> {
    const clock = this.o.clock();
    const bar = Math.floor(clock / 300) * 300;
    if (bar === this.builtAt) return this.map;
    const m = new Map<string, SymbolNow>();
    const unc = new Set(this.o.uncovered ?? []);
    const open = bar - (bar % 86_400) + 13.5 * 3600;
    for (const s of this.o.symbols) {
      if (unc.has(s)) {
        m.set(s, { symbol: s, covered: false, price: null, barT: bar, prevClose: null, sessionOpen: null, sessionHigh: null, sessionLow: null, spark: [] });
        continue;
      }
      const spark: number[] = [];
      for (let t = Math.max(open, bar - 79 * 300); t <= bar; t += 300) spark.push(this.price(s, t));
      if (!spark.length) spark.push(this.price(s, bar));
      m.set(s, { symbol: s, covered: true, price: this.price(s, bar), barT: bar, prevClose: this.price(s, open - 3 * 3600), sessionOpen: spark[0]!, sessionHigh: Math.max(...spark), sessionLow: Math.min(...spark), spark });
    }
    this.map = m;
    this.builtAt = bar;
    this.lastTickAt = Date.now();
    return m;
  }
  now(symbol: string): SymbolNow | null {
    return this.nowAll().get(symbol) ?? null;
  }
  candles(symbol: string, tf: Tf, limit: number, before?: number): Candle[] {
    const n = this.now(symbol);
    if (!n?.covered) return [];
    const step = TF_S[tf];
    const end = Math.floor((before ?? this.o.clock() + 1) / step) * step;
    const out: Candle[] = [];
    for (let i = limit; i >= 1; i--) {
      const t = end - i * step + (before === undefined ? step : 0);
      const o = this.price(symbol, t - 300);
      const c = this.price(symbol, t);
      out.push({ t, o, h: Math.max(o, c), l: Math.min(o, c), c });
    }
    return out;
  }
  warm(symbol: string, clientKey: string, ttlS = 90): { ok: boolean; warmUntil?: number; reason?: 'not-listed' | 'no-series' | 'rate' | 'full' } {
    this.warmCalls.push({ symbol, clientKey });
    if (!this.o.listed().has(symbol)) return { ok: false, reason: 'not-listed' };
    if (!this.now(symbol)?.covered) return { ok: false, reason: 'no-series' };
    const nowS = Math.floor(Date.now() / 1000);
    for (const [s, until] of this.warmSet) if (until <= nowS) this.warmSet.delete(s);
    if (!this.warmSet.has(symbol)) {
      const r = this.rate.get(clientKey);
      if (r && nowS - r.start < 60 && r.n >= (this.o.warmPerMin ?? 60)) return { ok: false, reason: 'rate' };
      if (!r || nowS - r.start >= 60) this.rate.set(clientKey, { start: nowS, n: 1 });
      else r.n++;
      if (this.warmSet.size >= (this.o.warmCap ?? 64)) this.warmSet.delete(this.warmSet.keys().next().value!);
    }
    const until = nowS + Math.min(120, Math.max(1, ttlS));
    this.warmSet.delete(symbol);
    this.warmSet.set(symbol, until);
    return { ok: true, warmUntil: until };
  }
  coverage() {
    const unc = new Set(this.o.uncovered ?? []);
    const eligible = this.o.symbols.filter((s) => !unc.has(s));
    return { bars: 391, symbols: this.o.symbols.length, eligible, missing: this.o.symbols.filter((s) => unc.has(s)), rule: 'raw 5m bars cover >= 90% of the shared axis' };
  }
  etaWall(forkTs: number): number | null {
    const d = forkTs - this.o.clock();
    return d <= 0 ? 0 : Math.ceil(d / 300);
  }
  nextClose(): number {
    return nextCloseAfter(this.o.clock());
  }
  status() {
    return { core: this.o.core ?? [], warm: [...this.warmSet.keys()], due: [], watchdog: [], rowsLastPost: (this.o.core ?? []).length + this.warmSet.size, tickMs: 12, tickP95Ms: 20, source: 'fake', frozen: true, lastTickAt: this.lastTickAt };
  }
}
