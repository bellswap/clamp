// The demo fleet: 24 traders and 4 LPs. Every address is registered with the bell
// (POST /admin/bots) so its rows carry the bot flag and the site shows the "demo" tag.
import { stringToHex, type Abi, type Account } from 'viem';
import { BOOK, VAULT } from './abi';
import type { Bell, BellState, BookAddrs, OpenTicket } from './bell';
import { tradableSymbols } from './bell';
import { openedTicket, type ChainPort, type SendResult } from './chain';
import { DEFAULT_CORE } from './config';
import {
  expDelay,
  guardReason,
  LIMITS,
  lpFirstDepositRaw,
  lpNextMs,
  lpRebalance,
  pickAmountRaw,
  pickHorizon,
  pickMultiple,
  pickSide,
  pickSymbol,
  reasonKey,
  RevertTracker,
  tickAgeMs,
  USDG,
  type Rng,
} from './strategy';

export type BellPort = Pick<Bell, 'state' | 'markets' | 'market' | 'warm' | 'closes' | 'ownerTickets' | 'ticket' | 'registerBots'>;

export interface FleetOpts {
  intervalMs: number;
  core: string[] | null;
  rng?: Rng;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** How long a non-core open waits for the warm print (ms). */
  freshWaitMs?: number;
  freshPollMs?: number;
  maxInflight?: number;
  /** Trader USDG: top up below `traderMin` to `traderTarget` (raw). */
  traderMin?: bigint;
  traderTarget?: bigint;
}

export interface Stats {
  opens: number;
  txReverts: number;
  simRejects: number;
  skips: Record<string, number>;
  lpOps: number;
  fundings: number;
  resets: number;
  lastLoopAt: number;
  lastStatus: string;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await f(items[i++]!);
    }),
  );
}

export class Fleet {
  readonly stats: Stats = { opens: 0, txReverts: 0, simRejects: 0, skips: {}, lpOps: 0, fundings: 0, resets: 0, lastLoopAt: 0, lastStatus: 'starting' };
  readonly reverts = new RevertTracker();
  /**
   * Open ticket ids per bot (lower-case address): ids this process opened plus the bell's open rows, reconciled every
   * maintenance pass. An id leaves only when the bell lists it settled or the chain says it is no longer open, so an
   * indexer lag or a truncated bell page never drops a live ticket.
   */
  readonly open = new Map<string, Set<string>>();
  book: BookAddrs | null = null;
  core: string[] = [];
  nonCore: string[] = [];
  lastTickAt: number | null = null;
  vaultFreePct: number | null = null;
  private lastHead = 0n;
  private registered = false;
  private busy = new Set<string>();
  /** Symbols with an open in flight: one at a time per symbol, so each open reads the OI the previous one left. */
  private busySymbols = new Set<string>();
  /** Opens past the fleet-cap check and not yet resolved (counted against the fleet cap). */
  private pendingOpens = 0;
  /** How many ids lastOpened records (set by once; 0 in the long-running mode). */
  private keepOpened = 0;
  private inflight = 0;
  private lpNext = new Map<string, number>();
  private stopped = false;
  private opensAtLastLine = 0;
  private lastRegisterWarn = 0;
  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (l: string) => void;
  private readonly traderMin: bigint;
  private readonly traderTarget: bigint;

  constructor(readonly traders: Account[], readonly lps: Account[], readonly chain: ChainPort, readonly bell: BellPort, readonly o: FleetOpts) {
    this.rng = o.rng ?? Math.random;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? sleepReal;
    this.log = o.log ?? ((l) => console.log(l));
    this.traderMin = o.traderMin ?? 1000n * USDG;
    this.traderTarget = o.traderTarget ?? 5000n * USDG;
    for (const a of traders) this.open.set(a.address.toLowerCase(), new Set());
  }

  get addresses(): string[] {
    return [...this.traders, ...this.lps].map((a) => a.address);
  }

  fleetOpen(): number {
    let n = 0;
    for (const s of this.open.values()) n += s.size;
    return n;
  }

  private skip(reason: string): string {
    const k = reasonKey(this.stats.skips, reason);
    this.stats.skips[k] = (this.stats.skips[k] ?? 0) + 1;
    return reason;
  }

  get isRegistered(): boolean {
    return this.registered;
  }

  /** Applies a /state answer: book addresses, tick time, core list; returns true when the fork was reset. */
  applyState(s: BellState, head: bigint): boolean {
    this.lastTickAt = s.lastTickAt;
    if (s.core) this.core = s.core;
    let reset = false;
    const b = s.book;
    if (b && this.book) {
      const same = b.ticketBook.toLowerCase() === this.book.ticketBook.toLowerCase() && b.vault.toLowerCase() === this.book.vault.toLowerCase() && b.usdg.toLowerCase() === this.book.usdg.toLowerCase() && b.startBlock === this.book.startBlock;
      if (!same) reset = true;
    }
    if (this.lastHead > 0n && head + 3n < this.lastHead) reset = true;
    if (head > 0n) this.lastHead = head;
    if (b) this.book = b;
    if (reset) {
      this.stats.resets += 1;
      for (const s2 of this.open.values()) s2.clear();
      this.registered = false;
      this.lpNext.clear();
      this.log('[bots] fork reset or new book detected: re-funding, re-approving and re-registering');
    }
    return reset;
  }

  /** Light poll (every few seconds): tick time for the stall guard. */
  async pollState(): Promise<void> {
    try {
      const s = await this.bell.state();
      this.lastTickAt = s.lastTickAt;
    } catch {
      // keep the last value; the stall guard trips once it ages past 20 s
    }
  }

  /** Every minute: book from the bell, reset detection, funding and approvals, registration, open tickets, symbols. */
  async maintain(): Promise<void> {
    const s = await this.bell.state();
    const head = await this.chain.head().catch(() => 0n);
    this.applyState(s, head);
    const book = this.book;
    if (!book) {
      this.stats.lastStatus = 'waiting for the book (bell /state book is null)';
      return;
    }
    await this.fund(book);
    // fewer bots in the bell's registry than we run (bell state reset): register again before trading on
    if (s.bots !== null && s.bots < this.addresses.length) this.registered = false;
    if (!this.registered) await this.register();
    await this.refreshOpen();
    await this.refreshSymbols();
    try {
      const v = await this.chain.vaultState(book.vault);
      this.vaultFreePct = v.assets > 0n ? Number((v.free * 10_000n) / v.assets) / 100 : null;
    } catch {
      // stats only
    }
  }

  async fund(book: BookAddrs): Promise<void> {
    const all = [...this.traders.map((a) => ({ a, trader: true })), ...this.lps.map((a) => ({ a, trader: false }))];
    await pool(all, 6, async ({ a, trader }) => {
      try {
        if (await this.chain.ensureEth(a.address)) this.stats.fundings += 1;
        if (trader && (await this.chain.ensureUsdg(book.usdg, a.address, this.traderMin, this.traderTarget))) this.stats.fundings += 1;
        for (const spender of [book.ticketBook, book.vault]) {
          const r = await this.chain.ensureApproval(a, book.usdg, spender);
          if (r && !r.ok) this.log(`[bots] approve ${spender} from ${a.address} failed: ${r.stage}:${r.reason}`);
        }
      } catch (e) {
        this.log(`[bots] funding ${a.address} failed: ${(e as Error).message.split('\n')[0]}`);
      }
    });
  }

  async register(): Promise<void> {
    const st = await this.bell.registerBots(this.addresses).catch(() => -1);
    if (st === 200) {
      if (!this.registered) this.log(`[bots] registered ${this.addresses.length} addresses with the bell`);
      this.registered = true;
      return;
    }
    this.registered = false;
    this.stats.lastStatus = 'not registered with the bell: opens and LP steps paused';
    if (this.now() - this.lastRegisterWarn > 600_000) {
      this.lastRegisterWarn = this.now();
      this.log(`[bots] POST /admin/bots answered ${st === 0 ? 'nothing (BELL_ADMIN_TOKEN unset)' : st}; opens and LP steps stay paused until it succeeds, so no row goes out without the bot flag`);
    }
  }

  /** Reconciles every trader's open set with the bell (owner query) and, for ids the bell does not show, the chain. */
  async refreshOpen(): Promise<void> {
    await pool(this.traders, 4, (a) => this.refreshOwner(a.address.toLowerCase()));
  }

  private async refreshOwner(key: string): Promise<void> {
    const set = this.open.get(key);
    const book = this.book;
    if (!set) return;
    let rows: OpenTicket[];
    try {
      rows = await this.bell.ownerTickets(key);
    } catch {
      return; // keep the local ids
    }
    const statusOf = new Map(rows.filter((t) => t.owner?.toLowerCase() === key).map((t) => [String(t.id), t.status]));
    const drop: string[] = [];
    for (const id of [...set]) {
      const st = statusOf.get(id);
      if (st === 'open') continue;
      if (st !== undefined) {
        drop.push(id); // indexed and no longer open
        continue;
      }
      // not in the bell's answer: not indexed yet, or beyond its page; the chain decides
      if (book && !(await this.chain.ticketOpen(book.ticketBook, id).catch(() => true))) drop.push(id);
    }
    for (const id of drop) set.delete(id);
    for (const [id, st] of statusOf) if (st === 'open') set.add(id);
  }

  async refreshSymbols(): Promise<void> {
    let tradable: string[] | null = null;
    try {
      const rows = await this.bell.markets();
      if (rows) tradable = tradableSymbols(rows);
    } catch {
      // keep the last lists
      return;
    }
    const core = (this.o.core ?? (this.core.length ? this.core : DEFAULT_CORE)).map((x) => x.toUpperCase());
    if (tradable === null) {
      // bell without /markets: core only
      this.core = core;
      this.nonCore = [];
      return;
    }
    const t = new Set(tradable);
    this.core = core.filter((x) => t.has(x));
    const c = new Set(this.core);
    this.nonCore = tradable.filter((x) => !c.has(x));
  }

  /** Waits for the warm print of a non-core symbol: /markets/:symbol fresh (or a last round when the field is absent). */
  async waitFresh(symbol: string): Promise<boolean> {
    const deadline = this.now() + (this.o.freshWaitMs ?? 20_000);
    for (;;) {
      const m = await this.bell.market(symbol).catch(() => null);
      if (m && (m.fresh === true || (m.fresh === undefined && !!m.lastRound))) return true;
      if (this.now() >= deadline) return false;
      await this.sleep(this.o.freshPollMs ?? 1000);
    }
  }

  /** One open attempt; returns 'opened', a skip reason, or 'sim:<Error>' / 'tx:<reason>'. */
  async tryOpen(): Promise<string> {
    const book = this.book;
    if (!book) return this.skip('no-book');
    const now = this.now();
    if (now < this.reverts.backoffUntil) return this.skip('backoff');
    if (!(tickAgeMs(this.lastTickAt, now) <= LIMITS.tickMaxAgeMs)) return this.skip('bell-stalled');
    if (!this.registered) return this.skip('unregistered');
    if (this.fleetOpen() + this.pendingOpens >= LIMITS.fleet) return this.skip('fleet-cap');
    const free = this.traders.filter((a) => !this.busy.has(a.address) && (this.open.get(a.address.toLowerCase())?.size ?? 0) < LIMITS.perBot);
    if (!free.length) return this.skip('bot-cap');
    const trader = free[Math.floor(this.rng() * free.length) % free.length]!;
    const pick = pickSymbol(this.rng, this.core, this.nonCore);
    if (!pick) return this.skip('no-symbols');
    if (this.busySymbols.has(pick.symbol)) return this.skip('symbol-busy');
    // reserve synchronously (no await since the checks above): trader, symbol and one fleet slot
    this.busy.add(trader.address);
    this.busySymbols.add(pick.symbol);
    this.pendingOpens += 1;
    try {
      if (!pick.core) {
        if (!(await this.bell.warm(pick.symbol, 30).catch(() => false))) return this.skip('warm-refused');
        if (!(await this.waitFresh(pick.symbol))) return this.skip('not-fresh');
      }
      const [m, v, closes] = await Promise.all([this.chain.market(book.ticketBook, pick.symbol), this.chain.vaultState(book.vault), this.bell.closes(pick.symbol, 3).catch(() => [] as number[])]);
      if (!m.listed) return this.skip('not-listed');
      const amount = pickAmountRaw(this.rng, m.maxStake);
      const leverage = pickMultiple(this.rng, m.maxLeverage);
      const horizon = pickHorizon(this.rng);
      const long = pickSide(this.rng, closes);
      const g = guardReason({
        vaultFree: v.free,
        vaultAssets: v.assets,
        oi: m.oi,
        oiCap: m.oiCap,
        amount,
        botOpen: this.open.get(trader.address.toLowerCase())?.size ?? 0,
        fleetOpen: this.fleetOpen() + this.pendingOpens - 1, // the other opens in flight
        tickAgeMs: tickAgeMs(this.lastTickAt, this.now()),
        backoffUntil: this.reverts.backoffUntil,
        now: this.now(),
      });
      if (g) return this.skip(g);
      await this.chain.ensureUsdg(book.usdg, trader.address, this.traderMin > amount ? this.traderMin : amount, this.traderTarget > amount ? this.traderTarget : amount * 2n);
      // registration can fail while the reads above are pending: check again here and inside the send
      if (!this.registered) return this.skip('unregistered');
      const r = await this.chain.write(trader, { address: book.ticketBook, abi: BOOK as Abi, functionName: 'open', args: [stringToHex(pick.symbol, { size: 32 }), long, leverage, amount, horizon], guard: this.registeredGuard });
      return this.after(r, trader, pick.symbol);
    } catch (e) {
      return this.skip(`error:${(e as Error).message.split('\n')[0]!.slice(0, 40)}`);
    } finally {
      this.busy.delete(trader.address);
      this.busySymbols.delete(pick.symbol);
      this.pendingOpens -= 1;
    }
  }

  /** Opens per symbol (for --once and the rig report). */
  readonly bySymbol: Record<string, number> = {};

  /** Write guard for opens and LP steps: no row goes out while the bell does not know the address as a bot. */
  private readonly registeredGuard = (): string | null => (this.registered ? null : 'unregistered');

  private after(r: SendResult, trader: Account, symbol: string): string {
    if (!r.ok && r.stage === 'guard') return this.skip(r.reason);
    if (r.ok) {
      const t = openedTicket(r.logs);
      if (t) this.open.get(trader.address.toLowerCase())?.add(t.id);
      this.stats.opens += 1;
      this.bySymbol[symbol] = (this.bySymbol[symbol] ?? 0) + 1;
      this.reverts.ok();
      if (this.lastOpened.length < this.keepOpened) this.lastOpened.push(t?.id ?? '');
      return 'opened';
    }
    const reason = `${r.stage}:${r.reason}`;
    if (r.stage === 'tx') this.stats.txReverts += 1;
    else this.stats.simRejects += 1;
    this.reverts.revert(reason, this.now());
    this.log(`[bots] open ${symbol} from ${trader.address} failed: ${reason}`);
    return reason;
  }

  /** Ids of tickets opened by this process, in order (for --once; bounded by its N, empty in the long-running mode). */
  readonly lastOpened: string[] = [];

  /** One LP step when it is due: the first deposit, then a deposit or withdraw of at most 10 %. */
  async lpStep(lp: Account, idx: number): Promise<void> {
    const book = this.book;
    if (!book || !this.registered) return;
    const key = lp.address.toLowerCase();
    const now = this.now();
    if (!this.lpNext.has(key)) {
      // staggered first step: 20 to 60 s apart per LP
      this.lpNext.set(key, now + (idx + 1) * (20_000 + this.rng() * 40_000));
      return;
    }
    if (now < this.lpNext.get(key)!) return;
    this.lpNext.set(key, now + lpNextMs(this.rng));
    const pos = await this.chain.lpPosition(book.vault, lp.address);
    let kind: 'deposit' | 'withdraw';
    let amount: bigint;
    if (pos.shares === 0n) {
      kind = 'deposit';
      amount = lpFirstDepositRaw(this.rng);
    } else {
      const plan = lpRebalance(this.rng, pos.assets, pos.maxWithdraw);
      if (!plan) return;
      ({ kind, amount } = plan);
    }
    if (kind === 'deposit') await this.chain.ensureUsdg(book.usdg, lp.address, amount, amount + 1000n * USDG);
    // registration can fail while the reads above are pending: check again here and inside the send
    if (!this.registered) return;
    const args = kind === 'deposit' ? [amount, lp.address] : [amount, lp.address, lp.address];
    const r = await this.chain.write(lp, { address: book.vault, abi: VAULT as Abi, functionName: kind, args, guard: this.registeredGuard });
    if (!r.ok && r.stage === 'guard') return;
    if (r.ok) {
      this.stats.lpOps += 1;
      this.log(`[bots] LP ${lp.address} ${kind} ${amount / USDG} USDG`);
    } else this.log(`[bots] LP ${lp.address} ${kind} failed: ${r.stage}:${r.reason}`);
  }

  statsLine(): string {
    const d = this.stats.opens - this.opensAtLastLine;
    this.opensAtLastLine = this.stats.opens;
    const age = tickAgeMs(this.lastTickAt, this.now());
    const reasons = Object.entries(this.reverts.byReason).map(([k, v]) => `${k}:${v}`).join(',') || '-';
    const skips = Object.entries(this.stats.skips).map(([k, v]) => `${k}:${v}`).join(',') || '-';
    return `[bots] stats opens=${this.stats.opens} (+${d}) reverts=${this.reverts.total} [${reasons}] skips=[${skips}] open=${this.fleetOpen()}/${LIMITS.fleet} vaultFree=${this.vaultFreePct === null ? '?' : this.vaultFreePct.toFixed(1) + '%'} tickAge=${Number.isFinite(age) ? (age / 1000).toFixed(1) + 's' : '?'} lpOps=${this.stats.lpOps} symbols=${this.core.length}+${this.nonCore.length}`;
  }

  stop(): void {
    this.stopped = true;
  }

  /** The long-running loops: Poisson opens, state poll, maintenance and stats every minute, LP steps. */
  async run(): Promise<void> {
    const every = async (ms: number, f: () => Promise<void>) => {
      while (!this.stopped) {
        try {
          await f();
        } catch (e) {
          this.log(`[bots] ${(e as Error).message.split('\n')[0]}`);
        }
        await this.sleep(ms);
      }
    };
    await this.maintain().catch((e) => this.log(`[bots] first maintenance failed: ${(e as Error).message.split('\n')[0]}`));
    const loops = [
      every(60_000, async () => {
        await this.maintain();
        this.log(this.statsLine());
      }),
      every(5_000, () => this.pollState()),
      every(15_000, async () => {
        for (const [i, lp] of this.lps.entries()) await this.lpStep(lp, i).catch((e) => this.log(`[bots] LP step failed: ${(e as Error).message.split('\n')[0]}`));
      }),
      (async () => {
        while (!this.stopped) {
          await this.sleep(expDelay(this.o.intervalMs, this.rng));
          this.stats.lastLoopAt = this.now();
          if (this.inflight >= (this.o.maxInflight ?? 4)) {
            this.skip('busy');
            continue;
          }
          this.inflight += 1;
          void this.tryOpen().finally(() => (this.inflight -= 1));
        }
      })(),
    ];
    this.stats.lastStatus = 'running';
    await Promise.all(loops);
  }

  /** --once N: open N tickets (sequential), then check the bell lists every one of them with bot true. */
  async once(n: number, opts: { deadlineMs?: number; verifyMs?: number } = {}): Promise<OnceResult> {
    this.keepOpened = n;
    await this.maintain();
    const deadline = this.now() + (opts.deadlineMs ?? 15 * 60_000);
    let attempts = 0;
    while (this.stats.opens < n && attempts < n * 8 && this.now() < deadline) {
      attempts += 1;
      const r = await this.tryOpen();
      if (r === 'unregistered') await this.register();
      if (r === 'bell-stalled' || r === 'backoff' || r === 'not-fresh' || r === 'bot-cap' || r === 'unregistered') {
        await this.pollState();
        await this.sleep(1000);
      }
      if (attempts % 25 === 0) await this.refreshOpen();
    }
    const ids = this.lastOpened.filter(Boolean);
    const verifyDeadline = this.now() + (opts.verifyMs ?? 60_000);
    let flagged = 0;
    let indexed = 0;
    for (;;) {
      flagged = 0;
      indexed = 0;
      for (const id of ids) {
        const t = await this.bell.ticket(id).catch(() => null);
        if (t) indexed += 1;
        if (t?.bot === true) flagged += 1;
      }
      if (flagged === ids.length || this.now() >= verifyDeadline) break;
      await this.sleep(2000);
    }
    const ok = this.stats.opens === n && this.stats.txReverts === 0 && flagged === n;
    return { ok, requested: n, opened: this.stats.opens, bySymbol: { ...this.bySymbol }, attempts, txReverts: this.stats.txReverts, simRejects: this.stats.simRejects, revertReasons: { ...this.reverts.byReason }, skips: { ...this.stats.skips }, indexed, botFlagged: flagged, ids };
  }
}

export interface OnceResult {
  ok: boolean;
  requested: number;
  opened: number;
  bySymbol: Record<string, number>;
  attempts: number;
  txReverts: number;
  simRejects: number;
  revertReasons: Record<string, number>;
  skips: Record<string, number>;
  indexed: number;
  botFlagged: number;
  ids: string[];
}

