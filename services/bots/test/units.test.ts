import { describe, expect, test } from 'bun:test';
import { BaseError, ContractFunctionRevertedError, encodeErrorResult } from 'viem';
import { BOOK } from '../src/abi';
import { Bell, parseState, tradableSymbols } from '../src/bell';
import { ANVIL_MNEMONIC, ChainIO, deriveWallets, revertName, usdgSlot, withHeadroom } from '../src/chain';
import { MAX_REASON_KEYS, reasonKey, RevertTracker } from '../src/strategy';
import { DEFAULT_CORE, loadEnv } from '../src/config';
import { parseArgs } from '../src/index';

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

describe('config', () => {
  test('defaults', () => {
    const e = loadEnv({});
    expect(e).toMatchObject({ count: 24, lp: 4, enabled: false, intervalMs: 3000, rpcUrl: 'http://anvil:8545', bellUrl: 'http://bell:8787', healthPort: 8790, core: null, usdgSlot: 1n });
  });
  test('reads the env', () => {
    const e = loadEnv({ BOTS_MNEMONIC: ` ${MNEMONIC} `, BOTS_COUNT: '3', BOTS_LP: '1', BOTS_ENABLED: '1', BOTS_INTERVAL_MS: '500', BOTS_BELL_URL: 'http://x:1/', BOTS_CORE: 'nvda, spy' });
    expect(e).toMatchObject({ mnemonic: MNEMONIC, count: 3, lp: 1, enabled: true, intervalMs: 500, bellUrl: 'http://x:1', core: ['NVDA', 'SPY'] });
  });
  test('rejects nonsense numbers', () => {
    expect(() => loadEnv({ BOTS_COUNT: 'many' })).toThrow();
    expect(() => loadEnv({ BOTS_INTERVAL_MS: '0' })).toThrow();
  });
  test('default core is the 14 book.json markets', () => expect(DEFAULT_CORE.length).toBe(14));
  test('--once N', () => {
    expect(parseArgs(['--once', '50'])).toEqual({ once: 50 });
    expect(parseArgs([])).toEqual({ once: null });
    expect(() => parseArgs(['--once', 'x'])).toThrow();
  });
});

describe('wallets', () => {
  test('traders then LPs, distinct', () => {
    const w = deriveWallets(MNEMONIC, 24, 4);
    expect(w.traders.length).toBe(24);
    expect(w.lps.length).toBe(4);
    expect(new Set([...w.traders, ...w.lps].map((a) => a.address)).size).toBe(28);
  });
  test('refuses the anvil mnemonic (dev keys 0 to 9) and an empty one', () => {
    expect(() => deriveWallets(ANVIL_MNEMONIC, 24, 4)).toThrow(/dev key/);
    expect(() => deriveWallets('', 1, 0)).toThrow(/BOTS_MNEMONIC/);
  });
  test('USDG balance slot keccak256(abi.encode(holder, 1)) matches cast index', () => {
    // cast index address 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 1
    expect(usdgSlot('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')).toBe('0x3c8e904cdb19937d60d41c8d984b1a8803ad6e0891b4f9e032dcec2a22c2c7f5');
  });
  test('revertName decodes custom errors', () => {
    const data = encodeErrorResult({ abi: BOOK, errorName: 'OiCap', args: [1n, 2n] });
    const e = new ContractFunctionRevertedError({ abi: BOOK, data, functionName: 'open' });
    expect(revertName(new BaseError('x', { cause: e }))).toBe('OiCap');
    expect(revertName(new Error('boom\nmore'))).toBe('boom');
  });
});

describe('bell', () => {
  test('parses the current /state (replay.lastTick.at)', () => {
    const s = parseState({ clockUnix: 5, book: { ticketBook: '0xA2Ec435D67B35893b81a87212815DCDd20EE4f9B', vault: '0xB8357F7f41125d4b24AD052c1b7288BeF5C43446', reference: '0x980ea9f1a0C36e1E5f3B6BD451bEf8a7Fe661f97', usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', startBlock: '1' }, replay: { lastTick: { at: 123 } }, counts: { open: 2 } });
    expect(s.book?.ticketBook).toBe('0xA2Ec435D67B35893b81a87212815DCDd20EE4f9B');
    expect(s.lastTickAt).toBe(123);
    expect(s.core).toBeNull();
    expect(s.bots).toBeNull();
    expect(s.open).toBe(2);
  });
  test('parses the 3.2 /state (feed.status, counts.bots)', () => {
    const s = parseState({ book: null, feed: { core: ['nvda'], lastTickAt: 999 }, replay: { lastTick: { at: 1 } }, counts: { bots: 28 } });
    expect(s.book).toBeNull();
    expect(s.lastTickAt).toBe(999);
    expect(s.core).toEqual(['NVDA']);
    expect(s.bots).toBe(28);
  });
  test('tradable rows', () => {
    expect(tradableSymbols([{ symbol: 'a', tradable: true }, { symbol: 'B', tradable: false }, { symbol: 'C', listed: true, covered: true }, { symbol: 'D', listed: true, covered: false }])).toEqual(['A', 'C']);
  });
  test('client: /markets 404 means no route; closes fall back to /prices; admin call carries the bearer', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/markets')) return new Response('{"error":"not found"}', { status: 404 });
      if (url.includes('/candles/')) return new Response('{"error":"not found"}', { status: 404 });
      if (url.includes('/prices/')) return Response.json({ rounds: [{ t: 1, price8: '10000000000' }, { t: 2, price8: '10100000000' }] });
      if (url.endsWith('/admin/bots')) return Response.json({ ok: true });
      if (url.includes('/tickets?')) return Response.json({ tickets: [{ id: '1', status: 'open', owner: '0xa' }, { id: '2', status: 'settled', owner: '0xa' }] });
      return new Response('', { status: 500 });
    }) as unknown as typeof fetch;
    const b = new Bell('http://bell', 'tok', f);
    expect(await b.markets()).toBeNull();
    expect(await b.closes('NVDA')).toEqual([100, 101]);
    expect(await b.registerBots(['0x1'])).toBe(200);
    const admin = calls.find((c) => c.url.endsWith('/admin/bots'))!;
    expect((admin.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(String(admin.init!.body))).toEqual({ addresses: ['0x1'] });
    expect((await b.ownerTickets('0xA')).map((t) => `${t.id}:${t.status}`)).toEqual(['1:open', '2:settled']);
    expect(calls.find((c) => c.url.includes('/tickets?'))!.url).toBe('http://bell/tickets?owner=0xA&status=open&limit=500');
    expect(await new Bell('http://bell', '', f).registerBots(['0x1'])).toBe(0);
  });
});

describe('bounded counters', () => {
  test('reason keys drop numbers and hex, new keys past the cap count as other', () => {
    const t = new RevertTracker();
    t.revert('sim:OiCap(0xabc, 12345)', 0);
    t.revert('sim:OiCap(0xdef, 999)', 0);
    expect(t.byReason).toEqual({ 'sim:OiCap(HEX, N)': 2 });
    const c: Record<string, number> = {};
    for (let i = 0; i < MAX_REASON_KEYS; i++) c[`r${String.fromCharCode(97 + i)}`] = 1;
    expect(reasonKey(c, 'brand new')).toBe('other');
    expect(reasonKey(c, 'ra')).toBe('ra');
  });
});

describe('chain io', () => {
  test('ensureUsdg runs under the address lock: two concurrent top-ups write once; a payout in between is fine', async () => {
    const io = new ChainIO('http://127.0.0.1:1', 46633);
    let bal = 0n;
    let writes = 0;
    const tick = () => new Promise((r) => setTimeout(r, 5));
    (io as unknown as { usdgBalance: () => Promise<bigint> }).usdgBalance = async () => {
      await tick();
      return bal;
    };
    (io as unknown as { rpc: (m: string, p: unknown[]) => Promise<null> }).rpc = async (_m, params) => {
      await tick();
      writes += 1;
      bal = BigInt(params[2] as string) + (writes === 1 ? 7n : 0n); // a payout lands right after the write
      return null;
    };
    const a = '0x00000000000000000000000000000000000000aa';
    const u = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
    const r = await Promise.all([io.ensureUsdg(u, a, 1000n, 5000n), io.ensureUsdg(u, a.toUpperCase().replace('0X', '0x') as typeof a, 1000n, 5000n)]);
    expect(r).toEqual([true, false]);
    expect(writes).toBe(1);
  });
  test('write: gas is estimated with the bare address, not the local account (one eth_estimateGas, no capped re-estimate)', async () => {
    const io = new ChainIO('http://127.0.0.1:1', 46633);
    const seen: unknown[] = [];
    const raw = io as unknown as { pub: { simulateContract: () => Promise<unknown>; estimateContractGas: (c: { account: unknown }) => Promise<bigint> }; wallet: () => { writeContract: () => Promise<never> } };
    raw.pub.simulateContract = async () => ({ request: {} });
    raw.pub.estimateContractGas = async (c) => {
      seen.push(c.account);
      throw new Error('stop after the estimate');
    };
    const a = { address: '0x00000000000000000000000000000000000000aa', type: 'local' } as never;
    const req = { address: '0x00000000000000000000000000000000000000bb' as const, abi: BOOK, functionName: 'open', args: [] };
    expect((await io.write(a, req)).ok).toBe(false);
    expect(seen).toEqual(['0x00000000000000000000000000000000000000aa']);
  });
  test('write guard: checked before the simulation and again before the send; a reason drops the write unsent', async () => {
    const io = new ChainIO('http://127.0.0.1:1', 46633);
    let ok = true;
    let sims = 0;
    let sends = 0;
    const raw = io as unknown as { pub: { simulateContract: () => Promise<unknown>; estimateContractGas: () => Promise<bigint> }; wallet: () => { writeContract: () => Promise<never> } };
    raw.pub.estimateContractGas = async () => 100_000n;
    raw.pub.simulateContract = async () => {
      sims += 1;
      ok = false; // registration lost while the simulation runs
      return { request: {} };
    };
    raw.wallet = () => ({
      writeContract: async () => {
        sends += 1;
        throw new Error('unexpected send');
      },
    });
    const a = { address: '0x00000000000000000000000000000000000000aa' } as never;
    const req = { address: '0x00000000000000000000000000000000000000bb' as const, abi: BOOK, functionName: 'open', args: [], guard: () => (ok ? null : 'unregistered') };
    expect(await io.write(a, req)).toEqual({ ok: false, stage: 'guard', reason: 'unregistered' });
    expect([sims, sends]).toEqual([1, 0]);
    expect(await io.write(a, req)).toEqual({ ok: false, stage: 'guard', reason: 'unregistered' });
    expect([sims, sends]).toEqual([1, 0]);
  });
});

describe('withHeadroom', () => {
  test('adds 30%, rounded up', () => {
    expect(withHeadroom(100_000n)).toBe(130_000n);
    expect(withHeadroom(1n)).toBe(2n);
    expect(withHeadroom(21_001n)).toBe(27_302n);
  });
});
