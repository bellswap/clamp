// Bell HTTP client. Tolerant of the current bell (no /markets, no bot flag) so the fleet degrades
// to the core symbols and on-chain market reads instead of stopping.
import { isAddress, type Address } from 'viem';

export interface BookAddrs {
  ticketBook: Address;
  vault: Address;
  reference: Address;
  usdg: Address;
  startBlock: string;
}

export interface BellState {
  book: BookAddrs | null;
  clockUnix: number | null;
  /** Wall time of the bell's last replay tick (feed.lastTickAt, else replay.lastTick.at). */
  lastTickAt: number | null;
  core: string[] | null;
  bots: number | null;
  open: number | null;
}

export interface MarketRow {
  symbol: string;
  listed?: boolean;
  covered?: boolean;
  tradable?: boolean;
  price?: number | null;
  oiRaw?: string;
  oiCapRaw?: string;
  maxStakeRaw?: string;
  maxLeverage?: number;
  lastRound?: { t: number; price8: string } | null;
  fresh?: boolean;
}

export interface OpenTicket {
  id: string;
  owner: string;
  symbol: string;
  expiry: number;
  status: string;
  bot?: boolean;
}

type F = typeof fetch;

export class Bell {
  constructor(readonly base: string, readonly adminToken = '', readonly f: F = fetch, readonly timeoutMs = 10_000) {}

  private async get<T>(path: string): Promise<{ status: number; body: T | null }> {
    const r = await this.f(this.base + path, { signal: AbortSignal.timeout(this.timeoutMs) });
    const body = r.ok ? ((await r.json()) as T) : null;
    return { status: r.status, body };
  }

  private async post<T>(path: string, data: unknown, auth = false): Promise<{ status: number; body: T | null }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth) headers.authorization = `Bearer ${this.adminToken}`;
    const r = await this.f(this.base + path, { method: 'POST', headers, body: JSON.stringify(data), signal: AbortSignal.timeout(this.timeoutMs) });
    let body: T | null = null;
    try {
      body = (await r.json()) as T;
    } catch {
      body = null;
    }
    return { status: r.status, body };
  }

  async state(): Promise<BellState> {
    const { status, body } = await this.get<Record<string, unknown>>('/state');
    if (!body) throw new Error(`bell /state answered ${status}`);
    return parseState(body);
  }

  /** All catalog rows, or null when the bell has no /markets route yet. */
  async markets(): Promise<MarketRow[] | null> {
    const { status, body } = await this.get<{ markets?: MarketRow[] }>('/markets');
    if (status === 404) return null;
    if (!body || !Array.isArray(body.markets)) throw new Error(`bell /markets answered ${status}`);
    return body.markets;
  }

  async market(symbol: string): Promise<MarketRow | null> {
    const { body } = await this.get<MarketRow>(`/markets/${encodeURIComponent(symbol)}`);
    return body && typeof body.symbol === 'string' ? body : null;
  }

  async warm(symbol: string, ttl = 30): Promise<boolean> {
    const { status, body } = await this.post<{ ok?: boolean }>(`/warm/${encodeURIComponent(symbol)}`, { ttl });
    return status === 200 && body?.ok !== false;
  }

  /** The last `n` 5-minute closes from /candles, falling back to the posted rounds of /prices. */
  async closes(symbol: string, n = 3): Promise<number[]> {
    const c = await this.get<{ candles?: { c: number }[] }>(`/candles/${encodeURIComponent(symbol)}?tf=5m&limit=${n}`).catch(() => null);
    if (c?.body?.candles?.length) return c.body.candles.slice(-n).map((x) => Number(x.c));
    const p = await this.get<{ rounds?: { price8: string }[] }>(`/prices/${encodeURIComponent(symbol)}`).catch(() => null);
    return (p?.body?.rounds ?? []).slice(-n).map((r) => Number(r.price8) / 1e8);
  }

  /**
   * Tickets of one owner, newest first (owner and status=open filters of 3.2). Rows of every status come back as the
   * bell sends them (an older bell ignores the status filter), so the caller can tell settled from not indexed.
   */
  async ownerTickets(owner: string): Promise<OpenTicket[]> {
    const { status, body } = await this.get<{ tickets?: OpenTicket[] }>(`/tickets?owner=${encodeURIComponent(owner)}&status=open&limit=500`);
    if (!body || !Array.isArray(body.tickets)) throw new Error(`bell /tickets answered ${status}`);
    return body.tickets;
  }

  async ticket(id: string): Promise<OpenTicket | null> {
    const { body } = await this.get<{ ticket?: OpenTicket }>(`/tickets/${encodeURIComponent(id)}`);
    return body?.ticket ?? null;
  }

  /** POST /admin/bots; returns the HTTP status (200 on success). */
  async registerBots(addresses: string[]): Promise<number> {
    if (!this.adminToken) return 0;
    const { status } = await this.post('/admin/bots', { addresses }, true);
    return status;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseState(s: Record<string, unknown>): BellState {
  const b = s.book as Record<string, unknown> | null | undefined;
  const ok = b && ['ticketBook', 'vault', 'reference', 'usdg'].every((k) => typeof b[k] === 'string' && isAddress(b[k] as string));
  const feed = s.feed as { core?: unknown; lastTickAt?: unknown } | undefined;
  const replay = s.replay as { lastTick?: { at?: unknown } | null } | undefined;
  const counts = s.counts as { bots?: unknown; open?: unknown } | undefined;
  const core = Array.isArray(feed?.core) ? (feed!.core as unknown[]).filter((x): x is string => typeof x === 'string').map((x) => x.toUpperCase()) : null;
  return {
    book: ok
      ? { ticketBook: b!.ticketBook as Address, vault: b!.vault as Address, reference: b!.reference as Address, usdg: b!.usdg as Address, startBlock: String(b!.startBlock ?? '') }
      : null,
    clockUnix: num(s.clockUnix),
    lastTickAt: num(feed?.lastTickAt) ?? num(replay?.lastTick?.at),
    core: core && core.length ? core : null,
    bots: num(counts?.bots),
    open: num(counts?.open),
  };
}

/** Tradable symbols of a /markets answer (tradable, else listed and covered). */
export function tradableSymbols(rows: MarketRow[]): string[] {
  return rows.filter((r) => (r.tradable ?? (r.listed && r.covered !== false)) === true).map((r) => r.symbol.toUpperCase());
}
