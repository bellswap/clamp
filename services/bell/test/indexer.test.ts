import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_HOUSE_VAULT, MIN_TICKET_BOOK } from '../src/abi';
import { parseBook } from '../src/config';
import { decodeLog, indexOnce, type IndexerChain, type RawLog } from '../src/indexer';
import { leaderboard } from '../src/math';
import { expiredOpen } from '../src/settler';
import { emptyState } from '../src/store';

const logs = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/logs.json'), 'utf8')) as RawLog[];
const BOOK = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
const VAULT = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as const;
const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

function fakeChain(head: bigint, all: RawLog[]): IndexerChain & { calls: [bigint, bigint][] } {
  const calls: [bigint, bigint][] = [];
  return {
    calls,
    head: async () => head,
    getLogs: async (f) => {
      const a = BigInt(f.fromBlock);
      const b = BigInt(f.toBlock);
      calls.push([a, b]);
      const addrs = f.address.map((x) => x.toLowerCase());
      return all.filter((l) => addrs.includes(l.address.toLowerCase()) && BigInt(l.blockNumber) >= a && BigInt(l.blockNumber) <= b);
    },
    blockTime: async (bn) => 1_792_300_000 + Number(bn) * 10,
    blockHash: async (bn) => (bn <= head ? `0xhash${bn}` : null),
  };
}

describe('indexer', () => {
  test('decodes the fixture logs with the minimal ABI', () => {
    expect(decodeLog(MIN_TICKET_BOOK, logs[0]!)?.eventName).toBe('MarketListed');
    expect(decodeLog(MIN_HOUSE_VAULT, logs[1]!)?.eventName).toBe('Deposit');
    const o = decodeLog(MIN_TICKET_BOOK, logs[2]!)!;
    expect(o.eventName).toBe('TicketOpened');
    expect(o.args.leverage).toBe(5);
    expect(o.args.long).toBe(false);
    expect(decodeLog(MIN_TICKET_BOOK, { topics: ['0x' + '11'.repeat(32)] as `0x${string}`[], data: '0x' })).toBeNull();
  });

  test('builds markets, tickets, LP shares and activity from the deployment block', async () => {
    const d = emptyState();
    const chain = fakeChain(25n, logs);
    const n = await indexOnce(d, chain, { book: BOOK, vault: VAULT, startBlock: 5n }, { book: MIN_TICKET_BOOK, vault: MIN_HOUSE_VAULT });
    expect(n).toBe(4);
    expect(chain.calls[0]).toEqual([5n, 25n]);
    expect(d.lastBlock).toBe(25);
    expect(d.markets.NVDA).toMatchObject({ symbol: 'NVDA', maxLeverage: 20, maxStake: '10000000000', maxStaleness: 600, reference: '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0' });
    expect(d.lpShares[OWNER]).toBe('500000000000');
    const t = d.tickets['1']!;
    expect(t).toMatchObject({ owner: OWNER, symbol: 'NVDA', long: false, leverage: 5, stake: '100000000', entryPrice8: '18000000000', expiry: 1792364400, status: 'settled', settlePrice8: '17640000000', payout: '108900000', openBlock: 12 });
    expect(t.openedAt).toBe(1_792_300_120);
    expect(d.activity.map((a) => a.kind)).toEqual(['market', 'deposit', 'open', 'settle']);
    expect(leaderboard([{ owner: t.owner, stake: BigInt(t.stake), payout: BigInt(t.payout!) }])[0]).toMatchObject({ points: 35, wins: 1, pnlRaw: '8900000', stakedRaw: t.stake, staked: Number(t.stake) / 1e6 });
  });

  test('resumes from lastBlock + 1 and resets when the TicketBook address changes', async () => {
    const d = emptyState();
    await indexOnce(d, fakeChain(15n, logs), { book: BOOK, vault: VAULT, startBlock: 0n }, { book: MIN_TICKET_BOOK, vault: MIN_HOUSE_VAULT });
    expect(d.tickets['1']!.status).toBe('open');
    expect(expiredOpen(d, 1792364400)).toEqual(['1']);
    expect(expiredOpen(d, 1792364399)).toEqual([]);
    const c2 = fakeChain(25n, logs);
    await indexOnce(d, c2, { book: BOOK, vault: VAULT, startBlock: 0n }, { book: MIN_TICKET_BOOK, vault: MIN_HOUSE_VAULT });
    expect(c2.calls[0]).toEqual([16n, 25n]);
    expect(d.tickets['1']!.status).toBe('settled');
    await indexOnce(d, fakeChain(25n, []), { book: '0x0000000000000000000000000000000000000001', vault: null, startBlock: 20n }, { book: MIN_TICKET_BOOK, vault: MIN_HOUSE_VAULT });
    expect(Object.keys(d.tickets)).toEqual([]);
    expect(d.lastBlock).toBe(25);
  });

  test('book.json is read leniently', () => {
    const b = parseBook({ chainId: 46633, deployBlock: 91940972, addresses: { TicketBook: BOOK, HouseVault: VAULT, DemoSignerReference: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0', USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' } });
    expect(b.book).toBe(BOOK);
    expect(b.vault).toBe(VAULT);
    expect(b.startBlock).toBe(91940972n);
    expect(b.usdg).toBe('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
    expect(parseBook({ contracts: { ticketBook: { address: BOOK } } }).book).toBe(BOOK);
    // the shape contracts/script/Deploy.s.sol writes
    const d = parseBook({ chainId: 46633, block: 120, usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', usdgDecimals: 6, vault: VAULT, book: BOOK, demoSigner: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0', signer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', feeBps: 100, markets: [] });
    expect([d.book, d.vault, d.reference, d.startBlock, d.chainId]).toEqual([BOOK, VAULT, '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0', 120n, 46633]);
  });
});

describe('indexer with the ABIs from the contracts build (src/abi, scripts/abi.ts)', () => {
  test('the fixture logs decode to the same state with the built ABIs', async () => {
    const { abis, abiFromBuild } = await import('../src/abi');
    if (!abiFromBuild) return; // generated ABIs are always present since scripts/abi.ts
    const d = emptyState();
    await indexOnce(d, fakeChain(25n, logs), { book: BOOK, vault: VAULT, startBlock: 0n }, abis);
    expect(d.markets.NVDA!.reference).toBe('0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0');
    expect(d.tickets['1']).toMatchObject({ status: 'settled', payout: '108900000', leverage: 5, long: false });
    expect(d.lpShares[OWNER]).toBe('500000000000');
  });
  test('signer digest matches DemoSignerReference (DOMAIN_TAG, chain id, reference, symbol, price8, timestamp)', async () => {
    const { DOMAIN_TAG, roundDigest } = await import('../src/signer');
    const { keccak256, toHex } = await import('viem');
    expect(DOMAIN_TAG).toBe(keccak256(toHex('bellswap.v2.DemoSignerReference.post')));
    expect(roundDigest(46633, VAULT, '0x' + '00'.repeat(32) as `0x${string}`, 1n, 1)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
