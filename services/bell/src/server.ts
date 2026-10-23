// HTTP routes (docs/INTERFACES.md, Service). CORS: GET answers carry the caller's origin when it is a site origin
// (BELL_ORIGINS or a Pages preview suffix) and * otherwise; POST from a browser is accepted only from a site origin
// (calls without an Origin header, i.e. curl, are accepted). Admin routes need Authorization: Bearer <token>.
// Units: USDG as raw 6-decimal integer strings (Raw suffix on new fields), prices as numbers, times as fork unix
// seconds. No request scans all tickets: lists walk the ticket index (src/api/ticket-index.ts) and the aggregates
// (/state, /leaderboard, /markets, /vault) are memoized per indexed block, per feed tick and per clock second.
import { timingSafeEqual } from 'node:crypto';
import { isAddress, type Address } from 'viem';
import { abis } from './abi';
import { feedOf, hasFeed, nextCloseAfter } from './api/feed';
import { expiriesAt, isFresh, lastRoundOf, marketRow, type MarketRow } from './api/markets';
import { indexOf } from './api/ticket-index';
import { pnl7d, sharePriceOf, vaultHistory, vaultSync } from './api/vault';
import type { App } from './app';
import type { Env } from './config';
import type { Feed, Tf } from './feed/types';
import { faucet, HttpError } from './faucet';
import { DAY_S, feeOf, leaderboard, leaderRows, LEADER_MIN_STAKED_RAW, payoutOf, rankByRoi, reserveOf, toPrice8, type LeaderRow } from './math';
import type { ActivityRec, TicketRec } from './store';

export function originAllowed(env: Pick<Env, 'origins' | 'originSuffixes'>, origin: string | null): boolean {
  if (!origin) return false;
  if (env.origins.includes(origin)) return true;
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' && env.originSuffixes.some((s) => u.hostname.endsWith(s));
  } catch {
    return false;
  }
}

function corsHeaders(env: Env, req: Request): Record<string, string> {
  const o = req.headers.get('origin');
  const ok = originAllowed(env, o);
  return {
    'access-control-allow-origin': ok ? o! : '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

/** Adds the CORS headers to a route's own Response; Vary is merged (chart answers vary by Accept-Encoding too). */
export function withCors(out: Response, cors: Record<string, string>): Response {
  for (const [k, v] of Object.entries(cors)) {
    if (k.toLowerCase() !== 'vary') {
      out.headers.set(k, v);
      continue;
    }
    const seen = new Map<string, string>();
    for (const x of `${out.headers.get('vary') ?? ''},${v}`.split(',')) {
      const t = x.trim();
      if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    }
    out.headers.set('vary', [...seen.values()].join(', '));
  }
  return out;
}

const replacer = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, replacer), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

/** Client key: the right-most X-Forwarded-For entry (appended by Caddy in front of the service), else the peer. */
export function clientKey(req: Request, peer: string | null): string {
  const xff = (req.headers.get('x-forwarded-for') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1]! : peer || 'local';
}

function requireAdmin(app: App, req: Request): void {
  const t = app.env.adminToken;
  if (!t) throw new HttpError(403, 'admin routes are disabled (BELL_ADMIN_TOKEN unset)');
  const got = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got);
  const b = Buffer.from(t);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'bad admin token');
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'body is not JSON');
  }
}

/** One cached value per key (the key names everything the value depends on). */
class Memo<T> {
  private key: string | null = null;
  private value: T | undefined;
  get(key: string, f: () => T): T {
    if (key !== this.key) {
      this.value = f();
      this.key = key;
    }
    return this.value as T;
  }
}

const IDS = new WeakMap<object, number>();
let idSeq = 0;
/** A small id per object identity (the feed rebuilds nowAll once per tick). */
function idOf(o: object): number {
  let n = IDS.get(o);
  if (n === undefined) IDS.set(o, (n = ++idSeq));
  return n;
}

const TFS: readonly Tf[] = ['5m', '15m', '1h', '4h', '1d'];
const KINDS: readonly ActivityRec['kind'][] = ['open', 'settle', 'deposit', 'withdraw', 'market'];
export const BOTS_MAX = 1_000;

function intParam(url: URL, name: string, def: number | null, min: number, max: number): number | null {
  const v = url.searchParams.get(name);
  if (v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be an integer from ${min} to ${max}`);
  return n;
}

function symbolParam(raw: string): string {
  try {
    return decodeURIComponent(raw).toUpperCase();
  } catch {
    throw new HttpError(400, 'bad symbol encoding');
  }
}

async function safeClock(app: App): Promise<{ clock: number | null; block: number | null; error?: string }> {
  try {
    return await app.clock();
  } catch (e) {
    return { clock: null, block: null, error: (e as Error).message.split('\n')[0] };
  }
}

type Route = { method: 'GET' | 'POST'; re: RegExp; keys: string[]; h: (req: Request, p: Record<string, string>, url: URL, ip: string) => Promise<Response | unknown> };

export function handler(app: App) {
  const routes: Route[] = [];
  const add = (method: Route['method'], path: string, h: Route['h']) => {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    routes.push({ method, re, keys, h });
  };
  const d = () => app.store.data;
  const ix = () => indexOf(d());
  let lastClock: number | null = null;
  const feed = (): Feed => feedOf(app, () => lastClock ?? Math.floor(Date.now() / 1000));
  const clock = async () => {
    const c = await safeClock(app);
    if (c.clock !== null) lastClock = c.clock;
    return c;
  };
  const nextClose = (c: number | null): number => (hasFeed(app) || c === null ? feed().nextClose() : nextCloseAfter(c));

  let botsMemo: { ref: string[]; n: number; set: Set<string> } | null = null;
  const bots = (): Set<string> => {
    const b = d().bots ?? [];
    if (!botsMemo || botsMemo.ref !== b || botsMemo.n !== b.length) botsMemo = { ref: b, n: b.length, set: new Set(b) };
    return botsMemo.set;
  };
  const botsKey = () => `${idOf(d().bots ?? [])}.${(d().bots ?? []).length}`;

  /** Implicit warm (GET /markets/:symbol, /candles/:symbol, /prices/:symbol): the answer never depends on it. */
  const warmQuietly = (sym: string, ip: string) => {
    try {
      feed().warm(sym, ip);
    } catch (e) {
      console.log(`[bell] warm ${sym} failed: ${(e as Error).message.split('\n')[0]}`);
    }
  };
  const known = (sym: string) => app.catalogBySymbol.has(sym) || !!d().markets[sym];
  /** Fee in force: the latest indexed FeeSet (follows setFee), else the one-time on-chain read or the env fallback. */
  const feeNow = async (): Promise<bigint> => {
    const f = d().feeBps;
    return f !== null && f !== undefined ? BigInt(f) : app.feeBps();
  };

  async function ticketView(t: TicketRec, clockNow: number, f: Feed, botSet: Set<string>) {
    // The net stake booked at open (fee in force at the open block); state from before netStake falls back to the
    // current fee.
    const net = t.netStake !== undefined ? BigInt(t.netStake) : BigInt(t.stake) - feeOf(BigInt(t.stake), await feeNow());
    const fee = BigInt(t.stake) - net;
    const ref = lastRoundOf(d(), t.symbol);
    const entry = BigInt(t.entryPrice8);
    // Priced at the playground price the next print carries (prints are demand driven, so the last on-chain round
    // can be old); the last round when the feed has no price for the symbol.
    let mark: bigint | null = null;
    if (t.status === 'open') {
      const p = f.now(t.symbol)?.price;
      mark = p !== null && p !== undefined && Number.isFinite(p) && p > 0 ? toPrice8(p) : ref ? BigInt(ref.price8) : null;
    }
    const current = mark !== null && entry > 0n ? payoutOf(net, t.long, t.leverage, entry, mark) : null;
    return {
      ...t,
      fee: fee.toString(),
      netStake: net.toString(),
      horizon: t.horizon ?? null,
      maxPayout: reserveOf(net, t.leverage).toString(),
      reference: ref ? { price8: ref.price8, t: ref.t } : null,
      currentPayout: current?.toString() ?? null,
      secondsLeft: t.status === 'open' ? Math.max(0, t.expiry - clockNow) : 0,
      win: t.status === 'settled' ? BigInt(t.payout ?? '0') > BigInt(t.stake) : null,
      bot: botSet.has(t.owner),
    };
  }

  add('GET', '/', async () => ({ service: 'bell v2', routes: ['/state', '/catalog', '/charts/:range', '/prices/:symbol', '/markets', '/markets/:symbol', '/candles/:symbol?tf=&limit=&before=', 'POST /warm/:symbol', '/replay/coverage', 'POST /faucet', '/tickets?owner=&symbol=&status=&limit=&before=', '/tickets/:id', '/activity?address=&symbol=&kind=&limit=&before=', '/leaderboard?period=all|day', '/vault', 'POST /replay', 'POST /admin/bots'] }));
  add('GET', '/health', async () => ({ ok: true }));

  const stateMemo = new Memo<Record<string, unknown>>();
  add('GET', '/state', async () => {
    const c = await clock();
    const i = ix();
    const f = feed();
    const st = f.status();
    const key = [d().lastBlock, i.version, c.clock, c.block, c.error ?? '', app.lastTick?.at ?? 0, app.speed, app.replayPaused, d().replay.range ?? '', app.replay.cursor, st.lastTickAt, st.core.join(','), st.warm.join(','), botsKey(), app.book?.book ?? ''].join('|');
    return stateMemo.get(key, () => {
      const s = app.replaySeries();
      return {
        chainId: app.env.chainId,
        block: c.block,
        clockUnix: c.clock,
        speed: app.speed,
        counts: {
          tickets: i.count,
          open: i.open.size,
          settled: i.settledCount,
          addresses: i.owners,
          markets: Object.keys(d().markets).length,
          lps: Object.keys(d().lpShares).length,
          bots: (d().bots ?? []).length,
        },
        book: app.book ? { ticketBook: app.book.book, vault: app.book.vault, reference: app.book.reference, usdg: app.usdg(), startBlock: app.book.startBlock.toString() } : null,
        replay: { running: app.env.replay && !app.replayPaused, range: app.replayRange(), cursor: app.replay.cursor, bars: s?.t.length ?? 0, bar: s?.bar ?? null, source: s?.source ?? null, lastTick: app.lastTick },
        indexedBlock: d().lastBlock,
        nextClose: nextClose(c.clock),
        feed: st,
        ...(c.error ? { error: c.error } : {}),
      };
    });
  });

  add('GET', '/catalog', async () => {
    const listed = d().markets;
    return app.catalog.map((e) => ({ ...e, onChain: !!listed[e.symbol.toUpperCase()] }));
  });

  add('GET', '/charts/:range', async (req, p) => app.charts.respond(req, p.range!));
  add('GET', '/charts/:range/:symbol', async (_req, p) => app.charts.respondOne(p.range!, p.symbol!));

  add('GET', '/prices/:symbol', async (_req, p, _u, ip) => {
    const s = symbolParam(p.symbol!);
    if (!known(s)) throw new HttpError(404, 'unknown symbol');
    warmQuietly(s, ip);
    return { symbol: s, rounds: d().rounds[s] ?? [] };
  });

  // ------------------------------------------------------------ markets, candles, warm
  const marketsMemo = new Memo<{ clockUnix: number | null; nextClose: number; markets: MarketRow[] }>();
  const symbolsMemo = new Memo<string[]>();
  const allSymbols = () =>
    symbolsMemo.get(`${app.catalog.length}|${d().lastBlock}|${idOf(d().markets)}`, () => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const e of app.catalog) {
        const s = e.symbol.toUpperCase();
        if (!seen.has(s)) (seen.add(s), out.push(s));
      }
      for (const s of Object.keys(d().markets)) if (!seen.has(s)) (seen.add(s), out.push(s));
      return out;
    });
  const hotSet = (f: Feed) => {
    const st = f.status();
    return new Set([...st.core, ...st.warm]);
  };

  add('GET', '/markets', async () => {
    const c = await clock();
    const f = feed();
    const i = ix();
    const all = f.nowAll();
    const st = f.status();
    // The warm set is in the key: a warm call between ticks changes the hot flags.
    const key = [d().lastBlock, i.version, idOf(all), st.lastTickAt, st.core.join(','), st.warm.join(','), c.clock].join('|');
    return marketsMemo.get(key, () => {
      const hot = hotSet(f);
      return { clockUnix: c.clock, nextClose: nextClose(c.clock), markets: allSymbols().map((s) => marketRow(d(), i, s, all.get(s) ?? null, c.clock, hot)) };
    });
  });

  add('GET', '/markets/:symbol', async (_req, p, _u, ip) => {
    const s = symbolParam(p.symbol!);
    if (!known(s)) throw new HttpError(404, 'unknown symbol');
    warmQuietly(s, ip);
    const c = await clock();
    const f = feed();
    const i = ix();
    const row = marketRow(d(), i, s, f.now(s), c.clock, hotSet(f));
    const m = d().markets[s];
    const exp = c.clock !== null ? expiriesAt(c.clock) : null;
    return {
      ...row,
      exposureRaw: (i.bySymbol.get(s)?.exposure ?? 0n).toString(),
      feeBps: Number(await feeNow()),
      maxStaleness: m?.maxStaleness ?? 0,
      fresh: isFresh(row.lastRound, c.clock),
      clockUnix: c.clock,
      expiries: exp,
      etaWall: exp ? { session: f.etaWall(exp.session), day: f.etaWall(exp.day), week: f.etaWall(exp.week) } : null,
    };
  });

  add('GET', '/candles/:symbol', async (_req, p, url, ip) => {
    const s = symbolParam(p.symbol!);
    if (!known(s)) throw new HttpError(404, 'unknown symbol');
    const tf = (url.searchParams.get('tf') ?? '5m') as Tf;
    if (!TFS.includes(tf)) throw new HttpError(400, `tf must be one of ${TFS.join(', ')}`);
    const limit = intParam(url, 'limit', 300, 1, 1000)!;
    const before = intParam(url, 'before', null, 0, Number.MAX_SAFE_INTEGER);
    warmQuietly(s, ip);
    const c = await clock();
    return { symbol: s, tf, clockUnix: c.clock, source: 'replay', candles: feed().candles(s, tf, limit, before ?? undefined) };
  });

  add('POST', '/warm/:symbol', async (req, p, _u, ip) => {
    const s = symbolParam(p.symbol!);
    if (!known(s)) throw new HttpError(404, 'unknown symbol');
    const b = await body(req);
    let ttl: number | undefined;
    if (b.ttl !== undefined) {
      ttl = Number(b.ttl);
      if (!Number.isFinite(ttl) || ttl <= 0) throw new HttpError(400, 'ttl must be a positive number of seconds');
    }
    const r = feed().warm(s, ip, ttl);
    if (r.ok) return { ok: true, symbol: s, warmUntil: r.warmUntil ?? null };
    if (r.reason === 'rate') throw new HttpError(429, 'too many warm requests from this network', { symbol: s, reason: r.reason });
    if (r.reason === 'full') throw new HttpError(503, 'the warm set is full, try again shortly', { symbol: s, reason: r.reason });
    throw new HttpError(404, r.reason === 'not-listed' ? 'market not listed' : 'no price feed for this symbol', { symbol: s, reason: r.reason ?? 'no-series' });
  });

  add('GET', '/replay/coverage', async () => feed().coverage());

  add('POST', '/faucet', async (req, _p, _u, ip) => {
    const b = await body(req);
    return faucet({ chain: app.chain, limiter: app.limiter, enabled: app.env.faucet, ethWei: app.env.faucetEthWei, usdgRaw: app.env.faucetUsdgRaw, usdg: () => app.usdg(), spender: () => app.book?.book ?? null, save: () => app.store.save(true) }, b.address, ip);
  });

  // ------------------------------------------------------------ tickets, activity, leaderboard
  add('GET', '/tickets', async (_req, _p, url) => {
    const owner = url.searchParams.get('owner');
    if (owner !== null && !isAddress(owner)) throw new HttpError(400, 'owner must be an address');
    const symbol = url.searchParams.get('symbol');
    const status = url.searchParams.get('status');
    if (status !== null && status !== '' && status !== 'open' && status !== 'settled') throw new HttpError(400, 'status must be open or settled');
    const limit = intParam(url, 'limit', 50, 1, 500)!;
    const before = intParam(url, 'before', null, 0, Number.MAX_SAFE_INTEGER);
    const c = await clock();
    const f = feed();
    const botSet = bots();
    const list = ix().query({ owner, symbol: symbol ? symbol.toUpperCase() : null, status: (status || null) as 'open' | 'settled' | null, before, limit });
    return { clockUnix: c.clock, tickets: await Promise.all(list.map((t) => ticketView(t, c.clock ?? 0, f, botSet))) };
  });

  add('GET', '/tickets/:id', async (_req, p) => {
    const t = d().tickets[p.id!];
    if (!t) throw new HttpError(404, 'unknown ticket');
    const c = await clock();
    return { clockUnix: c.clock, ticket: await ticketView(t, c.clock ?? 0, feed(), bots()) };
  });

  add('GET', '/activity', async (_req, _p, url) => {
    const a = url.searchParams.get('address')?.toLowerCase() || null;
    const sym = url.searchParams.get('symbol')?.toUpperCase() || null;
    const kindsRaw = url.searchParams.get('kind');
    let kinds: Set<string> | null = null;
    if (kindsRaw) {
      kinds = new Set(kindsRaw.split(',').map((k) => k.trim()).filter(Boolean));
      for (const k of kinds) if (!KINDS.includes(k as ActivityRec['kind'])) throw new HttpError(400, `kind must be a list of ${KINDS.join(', ')}`);
    }
    const limit = intParam(url, 'limit', 200, 1, 500)!;
    const before = intParam(url, 'before', null, 0, Number.MAX_SAFE_INTEGER);
    const botSet = bots();
    const rows = d().activity;
    const events: (ActivityRec & { bot: boolean })[] = [];
    for (let i = rows.length - 1; i >= 0 && events.length < limit; i--) {
      const x = rows[i]!;
      if (before !== null && (x.seq ?? 0) >= before) continue;
      if (a && x.address !== a) continue;
      if (sym && x.symbol !== sym) continue;
      if (kinds && !kinds.has(x.kind)) continue;
      events.push({ ...x, bot: !!x.address && botSet.has(x.address) });
    }
    return { events };
  });

  const leadersAll = new Memo<LeaderRow[]>();
  const leadersDay = new Memo<LeaderRow[]>();
  add('GET', '/leaderboard', async (_req, _p, url) => {
    const period = url.searchParams.get('period') || 'all';
    if (period !== 'all' && period !== 'day') throw new HttpError(400, 'period must be all or day');
    const i = ix();
    let rows: LeaderRow[];
    if (period === 'all') rows = leadersAll.get(`${i.version}`, () => rankByRoi(leaderRows(i.byOwner), LEADER_MIN_STAKED_RAW).slice(0, 100));
    else {
      const c = await clock();
      const now = c.clock ?? lastClock ?? Math.floor(Date.now() / 1000);
      rows = leadersDay.get(`${i.version}|${now}`, () => {
        const settled = i.settledSince(now - DAY_S).map((t) => ({ owner: t.owner, stake: BigInt(t.stake), payout: BigInt(t.payout ?? '0') }));
        return rankByRoi(leaderboard(settled), LEADER_MIN_STAKED_RAW).slice(0, 100);
      });
    }
    const botSet = bots();
    return { minStakedRaw: LEADER_MIN_STAKED_RAW.toString(), period, rows: rows.map((r) => ({ ...r, bot: botSet.has(r.address) })) };
  });

  // ------------------------------------------------------------ vault
  let vaultReads: { key: string; at: number; v: Promise<(string | null)[]> } | null = null;
  /** The four vault reads pinned to one block, so assets and supply come from the same state: the indexed block when
   *  the node still has its state (then the indexed totals are synced with them, see vaultSync), else the head (the
   *  clock's block, or one block number read for this; without either no read is made). */
  const readVault = async (v: Address, c: { clock: number | null; block: number | null }): Promise<(string | null)[]> => {
    const read = async (fn: string, bn: bigint): Promise<string | null> => {
      try {
        return ((await app.chain.pub.readContract({ address: v, abi: abis.vault, functionName: fn as never, blockNumber: bn })) as bigint).toString();
      } catch {
        return null;
      }
    };
    const all = (bn: bigint) => Promise.all(['totalAssets', 'reserved', 'free', 'totalSupply'].map((fn) => read(fn, bn)));
    const indexed = d().lastBlock;
    const indexedHash = d().lastHash ?? null;
    if (indexed >= 0) {
      const out = await all(BigInt(indexed));
      if (out.every((x) => x !== null)) {
        let at: number | null = indexed === c.block ? c.clock : null;
        if (at === null) {
          try {
            at = Number((await app.chain.pub.getBlock({ blockNumber: BigInt(indexed) })).timestamp);
          } catch {
            at = null;
          }
        }
        // The index may have moved on, or been reset and rebuilt on another branch to the same height, while the reads
        // were in flight: the stored hash of the indexed block tells the branches apart.
        if (at !== null && d().lastBlock === indexed && (d().lastHash ?? null) === indexedHash && vaultSync(d(), at, { assets: BigInt(out[0]!), supply: BigInt(out[3]!), reserved: BigInt(out[1]!) })) app.store.touch();
        return out;
      }
    }
    // Never four unpinned reads: a deposit between them would mix blocks (assets before it, supply after it).
    let headBn: bigint | null = c.block !== null ? BigInt(c.block) : null;
    if (headBn === null) {
      try {
        headBn = await app.chain.pub.getBlockNumber();
      } catch {
        headBn = null;
      }
    }
    return headBn !== null ? all(headBn) : [null, null, null, null];
  };
  add('GET', '/vault', async () => {
    const v = app.book?.vault;
    if (!v) return { deployed: false };
    const c = await clock();
    // Chain reads once per indexed block (at most every 2 s).
    const key = `${v}|${d().lastBlock}`;
    if (!vaultReads || vaultReads.key !== key || Date.now() - vaultReads.at > 2000) vaultReads = { key, at: Date.now(), v: readVault(v as Address, c) };
    const [assets, reserved, free, shares] = await vaultReads.v;
    const now = c.clock ?? lastClock ?? Math.floor(Date.now() / 1000);
    const A = assets !== null ? BigInt(assets) : null;
    return {
      deployed: true,
      address: v,
      assets,
      reserved,
      free,
      shares,
      lpCount: Object.keys(d().lpShares).length,
      sharePrice: A !== null && shares !== null ? sharePriceOf(A, BigInt(shares)) : null,
      utilization: A !== null && A > 0n && reserved !== null ? Number((BigInt(reserved) * 1_000_000n) / A) / 1_000_000 : 0,
      pnl7d: pnl7d(d(), now),
      history: vaultHistory(d()),
    };
  });

  // ------------------------------------------------------------ admin
  add('POST', '/replay', async (req) => {
    requireAdmin(app, req);
    const b = await body(req);
    if (b.speed !== undefined) {
      const s = Number(b.speed);
      if (!Number.isFinite(s) || s < 1 || s > 600) throw new HttpError(400, 'speed must be 1 to 600 bars per wall minute');
      app.speed = s;
      d().replay.speed = s;
    }
    if (b.range !== undefined) {
      if (b.range !== '5d' && b.range !== '1d') throw new HttpError(400, 'range must be 5d or 1d');
      d().replay.range = b.range;
    }
    if (b.cursor !== undefined) app.replay.cursor = Math.max(0, Math.floor(Number(b.cursor) || 0));
    if (b.paused !== undefined) app.replayPaused = Boolean(b.paused);
    app.store.save(true);
    return { speed: app.speed, range: app.replayRange(), cursor: app.replay.cursor, paused: app.replayPaused };
  });

  /** POST /admin/bots {addresses, replace?}: registers demo bot addresses (merged unless replace is true); the bot
   *  flag on tickets, activity and leaderboard rows is computed from this list at read time. */
  add('POST', '/admin/bots', async (req) => {
    requireAdmin(app, req);
    const b = await body(req);
    if (!Array.isArray(b.addresses)) throw new HttpError(400, 'addresses must be a list of addresses');
    const add = (b.addresses as unknown[]).map((x) => {
      if (typeof x !== 'string' || !isAddress(x, { strict: false })) throw new HttpError(400, `not an address: ${String(x).slice(0, 64)}`);
      return x.toLowerCase();
    });
    const next = new Set(b.replace === true ? [] : (d().bots ?? []));
    for (const a of add) next.add(a);
    if (next.size > BOTS_MAX) throw new HttpError(400, `at most ${BOTS_MAX} bot addresses`);
    d().bots = [...next];
    app.store.save(true);
    return { ok: true, count: d().bots.length };
  });

  return async (req: Request, server?: { requestIP(r: Request): { address: string } | null }): Promise<Response> => {
    const cors = corsHeaders(app.env, req);
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (req.method === 'POST' && req.headers.get('origin') && !originAllowed(app.env, req.headers.get('origin'))) throw new HttpError(403, 'origin not allowed');
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const p: Record<string, string> = {};
        r.keys.forEach((k, i) => (p[k] = m[i + 1]!));
        const out = await r.h(req, p, url, clientKey(req, server?.requestIP(req)?.address ?? null));
        if (out instanceof Response) return withCors(out, cors);
        return json(out, 200, cors);
      }
      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status, cors);
      console.log(`[bell] ${req.method} ${url.pathname} failed: ${(e as Error).message.split('\n')[0]}`);
      return json({ error: 'internal error' }, 500, cors);
    }
  };
}
