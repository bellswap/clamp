// Indexer: eth_getLogs over the TicketBook and HouseVault events from the deployment block into the state file.
import { decodeEventLog, getAddress, numberToHex, type Abi, type Address, type Hex } from 'viem';
import { noteTicket } from './api/ticket-index';
import { vaultMove } from './api/vault';
import { bytes32ToSymbol } from './math';
import { ACTIVITY_MAX, resetIndex, type ActivityRec, type StateData } from './store';

export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  blockHash?: Hex | null;
  transactionHash: Hex;
  logIndex: Hex;
}

export interface Decoded {
  eventName: string;
  args: Record<string, unknown>;
}

export function decodeLog(abi: Abi, log: { topics: Hex[]; data: Hex }): Decoded | null {
  try {
    const d = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: false });
    return { eventName: d.eventName as unknown as string, args: (d.args ?? {}) as Record<string, unknown> };
  } catch {
    return null;
  }
}

function arg(a: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (a[n] !== undefined) return a[n];
  return undefined;
}
const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : typeof v === 'number' ? BigInt(v) : typeof v === 'string' && v ? BigInt(v) : 0n);
const sym = (v: unknown): string => (typeof v === 'string' && v.startsWith('0x') && v.length === 66 ? bytes32ToSymbol(v as Hex) : String(v ?? ''));
const lc = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : '');

/** Within the activity cap, the newest vault events (deposit, withdraw) and market listings are kept up to these
 *  counts before trades push them out, so the vault and listing rows outlive a busy hour of bot trading. */
export const ACTIVITY_KEEP = { vault: 400, market: 100 } as const;
type ActivityClass = 'vault' | 'market' | 'trade';
const classOf = (k: ActivityRec['kind']): ActivityClass => (k === 'deposit' || k === 'withdraw' ? 'vault' : k === 'market' ? 'market' : 'trade');

/** Drops the oldest entries until `max` remain: vault and market entries beyond their keep counts first, then
 *  trades, then the rest. Order is preserved. */
export function trimActivity(list: ActivityRec[], max = ACTIVITY_MAX): ActivityRec[] {
  let over = list.length - max;
  if (over <= 0) return list;
  const n = { vault: 0, market: 0, trade: 0 };
  for (const x of list) n[classOf(x.kind)]++;
  const drop = { vault: 0, market: 0, trade: 0 };
  const take = (c: ActivityClass, k: number) => {
    const t = Math.max(0, Math.min(over, k));
    drop[c] += t;
    over -= t;
  };
  take('vault', n.vault - ACTIVITY_KEEP.vault);
  take('market', n.market - ACTIVITY_KEEP.market);
  take('trade', n.trade);
  take('vault', n.vault - drop.vault);
  take('market', n.market - drop.market);
  return list.filter((x) => {
    const c = classOf(x.kind);
    if (drop[c] > 0) {
      drop[c]--;
      return false;
    }
    return true;
  });
}

function pushActivity(d: StateData, a: ActivityRec): void {
  d.activitySeq = (d.activitySeq ?? 0) + 1;
  a.seq = d.activitySeq;
  d.activity.push(a);
  if (d.activity.length > ACTIVITY_MAX) d.activity = trimActivity(d.activity);
}

const ZERO = '0x0000000000000000000000000000000000000000';

function subShares(d: StateData, owner: string, shares: bigint): void {
  const left = big(d.lpShares[owner]) - shares;
  if (left > 0n) d.lpShares[owner] = left.toString();
  else delete d.lpShares[owner];
}

export interface LogMeta {
  block: number;
  tx: string;
  logIndex: number;
  at: number;
}

/** Applies one decoded event to the state. Returns true when it changed something. */
export function applyEvent(d: StateData, ev: Decoded, m: LogMeta): boolean {
  const a = ev.args;
  switch (ev.eventName) {
    case 'MarketListed': {
      const s = sym(arg(a, 'symbol'));
      d.markets[s] = {
        symbol: s,
        reference: lc(arg(a, 'reference', 'ref', 'source', 'referenceAddress', 'oracle', 'feed')),
        maxLeverage: Number(arg(a, 'maxLeverage') ?? 0),
        maxStake: big(arg(a, 'maxStake')).toString(),
        oiCap: big(arg(a, 'oiCap')).toString(),
        maxStaleness: Number(arg(a, 'maxStaleness') ?? 0),
        listedBlock: m.block,
      };
      pushActivity(d, { kind: 'market', symbol: s, block: m.block, tx: m.tx, logIndex: m.logIndex, at: m.at });
      return true;
    }
    case 'TicketOpened': {
      const id = big(arg(a, 'id', 'ticketId')).toString();
      const owner = lc(arg(a, 'owner', 'trader', 'user'));
      const s = sym(arg(a, 'symbol'));
      const long = Boolean(arg(a, 'long', 'isLong'));
      const leverage = Number(arg(a, 'leverage') ?? 0);
      const stake = big(arg(a, 'stake')).toString();
      const entry = big(arg(a, 'entryPrice8', 'entryPrice', 'entry')).toString();
      const expiry = Number(big(arg(a, 'expiry')));
      const prev = d.tickets[id];
      // The fee in force at the open block (TicketBook.open: net = stake - stake * feeBps / 10_000, rounded down).
      const netStake = d.feeBps != null ? (BigInt(stake) - (BigInt(stake) * BigInt(d.feeBps)) / 10_000n).toString() : undefined;
      d.tickets[id] = { ...(prev ?? {}), id, owner, symbol: s, long, leverage, stake, entryPrice8: entry, expiry, openedAt: m.at, openTx: m.tx, openBlock: m.block, ...(netStake !== undefined ? { netStake } : {}), status: prev?.status === 'settled' ? 'settled' : 'open' };
      noteTicket(d, id);
      if (!prev) vaultMove(d, m.at, { kind: 'open', stake: BigInt(stake), net: netOf(stake, netStake, d.feeBps) });
      pushActivity(d, { kind: 'open', id, address: owner, symbol: s, long, leverage, amount: stake, price8: entry, block: m.block, tx: m.tx, logIndex: m.logIndex, at: m.at });
      return true;
    }
    case 'TicketSettled': {
      const id = big(arg(a, 'id', 'ticketId')).toString();
      const price = big(arg(a, 'settlePrice8', 'settlePrice', 'price8')).toString();
      const payout = big(arg(a, 'payout')).toString();
      const t = d.tickets[id];
      if (!t) vaultMove(d, m.at, { kind: 'settle', payout: BigInt(payout), net: 0n });
      else if (t.status === 'open') vaultMove(d, m.at, { kind: 'settle', payout: BigInt(payout), net: netOf(t.stake, t.netStake, d.feeBps) });
      if (t) {
        t.status = 'settled';
        t.settlePrice8 = price;
        t.payout = payout;
        t.settledAt = m.at;
        t.settleTx = m.tx;
        noteTicket(d, id);
      }
      pushActivity(d, { kind: 'settle', id, address: t?.owner, symbol: t?.symbol, long: t?.long, leverage: t?.leverage, amount: t?.stake, price8: price, payout, block: m.block, tx: m.tx, logIndex: m.logIndex, at: m.at });
      return true;
    }
    case 'FeeSet': {
      d.feeBps = Number(big(arg(a, 'feeBps')));
      return true;
    }
    case 'Transfer': {
      // Vault share transfers between holders; mints and burns are covered by Deposit and Withdraw.
      const from = lc(arg(a, 'from'));
      const to = lc(arg(a, 'to'));
      const v = big(arg(a, 'value', 'amount'));
      if (!from || !to || from === ZERO || to === ZERO || v === 0n) return false;
      subShares(d, from, v);
      d.lpShares[to] = (big(d.lpShares[to]) + v).toString();
      return true;
    }
    case 'Deposit': {
      const owner = lc(arg(a, 'owner', 'receiver'));
      d.lpShares[owner] = (big(d.lpShares[owner]) + big(arg(a, 'shares'))).toString();
      vaultMove(d, m.at, { kind: 'deposit', assets: big(arg(a, 'assets')), shares: big(arg(a, 'shares')) });
      pushActivity(d, { kind: 'deposit', address: owner, amount: big(arg(a, 'assets')).toString(), block: m.block, tx: m.tx, logIndex: m.logIndex, at: m.at });
      return true;
    }
    case 'Withdraw': {
      const owner = lc(arg(a, 'owner'));
      subShares(d, owner, big(arg(a, 'shares')));
      vaultMove(d, m.at, { kind: 'withdraw', assets: big(arg(a, 'assets')), shares: big(arg(a, 'shares')) });
      pushActivity(d, { kind: 'withdraw', address: owner, amount: big(arg(a, 'assets')).toString(), block: m.block, tx: m.tx, logIndex: m.logIndex, at: m.at });
      return true;
    }
    case 'Reserved':
    case 'Released': {
      // HouseVault's events carry the new total; TicketBook's bucket events of the same name do not.
      const total = arg(a, 'totalReserved');
      if (total === undefined) return false;
      vaultMove(d, m.at, { kind: 'reserved', total: big(total) });
      return true;
    }
    default:
      return false;
  }
}

/** Net stake of a ticket: the one booked at open, else stake minus the indexed fee (1% before any FeeSet). */
function netOf(stake: string, netStake: string | undefined, feeBps: number | null | undefined): bigint {
  if (netStake !== undefined) return BigInt(netStake);
  const s = BigInt(stake);
  return s - (s * BigInt(feeBps ?? 100)) / 10_000n;
}

export interface IndexerChain {
  head(): Promise<bigint>;
  getLogs(filter: { address: Address[]; fromBlock: Hex; toBlock: Hex }): Promise<RawLog[]>;
  blockTime(blockNumber: bigint): Promise<number>;
  /** Hash of a block, or null when the chain has no such block. */
  blockHash(blockNumber: bigint): Promise<string | null>;
  /** Horizon of a ticket from the contract (TicketBook.getTicket(id).horizon through eth_call). Optional: without it
   *  the tickets keep no horizon. */
  ticketHorizon?(id: bigint): Promise<number>;
}

/** Most getTicket reads per indexer pass; the rest follow on the next passes. */
export const HORIZON_BATCH = 50;

/** Fills the horizon of indexed tickets that lack it (the TicketOpened event does not carry it), lowest id first, at
 *  most `max` reads. A failed read stops the pass and is retried on the next one; a value outside 0..2 is ignored.
 *  Returns the number of tickets updated. */
export async function backfillHorizons(d: StateData, chain: IndexerChain, max = HORIZON_BATCH): Promise<number> {
  if (!chain.ticketHorizon) return 0;
  const missing = Object.values(d.tickets)
    .filter((t) => t.horizon === undefined)
    .sort((x, y) => Number(BigInt(x.id) - BigInt(y.id)))
    .slice(0, max);
  let n = 0;
  for (const t of missing) {
    let h: number;
    try {
      h = Number(await chain.ticketHorizon(BigInt(t.id)));
    } catch {
      break;
    }
    // The ticket may have been dropped by a reset while the read was in flight.
    if (d.tickets[t.id] !== t || !Number.isInteger(h) || h < 0 || h > 2) continue;
    t.horizon = h;
    n++;
  }
  return n;
}

export const LOG_CHUNK = 2_000n;

/** One indexer pass: logs from lastBlock + 1 (or the deployment block) to the head, applied in order. The index is
 *  rebuilt from the deployment block when the TicketBook changes, when the head is below lastBlock or the hash of
 *  lastBlock changed (the fork was rolled back, e.g. an older anvil snapshot was loaded), or when the state predates
 *  the stored hash. Each chunk is read in full (logs, block times, the hash of its last block) before any event is
 *  applied, and the events and the new watermark are committed together, so a failed read never applies a chunk twice;
 *  a chunk whose last block changed hash during those reads, or whose base (the watermark block) no longer has the
 *  stored hash after them, is not committed (see the loop).
 *  After the logs, tickets without a horizon get it from the contract (backfillHorizons). */
export async function indexOnce(d: StateData, chain: IndexerChain, book: { book: Address; vault: Address | null; startBlock: bigint }, abis: { book: Abi; vault: Abi }): Promise<number> {
  const bookLc = book.book.toLowerCase();
  if (d.bookAddress !== bookLc) resetIndex(d, bookLc);
  const head = await chain.head();
  if (d.lastBlock >= 0) {
    const last = BigInt(d.lastBlock);
    const rolledBack = head < last || !d.lastHash || (await chain.blockHash(last)) !== d.lastHash;
    if (rolledBack) resetIndex(d, bookLc);
  }
  let from = d.lastBlock >= 0 ? BigInt(d.lastBlock) + 1n : book.startBlock;
  if (from > head) return backfillHorizons(d, chain);
  const addrs = [getAddress(book.book), ...(book.vault ? [getAddress(book.vault)] : [])];
  let n = 0;
  const times = new Map<string, number>();
  while (from <= head) {
    const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
    // The hash of the chunk's last block before and after the reads: a rollback in between (logs from the discarded
    // branch, watermark hash from the new one) shows as a change, and the chunk is dropped uncommitted; the next pass
    // starts from the old watermark and its rollback check re-indexes when needed.
    const before = await chain.blockHash(to);
    if (before === null) break;
    const logs = await chain.getLogs({ address: addrs, fromBlock: numberToHex(from), toBlock: numberToHex(to) });
    logs.sort((x, y) => Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) || Number(BigInt(x.logIndex) - BigInt(y.logIndex)));
    const ready: { ev: Decoded; m: LogMeta }[] = [];
    for (const l of logs) {
      const isBook = l.address.toLowerCase() === bookLc;
      const ev = decodeLog(isBook ? abis.book : abis.vault, l);
      if (!ev) continue;
      const bn = BigInt(l.blockNumber);
      let at = times.get(l.blockNumber);
      if (at === undefined) {
        at = await chain.blockTime(bn);
        times.set(l.blockNumber, at);
      }
      ready.push({ ev, m: { block: Number(bn), tx: l.transactionHash, logIndex: Number(BigInt(l.logIndex)), at } });
    }
    const hash = await chain.blockHash(to);
    if (hash !== before) break;
    // The base the chunk is applied on: a rollback after the watermark check (or the previous chunk's commit) but
    // before `before` leaves both chunk hashes on the new branch while the indexed state is still the discarded one.
    if (d.lastBlock >= 0 && (await chain.blockHash(BigInt(d.lastBlock))) !== d.lastHash) break;
    // Commit: no await from here to the watermark.
    for (const r of ready) if (applyEvent(d, r.ev, r.m)) n++;
    d.lastBlock = Number(to);
    d.lastHash = hash;
    from = to + 1n;
  }
  return n + (await backfillHorizons(d, chain));
}
