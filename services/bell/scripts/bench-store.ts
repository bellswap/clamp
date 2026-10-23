// Store benchmark: N synthetic tickets (default 30,000) applied through the indexer's applyEvent over 513 listed
// markets, then a simulated run of indexed blocks (a few opens and settlements per block, the fork clock moving 150 s
// per block as with two blocks per tick) with requests to the memoized routes after each block. Prints p50, p95 and
// max per route and the state save time; exits 1 when /state, /leaderboard or /markets p95 is 50 ms or more, or a
// save takes 200 ms or more. No network: the chain clock, fee and vault reads are stubbed, prices come from FakeFeed.
//   bun run scripts/bench-store.ts --tickets 30000 [--blocks 200] [--per-block 3]
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeFeed } from '../src/api/fake-feed';
import { indexOf } from '../src/api/ticket-index';
import { App } from '../src/app';
import { loadEnv } from '../src/config';
import { applyEvent } from '../src/indexer';
import { handler } from '../src/server';

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : def;
  if (!Number.isFinite(v) || v < 0) throw new Error(`--${name} must be a number`);
  return v;
}
const N = arg('tickets', 30_000);
const BLOCKS = arg('blocks', 200);
const PER_BLOCK = arg('per-block', 3);

const dir = mkdtempSync(join(tmpdir(), 'bell-bench-'));
const app = new App(loadEnv({ BELL_RPC_URL: 'http://127.0.0.1:1', BELL_STATE_FILE: join(dir, 'state.json'), BELL_BOOK: join(dir, 'none.json'), BELL_CHARTS: 'off', BELL_REPLAY: 'off', BELL_ADMIN_TOKEN: 'bench' }));
const START = 1_800_000_000;
let clock = START;
let block = 1;
app.clock = async () => ({ clock, block });
app.feeBps = async () => 100n;
app.book = { chainId: 46633, startBlock: 1n, usdg: null, vault: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512', book: '0x5FbDB2315678afecb367f032d93F642f64180aa3', reference: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0', raw: {} };
(app.chain.pub as unknown as { readContract: (a: { functionName: string }) => Promise<bigint> }).readContract = async (a) => ({ totalAssets: 10_000_000_000_000n, reserved: 2_000_000_000_000n, free: 8_000_000_000_000n, totalSupply: 10n ** 19n })[a.functionName] ?? 0n;
const d = app.store.data;
d.feeBps = 100;
const symbols = app.catalog.map((e) => e.symbol.toUpperCase());
const core = symbols.slice(0, 14);
const feed = new FakeFeed({ symbols, uncovered: ['SATS'], listed: () => new Set(Object.keys(d.markets)), clock: () => clock, core });
(app as unknown as { feed: FakeFeed }).feed = feed;
const h = handler(app);

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const owners = Array.from({ length: 400 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
d.bots = owners.slice(0, 24);
let logIndex = 0;
const meta = (at: number) => ({ block, tx: `0x${block.toString(16)}`, logIndex: logIndex++, at });

for (const s of symbols) applyEvent(d, { eventName: 'MarketListed', args: { symbol: s, reference: '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0', maxLeverage: 20, maxStake: 1_000_000_000n, oiCap: 20_000_000_000n, maxStaleness: 86_400n } }, meta(START - 2_000_000));
for (let i = 0; i < 20; i++) applyEvent(d, { eventName: 'Deposit', args: { sender: owners[i], owner: owners[i], assets: 100_000_000_000n, shares: 10n ** 17n } }, meta(START - 1_900_000 + i * 600));

let nextId = 1;
const open: number[] = [];
function openOne(at: number) {
  const id = nextId++;
  const sym = rnd() < 0.4 ? core[Math.floor(rnd() * core.length)]! : symbols[Math.floor(rnd() * symbols.length)]!;
  applyEvent(d, { eventName: 'TicketOpened', args: { id: BigInt(id), owner: owners[Math.floor(rnd() * owners.length)], symbol: sym, long: rnd() < 0.5, leverage: [2, 5, 10, 20][Math.floor(rnd() * 4)], stake: BigInt(5 + Math.floor(rnd() * 245)) * 1_000_000n, entryPrice8: 20_000_000_000n, expiry: BigInt(at + 3600) } }, meta(at));
  open.push(id);
}
function settleOne(at: number) {
  if (!open.length) return;
  const id = open.splice(Math.floor(rnd() * Math.min(open.length, 50)), 1)[0]!;
  applyEvent(d, { eventName: 'TicketSettled', args: { id: BigInt(id), settlePrice8: 21_000_000_000n, payout: BigInt(Math.floor(rnd() * 400)) * 1_000_000n } }, meta(at));
}

// History: N tickets over the fork time before START, about 90% settled.
let t0 = performance.now();
const span = 1_500_000;
for (let i = 0; i < N; i++) {
  const at = START - span + Math.floor((i * span) / N);
  openOne(at);
  if (open.length > N * 0.1 || rnd() < 0.9) settleOne(at);
  if (i % 50 === 0) block++;
}
d.lastBlock = block;
const seedMs = performance.now() - t0;
t0 = performance.now();
indexOf(d);
const buildMs = performance.now() - t0;

const ROUTES = ['/state', '/leaderboard', '/leaderboard?period=day', '/markets', '/markets/NVDA', `/tickets?owner=${owners[30]}`, '/tickets?status=open&limit=100', '/activity?kind=deposit', '/vault'];
const times = new Map<string, number[]>(ROUTES.map((r) => [r, []]));
async function hit(path: string) {
  const a = performance.now();
  const r = await h(new Request(`http://x${path}`));
  await r.text();
  times.get(path)!.push(performance.now() - a);
  if (r.status !== 200) throw new Error(`${path}: ${r.status}`);
}

for (let b = 0; b < BLOCKS; b++) {
  block++;
  clock += 150;
  for (let k = 0; k < 2; k++) openOne(clock);
  settleOne(clock);
  d.lastBlock = block;
  for (let k = 0; k < PER_BLOCK; k++) for (const r of ROUTES) await hit(r);
}

const q = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const saves: number[] = [];
for (let i = 0; i < 5; i++) {
  app.store.touch();
  const a = performance.now();
  app.store.save();
  saves.push(performance.now() - a);
}
const bytes = statSync(join(dir, 'state.json')).size;

const f = (x: number) => x.toFixed(2).padStart(8);
console.log(`tickets ${Object.keys(d.tickets).length} (open ${indexOf(d).open.size}), activity ${d.activity.length}, markets ${Object.keys(d.markets).length}, owners ${indexOf(d).owners}, vault history ${d.vault.history.length}`);
console.log(`seed through applyEvent ${seedMs.toFixed(0)} ms, cold index build ${buildMs.toFixed(1)} ms; ${BLOCKS} blocks x ${PER_BLOCK} requests per route`);
console.log(`${'route'.padEnd(36)}     p50      p95      max  (ms)`);
for (const [r, a] of times) console.log(`${r.padEnd(36)}${f(q(a, 0.5))} ${f(q(a, 0.95))} ${f(Math.max(...a))}`);
const saveMax = Math.max(...saves);
console.log(`${'save state.json'.padEnd(36)}${f(q(saves, 0.5))} ${f(q(saves, 0.95))} ${f(saveMax)}  (${(bytes / 1e6).toFixed(1)} MB)`);
const gated = ['/state', '/leaderboard', '/markets'];
const bad = gated.filter((r) => q(times.get(r)!, 0.95) >= 50);
if (saveMax >= 200) bad.push('save');
console.log(bad.length ? `FAIL: ${bad.join(', ')}` : `PASS: p95 under 50 ms for ${gated.join(', ')}; save under 200 ms`);
process.exit(bad.length ? 1 : 0);
