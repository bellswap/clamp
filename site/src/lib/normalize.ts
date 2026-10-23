// Normalisers of bell answers into the site's types (lib/types.ts). Tolerant of the two encodings a service may use:
// numbers in display units, or digit strings in raw units (USDG 6 decimals, prices 8 decimals under *8 keys).
import { horizonOf } from './horizon';
import { LEADER_MIN_STAKED } from './leaders';
import type { ActivityItem, ActivityKind, ActivityQuery, CatalogEntry, Leaderboard, LeaderRow, MarketRow, MarketsView, PriceRound, TicketStatus, TicketView, VaultPoint, VaultView } from './types';

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null;

export function usd(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v) / 1e6;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v) / 1e6;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

function price(o: Obj, key: string): number | null {
  const raw = o[`${key}8`];
  if (raw !== undefined && raw !== null) {
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw) / 1e8;
    if (typeof raw === 'number') return raw / 1e8;
    if (typeof raw === 'bigint') return Number(raw) / 1e8;
  }
  const v = o[key];
  return typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : null;
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : '');

/** The array of an answer that is either an array or an object holding one under `key`. */
export function list(x: unknown, key: string): unknown[] {
  if (Array.isArray(x)) return x;
  if (isObj(x) && Array.isArray(x[key])) return x[key] as unknown[];
  return [];
}

export function toCatalog(x: unknown): CatalogEntry[] {
  return list(x, 'entries').filter(isObj).map((o) => ({
    symbol: str(o.symbol).toUpperCase(),
    display: str(o.display) || `s${str(o.symbol)}`,
    name: str(o.name),
    sector: typeof o.sector === 'string' ? o.sector : null,
    marketCap: typeof o.marketCap === 'number' ? o.marketCap : null,
    lastPrice: typeof o.lastPrice === 'number' ? o.lastPrice : null,
    listedByRobinhood: o.listedByRobinhood === true,
    // Only the bell's /catalog knows which symbols have a market; the static fallback has no flag, so it stays off.
    onChain: o.onChain === true,
  })).filter((e) => e.symbol !== '');
}

export function toRounds(x: unknown): PriceRound[] {
  return list(x, 'rounds').filter(isObj).map((o) => ({ t: num(o.t ?? o.timestamp), price: price(o, 'price') ?? 0 })).filter((r) => r.price > 0).sort((a, b) => a.t - b.t);
}

function statusOf(o: Obj, stake: number, payout: number | null): TicketStatus {
  const s = o.status;
  if (s === 'won' || s === 'lost' || s === 'refunded' || s === 'open' || s === 'settling') return s;
  if (s === 2 || s === '2') return 'refunded';
  if (s === 1 || s === '1' || s === 'settled' || payout !== null) return (payout ?? 0) > stake ? 'won' : 'lost';
  return 'open';
}

export function toTicket(x: unknown): TicketView | null {
  const o = isObj(x) && isObj(x.ticket) ? x.ticket : x;
  if (!isObj(o)) return null;
  const stake = usd(o.stake);
  const payoutRaw = o.payout;
  const settled = o.status !== 0 && o.status !== '0' && o.status !== 'open';
  const payout = payoutRaw === undefined || payoutRaw === null || (!settled && usd(payoutRaw) === 0) ? null : usd(payoutRaw);
  const net = o.net !== undefined ? usd(o.net) : o.netStake !== undefined && o.netStake !== null ? usd(o.netStake) : o.reserved !== undefined && num(o.leverage, 1) > 0 ? usd(o.reserved) / num(o.leverage, 1) : stake;
  const settlePrice = price(o, 'settlePrice');
  return {
    id: str(o.id),
    owner: str(o.owner),
    symbol: str(o.symbol).replace(/\0+$/, '').toUpperCase(),
    long: o.long === true || o.side === 'long',
    leverage: num(o.leverage, 1),
    horizon: horizonOf(o.horizon),
    stake,
    net,
    entryPrice: price(o, 'entryPrice') ?? 0,
    openedAt: num(o.openedAt),
    expiry: num(o.expiry),
    status: statusOf(o, stake, payout),
    payout,
    settlePrice: settlePrice && settlePrice > 0 ? settlePrice : null,
    settledAt: o.settledAt === undefined || o.settledAt === null ? null : num(o.settledAt),
    ...(o.bot === true ? { bot: true } : {}),
  };
}

export function toTickets(x: unknown): TicketView[] {
  return list(x, 'tickets').map(toTicket).filter((t): t is TicketView => t !== null);
}

const KINDS: Record<string, ActivityKind> = { open: 'open', settle: 'settle', deposit: 'deposit', withdraw: 'withdraw', market: 'market', TicketOpened: 'open', TicketSettled: 'settle', Deposit: 'deposit', Withdraw: 'withdraw', MarketListed: 'market' };
const kindOf = (o: Obj): ActivityKind | null => KINDS[str(o.kind)] ?? KINDS[str(o.type)] ?? null;

/** Every kind the bell indexes: ticket opens and settlements, vault deposits and withdrawals, market listings.
 *  A deposit or withdraw carries its amount in `stake` (USDG); a market listing has no owner and no amount. */
export function toActivity(x: unknown): ActivityItem[] {
  return list(x, 'events').filter(isObj).filter((o) => kindOf(o) !== null).map((o) => {
    const amount = o.amountRaw ?? o.stakeRaw ?? o.stake ?? o.amount ?? o.assets;
    const item: ActivityItem = {
      kind: kindOf(o)!,
      id: str(o.id),
      owner: str(o.owner ?? o.address),
      symbol: str(o.symbol).replace(/\0+$/, '').toUpperCase(),
      long: o.long === true,
      leverage: num(o.leverage, 1),
      stake: usd(amount),
      payout: o.payout === undefined || o.payout === null ? null : usd(o.payoutRaw ?? o.payout),
      t: num(o.t ?? o.timestamp ?? o.at),
    };
    if (typeof o.seq === 'number' || (typeof o.seq === 'string' && /^\d+$/.test(o.seq))) item.seq = Number(o.seq);
    if (o.bot === true) item.bot = true;
    return item;
  });
}

export function toLeaders(x: unknown): LeaderRow[] {
  return list(x, 'rows').filter(isObj).map((o) => {
    const staked = o.stakedRaw !== undefined ? usd(o.stakedRaw) : usd(o.staked);
    const pnl = o.pnlRaw !== undefined ? usd(o.pnlRaw) : usd(o.pnl ?? o.netPnl);
    const row: LeaderRow = { address: str(o.address), settled: num(o.settled), wins: num(o.wins), staked, pnl, roiPct: o.roiPct !== undefined ? num(o.roiPct) : staked > 0 ? (pnl / staked) * 100 : 0, points: num(o.points) };
    if (o.bot === true) row.bot = true;
    return row;
  });
}

/** /leaderboard: the rows and the bell's ranking floor (minStakedRaw, 6 decimals), else the site's default. */
export function toLeaderboard(x: unknown): Leaderboard {
  const o = isObj(x) ? x : {};
  const min = o.minStakedRaw !== undefined && o.minStakedRaw !== null && o.minStakedRaw !== '' ? usd(o.minStakedRaw) : LEADER_MIN_STAKED;
  return { minStaked: Number.isFinite(min) && min >= 0 ? min : LEADER_MIN_STAKED, rows: toLeaders(x) };
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
/** A USDG amount under `key`Raw (raw 6-decimal string) or `key` (either encoding). */
const usdAt = (o: Obj, key: string): number => (o[`${key}Raw`] !== undefined && o[`${key}Raw`] !== null ? usd(o[`${key}Raw`]) : usd(o[key]));

export function toVault(x: unknown): VaultView {
  const o = isObj(x) ? x : {};
  const pnl = Array.isArray(o.pnl7d) ? (o.pnl7d as unknown[]).map(usd) : [];
  const assets = usdAt(o, 'assets');
  const reserved = usdAt(o, 'reserved');
  const history: VaultPoint[] = list(o.history, 'points').filter(isObj).map((h) => ({ t: num(h.t), assets: usdAt(h, 'assets'), reserved: usdAt(h, 'reserved'), sharePrice: num(h.sharePrice) })).filter((h) => h.t > 0).sort((a, b) => a.t - b.t);
  const util = numOrNull(o.utilization);
  return {
    assets,
    reserved,
    free: o.free !== undefined || o.freeRaw !== undefined ? usdAt(o, 'free') : assets - reserved,
    lpCount: num(o.lpCount),
    pnl7d: pnl,
    pnl7dTotal: o.pnl7dTotal !== undefined ? usd(o.pnl7dTotal) : pnl.length ? pnl[pnl.length - 1]! - pnl[0]! : 0,
    sharePrice: numOrNull(o.sharePrice),
    utilization: util !== null ? util : assets > 0 ? reserved / assets : null,
    history,
  };
}

function toMarketRow(o: Obj): MarketRow {
  const listed = o.listed === true;
  const covered = o.covered === true;
  const lr = isObj(o.lastRound) ? o.lastRound : null;
  const lrPrice = lr ? price(lr, 'price') : null;
  return {
    symbol: str(o.symbol).replace(/\0+$/, '').toUpperCase(),
    listed,
    covered,
    tradable: o.tradable === undefined ? listed && covered : o.tradable === true,
    hot: o.hot === true,
    price: numOrNull(o.price),
    prevClose: numOrNull(o.prevClose),
    chg: numOrNull(o.chg),
    sessionOpen: numOrNull(o.sessionOpen),
    sessionHigh: numOrNull(o.sessionHigh),
    sessionLow: numOrNull(o.sessionLow),
    spark: Array.isArray(o.spark) ? (o.spark as unknown[]).map((v) => numOrNull(v)).filter((v): v is number => v !== null) : [],
    openCount: num(o.openCount),
    oi: usdAt(o, 'oi'),
    longOpen: usdAt(o, 'longOpen'),
    shortOpen: usdAt(o, 'shortOpen'),
    oiCap: usdAt(o, 'oiCap'),
    maxStake: usdAt(o, 'maxStake'),
    maxLeverage: num(o.maxLeverage),
    volume24h: usdAt(o, 'volume24h'),
    lastRound: lr && lrPrice !== null && lrPrice > 0 ? { t: num(lr.t), price: lrPrice } : null,
  };
}

/** GET /markets: every catalog symbol with its playground price, session figures and open interest. */
export function toMarkets(x: unknown): MarketsView {
  const o = isObj(x) ? x : {};
  return {
    clockUnix: numOrNull(o.clockUnix),
    nextClose: numOrNull(o.nextClose),
    markets: list(x, 'markets').filter(isObj).map(toMarketRow).filter((m) => m.symbol !== ''),
  };
}

/** GET /markets/:symbol: one row plus the bell's wall ETAs to its expiries (etaWall), as of `atMs`; the other extra
 *  fields of the single route are read by the ticker page. */
export function toMarket(x: unknown, atMs = Date.now()): MarketRow | null {
  const o = isObj(x) && isObj(x.market) ? x.market : x;
  if (!isObj(o) || str(o.symbol) === '') return null;
  const exp = isObj(o.expiries) ? o.expiries : {};
  const w = isObj(o.etaWall) ? o.etaWall : {};
  const points = (['session', 'day', 'week'] as const).flatMap((k) => {
    const expiry = numOrNull(exp[k]);
    const wallS = numOrNull(w[k]);
    return expiry !== null && wallS !== null && wallS >= 0 ? [{ expiry, wallS }] : [];
  });
  return { ...toMarketRow(o), eta: points.length ? { atMs, points } : null };
}

/** Joins an older page (GET /activity?before=`before`) to the loaded rows while they still end at `before`; null when a
 *  poll replaced the list while the page was in flight, since the page no longer joins it. */
export function appendActivityPage(rows: readonly ActivityItem[], before: number, page: readonly ActivityItem[]): ActivityItem[] | null {
  const end = rows.length ? rows[rows.length - 1]!.seq : undefined;
  if (end !== before) return null;
  return [...rows, ...page.filter((x) => x.seq !== undefined && x.seq < before)];
}

/** Move since the session open in percent: price over sessionOpen, else the service's chg; null without either. */
export function moveSinceOpen(m: Pick<MarketRow, 'price' | 'sessionOpen' | 'chg'>): number | null {
  if (m.price !== null && m.sessionOpen !== null && m.sessionOpen > 0) return (m.price / m.sessionOpen - 1) * 100;
  return m.chg !== null ? m.chg * 100 : null;
}

export type MarketSort = 'active' | 'move' | 'name';
export const MARKET_SORTS: readonly MarketSort[] = ['active', 'move', 'name'];

/** Board order. Tradable rows always come before the rest (No price feed); inside each group:
 *  active = open tickets, then 24 h volume, then in the print set, then A to Z; move = absolute move since the
 *  open; name = A to Z. */
export function sortMarkets(rows: readonly MarketRow[], sort: MarketSort): MarketRow[] {
  const byName = (a: MarketRow, b: MarketRow) => a.symbol.localeCompare(b.symbol);
  const mv = (m: MarketRow) => {
    const v = moveSinceOpen(m);
    return v === null ? -1 : Math.abs(v);
  };
  const cmp: Record<MarketSort, (a: MarketRow, b: MarketRow) => number> = {
    active: (a, b) => b.openCount - a.openCount || b.volume24h - a.volume24h || Number(b.hot) - Number(a.hot) || byName(a, b),
    move: (a, b) => mv(b) - mv(a) || byName(a, b),
    name: byName,
  };
  return [...rows].sort((a, b) => Number(b.tradable) - Number(a.tradable) || cmp[sort](a, b));
}

/** Search over symbol and catalog name, case-insensitive. */
export function filterMarkets(rows: readonly MarketRow[], q: string, nameOf: (symbol: string) => string): MarketRow[] {
  const k = q.trim().toLowerCase();
  if (!k) return [...rows];
  return rows.filter((m) => m.symbol.toLowerCase().includes(k) || nameOf(m.symbol).toLowerCase().includes(k));
}

/** The query string of GET /activity: address, symbol, kind (comma list), limit, before. */
export function activityPath(q: ActivityQuery = {}): string {
  const p = new URLSearchParams();
  if (q.address) p.set('address', q.address);
  if (q.symbol) p.set('symbol', q.symbol);
  if (q.kinds?.length) p.set('kind', q.kinds.join(','));
  if (q.limit !== undefined) p.set('limit', String(Math.max(1, Math.min(500, Math.floor(q.limit)))));
  if (q.before !== undefined) p.set('before', String(q.before));
  const s = p.toString();
  return s ? `/activity?${s}` : '/activity';
}

/** Client-side filter with the same meaning as the bell's (an older bell ignores the query and sends everything). */
export function applyActivityQuery(items: ActivityItem[], q: ActivityQuery = {}): ActivityItem[] {
  const a = q.address?.toLowerCase();
  const s = q.symbol?.toUpperCase();
  const out = items.filter((i) => (!a || i.owner.toLowerCase() === a) && (!s || i.symbol === s) && (!q.kinds?.length || q.kinds.includes(i.kind)) && (q.before === undefined || i.seq === undefined || i.seq < q.before));
  return q.limit !== undefined ? out.slice(0, q.limit) : out;
}

/** The Activity list after a poll of the newest `page` events, while older pages are shown: the head replaces the rows
 *  it covers (seq at or above its oldest seq) and every row below it stays, so events that newer ones push out of the
 *  head remain between the head and the older pages. Null when the two cannot be joined: no seqs (an older bell), or a
 *  full head that does not reach the shown rows (more than a page of new events between two polls). */
export function mergeActivityHead(shown: ActivityItem[], head: ActivityItem[], page: number): ActivityItem[] | null {
  if (!head.length) return null;
  const tail = head[head.length - 1]!.seq;
  const top = shown[0]?.seq;
  if (tail === undefined || top === undefined) return null;
  if (head.length >= page && top < tail) return null;
  return [...head, ...shown.filter((x) => x.seq !== undefined && x.seq < tail)];
}

/** A complete 0x address (the bell filters /activity?address= by exact match). */
export const isFullAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);
