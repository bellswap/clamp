// The site's data access: the bell v2 service (docs/INTERFACES.md, Service) or, in mock mode, the fixture layer.
import { BELL_URL, MOCK } from '../config';
import * as mock from './mock';
import { activityPath, applyActivityQuery, toActivity, toCatalog, toLeaderboard, toMarket, toMarkets, toRounds, toTicket, toTickets, toVault } from './normalize';
import type { ActivityItem, ActivityQuery, BellState, CatalogEntry, Leaderboard, MarketRow, MarketsView, PriceRound, TicketView, VaultView } from './types';

export class BellError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'BellError';
  }
}

const READ_TIMEOUT_MS = 15_000;
/** The faucet sends two transactions on the fork, and a fresh address can wait on the upstream archive RPC first. */
const FAUCET_TIMEOUT_MS = 90_000;

async function bell<T = unknown>(path: string, init: RequestInit = {}, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BELL_URL.replace(/\/+$/, '')}${path}`, { ...init, signal: ctl.signal, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    const text = await r.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!r.ok) throw new BellError(r.status, (body as { error?: string } | null)?.error ?? `bell answered ${r.status}`);
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface Api {
  catalog(): Promise<CatalogEntry[]>;
  state(): Promise<BellState>;
  prices(symbol: string): Promise<PriceRound[]>;
  tickets(owner: string): Promise<TicketView[]>;
  /** The newest tickets of every owner (GET /tickets?limit=), for pages that show the fork's own activity. */
  recentTickets(limit?: number): Promise<TicketView[]>;
  ticket(id: string): Promise<TicketView | null>;
  activity(q?: ActivityQuery): Promise<ActivityItem[]>;
  leaderboard(): Promise<Leaderboard>;
  vault(): Promise<VaultView>;
  /** GET /markets: all catalog symbols, cached per tick by the bell. */
  markets(): Promise<MarketsView>;
  /** GET /markets/:symbol (marks the symbol warm); null when the bell does not know it. */
  market(symbol: string): Promise<MarketRow | null>;
  faucet(address: string): Promise<void>;
}

const live: Api = {
  async catalog() {
    try {
      const c = toCatalog(await bell('/catalog'));
      if (c.length) return c;
    } catch {
      /* fall back to the static copy */
    }
    return toCatalog(await (await fetch('/catalog.json')).json());
  },
  state: () => bell<BellState>('/state'),
  prices: async (s) => toRounds(await bell(`/prices/${encodeURIComponent(s)}`)),
  tickets: (o) => pagedTickets(async (before) => toTickets(await bell(`/tickets?owner=${encodeURIComponent(o)}&limit=${OWNER_PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}`))),
  recentTickets: async (limit = 12) => toTickets(await bell(`/tickets?limit=${limit}`)).slice(0, limit),
  ticket: async (id) => {
    try {
      return toTicket(await bell(`/tickets/${encodeURIComponent(id)}`));
    } catch (e) {
      if (e instanceof BellError && e.status === 404) return null;
      throw e;
    }
  },
  activity: async (q) => applyActivityQuery(toActivity(await bell(activityPath(q))), q),
  leaderboard: async () => toLeaderboard(await bell('/leaderboard')),
  vault: async () => toVault(await bell('/vault')),
  markets: async () => {
    try {
      return toMarkets(await bell('/markets'));
    } catch (e) {
      if (!(e instanceof BellError && e.status === 404)) throw e;
      return marketsFromCatalog(await live.catalog(), (s) => live.prices(s));
    }
  },
  market: async (s) => {
    try {
      return toMarket(await bell(`/markets/${encodeURIComponent(s)}`));
    } catch (e) {
      if (e instanceof BellError && e.status === 404) return null;
      throw e;
    }
  },
  faucet: async (address) => {
    await bell('/faucet', { method: 'POST', body: JSON.stringify({ address }) }, FAUCET_TIMEOUT_MS);
  },
};

/** Page size and page cap of an owner's tickets (GET /tickets defaults to 50 rows and allows 500 per request). */
export const OWNER_PAGE = 500;
const OWNER_PAGES = 20;

const idNum = (id: string): bigint => {
  try {
    return BigInt(id);
  } catch {
    return 0n;
  }
};

/** Every ticket of an owner, newest first: pages of `page` rows walked with before=<oldest id so far> until a short page.
 *  An older bell ignores limit and before and answers the same page again; no new ids end the walk. */
export async function pagedTickets(fetchPage: (before: string | null) => Promise<TicketView[]>, page = OWNER_PAGE, maxPages = OWNER_PAGES): Promise<TicketView[]> {
  const out: TicketView[] = [];
  const seen = new Set<string>();
  let before: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const rows = await fetchPage(before);
    let added = 0;
    for (const t of rows) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      added++;
    }
    if (rows.length < page || added === 0) break;
    before = rows.reduce((m, t) => (idNum(t.id) < idNum(m) ? t.id : m), rows[0]!.id);
  }
  return out;
}

/** A bell without GET /markets (older than the feed module): every catalog row, the listed ones priced from their last
 *  posted round (GET /prices/:symbol), the rest marked without a feed. No session figures, so no move and no spark. */
export async function marketsFromCatalog(catalog: CatalogEntry[], prices: (symbol: string) => Promise<PriceRound[]>): Promise<MarketsView> {
  const listed = catalog.filter((e) => e.onChain);
  const last = new Map<string, PriceRound>();
  await Promise.all(listed.map((e) => prices(e.symbol).then((r) => r.length && last.set(e.symbol, r[r.length - 1]!), () => undefined)));
  const markets: MarketRow[] = catalog.map((e) => {
    const r = last.get(e.symbol);
    return { symbol: e.symbol, listed: e.onChain, covered: !!r, tradable: e.onChain && !!r, hot: false, price: r?.price ?? null, prevClose: null, chg: null, sessionOpen: null, sessionHigh: null, sessionLow: null, spark: [], openCount: 0, oi: 0, longOpen: 0, shortOpen: 0, oiCap: 0, maxStake: 0, maxLeverage: 0, volume24h: 0, lastRound: r ? { t: r.t, price: r.price } : null };
  });
  return { clockUnix: null, nextClose: null, markets };
}

const fixtures: Api = {
  catalog: mock.mockCatalog,
  state: mock.mockState,
  prices: mock.mockPrices,
  tickets: mock.mockTickets,
  recentTickets: mock.mockRecentTickets,
  ticket: mock.mockTicket,
  activity: mock.mockActivity,
  leaderboard: mock.mockLeaderboard,
  vault: mock.mockVault,
  markets: mock.mockMarkets,
  market: mock.mockMarket,
  faucet: mock.mockFaucet,
};

export const api: Api = MOCK ? fixtures : live;
