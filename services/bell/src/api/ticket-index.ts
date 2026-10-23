// Ticket indexes for the HTTP routes: per symbol (open tickets, long and short open gross, exposure, 24 h volume),
// per owner (ticket ids, settled totals for the leaderboard) and global counts. The index is built once from
// StateData.tickets and then kept current by the indexer (noteTicket after each TicketOpened and TicketSettled), so
// no request scans all tickets. A new tickets object (resetIndex) or an update the incremental path cannot apply
// (an id out of order, a settled ticket reopening) rebuilds it on the next read.
import { addSettled, feeOf, reserveOf, type LeaderAgg } from '../math';
import type { StateData, TicketRec } from '../store';

interface Contrib {
  owner: string;
  symbol: string;
  open: boolean;
  long: boolean;
  stake: bigint;
  exposure: bigint;
  settled: boolean;
  payout: bigint;
}

export interface SymbolAgg {
  /** Ticket ids in open order (ascending), with the open time and the running gross stake (pref[i] = sum of the
   *  first i stakes) for the 24 h volume. */
  ids: string[];
  openedAt: number[];
  pref: bigint[];
  open: Set<string>;
  longOpen: bigint;
  shortOpen: bigint;
  /** Sum of net stake x leverage over the open tickets (the vault's worst case on this symbol). */
  exposure: bigint;
  /** Settled ticket ids, ascending. */
  settledIds: string[];
}

export interface OwnerAgg extends LeaderAgg {
  ids: string[];
  /** Settled ticket ids, ascending. */
  settledIds: string[];
}

let GEN = 0;

const num = (id: string) => Number(id);

function netOf(t: TicketRec, feeBps: number): bigint {
  const stake = BigInt(t.stake);
  return t.netStake !== undefined ? BigInt(t.netStake) : stake - feeOf(stake, BigInt(feeBps));
}

function contribOf(t: TicketRec, feeBps: number): Contrib {
  const stake = BigInt(t.stake);
  const open = t.status === 'open';
  return { owner: t.owner, symbol: t.symbol, open, long: t.long, stake, exposure: open ? reserveOf(netOf(t, feeBps), t.leverage) : 0n, settled: !open, payout: BigInt(t.payout ?? '0') };
}

/** Index of the first element of a nondecreasing array that is >= x. */
export function lowerBound(a: readonly number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m]! < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Index of the first id in an ascending id list that is >= id. */
function lowerBoundId(a: readonly string[], id: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (num(a[m]!) < id) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Inserts an id into an ascending id list (settles come roughly in id order, so this is near the end). */
function insertId(a: string[], id: string): void {
  const i = lowerBoundId(a, num(id));
  if (a[i] !== id) a.splice(i, 0, id);
}

export interface TicketQuery {
  owner?: string | null;
  symbol?: string | null;
  status?: 'open' | 'settled' | null;
  /** Only ids below this one. */
  before?: number | null;
  limit: number;
}

export class TicketIndex {
  /** Changes on every applied update; memo keys use it. */
  version = ++GEN;
  stale = false;
  readonly ids: string[] = [];
  readonly contrib = new Map<string, Contrib>();
  readonly bySymbol = new Map<string, SymbolAgg>();
  readonly byOwner = new Map<string, OwnerAgg>();
  readonly open = new Set<string>();
  settledCount = 0;
  /** Settled ticket ids, ascending (GET /tickets?status=settled walks this, not every ticket). */
  readonly settledIds: string[] = [];
  /** Settled tickets in settle order (settledAt nondecreasing), for the day leaderboard. */
  readonly settledLog: { at: number; id: string }[] = [];
  private openSorted: { v: number; ids: string[] } | null = null;

  constructor(readonly tickets: Record<string, TicketRec>, private readonly feeBps: () => number) {}

  private sym(s: string): SymbolAgg {
    let a = this.bySymbol.get(s);
    if (!a) this.bySymbol.set(s, (a = { ids: [], openedAt: [], pref: [0n], open: new Set(), longOpen: 0n, shortOpen: 0n, exposure: 0n, settledIds: [] }));
    return a;
  }
  private owner(o: string): OwnerAgg {
    let a = this.byOwner.get(o);
    if (!a) this.byOwner.set(o, (a = { ids: [], settledIds: [], points: 0, settled: 0, wins: 0, pnl: 0n, staked: 0n }));
    return a;
  }

  private apply(id: string, c: Contrib, sign: 1 | -1): void {
    const s = this.sym(c.symbol);
    if (c.open) {
      if (sign > 0) {
        s.open.add(id);
        this.open.add(id);
      } else {
        s.open.delete(id);
        this.open.delete(id);
      }
      if (c.long) s.longOpen += BigInt(sign) * c.stake;
      else s.shortOpen += BigInt(sign) * c.stake;
      s.exposure += BigInt(sign) * c.exposure;
    }
    if (c.settled) {
      this.settledCount += sign;
      addSettled(this.owner(c.owner), { stake: c.stake, payout: c.payout }, sign);
    }
  }

  /** Applies the current record of one ticket. */
  upsert(t: TicketRec | undefined): void {
    if (!t || this.stale) return;
    const id = t.id;
    const old = this.contrib.get(id);
    const c = contribOf(t, this.feeBps());
    if (old) {
      if (old.owner !== c.owner || old.symbol !== c.symbol || (old.settled && !c.settled)) {
        this.stale = true;
        return;
      }
      this.apply(id, old, -1);
    } else {
      const last = this.ids[this.ids.length - 1];
      if (last !== undefined && num(id) <= num(last)) {
        this.stale = true;
        return;
      }
      this.ids.push(id);
      this.owner(c.owner).ids.push(id);
      const s = this.sym(c.symbol);
      s.ids.push(id);
      // Ids follow block order, so open times are nondecreasing; clamp anyway to keep the volume search valid.
      s.openedAt.push(Math.max(t.openedAt, s.openedAt[s.openedAt.length - 1] ?? t.openedAt));
      s.pref.push(s.pref[s.pref.length - 1]! + c.stake);
    }
    if (c.settled && !old?.settled) {
      this.settledLog.push({ at: t.settledAt ?? 0, id });
      insertId(this.settledIds, id);
      insertId(this.sym(c.symbol).settledIds, id);
      insertId(this.owner(c.owner).settledIds, id);
    }
    this.apply(id, c, 1);
    this.contrib.set(id, c);
    this.version = ++GEN;
  }

  get count(): number {
    return this.ids.length;
  }
  get owners(): number {
    return this.byOwner.size;
  }

  /** Gross stake opened on `symbol` at or after `since` (fork seconds). */
  volumeSince(symbol: string, since: number): bigint {
    const s = this.bySymbol.get(symbol);
    if (!s || !s.ids.length) return 0n;
    const i = lowerBound(s.openedAt, since);
    return s.pref[s.pref.length - 1]! - s.pref[i]!;
  }

  private openIds(): string[] {
    if (this.openSorted?.v !== this.version) this.openSorted = { v: this.version, ids: [...this.open].sort((a, b) => num(a) - num(b)) };
    return this.openSorted.ids;
  }

  /** Tickets newest first (id descending), filtered; walks only the smallest matching id list (settled tickets have
   *  their own lists, so a settled query never walks the open ones). */
  query(q: TicketQuery): TicketRec[] {
    const owner = q.owner?.toLowerCase() ?? null;
    const symbol = q.symbol ?? null;
    const settled = q.status === 'settled';
    let list: readonly string[] = settled ? this.settledIds : this.ids;
    if (owner) {
      const o = this.byOwner.get(owner);
      list = (settled ? o?.settledIds : o?.ids) ?? [];
    }
    if (symbol) {
      const s = this.bySymbol.get(symbol);
      const cand = q.status === 'open' ? (s ? [...s.open].sort((a, b) => num(a) - num(b)) : []) : ((settled ? s?.settledIds : s?.ids) ?? []);
      if (!owner || cand.length < list.length) list = cand;
    } else if (!owner && q.status === 'open') list = this.openIds();
    let i = q.before != null ? lowerBoundId(list, q.before) - 1 : list.length - 1;
    const out: TicketRec[] = [];
    for (; i >= 0 && out.length < q.limit; i--) {
      const t = this.tickets[list[i]!];
      if (!t) continue;
      if (owner && t.owner !== owner) continue;
      if (symbol && t.symbol !== symbol) continue;
      if (q.status && t.status !== q.status) continue;
      out.push(t);
    }
    return out;
  }

  /** Settled tickets with settledAt at or after `since`, from the end of the settle log. */
  settledSince(since: number): TicketRec[] {
    const out: TicketRec[] = [];
    for (let i = this.settledLog.length - 1; i >= 0; i--) {
      const e = this.settledLog[i]!;
      if (e.at < since) break;
      const t = this.tickets[e.id];
      if (t?.status === 'settled') out.push(t);
    }
    return out;
  }
}

const INDEX = new WeakMap<StateData, TicketIndex>();

function build(d: StateData): TicketIndex {
  const ix = new TicketIndex(d.tickets, () => d.feeBps ?? 100);
  const all = Object.values(d.tickets).sort((a, b) => num(a.id) - num(b.id));
  for (const t of all) ix.upsert(t);
  ix.settledLog.sort((a, b) => a.at - b.at || num(a.id) - num(b.id));
  ix.version = ++GEN;
  return ix;
}

/** The current index of a state (built on first use, rebuilt after a reset). */
export function indexOf(d: StateData): TicketIndex {
  let ix = INDEX.get(d);
  if (!ix || ix.tickets !== d.tickets || ix.stale) {
    ix = build(d);
    INDEX.set(d, ix);
  }
  return ix;
}

/** Called by the indexer after it changed d.tickets[id]; a no-op until the index is first used. */
export function noteTicket(d: StateData, id: string): void {
  const ix = INDEX.get(d);
  if (ix && ix.tickets === d.tickets) ix.upsert(d.tickets[id]);
}

/** Forces a rebuild on the next read (after a direct edit of d.tickets). */
export function invalidateIndex(d: StateData): void {
  INDEX.delete(d);
}
