// Shapes the site reads from the bell v2 service (docs/INTERFACES.md, Service). The normalisers in lib/bell.ts accept
// USDG amounts as numbers (USDG) or as digit strings in raw 6-decimal units, and prices as numbers or as raw 8-decimal
// strings under the *8 keys (entryPrice8, settlePrice8, price8), so either service encoding reads the same.
export interface CatalogEntry {
  symbol: string;
  display: string;
  name: string;
  sector: string | null;
  marketCap: number | null;
  lastPrice: number | null;
  listedByRobinhood: boolean;
  /** The symbol has a market on the TicketBook (from GET /catalog); true for every entry in mock mode. */
  onChain: boolean;
}

export interface BellState {
  chainId: number;
  block: number;
  clockUnix: number | null;
  speed: number;
  /** tickets, open, settled, addresses, markets, lps and (since the bot registry) bots. */
  counts: Record<string, number>;
  /** bars and source name the recording (GET /state since the feed module). */
  replay?: { running?: boolean; bar?: number; bars?: number; source?: string | null };
  /** Fork unix second of the next 21:00 UTC close (GET /state since the feed module); absent on an older bell. */
  nextClose?: number | null;
}

/** One catalog symbol on GET /markets. USDG amounts in USDG (the *Raw strings scaled), prices as numbers. */
export interface MarketRow {
  symbol: string;
  /** The symbol has a market on the TicketBook. */
  listed: boolean;
  /** The recording has a series for it (D1 coverage rule). */
  covered: boolean;
  /** listed and covered: tickets can open. */
  tradable: boolean;
  /** In the current print set (core, warm, due or watchdog). */
  hot: boolean;
  /** The playground price: the value the next print carries. */
  price: number | null;
  prevClose: number | null;
  /** The service's change figure (a fraction). */
  chg: number | null;
  sessionOpen: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  /** Closes of the current playground session, at most 80. */
  spark: number[];
  openCount: number;
  oi: number;
  longOpen: number;
  shortOpen: number;
  oiCap: number;
  maxStake: number;
  maxLeverage: number;
  volume24h: number;
  lastRound: { t: number; price: number } | null;
  /** GET /markets/:symbol only: the bell's tick-counted wall seconds to its session, day and week expiries; null when
   *  it gives none (paused replay, an older bell). */
  eta?: BellEta | null;
}

/** The bell's tick-counted wall ETAs (GET /markets/:symbol etaWall): wall seconds to each of its expiries as of wall ms
 *  `atMs`. The bell walks the recording itself, so a short session, the night jump and the daylight offset are exact. */
export interface BellEta { atMs: number; points: readonly { expiry: number; wallS: number }[] }

export interface MarketsView { clockUnix: number | null; nextClose: number | null; markets: MarketRow[] }

export interface PriceRound { t: number; price: number }

export type TicketStatus = 'open' | 'settling' | 'won' | 'lost' | 'refunded';

export interface TicketView {
  id: string;
  owner: string;
  symbol: string;
  long: boolean;
  leverage: number;
  /** 0 session, 1 day, 2 week; null when the service answer omits it (the label is then hidden). */
  horizon: number | null;
  /** USDG, fee included. */
  stake: number;
  /** USDG after the fee. */
  net: number;
  entryPrice: number;
  openedAt: number;
  expiry: number;
  status: TicketStatus;
  payout: number | null;
  settlePrice: number | null;
  settledAt: number | null;
  /** The owner is a registered demo trader (bell bot registry); absent on an older bell. */
  bot?: boolean;
}

export type ActivityKind = 'open' | 'settle' | 'deposit' | 'withdraw' | 'market';
export const ACTIVITY_KINDS: readonly ActivityKind[] = ['open', 'settle', 'deposit', 'withdraw', 'market'];

export interface ActivityItem {
  /** Ticket opens and settlements, vault deposits and withdrawals, market listings. */
  kind: ActivityKind;
  id: string;
  owner: string;
  symbol: string;
  long: boolean;
  leverage: number;
  stake: number;
  payout: number | null;
  t: number;
  /** Store sequence number (paging cursor); absent on an older bell. */
  seq?: number;
  /** The address is a registered demo trader. */
  bot?: boolean;
}

export interface ActivityQuery { address?: string; symbol?: string; kinds?: readonly ActivityKind[]; limit?: number; before?: number }

export interface LeaderRow { address: string; settled: number; wins: number; staked: number; pnl: number; roiPct: number; points?: number; bot?: boolean }
export interface Leaderboard { minStaked: number; rows: LeaderRow[] }

export interface VaultPoint { t: number; assets: number; reserved: number; sharePrice: number }
export interface VaultView {
  assets: number;
  reserved: number;
  free: number;
  lpCount: number;
  pnl7d: number[];
  pnl7dTotal: number;
  /** USDG per vault share; null on an older bell. */
  sharePrice?: number | null;
  /** reserved / assets as a fraction; null on an older bell. */
  utilization?: number | null;
  /** One point per fork hour, oldest first. */
  history?: VaultPoint[];
}

export interface Balances { usdg: number; eth: number }
