// The service context: env, chain clients, state, address book, catalog, charts, replay, feed (print set, timeline,
// candles), and the three loops (replay, indexer, settler) plus the one-time USDG bootstrap.
import { encodeFunctionData, getAddress, numberToHex, type Address, type Hex } from 'viem';
import { abiFromBuild, abis, ERC20 } from './abi';
import { Chain, Mutex } from './chain';
import { ChartService, yahooOf, type ChartSymbol } from './charts';
import { loadBook, loadCatalog, USDG_4663, USDG_HOLDER_4663, type Book, type CatalogEntry, type Env } from './config';
import { FaucetLimiter } from './faucet';
import { FeedService } from './feed';
import { healthyFirst, postChunked, postManyGas, POST_ONE_GAS } from './feed/post';
import { indexOnce, type RawLog } from './indexer';
import { symbolToBytes32 } from './math';
import { Replay, ReplaySource, nextDue, seriesForRange, type ReplaySeries, type RoundPost, type TickResult } from './replay';
import { signRound } from './signer';
import { expiredOpen, settleOnce } from './settler';
import { pushRound, Store } from './store';

export const log = (...a: unknown[]) => console.log(`[bell ${new Date().toISOString()}]`, ...a);

/** Consecutive posts that may throw because a due row did not land (the step is retried); after that the replay
 *  moves on, so one row that can never land does not stop the playground clock. It moves on only once every missed
 *  due row reverted on its own in one of these attempts: a due row the single-post budget never reached keeps the
 *  step retrying (the budget rotates over reverting rows, so it is reached). */
export const DUE_RETRIES = 3;

export class App {
  readonly chain: Chain;
  readonly store: Store;
  readonly catalog: CatalogEntry[];
  readonly catalogBySymbol = new Map<string, CatalogEntry>();
  readonly charts: ChartService;
  readonly source: ReplaySource;
  readonly replay: Replay;
  readonly limiter: FaucetLimiter;
  /** Print set, replay timeline, candles and live prices (feed/types.ts). */
  readonly feed: FeedService;
  /** Catalog symbols (upper case) and their Yahoo symbols: the replay records the whole catalog. */
  readonly catalogSymbols: string[];
  private readonly recordSymbols: { symbol: string; yahoo: string }[];
  book: Book | null = null;
  speed: number;
  replayPaused = false;
  lastTick: { at: number; posted: number; delta: number; idle?: string } | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private saver: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** One index pass at a time (the indexer loop and the pass before a daily-close re-post). */
  private readonly indexLock = new Mutex();
  /** Symbols whose row reverted on its own, with the sequence number of the latest revert: posted after the others
   *  (least recently reverted first), so they cannot spend the single-post budget of healthy rows and the budget
   *  rotates over them. A row that lands leaves the map. */
  private postBad = new Map<string, number>();
  private revertSeq = 0;
  private dueMisses = 0;
  /** Symbols that reverted on their own since the last post that did not throw (the current retry run). */
  private revertedRun = new Set<string>();
  private recentlySettled = new Map<string, number>();
  private settleBackoff = new Map<string, number>();
  private feeBpsCache: bigint | null = null;
  private clockCache: { at: number; clock: number; block: number } | null = null;
  private seriesMemo: { src: ReplaySeries | null; range: string; out: ReplaySeries | null } | null = null;
  private coreMemo: { book: Book | null; out: string[] } | null = null;

  constructor(readonly env: Env) {
    this.chain = new Chain(env.rpcUrl, env.chainId, env.houseKey, env.signerKey);
    this.store = new Store(env.stateFile);
    this.catalog = loadCatalog(env.catalogPath);
    for (const e of this.catalog) this.catalogBySymbol.set(e.symbol.toUpperCase(), e);
    const chartSymbols: ChartSymbol[] = this.catalog.map((e) => ({ symbol: e.symbol.toUpperCase(), yahoo: e.yahooSymbol || yahooOf(e.symbol), subject: typeof e.subject === 'string' && !e.elsewhere ? (e.subject as string).toLowerCase() : null, ref: typeof e.lastPrice === 'number' ? e.lastPrice : null }));
    this.charts = new ChartService({ symbols: chartSymbols, dir: env.chartsDir, ethRpc: env.chartsEthRpc, log });
    const seen = new Set<string>();
    this.recordSymbols = [];
    for (const e of this.catalog) {
      const sym = e.symbol.toUpperCase();
      if (seen.has(sym)) continue;
      seen.add(sym);
      this.recordSymbols.push({ symbol: sym, yahoo: e.yahooSymbol || yahooOf(e.symbol) });
    }
    this.catalogSymbols = this.recordSymbols.map((x) => x.symbol);
    this.source = new ReplaySource({ dir: env.chartsDir, log, refreshS: env.replayRefreshS, range: env.replayFetchRange, sessions: env.replaySessions, coverageMin: env.coverageMin }, () => this.charts.get('5d'));
    this.speed = this.store.data.replay.speed ?? env.speed;
    this.limiter = new FaucetLimiter(this.store.data.faucet, env.faucetCooldownS, env.faucetIpMax);
    this.replay = new Replay({
      now: () => this.chain.now(),
      advance: (s) => this.chain.advance(s),
      advanceTo: (t) => this.chain.advanceTo(t),
      post: (rows) => this.post(rows),
      beforeClose: () => this.indexTick(),
      markets: () => this.demoMarkets(),
      printSet: (at, close) => this.feed.printSet(at, close),
      series: () => this.replaySeries(),
      closeHourUtc: env.closeHourUtc,
      onPending: (p) => {
        this.store.data.replay.pending = p;
        this.store.touch();
      },
    });
    this.replay.cursor = this.store.data.replay.cursor;
    this.replay.restore(this.store.data.replay.pending);
    this.feed = new FeedService({
      series: () => this.replaySeries(),
      data: () => this.store.data,
      listed: () => this.demoMarkets(),
      core: () => this.coreSymbols(),
      catalog: () => this.catalogSymbols,
      cursor: (s, clock) => (s ? this.replay.cursorIn(s, clock) : this.replay.cursor),
      speed: () => this.speed,
      paused: () => this.replayPaused || !env.replay,
      frozen: () => this.source.frozen(),
      closeHourUtc: env.closeHourUtc,
      timelinePath: env.timelineFile,
      coverageMin: env.coverageMin,
      log,
    });
    this.reloadBook();
  }

  reloadBook(): Book | null {
    const b = loadBook(this.env.bookPath);
    if (b && (!this.book || this.book.book !== b.book)) {
      log(`book: TicketBook ${b.book}, vault ${b.vault}, reference ${b.reference}, from block ${b.startBlock} (ABI ${abiFromBuild ? 'from the contracts build' : 'minimal, from INTERFACES.md'})`);
      this.feeBpsCache = null;
    }
    this.book = b;
    return b;
  }

  /** Replay range: the admin's choice from the state file, else BELL_REPLAY_RANGE. */
  replayRange(): '5d' | '1d' {
    return this.store.data.replay.range ?? this.env.replayRange;
  }

  replaySeries(): ReplaySeries | null {
    const src = this.source.get();
    const range = this.replayRange();
    if (this.seriesMemo && this.seriesMemo.src === src && this.seriesMemo.range === range) return this.seriesMemo.out;
    const out = seriesForRange(src, range);
    this.seriesMemo = { src, range, out };
    return out;
  }

  /** BELL_CORE_SYMBOLS, else the markets of book.json (always printed while listed). */
  coreSymbols(): string[] {
    if (this.env.coreSymbols.length) return this.env.coreSymbols;
    if (this.coreMemo && this.coreMemo.book === this.book) return this.coreMemo.out;
    const ms = (this.book?.raw as { markets?: { ticker?: unknown }[] } | null)?.markets;
    const out = Array.isArray(ms) ? ms.map((m) => (typeof m?.ticker === 'string' ? m.ticker.toUpperCase() : '')).filter(Boolean) : [];
    this.coreMemo = { book: this.book, out };
    return out;
  }

  usdg(): Address | null {
    return this.env.usdg ?? this.book?.usdg ?? USDG_4663;
  }

  /** Listed markets whose reference is the demo signer (all markets when the book names no reference). */
  demoMarkets(): string[] {
    const ref = this.book?.reference?.toLowerCase();
    return Object.values(this.store.data.markets)
      .filter((m) => !ref || !m.reference || m.reference === ref)
      .map((m) => m.symbol);
  }

  async clock(): Promise<{ clock: number; block: number }> {
    const now = Date.now();
    if (this.clockCache && now - this.clockCache.at < 1000) return this.clockCache;
    const seq = this.feed.tickSeq();
    const b = await this.chain.pub.getBlock({ blockTag: 'latest' });
    const c = { at: now, clock: Number(b.timestamp), block: Number(b.number) };
    // A tick that finished during the read recorded a newer clock: this read is stale, neither cached nor applied.
    if (this.feed.tickSeq() !== seq) return c;
    this.clockCache = c;
    this.feed.setClock(c.clock, seq);
    return c;
  }

  async feeBps(): Promise<bigint> {
    if (this.feeBpsCache !== null) return this.feeBpsCache;
    let v = BigInt(this.env.feeBpsFallback);
    if (this.book?.book) {
      try {
        v = BigInt((await this.chain.pub.readContract({ address: this.book.book, abi: abis.book, functionName: 'feeBps' })) as bigint | number);
      } catch {
        /* the fallback stays */
      }
    }
    this.feeBpsCache = v;
    return v;
  }

  /** Posts one print set: postMany in chunks of at most 64 rows, a reverted chunk split in halves down to single
   *  posts (at most 8 per call); rows that land are recorded in the state's rounds. Returns the rows that landed.
   *  Throws on a transport error, and when a due row did not land (DUE_RETRIES times in a row, and after that while a
   *  missed due row has not reverted on its own in this run), so the replay retries the step instead of moving past a
   *  mandatory print. */
  private async post(rows: RoundPost[]): Promise<number> {
    const ref = this.book?.reference;
    if (!ref || !rows.length) return 0;
    // A row stored at its own time landed in an interrupted attempt of this step (posting it again reverts).
    const todo = healthyFirst(rows.filter((r) => this.store.data.rounds[r.symbol]?.at(-1)?.t !== r.t), (r) => this.postBad.get(r.symbol));
    const already = rows.length - todo.length;
    const signed: { r: RoundPost; s: Hex; sig: Hex }[] = [];
    for (const r of todo) {
      const s = symbolToBytes32(r.symbol);
      signed.push({ r, s, sig: await signRound(this.chain.signer, this.env.chainId, ref, s, r.price8, r.t) });
    }
    const sendOk = async (data: Hex, gas: bigint) => (await this.chain.send(this.chain.signer, { to: ref, data, gas })).status === 'success';
    const landed = new Set<string>();
    try {
      const st = await postChunked(
        signed,
        {
          many: (part) => sendOk(encodeFunctionData({ abi: abis.signer, functionName: 'postMany', args: [part.map((x) => x.s), part.map((x) => x.r.price8), part.map((x) => BigInt(x.r.t)), part.map((x) => x.sig)] }), postManyGas(part.length)),
          one: (x) => sendOk(encodeFunctionData({ abi: abis.signer, functionName: 'post', args: [x.s, x.r.price8, BigInt(x.r.t), x.sig] }), POST_ONE_GAS),
        },
        (x) => {
          pushRound(this.store.data, x.r.symbol, { t: x.r.t, price8: x.r.price8.toString() });
          landed.add(x.r.symbol);
          this.postBad.delete(x.r.symbol);
        },
        {},
        (x) => {
          this.postBad.set(x.r.symbol, ++this.revertSeq);
          this.revertedRun.add(x.r.symbol);
        },
      );
      if (st.failed) log(`post: ${st.failed} of ${rows.length} row(s) did not land (${st.txs} tx, ${st.singles} single)`);
    } finally {
      this.store.touch();
    }
    const due = new Set(this.feed.lastDue());
    const missed = todo.filter((r) => due.has(r.symbol) && !landed.has(r.symbol)).map((r) => r.symbol);
    if (missed.length && (this.dueMisses < DUE_RETRIES || missed.some((x) => !this.revertedRun.has(x)))) {
      this.dueMisses++;
      throw new Error(`due row(s) did not land: ${missed.join(', ')}; the step is retried`);
    }
    if (missed.length) log(`post: due row(s) ${missed.join(', ')} did not land after ${this.dueMisses} retries, each reverted on its own; moving on`);
    this.dueMisses = 0;
    this.revertedRun.clear();
    return already + landed.size;
  }

  // ---------------------------------------------------------------- loops
  async replayTick(): Promise<void> {
    if (this.replayPaused || !this.book?.reference) return;
    void this.source.ensure(this.recordSymbols);
    const started = Date.now();
    const t0 = performance.now();
    let r: TickResult;
    try {
      r = await this.chain.clockLock.run(() => this.replay.step());
    } catch (e) {
      // An interrupted step reaches the disk now (the rounds it posted with it), so a restart resumes it.
      if (this.replay.pendingStep()) this.store.save(true);
      throw e;
    }
    const dur = performance.now() - t0;
    this.lastTick = { at: Date.now(), posted: r.posted, delta: r.delta, idle: r.idle };
    this.feed.onTick(r, started, dur);
    this.store.data.replay.cursor = this.replay.cursor;
    this.store.touch();
    this.clockCache = null;
  }

  /** One index pass (serialized: the indexer loop and the pass before a daily-close re-post never overlap). */
  indexTick(): Promise<void> {
    return this.indexLock.run(() => this.indexPass());
  }

  private async indexPass(): Promise<void> {
    const b = this.reloadBook();
    if (!b?.book) return;
    const c = this.chain;
    const bookAddr = b.book;
    const n = await indexOnce(
      this.store.data,
      {
        head: () => c.head(),
        getLogs: (f) => c.rpc<RawLog[]>('eth_getLogs', [f]),
        blockTime: async (bn) => Number((await c.pub.getBlock({ blockNumber: bn })).timestamp),
        blockHash: async (bn) => (await c.rpc<{ hash: string } | null>('eth_getBlockByNumber', [numberToHex(bn), false]))?.hash ?? null,
        ticketHorizon: async (id) => Number(((await c.pub.readContract({ address: bookAddr, abi: abis.book, functionName: 'getTicket', args: [id] })) as { horizon: number | bigint }).horizon),
      },
      { book: b.book, vault: b.vault, startBlock: b.startBlock },
      abis,
    );
    if (n) this.store.touch();
    this.store.save();
  }

  async settleTick(): Promise<void> {
    if (!this.book?.book) return;
    const now = Date.now();
    for (const [id, at] of this.recentlySettled) if (now - at > 30_000 || this.store.data.tickets[id]?.status !== 'open') this.recentlySettled.delete(id);
    if (!expiredOpen(this.store.data, Number.MAX_SAFE_INTEGER).length) return;
    const ids = await settleOnce(this.store.data, this.chain, this.book.book, abis.book, log, new Set(this.recentlySettled.keys()), this.settleBackoff, now, (id, symbol) => this.feed.watch(id, symbol));
    for (const id of ids) this.recentlySettled.set(id, now);
    if (ids.length) log(`settled ticket(s) ${ids.join(', ')}`);
  }

  /** Moves 5,000,000 USDG from a large holder to dev account 0 (impersonation on the private anvil URL) when the house
   * wallet cannot pay a faucet drip; once per fork in practice. */
  async bootstrapUsdg(): Promise<void> {
    const usdg = this.usdg();
    if (!usdg || !(await this.chain.hasCode(usdg))) return;
    const house = this.chain.house.address;
    const bal = (await this.chain.pub.readContract({ address: usdg, abi: ERC20, functionName: 'balanceOf', args: [house] })) as bigint;
    // The flag alone is not enough: state.json survives a fork reset (same book addresses on a fresh fork), and the
    // house wallet of the new fork starts without the bootstrap. Run again whenever the house cannot pay one drip.
    if (this.store.data.usdgBootstrap && bal >= this.env.faucetUsdgRaw) return;
    if (bal >= this.env.bootstrapUsdgRaw) {
      this.store.data.usdgBootstrap = { holder: 'none needed', amount: '0', tx: '', at: Math.floor(Date.now() / 1000) };
      this.store.save(true);
      return;
    }
    const holder = getAddress(this.env.usdgHolder ?? USDG_HOLDER_4663);
    const hb = (await this.chain.pub.readContract({ address: usdg, abi: ERC20, functionName: 'balanceOf', args: [holder] })) as bigint;
    if (hb < this.env.bootstrapUsdgRaw) {
      log(`usdg bootstrap: holder ${holder} has ${hb}, below ${this.env.bootstrapUsdgRaw}; skipped`);
      return;
    }
    await this.chain.houseLock.run(async () => {
      await this.chain.impersonate(holder);
      try {
        const r = await this.chain.sendImpersonated(holder, { to: usdg, data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [house, this.env.bootstrapUsdgRaw] }) as Hex });
        if (r.status !== 'success') throw new Error(`transfer reverted, tx ${r.hash}`);
        this.store.data.usdgBootstrap = { holder, amount: this.env.bootstrapUsdgRaw.toString(), tx: r.hash, at: Math.floor(Date.now() / 1000) };
        this.store.save(true);
        log(`usdg bootstrap: moved ${this.env.bootstrapUsdgRaw} raw USDG from ${holder} to ${house}, tx ${r.hash}`);
      } finally {
        await this.chain.stopImpersonating(holder);
      }
    });
  }

  start(): void {
    if (this.env.charts) this.charts.start();
    const guard = (name: string, f: () => Promise<void>) => {
      let busy = false;
      return async () => {
        if (busy) return;
        busy = true;
        try {
          await f();
        } catch (e) {
          log(`${name} failed: ${(e as Error).message.split('\n')[0]}`);
        } finally {
          busy = false;
        }
      };
    };
    const every = (name: string, ms: number, f: () => Promise<void>) => {
      const g = guard(name, f);
      const loop = async () => {
        if (this.stopped) return;
        await g();
        if (!this.stopped) this.later(loop, ms);
      };
      this.later(loop, 500);
    };
    every('usdg bootstrap', 60_000, () => this.bootstrapUsdg());
    every('indexer', this.env.indexSeconds * 1000, () => this.indexTick());
    every('settler', this.env.settleSeconds * 1000, () => this.settleTick());
    if (this.env.replay) {
      const g = guard('replay', () => this.replayTick());
      let due = Date.now();
      const loop = async () => {
        if (this.stopped) return;
        await g();
        due = nextDue(due, Date.now(), this.speed);
        if (!this.stopped) this.later(loop, Math.max(0, due - Date.now()));
      };
      this.later(loop, 1000);
    }
    this.saver = setInterval(() => {
      this.store.save();
      try {
        this.feed.save();
      } catch (e) {
        log(`feed timeline save failed: ${(e as Error).message}`);
      }
    }, 5000);
  }

  /** One-shot timer that leaves the registry when it fires (the registry holds only pending timers). */
  private later(f: () => Promise<void>, ms: number): void {
    const h = setTimeout(() => {
      this.timers.delete(h);
      void f();
    }, ms);
    this.timers.add(h);
  }

  /** Pending one-shot timers (loops re-arm one each). */
  pendingTimers(): number {
    return this.timers.size;
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.saver) clearInterval(this.saver);
    this.saver = null;
    this.charts.stop();
    this.store.save();
    try {
      this.feed.save(true);
    } catch {
      /* best effort on shutdown */
    }
  }
}
