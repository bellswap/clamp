// Mock mode (VITE_MOCK=1): fixture data for every bell route and every write, so the walkthrough runs without the VM.
// The playground clock starts at 20:00 UTC of the current day and runs at 60x, so a session ticket (expiry 21:00 UTC)
// settles after about a minute of wall time, as on the real playground. Prices are a deterministic function of the
// symbol and the playground time; the user's own tickets, balances and vault shares persist in localStorage (a
// per-viewer convenience; a blocked storage gives a fresh session on each load).
import type { ChartBulk, ChartRange, ChartSeries } from './charts-client';
import { expiryOf } from './horizon';
import { applyActivityQuery, toCatalog } from './normalize';
import { payoutAt, preview } from './payout';
import { LEADER_LIMIT, LEADER_MIN_STAKED, leaderOrder } from './leaders';
import type { ActivityItem, ActivityQuery, Balances, BellState, CatalogEntry, Leaderboard, LeaderRow, MarketRow, MarketsView, PriceRound, TicketView, VaultPoint, VaultView } from './types';

export const MOCK_SPEED = 60;
export const MOCK_FEE_BPS = 100;
const STORE_KEY = 'bellswap.v2.mock';
const VAULT_SEED = 250_000;

// ---------- deterministic randomness ----------
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const unit = (s: string) => fnv(s) / 4294967296;

// ---------- clock ----------
interface Persist {
  wall0: number;
  clock0: number;
  tickets: TicketView[];
  balances: Record<string, Balances>;
  shares: Record<string, number>;
  nextId: number;
}

function today20(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 20) / 1000;
}

function load(): Persist {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Persist;
      if (typeof p.wall0 === 'number' && Array.isArray(p.tickets)) return p;
    }
  } catch {
    /* storage blocked or malformed: start fresh */
  }
  return { wall0: Date.now(), clock0: today20(), tickets: [], balances: {}, shares: {}, nextId: 1000 };
}

let db: Persist | null = null;
function store(): Persist {
  if (!db) db = load();
  return db;
}
function save(): void {
  try {
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(store()));
  } catch {
    /* storage blocked */
  }
}

export function mockNow(): number {
  const s = store();
  return s.clock0 + ((Date.now() - s.wall0) / 1000) * MOCK_SPEED;
}

// ---------- catalog ----------
let catalogP: Promise<CatalogEntry[]> | null = null;
export function mockCatalog(): Promise<CatalogEntry[]> {
  catalogP ??= fetch('/catalog.json')
    .then((r) => r.json() as Promise<unknown>)
    .then((x) => toCatalog(x).map((e) => ({ ...e, onChain: true })));
  return catalogP;
}
const lastPrice = new Map<string, number>();
const sectorOf = new Map<string, string | null>();
async function ensurePrices(): Promise<void> {
  if (lastPrice.size) return;
  for (const e of await mockCatalog()) {
    lastPrice.set(e.symbol, e.lastPrice ?? 50 + unit(e.symbol) * 150);
    sectorOf.set(e.symbol, e.sector);
  }
}

// ---------- reference price during the session ----------
/** Log-move of the playground reference at time t (seconds since the clock start), per symbol. */
function wiggle(symbol: string, t: number): number {
  const u1 = unit(`${symbol}:a`);
  const u2 = unit(`${symbol}:b`);
  const vol = sectorOf.get(symbol) === 'Technology' ? 1.5 : 1;
  const drift = sectorOf.get(symbol) === 'Technology' ? -0.006 : (unit(`${symbol}:d`) - 0.5) * 0.008;
  const knot = 120;
  const k = Math.floor(t / knot);
  const f = t / knot - k;
  const n0 = unit(`${symbol}:n${k}`) - 0.5;
  const n1 = unit(`${symbol}:n${k + 1}`) - 0.5;
  const noise = (n0 + (n1 - n0) * f) * 0.004;
  return vol * (0.006 * Math.sin((2 * Math.PI * t) / 5400 + u1 * 6.28) + 0.003 * Math.sin((2 * Math.PI * t) / 1500 + u2 * 6.28) + noise + (drift * t) / 3600);
}

/** The playground reference of `symbol` at playground time `unix`. */
export function mockPrice(symbol: string, unix: number): number {
  const base = lastPrice.get(symbol) ?? 100;
  const t0 = store().clock0;
  return Math.round(base * Math.exp(wiggle(symbol, unix - t0) - wiggle(symbol, 0)) * 1e4) / 1e4;
}

export async function mockPrices(symbol: string): Promise<PriceRound[]> {
  await ensurePrices();
  const now = Math.floor(mockNow());
  const out: PriceRound[] = [];
  for (let i = 299; i >= 0; i--) {
    const t = now - i * 15;
    out.push({ t, price: mockPrice(symbol, t) });
  }
  return out;
}

// ---------- charts (history before the session) ----------
const RANGE_BARS: Record<ChartRange, { n: number; step: number; vol: number }> = {
  '1d': { n: 78, step: 300, vol: 0.0022 },
  '5d': { n: 130, step: 1800, vol: 0.004 },
  '1m': { n: 120, step: 5 * 3600, vol: 0.009 },
  '3m': { n: 120, step: 15 * 3600, vol: 0.014 },
  '1y': { n: 120, step: 60 * 3600, vol: 0.025 },
};

export async function mockCharts(range: ChartRange): Promise<ChartBulk> {
  await ensurePrices();
  const { n, step, vol } = RANGE_BARS[range];
  const end = store().clock0;
  const t = Array.from({ length: n }, (_, i) => end - (n - 1 - i) * step);
  const series: Record<string, ChartSeries> = {};
  for (const [symbol, last] of lastPrice) {
    const r = rng(fnv(`${symbol}:${range}`));
    const tech = sectorOf.get(symbol) === 'Technology';
    const bias = tech ? -(0.00015 + r() * 0.0007) * (range === '1d' ? 1 : 0.5) : (r() - 0.5) * 0.0005;
    const sv = vol * (0.6 + r() * 1.2) * (tech ? 1.3 : 1);
    // A shock at a random bar gives each line its own shape (a gap, a selloff or a bounce).
    const shockAt = Math.floor(r() * n);
    const shock = (r() - 0.55) * 6 * sv;
    const logs: number[] = [0];
    for (let i = 1; i < n; i++) logs.push(logs[i - 1]! + bias + (r() - 0.5) * 2 * sv + (i === shockAt ? shock : 0));
    const endLog = logs[n - 1]!;
    const p = logs.map((l) => Math.round(last * Math.exp(l - endLog) * 1e4) / 1e4);
    const gap = (r() - 0.5) * 0.01;
    const base = Math.round(p[0]! * (1 - gap) * 1e4) / 1e4;
    series[symbol] = { p, base, last, chg: last / base - 1, k: 1 };
  }
  return { asOf: end, fetchedAt: Math.floor(Date.now() / 1000), range, interval: step, source: 'recorded', delayMin: 0, stale: false, count: n, t, series, missing: [] };
}

// ---------- tickets ----------
// Owners: demo traders (the bell's bot registry, shown with the demo tag), LP bots, and a few people.
const HUMANS = ['0x9f3c1e0b5a7d2c44e1b8f02a6d9e3c7b10a4f502', '0x3b7e2a91c04d58f6e2a1b7c903d4e8f1a2b6c7d8', '0xc4a2e6f81b3d9057a6c2e4f8b1d3a5c7e9f0a1b2'];
function hexAddr(seed: string): string {
  const r = rng(fnv(seed));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += Math.floor(r() * 16).toString(16);
  return out;
}
const BOT_TRADERS = Array.from({ length: 16 }, (_, i) => hexAddr(`bot-trader-${i}`));
const BOT_LPS = Array.from({ length: 4 }, (_, i) => hexAddr(`bot-lp-${i}`));
const BOTS = new Set([...BOT_TRADERS, ...BOT_LPS]);
export function mockIsBot(address: string): boolean {
  return BOTS.has(address.toLowerCase());
}
/** The 14 markets of deployments/book.json; everything else covered is listed by the catalog listing. */
export const MOCK_CORE = ['RTX', 'NOC', 'CPER', 'SOXL', 'DRAM', 'GD', 'MARA', 'UUUU', 'SPY', 'QQQ', 'NVDA', 'MU', 'SNDK', 'TSLA'];
/** Symbols with no recorded series: shown as No price feed. */
export const MOCK_UNCOVERED = new Set(['SATS', 'XAG', 'XAU', 'INFQ', 'XNDU']);
const SEED_SYMBOLS = [...MOCK_CORE, 'AMD', 'AVGO', 'INTC', 'AAPL', 'MSFT', 'META', 'AMZN', 'SMCI', 'ARM', 'TSM', 'PLTR', 'COIN', 'UBER', 'NFLX'];
/** Start of the playground session (14:30 UTC of the clock's day) and its close (21:00 UTC). */
const sessionStart = () => store().clock0 - 5.5 * 3600;
const sessionClose = () => store().clock0 + 3600;

let seeded: TicketView[] | null = null;
function seedTickets(): TicketView[] {
  if (seeded) return seeded;
  const r = rng(42);
  const t0 = store().clock0;
  const out: TicketView[] = [];
  const symbols = SEED_SYMBOLS.filter((s) => lastPrice.has(s) && !MOCK_UNCOVERED.has(s));
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
  for (let i = 0; i < 120; i++) {
    const symbol = pick(symbols.length ? symbols : [...lastPrice.keys()].slice(0, 10));
    const owner = r() < 0.82 ? pick(BOT_TRADERS) : pick(HUMANS);
    const long = r() < (sectorOf.get(symbol) === 'Technology' ? 0.4 : 0.6);
    const leverage = pick([2, 2, 5, 5, 5, 10, 10, 20]);
    const stake = pick([5, 10, 20, 20, 50, 50, 100, 250]);
    const open = i < 26;
    // Open tickets: the last 2 h of the clock, a mix of today's close, 24 h and 7 d. Settled: the 30 h before that.
    const openedAt = open ? t0 - 240 * (i + 1) : t0 - 7200 - 900 * (i - 26);
    const horizon = open ? (i % 5 === 0 ? 2 : i % 3 === 0 ? 1 : 0) : i % 4 === 0 ? 0 : 1;
    const expiry = open ? (horizon === 0 ? sessionClose() : expiryOf(horizon, openedAt)) : openedAt + (horizon === 0 ? 1800 : 6300);
    const pv = preview(stake, leverage, MOCK_FEE_BPS);
    out.push({ id: String(i + 1), owner, symbol, long, leverage, horizon, stake, net: pv.net, entryPrice: mockPrice(symbol, openedAt), openedAt, expiry, status: 'open', payout: null, settlePrice: null, settledAt: null });
  }
  seeded = out;
  return out;
}

function settleDue(): void {
  const now = mockNow();
  let dirty = false;
  for (const tk of [...seedTickets(), ...store().tickets]) {
    if (tk.status !== 'open' || tk.expiry > now) continue;
    const price = mockPrice(tk.symbol, tk.expiry);
    tk.settlePrice = price;
    tk.payout = payoutAt(tk.net, tk.leverage, tk.entryPrice, price, tk.long);
    tk.settledAt = Math.min(now, tk.expiry + 15);
    tk.status = tk.payout > tk.stake ? 'won' : 'lost';
    const owner = tk.owner.toLowerCase();
    const b = store().balances[owner];
    if (b) {
      b.usdg += tk.payout;
      dirty = true;
    }
  }
  if (dirty) save();
}

const withBot = <T extends { bot?: boolean }>(x: T, owner: string): T => (mockIsBot(owner) ? { ...x, bot: true } : { ...x });

async function all(): Promise<TicketView[]> {
  await ensurePrices();
  settleDue();
  return [...seedTickets(), ...store().tickets];
}

export async function mockTickets(owner: string): Promise<TicketView[]> {
  const o = owner.toLowerCase();
  return (await all()).filter((t) => t.owner.toLowerCase() === o).sort((a, b) => b.openedAt - a.openedAt).map((t) => withBot(t, t.owner));
}

export async function mockRecentTickets(limit = 12): Promise<TicketView[]> {
  const now = mockNow();
  return (await all()).filter((t) => t.openedAt <= now).sort((a, b) => b.openedAt - a.openedAt).slice(0, limit).map((t) => withBot(t, t.owner));
}

export async function mockTicket(id: string): Promise<TicketView | null> {
  const t = (await all()).find((x) => x.id === id);
  return t ? withBot(t, t.owner) : null;
}

// ---------- vault and market events ----------
interface VaultEvent { kind: 'deposit' | 'withdraw'; owner: string; amount: number; t: number }
function seedVaultEvents(): VaultEvent[] {
  const t0 = store().clock0;
  const r = rng(11);
  const out: VaultEvent[] = [];
  BOT_LPS.forEach((lp, i) => out.push({ kind: 'deposit', owner: lp, amount: 25_000 + Math.round(r() * 125) * 1000, t: t0 - 30 * 3600 + i * 2400 }));
  out.push({ kind: 'deposit', owner: HUMANS[1]!, amount: 5000, t: t0 - 20 * 3600 });
  BOT_LPS.forEach((lp, i) => out.push({ kind: i % 2 ? 'withdraw' : 'deposit', owner: lp, amount: 1000 + Math.round(r() * 9) * 1000, t: t0 - 3 * 3600 + i * 1700 }));
  return out;
}
const userVaultEvents: VaultEvent[] = [];

function marketEvents(): ActivityItem[] {
  const t0 = store().clock0;
  const core = MOCK_CORE.filter((s) => lastPrice.has(s)).map((symbol, i) => ({ symbol, t: t0 - 3 * 86400 + i * 12 }));
  const tail = [...lastPrice.keys()].filter((s) => !MOCK_CORE.includes(s) && !MOCK_UNCOVERED.has(s)).slice(0, 6).map((symbol, i) => ({ symbol, t: t0 - 3600 + i * 4 }));
  return [...core, ...tail].map((m) => ({ kind: 'market', id: '', owner: '', symbol: m.symbol, long: false, leverage: 0, stake: 0, payout: null, t: m.t }));
}

export async function mockActivity(q: ActivityQuery = {}): Promise<ActivityItem[]> {
  const now = mockNow();
  const out: ActivityItem[] = [];
  for (const t of await all()) {
    if (t.openedAt <= now) out.push(withBot<ActivityItem>({ kind: 'open', id: t.id, owner: t.owner, symbol: t.symbol, long: t.long, leverage: t.leverage, stake: t.stake, payout: null, t: t.openedAt }, t.owner));
    if (t.settledAt !== null) out.push(withBot<ActivityItem>({ kind: 'settle', id: t.id, owner: t.owner, symbol: t.symbol, long: t.long, leverage: t.leverage, stake: t.stake, payout: t.payout, t: t.settledAt }, t.owner));
  }
  for (const v of [...seedVaultEvents(), ...userVaultEvents]) if (v.t <= now) out.push(withBot<ActivityItem>({ kind: v.kind, id: '', owner: v.owner, symbol: '', long: false, leverage: 0, stake: v.amount, payout: null, t: v.t }, v.owner));
  out.push(...marketEvents());
  out.sort((a, b) => b.t - a.t);
  const seqd = out.slice(0, 2000).map((x, i, arr) => ({ ...x, seq: arr.length - i }));
  return applyActivityQuery(seqd, { ...q, limit: q.limit ?? 200 });
}

// Same shape and order as the bell: ranked rows first (minimum before the cap), then the rest, at most 100 rows.
export async function mockLeaderboard(): Promise<Leaderboard> {
  const by = new Map<string, LeaderRow>();
  for (const t of await all()) {
    if (t.payout === null) continue;
    const row = by.get(t.owner) ?? { address: t.owner, settled: 0, wins: 0, staked: 0, pnl: 0, roiPct: 0, points: 0 };
    row.settled += 1;
    row.wins += t.status === 'won' ? 1 : 0;
    row.points = row.settled * 10 + row.wins * 25; // the bell's POINTS_PER_SETTLED and POINTS_PER_WIN
    row.staked += t.stake;
    row.pnl += t.payout - t.stake;
    by.set(t.owner, row);
  }
  for (const r of by.values()) {
    r.roiPct = r.staked > 0 ? (r.pnl / r.staked) * 100 : 0;
    if (mockIsBot(r.address)) r.bot = true;
  }
  return { minStaked: LEADER_MIN_STAKED, rows: leaderOrder([...by.values()], LEADER_MIN_STAKED).slice(0, LEADER_LIMIT) };
}

/** The demo LPs' net deposits up to `now`. The viewer's own deposits are counted once, through the stored shares
 *  (userVaultEvents only feed the activity rows). */
function lpTotal(now: number): number {
  let lp = 0;
  for (const v of seedVaultEvents()) if (v.t <= now) lp += v.kind === 'deposit' ? v.amount : -v.amount;
  return lp;
}

export async function mockVault(): Promise<VaultView> {
  const ts = await all();
  const now = mockNow();
  let pnl = 0;
  let reserved = 0;
  for (const t of ts) {
    pnl += t.stake - (t.payout ?? 0);
    if (t.status === 'open') {
      reserved += t.net * t.leverage;
      pnl -= t.stake;
    }
  }
  const lp = Object.values(store().shares).reduce((a, b) => a + b, 0);
  const assets = VAULT_SEED + lpTotal(now) + lp + pnl;
  // 7 days of house PnL: a seeded walk that ends at the realised PnL of the fixture tickets.
  const r = rng(7);
  const walk: number[] = [0];
  for (let i = 1; i < 28; i++) walk.push(walk[i - 1]! + (r() - 0.45) * 160);
  const end = walk[walk.length - 1]!;
  const series = walk.map((v, i) => v + ((pnl - end) * i) / (walk.length - 1));
  // One point per fork hour over the last 36 hours: deposits step the assets, the house PnL walks the share price.
  const history: VaultPoint[] = [];
  const h0 = Math.floor(now / 3600) * 3600;
  const supply = VAULT_SEED + lpTotal(now) + lp;
  for (let i = 35; i >= 0; i--) {
    const t = h0 - i * 3600;
    const k = (35 - i) / 35;
    const a = VAULT_SEED + lpTotal(t) + lp * k + pnl * k + Math.sin(i / 3) * 400;
    history.push({ t, assets: a, reserved: reserved * (0.4 + 0.6 * k), sharePrice: 1 + ((pnl * k) / Math.max(1, supply)) + Math.sin(i / 3) * 0.0015 });
  }
  const sharePrice = supply > 0 ? assets / supply : 1;
  const lps = new Set([...seedVaultEvents(), ...userVaultEvents].map((v) => v.owner.toLowerCase()));
  for (const a of Object.keys(store().shares)) lps.add(a);
  return { assets, reserved, free: assets - reserved, lpCount: lps.size, pnl7d: series, pnl7dTotal: series[series.length - 1]! - series[0]!, sharePrice, utilization: assets > 0 ? reserved / assets : 0, history };
}

export async function mockState(): Promise<BellState> {
  const ts = await all();
  const v = await mockVault();
  return {
    chainId: 46633,
    block: 1_000_000 + Math.floor((Date.now() - store().wall0) / 1000),
    clockUnix: mockNow(),
    speed: MOCK_SPEED,
    counts: { tickets: ts.length, open: ts.filter((t) => t.payout === null).length, settled: ts.filter((t) => t.payout !== null).length, addresses: new Set(ts.map((t) => t.owner)).size, markets: [...lastPrice.keys()].filter((s) => !MOCK_UNCOVERED.has(s)).length, lps: v.lpCount, bots: BOTS.size },
    nextClose: nextCloseAfter(mockNow()),
  };
}

/** Fork unix second of the next 21:00 UTC after `unix`. */
export function nextCloseAfter(unix: number): number {
  const d = new Date(unix * 1000);
  const c = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 21) / 1000;
  return c > unix ? c : c + 86400;
}

// ---------- markets ----------
const SPARK_POINTS = 80;
function marketRow(e: CatalogEntry, now: number, open: TicketView[], vol: Map<string, number>): MarketRow {
  const sym = e.symbol;
  const covered = !MOCK_UNCOVERED.has(sym);
  const core = MOCK_CORE.includes(sym);
  const mine = open.filter((t) => t.symbol === sym);
  const gross = (long: boolean) => mine.filter((t) => t.long === long).reduce((a, t) => a + t.stake, 0);
  if (!covered) {
    return { symbol: sym, listed: false, covered: false, tradable: false, hot: false, price: null, prevClose: null, chg: null, sessionOpen: null, sessionHigh: null, sessionLow: null, spark: [], openCount: 0, oi: 0, longOpen: 0, shortOpen: 0, oiCap: 0, maxStake: 0, maxLeverage: 0, volume24h: 0, lastRound: null };
  }
  const t0 = sessionStart();
  const end = Math.min(now, sessionClose());
  const spark: number[] = [];
  for (let i = 0; i < SPARK_POINTS; i++) spark.push(mockPrice(sym, t0 + ((end - t0) * i) / (SPARK_POINTS - 1)));
  const price = mockPrice(sym, now);
  const sessionOpen = spark[0]!;
  const prevClose = mockPrice(sym, t0 - 17.5 * 3600);
  return {
    symbol: sym,
    listed: true,
    covered: true,
    tradable: true,
    hot: core || mine.length > 0,
    price,
    prevClose,
    chg: prevClose > 0 ? price / prevClose - 1 : null,
    sessionOpen,
    sessionHigh: Math.max(...spark, price),
    sessionLow: Math.min(...spark, price),
    spark,
    openCount: mine.length,
    oi: gross(true) + gross(false),
    longOpen: gross(true),
    shortOpen: gross(false),
    oiCap: core ? 50_000 : 20_000,
    maxStake: 1000,
    maxLeverage: 20,
    volume24h: vol.get(sym) ?? 0,
    lastRound: { t: Math.floor(now), price },
  };
}

export async function mockMarkets(): Promise<MarketsView> {
  const ts = await all();
  const now = mockNow();
  const open = ts.filter((t) => t.payout === null);
  const vol = new Map<string, number>();
  for (const t of ts) if (t.openedAt > now - 86400 && t.openedAt <= now) vol.set(t.symbol, (vol.get(t.symbol) ?? 0) + t.stake);
  const catalog = await mockCatalog();
  return { clockUnix: now, nextClose: nextCloseAfter(now), markets: catalog.map((e) => marketRow(e, now, open, vol)) };
}

export async function mockMarket(symbol: string): Promise<MarketRow | null> {
  const s = symbol.toUpperCase();
  const m = (await mockMarkets()).markets.find((x) => x.symbol === s);
  return m ?? null;
}

// ---------- wallet writes ----------
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function mockBalances(address: string): Balances {
  return { ...(store().balances[address.toLowerCase()] ?? { usdg: 0, eth: 0 }) };
}

export async function mockFaucet(address: string): Promise<void> {
  await wait(500);
  const k = address.toLowerCase();
  const b = store().balances[k] ?? { usdg: 0, eth: 0 };
  b.usdg += 1000;
  b.eth += 1;
  store().balances[k] = b;
  save();
}

export async function mockApprove(): Promise<void> {
  await wait(450);
}

export async function mockOpen(p: { owner: string; symbol: string; long: boolean; leverage: number; stake: number; horizon: number }): Promise<string> {
  await ensurePrices();
  await wait(650);
  const s = store();
  const k = p.owner.toLowerCase();
  const b = s.balances[k] ?? { usdg: 0, eth: 0 };
  if (b.usdg < p.stake) throw new Error('insufficient USDG');
  b.usdg -= p.stake;
  s.balances[k] = b;
  const now = mockNow();
  const id = String(s.nextId++);
  const pv = preview(p.stake, p.leverage, MOCK_FEE_BPS);
  s.tickets.push({ id, owner: p.owner, symbol: p.symbol, long: p.long, leverage: p.leverage, horizon: p.horizon, stake: p.stake, net: pv.net, entryPrice: mockPrice(p.symbol, now), openedAt: Math.floor(now), expiry: expiryOf(p.horizon, Math.floor(now)), status: 'open', payout: null, settlePrice: null, settledAt: null });
  save();
  return id;
}

export function mockShare(address: string): number {
  return store().shares[address.toLowerCase()] ?? 0;
}

export async function mockVaultMove(address: string, amount: number, deposit: boolean): Promise<void> {
  await wait(600);
  const s = store();
  const k = address.toLowerCase();
  const b = s.balances[k] ?? { usdg: 0, eth: 0 };
  const sh = s.shares[k] ?? 0;
  if (deposit ? b.usdg < amount : sh < amount) throw new Error('insufficient balance');
  b.usdg += deposit ? -amount : amount;
  s.balances[k] = b;
  s.shares[k] = sh + (deposit ? amount : -amount);
  userVaultEvents.push({ kind: deposit ? 'deposit' : 'withdraw', owner: address, amount, t: Math.floor(mockNow()) });
  save();
}
