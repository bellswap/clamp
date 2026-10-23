import { describe, expect, test } from 'bun:test';
import { encodeAbiParameters, encodeEventTopics, hexToString, type Account, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BOOK } from '../src/abi';
import type { BellState, MarketRow, OpenTicket } from '../src/bell';
import type { ChainPort, MarketOnChain, SendResult, WriteReq } from '../src/chain';
import { Fleet, type BellPort } from '../src/fleet';
import { seeded, USDG } from '../src/strategy';

const ADDR = {
  ticketBook: '0xA2Ec435D67B35893b81a87212815DCDd20EE4f9B' as Address,
  vault: '0xB8357F7f41125d4b24AD052c1b7288BeF5C43446' as Address,
  reference: '0x980ea9f1a0C36e1E5f3B6BD451bEf8a7Fe661f97' as Address,
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address,
  startBlock: '91989491',
};

function openedLog(id: bigint, owner: Address, symbol: `0x${string}`, expiry: bigint) {
  return {
    address: ADDR.ticketBook,
    topics: encodeEventTopics({ abi: BOOK, eventName: 'TicketOpened', args: { id, owner, symbol } }),
    data: encodeAbiParameters([{ type: 'bool' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint64' }], [true, 5, 10n * USDG, 100n * 10n ** 8n, expiry]),
    blockNumber: 1n,
    transactionHash: '0x' + '11'.repeat(32),
    logIndex: 0,
    blockHash: '0x' + '22'.repeat(32),
    transactionIndex: 0,
    removed: false,
  };
}

class FakeChain implements ChainPort {
  ids = 0n;
  writes: { from: Address; req: WriteReq }[] = [];
  eth = new Map<string, number>();
  usdg = new Map<string, bigint>();
  approvals: string[] = [];
  vault = { free: 9_000_000n * USDG, assets: 10_000_000n * USDG };
  oi = 0n;
  simFail: string | null = null;
  txFail = false;
  headN = 1000n;
  shares = new Map<string, bigint>();
  /** Ids open on chain (TicketBook.getTicket status 1). */
  chainOpen = new Set<string>();
  /** When set, open writes wait for it (concurrency tests). */
  gate: Promise<void> | null = null;
  /** When set, market() and lpPosition() reads wait for it (registration race tests). */
  readGate: Promise<void> | null = null;
  marketReads = 0;
  async ensureEth(a: Address) {
    if (this.eth.has(a)) return false;
    this.eth.set(a, 10);
    return true;
  }
  async ensureUsdg(_u: Address, a: Address, min: bigint, target: bigint) {
    if ((this.usdg.get(a) ?? 0n) >= min) return false;
    this.usdg.set(a, target);
    return true;
  }
  async usdgBalance(_u: Address, a: Address) {
    return this.usdg.get(a) ?? 0n;
  }
  async ensureApproval(a: Account, token: Address, spender: Address) {
    const k = `${a.address}:${token}:${spender}`;
    if (this.approvals.includes(k)) return null;
    this.approvals.push(k);
    return { ok: true, hash: '0x00', logs: [] } as SendResult;
  }
  async write(a: Account, req: WriteReq): Promise<SendResult> {
    const held = req.guard?.() ?? null; // as ChainIO.write: checked before the simulation
    if (held) return { ok: false, stage: 'guard', reason: held };
    this.writes.push({ from: a.address, req });
    if (this.simFail) return { ok: false, stage: 'sim', reason: this.simFail };
    if (this.txFail) return { ok: false, stage: 'tx', reason: 'reverted', hash: '0x01' };
    if (req.functionName === 'open') {
      if (this.gate) await this.gate;
      this.ids += 1n;
      this.chainOpen.add(this.ids.toString());
      const [sym, , , stake] = req.args as [`0x${string}`, boolean, number, bigint, number];
      this.oi += stake;
      return { ok: true, hash: '0x02', logs: [openedLog(this.ids, a.address, sym, 2_000_000_000n)] };
    }
    if (req.functionName === 'deposit') {
      const [amt] = req.args as [bigint];
      this.shares.set(a.address, (this.shares.get(a.address) ?? 0n) + amt);
    }
    return { ok: true, hash: '0x03', logs: [] };
  }
  async head() {
    return this.headN;
  }
  async vaultState() {
    return this.vault;
  }
  async ticketOpen(_b: Address, id: string) {
    return this.chainOpen.has(id);
  }
  async market(): Promise<MarketOnChain> {
    this.marketReads += 1;
    if (this.readGate) await this.readGate;
    return { listed: true, maxLeverage: 20, maxStake: 1000n * USDG, oiCap: 20_000n * USDG, oi: this.oi };
  }
  async lpPosition(_v: Address, lp: Address) {
    if (this.readGate) await this.readGate;
    const s = this.shares.get(lp) ?? 0n;
    return { shares: s, assets: s, maxWithdraw: s };
  }
}

class FakeBell implements BellPort {
  tickAt: number = Date.now();
  book: typeof ADDR | null = ADDR;
  core: string[] | null = ['NVDA', 'SPY'];
  rows: MarketRow[] | null = [
    { symbol: 'NVDA', tradable: true },
    { symbol: 'SPY', tradable: true },
    { symbol: 'AAPL', tradable: true },
    { symbol: 'SATS', tradable: false },
  ];
  registered: string[][] = [];
  registerStatus = 200;
  warms: string[] = [];
  freshAfter = 0; // market() polls until fresh
  polls = 0;
  bots: number | null = null;
  open: OpenTicket[] = [];
  tickets = new Map<string, OpenTicket>();
  flag = true;
  async state(): Promise<BellState> {
    return { book: this.book, clockUnix: 1_800_000_000, lastTickAt: this.tickAt, core: this.core, bots: this.bots, open: 0 };
  }
  async markets() {
    return this.rows;
  }
  async market(symbol: string): Promise<MarketRow | null> {
    this.polls += 1;
    return { symbol, tradable: true, fresh: this.polls > this.freshAfter };
  }
  async warm(symbol: string) {
    this.warms.push(symbol);
    return true;
  }
  async closes() {
    return [100, 101, 102];
  }
  ownerQueries: string[] = [];
  async ownerTickets(owner: string) {
    this.ownerQueries.push(owner);
    return this.open.filter((t) => t.owner.toLowerCase() === owner.toLowerCase());
  }
  async ticket(id: string) {
    return this.tickets.get(id) ?? { id, owner: '0x', symbol: 'X', expiry: 0, status: 'open', bot: this.flag };
  }
  async registerBots(addresses: string[]) {
    this.registered.push(addresses);
    return this.registerStatus;
  }
}

const accounts = (n: number) => Array.from({ length: n }, () => privateKeyToAccount(generatePrivateKey()) as Account);

function setup(opts: { traders?: number; lps?: number; now?: () => number } = {}) {
  const chain = new FakeChain();
  const bell = new FakeBell();
  const logs: string[] = [];
  const fleet = new Fleet(accounts(opts.traders ?? 4), accounts(opts.lps ?? 2), chain, bell, {
    intervalMs: 3000,
    core: null,
    rng: seeded(42),
    sleep: async () => {},
    log: (l) => logs.push(l),
    freshPollMs: 0,
    now: opts.now,
  });
  return { chain, bell, fleet, logs };
}

describe('maintenance', () => {
  test('funds every wallet, approves book and vault once each, registers all addresses', async () => {
    const { chain, bell, fleet } = setup();
    await fleet.maintain();
    expect(chain.eth.size).toBe(6);
    expect(chain.usdg.size).toBe(4); // traders only; LPs are funded at deposit time
    for (const v of chain.usdg.values()) expect(v).toBe(5000n * USDG);
    expect(chain.approvals.length).toBe(12);
    expect(bell.registered.length).toBe(1);
    expect(bell.registered[0]!.length).toBe(6);
    await fleet.maintain();
    expect(chain.approvals.length).toBe(12);
    expect(bell.registered.length).toBe(1);
  });
  test('symbols: core from the bell, non-core = the rest of the tradable rows', async () => {
    const { fleet } = setup();
    await fleet.maintain();
    expect(fleet.core).toEqual(['NVDA', 'SPY']);
    expect(fleet.nonCore).toEqual(['AAPL']);
  });
  test('bell without /markets: core only (default list when the bell gives none)', async () => {
    const { bell, fleet } = setup();
    bell.rows = null;
    bell.core = null;
    await fleet.maintain();
    expect(fleet.core).toContain('NVDA');
    expect(fleet.core.length).toBe(14);
    expect(fleet.nonCore).toEqual([]);
  });
  test('re-registers when the bell lists fewer bots (state moved aside)', async () => {
    const { bell, fleet } = setup();
    await fleet.maintain();
    bell.bots = 0;
    await fleet.maintain();
    expect(bell.registered.length).toBe(2);
  });
  test('fork reset (head went back) clears open counts and re-registers', async () => {
    const { chain, bell, fleet } = setup();
    await fleet.maintain();
    chain.headN = 10n;
    const s = await bell.state();
    expect(fleet.applyState(s, 10n)).toBe(true);
    expect(fleet.stats.resets).toBe(1);
    await fleet.maintain();
    expect(bell.registered.length).toBe(2);
  });
  test('open counts come from the bell', async () => {
    const { bell, fleet } = setup();
    const owner = fleet.traders[0]!.address.toLowerCase();
    bell.open = [1, 2, 3].map((i) => ({ id: String(i), owner, symbol: 'NVDA', expiry: 0, status: 'open' }));
    await fleet.maintain();
    expect(fleet.fleetOpen()).toBe(3);
  });
  test('indexer lag: confirmed local opens the bell has not indexed stay counted (chain says open)', async () => {
    const { bell, fleet } = setup({ traders: 1 });
    await fleet.maintain();
    for (let i = 0; i < 6; i++) expect(await fleet.tryOpen()).toBe('opened');
    bell.open = []; // nothing indexed yet
    await fleet.maintain();
    expect(fleet.fleetOpen()).toBe(6);
    expect(await fleet.tryOpen()).toBe('bot-cap');
  });
  test('reconciliation: ids the bell lists settled or the chain shows closed leave; bell-only open rows join', async () => {
    const { bell, chain, fleet } = setup({ traders: 1 });
    await fleet.maintain();
    for (let i = 0; i < 4; i++) expect(await fleet.tryOpen()).toBe('opened');
    const owner = fleet.traders[0]!.address.toLowerCase();
    bell.open = [
      { id: '1', owner, symbol: 'NVDA', expiry: 0, status: 'settled' },
      { id: '2', owner, symbol: 'NVDA', expiry: 0, status: 'open' },
      { id: '99', owner, symbol: 'SPY', expiry: 0, status: 'open' }, // opened by an earlier process
    ];
    chain.chainOpen.delete('3'); // settled, not indexed
    await fleet.maintain();
    expect([...fleet.open.get(owner)!].sort()).toEqual(['2', '4', '99']);
    expect(bell.ownerQueries).toContain(owner);
  });
  test('no book yet: waits', async () => {
    const { bell, fleet, chain } = setup();
    bell.book = null;
    await fleet.maintain();
    expect(chain.eth.size).toBe(0);
    expect(await fleet.tryOpen()).toBe('no-book');
  });
});

describe('opens', () => {
  test('opens through the book with stake 5 to 250 USDG and valid params', async () => {
    const { chain, fleet } = setup({ traders: 6 });
    await fleet.maintain();
    for (let i = 0; i < 30; i++) expect(await fleet.tryOpen()).toBe('opened');
    const opens = chain.writes.filter((w) => w.req.functionName === 'open');
    expect(opens.length).toBe(30);
    for (const w of opens) {
      expect(w.req.address).toBe(ADDR.ticketBook);
      const [sym, long, lev, stake, hz] = w.req.args as [`0x${string}`, boolean, number, bigint, number];
      expect(['NVDA', 'SPY', 'AAPL']).toContain(hexToString(sym, { size: 32 }).replace(/\0+$/, ''));
      expect(typeof long).toBe('boolean');
      expect([2, 5, 10, 20]).toContain(lev);
      expect(stake >= 5n * USDG && stake <= 250n * USDG).toBe(true);
      expect([0, 1, 2]).toContain(hz);
    }
    expect(fleet.fleetOpen()).toBe(30);
  });
  test('non-core: POST /warm then waits for fresh before sending', async () => {
    const { bell, fleet, chain } = setup();
    bell.core = [];
    await fleet.maintain();
    fleet.core = [];
    bell.freshAfter = 3;
    expect(await fleet.tryOpen()).toBe('opened');
    expect(bell.warms).toEqual(['AAPL']);
    expect(bell.polls).toBe(4);
    expect(chain.writes.filter((w) => w.req.functionName === 'open').length).toBe(1);
  });
  test('non-core that never turns fresh is skipped, nothing sent', async () => {
    let t = 1_000_000;
    const { bell, fleet, chain } = setup({ now: () => (t += 1000) });
    bell.tickAt = t + 5000;
    await fleet.maintain();
    fleet.core = [];
    bell.freshAfter = 1e9;
    expect(await fleet.tryOpen()).toBe('not-fresh');
    expect(bell.polls).toBeGreaterThan(5);
    expect(chain.writes.filter((w) => w.req.functionName === 'open').length).toBe(0);
  });
  test('guards: vault free under 40 % blocks', async () => {
    const { chain, fleet } = setup();
    await fleet.maintain();
    chain.vault = { free: 3_000_000n * USDG, assets: 10_000_000n * USDG };
    expect(await fleet.tryOpen()).toBe('vault-free');
    expect(chain.writes.filter((w) => w.req.functionName === 'open').length).toBe(0);
  });
  test('guards: oi near 80 % of the cap blocks', async () => {
    const { chain, fleet } = setup();
    await fleet.maintain();
    chain.oi = 15_999n * USDG;
    expect(await fleet.tryOpen()).toBe('oi-cap');
  });
  test('guards: a stalled bell pauses opens', async () => {
    const { bell, fleet } = setup();
    bell.tickAt = Date.now() - 25_000;
    await fleet.maintain();
    expect(await fleet.tryOpen()).toBe('bell-stalled');
  });
  test('concurrent opens: the fleet cap counts opens in flight', async () => {
    const { chain, fleet } = setup({ traders: 28 });
    await fleet.maintain();
    let n = 0;
    for (const set of fleet.open.values()) for (let i = 0; i < 6 && n < 149; i++, n++) set.add(`x${n}`);
    expect(fleet.fleetOpen()).toBe(149);
    let release!: () => void;
    chain.gate = new Promise<void>((r) => (release = r));
    const runs = Array.from({ length: 4 }, () => fleet.tryOpen());
    release();
    const out = await Promise.all(runs);
    expect(out.filter((x) => x === 'opened').length).toBe(1);
    expect(out.filter((x) => x === 'fleet-cap').length).toBe(3);
    expect(fleet.fleetOpen()).toBe(150);
  });
  test('concurrent opens on one symbol: the second waits its turn, so each reads the OI the last one left', async () => {
    const { chain, fleet } = setup({ traders: 4 });
    await fleet.maintain();
    fleet.core = ['NVDA'];
    fleet.nonCore = [];
    let release!: () => void;
    chain.gate = new Promise<void>((r) => (release = r));
    const runs = [fleet.tryOpen(), fleet.tryOpen()];
    release();
    expect((await Promise.all(runs)).sort()).toEqual(['opened', 'symbol-busy']);
    chain.gate = null;
    chain.oi = 15_999n * USDG; // the next open reads OI after the first one landed
    expect(await fleet.tryOpen()).toBe('oi-cap');
  });
  test('registration failure pauses opens and LP steps (no unflagged rows), success resumes', async () => {
    let now = 1_000_000;
    const { bell, chain, fleet } = setup({ now: () => now });
    bell.tickAt = now;
    bell.registerStatus = 401;
    await fleet.maintain();
    expect(fleet.isRegistered).toBe(false);
    expect(await fleet.tryOpen()).toBe('unregistered');
    await fleet.lpStep(fleet.lps[0]!, 0);
    now += 120_000;
    bell.tickAt = now;
    await fleet.lpStep(fleet.lps[0]!, 0);
    expect(chain.writes.filter((w) => w.req.functionName !== 'approve').length).toBe(0);
    bell.registerStatus = 200;
    await fleet.maintain();
    expect(await fleet.tryOpen()).toBe('opened');
    bell.bots = 0; // bell state moved aside, re-registration fails
    bell.registerStatus = 500;
    await fleet.maintain();
    expect(await fleet.tryOpen()).toBe('unregistered');
  });
  test('registration failing while an open or LP step awaits its reads: nothing is sent', async () => {
    let now = 1_000_000;
    const { bell, chain, fleet } = setup({ now: () => now });
    bell.tickAt = now;
    await fleet.maintain();
    expect(fleet.isRegistered).toBe(true);
    let release!: () => void;
    chain.readGate = new Promise<void>((r) => (release = r));
    const open = fleet.tryOpen();
    await fleet.lpStep(fleet.lps[0]!, 0); // first call only schedules
    now += 120_000;
    bell.tickAt = now;
    const lp = fleet.lpStep(fleet.lps[0]!, 0);
    await new Promise((r) => setTimeout(r, 5));
    expect(chain.marketReads).toBe(1); // the open is paused in chain.market()
    bell.registerStatus = 401; // bell registry reset, re-registration refused
    await fleet.register();
    release();
    expect(await open).toBe('unregistered');
    await lp;
    expect(chain.writes.filter((w) => w.req.functionName !== 'approve').length).toBe(0);
    expect(fleet.stats.opens).toBe(0);
    expect(fleet.stats.lpOps).toBe(0);
  });
  test('write guard: opens and LP writes carry it; it drops the send once registration is gone', async () => {
    const { chain, fleet } = setup();
    await fleet.maintain();
    expect(await fleet.tryOpen()).toBe('opened');
    const g = chain.writes.find((w) => w.req.functionName === 'open')!.req.guard!;
    expect(g()).toBeNull();
    (fleet as unknown as { registered: boolean }).registered = false;
    expect(g()).toBe('unregistered');
  });
  test('long-running mode keeps no opened-id history; reason keys stay bounded', async () => {
    const { chain, fleet } = setup({ traders: 6 });
    await fleet.maintain();
    for (let i = 0; i < 10; i++) expect(await fleet.tryOpen()).toBe('opened');
    expect(fleet.lastOpened.length).toBe(0);
    for (let i = 0; i < 40; i++) {
      chain.simFail = `ERC20InsufficientBalance(0x${i.toString(16)}, ${i}, ${i * 7})`;
      fleet.reverts.backoffUntil = 0;
      await fleet.tryOpen();
    }
    expect(Object.keys(fleet.reverts.byReason).length).toBe(1);
  });
  test('guards: 6 open per bot, then other bots, then bot-cap', async () => {
    const { fleet } = setup({ traders: 2 });
    await fleet.maintain();
    for (let i = 0; i < 12; i++) expect(await fleet.tryOpen()).toBe('opened');
    expect(await fleet.tryOpen()).toBe('bot-cap');
    for (const s of fleet.open.values()) expect(s.size).toBe(6);
  });
  test('5 consecutive simulate rejects start a 60 s back-off', async () => {
    let now = 1_000_000;
    const { chain, bell, fleet } = setup({ now: () => now });
    bell.tickAt = now;
    await fleet.maintain();
    chain.simFail = 'Stale';
    for (let i = 0; i < 5; i++) expect(await fleet.tryOpen()).toBe('sim:Stale');
    expect(await fleet.tryOpen()).toBe('backoff');
    now += 61_000;
    fleet.lastTickAt = now;
    chain.simFail = null;
    expect(await fleet.tryOpen()).toBe('opened');
    expect(fleet.stats.simRejects).toBe(5);
    expect(fleet.stats.txReverts).toBe(0);
    expect(fleet.statsLine()).toContain('sim:Stale:5');
  });
});

describe('LPs', () => {
  test('staggered first deposit of 25k to 150k, then at most 10 % about every 20 minutes', async () => {
    let now = 1_000_000;
    const { chain, fleet } = setup({ now: () => now });
    await fleet.maintain();
    const lp = fleet.lps[0]!;
    await fleet.lpStep(lp, 0); // schedules
    expect(chain.writes.length).toBe(0);
    now += 70_000;
    await fleet.lpStep(lp, 0);
    const d = chain.writes.filter((w) => w.req.functionName === 'deposit');
    expect(d.length).toBe(1);
    const amt = (d[0]!.req.args as [bigint])[0];
    expect(amt >= 25_000n * USDG && amt <= 150_000n * USDG).toBe(true);
    expect(d[0]!.req.address).toBe(ADDR.vault);
    expect(chain.usdg.get(lp.address)! >= amt).toBe(true);
    await fleet.lpStep(lp, 0); // not due yet
    expect(chain.writes.length).toBe(1);
    now += 26 * 60_000;
    await fleet.lpStep(lp, 0);
    expect(chain.writes.length).toBe(2);
    const second = chain.writes[1]!;
    expect(['deposit', 'withdraw']).toContain(second.req.functionName);
    expect((second.req.args as [bigint])[0] <= amt / 10n).toBe(true);
  });
});

describe('--once', () => {
  test('opens N, verifies the bot flag, ok with 0 reverts', async () => {
    const { fleet } = setup();
    const r = await fleet.once(10);
    expect(r.ok).toBe(true);
    expect(r.opened).toBe(10);
    expect(r.txReverts).toBe(0);
    expect(r.botFlagged).toBe(10);
    expect(r.ids.length).toBe(10);
  });
  test('not ok when the bell does not flag the rows', async () => {
    let now = 1_000_000;
    const { bell, fleet } = setup({ now: () => (now += 500) });
    bell.flag = false;
    bell.state = async () => ({ book: ADDR, clockUnix: 1, lastTickAt: now, core: ['NVDA'], bots: null, open: 0 });
    const r = await fleet.once(3, { verifyMs: 2000 });
    expect(r.opened).toBe(3);
    expect(r.botFlagged).toBe(0);
    expect(r.ok).toBe(false);
  });
  test('not ok on a reverted transaction', async () => {
    const { chain, fleet } = setup();
    chain.txFail = true;
    const r = await fleet.once(2, { deadlineMs: 60_000 });
    expect(r.ok).toBe(false);
    expect(r.txReverts).toBeGreaterThan(0);
  });
});
