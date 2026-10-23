// JSON state file (BELL_STATE_FILE): the indexer's tickets, activity, markets and LP shares, the vault totals and
// hourly history derived from the indexed events, the faucet log, the replay rounds and cursor, the demo bot
// registry and the one-time USDG bootstrap marker. Bigints are kept as decimal strings.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PendingStep } from './replay';

export interface TicketRec {
  id: string;
  owner: string;
  symbol: string;
  long: boolean;
  leverage: number;
  stake: string;
  entryPrice8: string;
  expiry: number;
  openedAt: number;
  openTx: string;
  openBlock: number;
  /** Stake minus the fee in force at the open block (from the indexed FeeSet events); absent in older state. */
  netStake?: string;
  /** 0 session, 1 day, 2 week. TicketOpened does not carry it, so the indexer reads it from getTicket(id) through
   *  eth_call after the event is applied; absent until that read succeeds. */
  horizon?: number;
  status: 'open' | 'settled';
  settlePrice8?: string;
  payout?: string;
  settledAt?: number;
  settleTx?: string;
}
export interface ActivityRec {
  kind: 'open' | 'settle' | 'deposit' | 'withdraw' | 'market';
  id?: string;
  address?: string;
  symbol?: string;
  long?: boolean;
  leverage?: number;
  amount?: string;
  price8?: string;
  payout?: string;
  block: number;
  tx: string;
  logIndex: number;
  at: number;
  /** Position in the activity log, increasing across the whole state (paging key of GET /activity). */
  seq?: number;
}
export interface MarketRec {
  symbol: string;
  reference: string;
  maxLeverage: number;
  maxStake: string;
  oiCap: string;
  maxStaleness: number;
  listedBlock: number;
}
export interface Round {
  t: number;
  price8: string;
}
/** One hourly vault sample (fork time at the start of the hour, the state at the end of the hour before). */
export interface VaultPoint {
  t: number;
  assetsRaw: string;
  reservedRaw: string;
  sharePrice: number;
  /** House pnl: assets minus net LP deposits (raw, signed). */
  pnlRaw: string;
}
/** Vault totals rebuilt from the indexed events (HouseVault.totalAssets = USDG balance minus the open net stakes). */
export interface VaultAcc {
  balanceRaw: string;
  openNetRaw: string;
  reservedRaw: string;
  supplyRaw: string;
  depositsRaw: string;
  history: VaultPoint[];
  /** Set when the state was indexed before these totals existed: they miss the earlier events, so GET /vault shows
   *  no history until the next re-index (resetIndex starts complete totals). */
  partial?: boolean;
}
export interface StateData {
  version: 2;
  /** TicketBook address the indexed data belongs to (lower case); a new deployment resets the index. */
  bookAddress: string | null;
  lastBlock: number;
  /** Hash of block lastBlock when it was indexed; a different hash (or a head below lastBlock) means the fork was
   *  rolled back and the index is rebuilt from the deployment block. */
  lastHash?: string | null;
  /** TicketBook fee in basis points from the latest indexed FeeSet event (null before the first one). */
  feeBps?: number | null;
  tickets: Record<string, TicketRec>;
  activity: ActivityRec[];
  markets: Record<string, MarketRec>;
  lpShares: Record<string, string>;
  faucet: Record<string, number>;
  rounds: Record<string, Round[]>;
  /** range and speed null: the BELL_REPLAY_RANGE and BELL_REPLAY_SPEED defaults. */
  /** pending: the replay step interrupted after its first post (resumed after a restart; null or absent: none). */
  replay: { cursor: number; range: '5d' | '1d' | null; speed: number | null; pending?: PendingStep | null };
  usdgBootstrap: { holder: string; amount: string; tx: string; at: number } | null;
  /** Demo bot addresses (lower case) registered through POST /admin/bots; rows of these owners carry bot: true. */
  bots: string[];
  /** Last activity seq handed out. */
  activitySeq: number;
  vault: VaultAcc;
}

export const ACTIVITY_MAX = 2_000;
export const VAULT_HISTORY_MAX = 2_000;
export const ROUNDS_MAX = 300;

export function emptyVault(): VaultAcc {
  return { balanceRaw: '0', openNetRaw: '0', reservedRaw: '0', supplyRaw: '0', depositsRaw: '0', history: [] };
}

export function emptyState(): StateData {
  return { version: 2, bookAddress: null, lastBlock: -1, lastHash: null, feeBps: null, tickets: {}, activity: [], markets: {}, lpShares: {}, faucet: {}, rounds: {}, replay: { cursor: 0, range: null, speed: null }, usdgBootstrap: null, bots: [], activitySeq: 0, vault: emptyVault() };
}

export function resetIndex(d: StateData, bookAddress: string | null): void {
  d.bookAddress = bookAddress;
  d.lastBlock = -1;
  d.lastHash = null;
  d.feeBps = null;
  d.tickets = {};
  d.activity = [];
  d.markets = {};
  d.lpShares = {};
  // Rounds of the old fork carry timestamps the new one has not reached yet (they would shadow its prints).
  d.rounds = {};
  d.vault = emptyVault();
}

/** Fills what older state files lack: activity seq numbers and the vault totals. */
export function upgradeState(d: StateData, hadVault = true): StateData {
  if (!Array.isArray(d.bots)) d.bots = [];
  if (!hadVault || !d.vault || !Array.isArray(d.vault.history)) d.vault = { ...emptyVault(), ...(d.lastBlock >= 0 ? { partial: true } : {}) };
  let seq = typeof d.activitySeq === 'number' ? d.activitySeq : 0;
  for (const a of d.activity) if (typeof a.seq !== 'number') a.seq = ++seq;
  for (const a of d.activity) if (a.seq! > seq) seq = a.seq!;
  d.activitySeq = seq;
  return d;
}

export class Store {
  data: StateData;
  private dirty = false;
  constructor(readonly path: string | null) {
    this.data = emptyState();
    if (path && existsSync(path)) {
      try {
        const d = JSON.parse(readFileSync(path, 'utf8')) as Partial<StateData>;
        if (d.version === 2) this.data = upgradeState({ ...emptyState(), ...d }, d.vault !== undefined);
      } catch {
        this.data = emptyState();
      }
    }
  }
  touch(): void {
    this.dirty = true;
  }
  save(force = false): void {
    if (!this.path || (!this.dirty && !force)) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path);
    this.dirty = false;
  }
}

export function pushRound(d: StateData, symbol: string, r: Round): void {
  const a = (d.rounds[symbol] ??= []);
  a.push(r);
  if (a.length > ROUNDS_MAX) a.splice(0, a.length - ROUNDS_MAX);
}
