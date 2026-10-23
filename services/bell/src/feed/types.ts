// Feed module contract. The API layer codes against this interface.
// Times are fork unix seconds unless a comment says wall; prices are plain numbers (USD per share).
export type Tf = '5m' | '15m' | '1h' | '4h' | '1d';
export interface Candle { t: number; o: number; h: number; l: number; c: number } // t = bucket start, fork unix s
export interface SymbolNow { symbol: string; covered: boolean; price: number | null; barT: number;
  prevClose: number | null; sessionOpen: number | null; sessionHigh: number | null; sessionLow: number | null;
  spark: number[] } // spark: at most 80 closes of the current playground session
export interface Feed {
  nowAll(): ReadonlyMap<string, SymbolNow>;  // rebuilt once per tick; price = the value the next print carries
  now(symbol: string): SymbolNow | null;
  candles(symbol: string, tf: Tf, limit: number, before?: number): Candle[]; // oldest first, last may be forming
  warm(symbol: string, clientKey: string, ttlS?: number): // warmUntil: wall unix seconds (TTL is wall time)
    { ok: boolean; warmUntil?: number; reason?: 'not-listed' | 'no-series' | 'rate' | 'full' };
  coverage(): { bars: number; symbols: number; eligible: string[]; missing: string[]; rule: string };
  etaWall(forkTs: number): number | null;    // wall seconds until the playground clock reaches forkTs
  nextClose(): number;                        // fork ts of the next 21:00 UTC
  status(): { core: string[]; warm: string[]; due: string[]; watchdog: string[]; rowsLastPost: number;
    tickMs: number; tickP95Ms: number; source: string; frozen: boolean; lastTickAt: number };
}
