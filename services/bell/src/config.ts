// Environment and the address book (deployments/book.json, written by the deploy script).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getAddress, isAddress, type Address, type Hex } from 'viem';

const HERE = dirname(new URL(import.meta.url).pathname);
export const SERVICE_DIR = resolve(HERE, '..');
export const REPO_DIR = resolve(SERVICE_DIR, '../..');

/** Well-known anvil dev keys (public test keys of every anvil node, never real funds). Account 0 is the house
 *  (faucet, settler, deploy), account 1 the demo signer. */
export const ANVIL_KEY_0: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const ANVIL_KEY_1: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

/** USDG on Robinhood Chain (chain id 4663) and the holder the faucet bootstrap impersonates (Uniswap v4
 *  PoolManager; 37,226,781 USDG at block 91940972, chain read of a fresh fork on 2026-10-18). */
export const USDG_4663: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const USDG_HOLDER_4663: Address = '0x8366a39CC670B4001A1121B8F6A443A643e40951';

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
function key(v: string | undefined, fallback: Hex): Hex {
  return v && /^0x[0-9a-fA-F]{64}$/.test(v.trim()) ? (v.trim() as Hex) : fallback;
}
function addr(v: string | undefined, fallback: Address | null): Address | null {
  return v && isAddress(v.trim()) ? getAddress(v.trim()) : fallback;
}

export const DEFAULT_ORIGINS = [
  'https://play.bellswap.fun',
  'https://v2.bellswap.fun',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
];

export interface Env {
  /** Private anvil URL (never the public eRPC): anvil_* and evm_* calls go here. */
  rpcUrl: string;
  chainId: number;
  port: number;
  origins: string[];
  /** Origin suffixes allowed as well (Pages previews), e.g. ".bellswap-play.pages.dev". */
  originSuffixes: string[];
  adminToken: string | null;
  houseKey: Hex;
  signerKey: Hex;
  bookPath: string;
  stateFile: string;
  catalogPath: string;
  chartsDir: string;
  charts: boolean;
  chartsEthRpc: string;
  /** Replay speed: recorded bars per wall minute (60: one five-minute bar per second, one session in about 78 s). */
  speed: number;
  replay: boolean;
  replayRange: '1d' | '5d';
  /** Hour (UTC) of the daily close on the playground clock; the replay posts the last close at this instant. */
  closeHourUtc: number;
  settleSeconds: number;
  indexSeconds: number;
  faucet: boolean;
  faucetCooldownS: number;
  /** Faucet calls per client IP per hour; high, because a venue network puts many people behind one IP. */
  faucetIpMax: number;
  faucetEthWei: bigint;
  faucetUsdgRaw: bigint;
  usdg: Address | null;
  usdgHolder: Address | null;
  /** Amount moved from the holder to dev account 0 once at boot (raw, 6 decimals). */
  bootstrapUsdgRaw: bigint;
  feeBpsFallback: number;
  /** Age (s) after which the replay recording is fetched again; until then it is frozen (default a week). */
  replayRefreshS: number;
  /** Yahoo range of a recording fetch and the complete sessions kept from it. */
  replayFetchRange: string;
  replaySessions: number;
  /** Always printed while listed; empty: the markets in book.json. */
  coreSymbols: string[];
  /** Coverage threshold for eligibility (raw 5-minute bars / axis length). */
  coverageMin: number;
  /** Replay timeline (fork ts, bar index, isClose) ring file. */
  timelineFile: string;
}

export function loadEnv(e: Record<string, string | undefined> = process.env): Env {
  const stateFile = e.BELL_STATE_FILE || resolve(SERVICE_DIR, 'data/state.json');
  let adminToken = e.BELL_ADMIN_TOKEN || null;
  if (!adminToken && e.BELL_ADMIN_TOKEN_FILE && existsSync(e.BELL_ADMIN_TOKEN_FILE)) adminToken = readFileSync(e.BELL_ADMIN_TOKEN_FILE, 'utf8').trim() || null;
  const range = e.BELL_REPLAY_RANGE === '1d' ? '1d' : '5d';
  return {
    rpcUrl: e.BELL_RPC_URL || 'http://127.0.0.1:8545',
    chainId: Number(e.BELL_CHAIN_ID || 46633),
    port: Number(e.BELL_PORT || e.PORT || 8787),
    origins: list(e.BELL_ORIGINS).length ? list(e.BELL_ORIGINS) : DEFAULT_ORIGINS,
    originSuffixes: list(e.BELL_ORIGIN_SUFFIXES ?? '.bellswap-play.pages.dev,.bellswap-v2-landing.pages.dev'),
    adminToken,
    houseKey: key(e.BELL_HOUSE_KEY, ANVIL_KEY_0),
    signerKey: key(e.BELL_SIGNER_KEY, ANVIL_KEY_1),
    bookPath: e.BELL_BOOK || resolve(REPO_DIR, 'deployments/book.json'),
    stateFile,
    catalogPath: e.BELL_CATALOG || resolve(SERVICE_DIR, 'vendor/catalog.json'),
    chartsDir: e.BELL_CHARTS_DIR || resolve(dirname(stateFile), 'charts'),
    charts: (e.BELL_CHARTS || 'on').toLowerCase() !== 'off',
    chartsEthRpc: e.BELL_CHARTS_ETH_RPC || 'https://gateway.tenderly.co/public/mainnet',
    speed: Math.max(1, Math.min(600, Number(e.BELL_REPLAY_SPEED || 60) || 60)),
    replay: (e.BELL_REPLAY || 'on').toLowerCase() !== 'off',
    replayRange: range,
    closeHourUtc: Number(e.BELL_CLOSE_HOUR_UTC || 21),
    settleSeconds: Number(e.BELL_SETTLE_SECONDS || 4),
    indexSeconds: Number(e.BELL_INDEX_SECONDS || 2),
    faucet: (e.BELL_FAUCET || 'on').toLowerCase() !== 'off',
    faucetCooldownS: Number(e.BELL_FAUCET_COOLDOWN_S || 3600),
    faucetIpMax: Number(e.BELL_FAUCET_IP_MAX || 200),
    faucetEthWei: 50_000_000_000_000_000n, // 0.05 ETH
    faucetUsdgRaw: 1_000_000_000n, // 1,000 USDG, 6 decimals
    usdg: addr(e.BELL_USDG, null),
    usdgHolder: addr(e.BELL_USDG_HOLDER, null),
    bootstrapUsdgRaw: 5_000_000_000_000n, // 5,000,000 USDG
    feeBpsFallback: Number(e.BELL_FEE_BPS || 100),
    replayRefreshS: Math.max(60, Number(e.BELL_REPLAY_REFRESH_S || 604_800) || 604_800),
    replayFetchRange: /^\d+d$/.test(e.BELL_REPLAY_FETCH_RANGE ?? '') ? e.BELL_REPLAY_FETCH_RANGE! : '7d',
    replaySessions: Math.max(1, Math.min(20, Number(e.BELL_REPLAY_SESSIONS || 5) || 5)),
    coreSymbols: list(e.BELL_CORE_SYMBOLS).map((x) => x.toUpperCase()),
    coverageMin: coverageMinOf(e.BELL_COVERAGE_MIN),
    timelineFile: e.BELL_FEED_TIMELINE || resolve(dirname(stateFile), 'feed-timeline.json'),
  };
}

/** BELL_COVERAGE_MIN in [0, 1]; unset, empty or not a number: 0.9 (0 is a valid threshold). */
export function coverageMinOf(v: string | undefined): number {
  const x = v === undefined || v.trim() === '' ? Number.NaN : Number(v);
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.9;
}

// ---------------------------------------------------------------- book.json
export interface Book {
  chainId: number | null;
  /** First block the indexer reads (the deployment block). */
  startBlock: bigint;
  usdg: Address | null;
  vault: Address | null;
  book: Address | null;
  reference: Address | null;
  raw: unknown;
}

/** Reads book.json leniently: addresses at the top level, under "addresses" or under "contracts", with the names the
 *  interfaces use in any case (TicketBook, ticketBook, book; HouseVault, houseVault, vault; DemoSignerReference,
 *  demoSigner, reference; USDG, usdg). The deployment block from deployBlock, startBlock, block or fork.block. */
export function parseBook(doc: unknown): Book {
  const d = (doc ?? {}) as Record<string, any>;
  const pools: Record<string, unknown>[] = [d, d.addresses ?? {}, d.contracts ?? {}];
  const pick = (...names: string[]): Address | null => {
    for (const p of pools) {
      for (const [k, v] of Object.entries(p)) {
        if (names.includes(k.toLowerCase())) {
          const a = typeof v === 'string' ? v : (v as { address?: string })?.address;
          if (typeof a === 'string' && isAddress(a)) return getAddress(a);
        }
      }
    }
    return null;
  };
  const blk = d.deployBlock ?? d.startBlock ?? d.block ?? d.fork?.deployBlock ?? d.fork?.block ?? 0;
  return {
    chainId: typeof d.chainId === 'number' ? d.chainId : typeof d.fork?.chainId === 'number' ? d.fork.chainId : null,
    startBlock: BigInt(typeof blk === 'string' || typeof blk === 'number' ? blk : 0),
    usdg: pick('usdg'),
    vault: pick('housevault', 'vault'),
    book: pick('ticketbook', 'book'),
    reference: pick('demosignerreference', 'demosigner', 'reference'),
    raw: doc,
  };
}

export function loadBook(path: string): Book | null {
  if (!existsSync(path)) return null;
  try {
    const b = parseBook(JSON.parse(readFileSync(path, 'utf8')));
    return b.book ? b : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- catalog (site/public/catalog.json, vendored)
export interface CatalogEntry {
  symbol: string;
  name: string;
  yahooSymbol?: string;
  listedByRobinhood: boolean;
  sector: string | null;
  industry?: string | null;
  marketCap: number | null;
  lastPrice?: number | null;
  logoUrl?: string | null;
  quoteType?: string | null;
  [k: string]: unknown;
}

export function loadCatalog(path: string): CatalogEntry[] {
  if (!existsSync(path)) return [];
  const d = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(d) ? (d as CatalogEntry[]) : [];
}
