// Service side of the ticket horizon: the horizon per ticket (0 session, 1 day, 2 week). TicketOpened does not carry it, so the
// indexer reads it from TicketBook.getTicket(id) through eth_call. The fixture was captured from a local anvil
// (--chain-id 46633) with three tickets opened at horizon 0, 1 and 2.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionResult, type Address, type Hex } from 'viem';
import { abis } from '../src/abi';
import { App } from '../src/app';
import { loadEnv } from '../src/config';
import { backfillHorizons, indexOnce, type IndexerChain, type RawLog } from '../src/indexer';
import { handler } from '../src/server';
import { emptyState } from '../src/store';

const fx = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/horizon.json'), 'utf8')) as { book: Address; head: Hex; logs: RawLog[]; getTicket: Record<string, Hex> };
const HEAD = BigInt(fx.head);
const BOOK = { book: fx.book, vault: null, startBlock: 0n };

/** Serves the fixture logs; ticketHorizon decodes the captured getTicket result with the contracts-build ABI.
 *  `failFor` makes the read for those ids throw (an RPC error). */
function chain(o: { failFor?: Set<string>; withHorizon?: boolean } = {}): IndexerChain & { reads: string[] } {
  const reads: string[] = [];
  const c: IndexerChain & { reads: string[] } = {
    reads,
    head: async () => HEAD,
    getLogs: async (f) => fx.logs.filter((l) => BigInt(l.blockNumber) >= BigInt(f.fromBlock) && BigInt(l.blockNumber) <= BigInt(f.toBlock)),
    blockTime: async (bn) => 1_792_300_000 + Number(bn),
    blockHash: async (bn) => (bn <= HEAD ? `0xh${bn}` : null),
  };
  if (o.withHorizon !== false) {
    c.ticketHorizon = async (id) => {
      const k = id.toString();
      reads.push(k);
      if (o.failFor?.has(k)) throw new Error('rpc down');
      const raw = fx.getTicket[k];
      if (!raw) throw new Error('no ticket');
      const t = decodeFunctionResult({ abi: abis.book, functionName: 'getTicket', data: raw }) as { horizon: number };
      return Number(t.horizon);
    };
  }
  return c;
}

describe('horizon per ticket', () => {
  test('the indexer fills the horizon of each ticket from getTicket after the logs', async () => {
    const d = emptyState();
    await indexOnce(d, chain(), BOOK, abis);
    expect(Object.keys(d.tickets).sort()).toEqual(['1', '2', '3']);
    expect([d.tickets['1']!.horizon, d.tickets['2']!.horizon, d.tickets['3']!.horizon]).toEqual([0, 1, 2]);
  });

  test('a failed read leaves the horizon missing; a later pass with no new blocks backfills it, without rereads', async () => {
    const d = emptyState();
    await indexOnce(d, chain({ failFor: new Set(['2']) }), BOOK, abis);
    expect(d.tickets['1']!.horizon).toBe(0);
    expect(d.tickets['2']!.horizon).toBeUndefined();
    expect(d.tickets['3']!.horizon).toBeUndefined(); // the pass stops at the first failed read
    const c = chain();
    const n = await indexOnce(d, c, BOOK, abis);
    expect(n).toBe(2);
    expect(c.reads).toEqual(['2', '3']);
    expect([d.tickets['2']!.horizon, d.tickets['3']!.horizon]).toEqual([1, 2]);
  });

  test('without a contract read and for values outside 0..2 the horizon stays missing', async () => {
    const d = emptyState();
    await indexOnce(d, chain({ withHorizon: false }), BOOK, abis);
    expect(d.tickets['1']!.horizon).toBeUndefined();
    const bad: IndexerChain = { ...chain(), ticketHorizon: async () => 7 };
    expect(await backfillHorizons(d, bad)).toBe(0);
    expect(d.tickets['1']!.horizon).toBeUndefined();
  });

  test('GET /tickets and GET /tickets/:id return the horizon, null while it is unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bell-horizon-'));
    const app = new App(loadEnv({ BELL_RPC_URL: 'http://127.0.0.1:1', BELL_STATE_FILE: join(dir, 'state.json'), BELL_BOOK: join(dir, 'none.json'), BELL_CHARTS: 'off', BELL_ADMIN_TOKEN: 'test-token' }));
    app.clock = async () => ({ clock: 1_792_300_000, block: 5 }); // no RPC in this test
    const d = app.store.data;
    await indexOnce(d, chain({ failFor: new Set(['3']) }), BOOK, abis);
    const h = handler(app);
    const list = (await (await h(new Request('http://x/tickets'))).json()) as { tickets: { id: string; horizon: number | null }[] };
    expect(Object.fromEntries(list.tickets.map((t) => [t.id, t.horizon]))).toEqual({ '1': 0, '2': 1, '3': null });
    const one = (await (await h(new Request('http://x/tickets/2'))).json()) as { ticket: { horizon: number | null } };
    expect(one.ticket.horizon).toBe(1);
  });
});
