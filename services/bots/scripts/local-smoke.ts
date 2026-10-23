// Local smoke run without a fork: bare anvil, the real contracts (Deploy.s.sol from a copy of contracts/ so the
// repo's deployments/book.json is never written; MockUSDG, balances at slot 0), a minimal stand-in bell (state,
// markets, warm, prices, tickets with the bot flag, admin registry, a round poster signing as dev 1), then
//   1. `bun run src/index.ts --once N` against it (exit code and JSON summary);
//   2. rpc-guard in front of the anvil: dev 0 pause rejected, a fresh key's post to the reference rejected, a fresh
//      key's approve and open through the guard accepted.
//   3. with --run-ms: the long-running fleet (BOTS_ENABLED=1, 500 ms mean interval) for that long; checks a stats
//      line and at least one LP deposit.
// Usage: bun run scripts/local-smoke.ts --dir <scratch dir> [--n 20] [--run-ms 80000] [--port-base 28500]
// Ports: anvil base+45, guard base+46, bell base+287, bots health base+290; the run stops when one is taken, so it
// never tests a stale anvil or guard left over from an earlier run.
// Needs anvil and forge (Foundry 1.7.1) on PATH or in ~/.foundry/bin. The anvil dev keys used here are the public
// anvil defaults; BOTS_MNEMONIC is generated per run and never printed.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, http, keccak256, maxUint256, parseAbi, stringToHex, toHex, type Address, type Hex } from 'viem';
import { english, generateMnemonic, generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i === -1 ? d : args[i + 1]!;
};
const DIR = resolve(opt('--dir', ''));
const N = Number(opt('--n', '20'));
const RUN_MS = Number(opt('--run-ms', '0'));
if (!opt('--dir', '')) throw new Error('--dir <scratch dir> is required');
const HERE = resolve(import.meta.dir, '..');
const REPO = resolve(HERE, '../..');
const FOUNDRY = join(homedir(), '.foundry/bin');
const bin = (x: string) => (existsSync(join(FOUNDRY, x)) ? join(FOUNDRY, x) : x);
const BASE = Number(opt('--port-base', '28500'));
const ANVIL_PORT = BASE + 45;
const BELL_PORT = BASE + 287;
const GUARD_PORT = BASE + 46;
const HEALTH_PORT = BASE + 290;
const portFreeOn = (port: number, host: string) =>
  new Promise<boolean>((res) => {
    const srv = createServer();
    srv.once('error', () => res(false));
    srv.listen(port, host, () => srv.close(() => res(true)));
  });
// both: a listener on 127.0.0.1 alone does not block a bind on 0.0.0.0 on macOS
const portFree = async (port: number) => (await portFreeOn(port, '127.0.0.1')) && (await portFreeOn(port, '0.0.0.0'));
for (const port of [ANVIL_PORT, BELL_PORT, GUARD_PORT, HEALTH_PORT]) {
  if (!(await portFree(port))) throw new Error(`port ${port} is in use (a stale run?); stop it or pass another --port-base`);
}
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const dev0 = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 });
const dev1 = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 });
const dev0Key = toHex(dev0.getHdKey().privateKey!);

const procs: ChildProcess[] = [];
const cleanup = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('exit', cleanup);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(`[smoke] ${s}`);

async function main() {
  mkdirSync(DIR, { recursive: true });
  // 1. anvil
  const anvil = spawn(bin('anvil'), ['--port', String(ANVIL_PORT), '--chain-id', '31337', '--hardfork', 'cancun', '--silent'], { stdio: 'ignore' });
  procs.push(anvil);
  const chain = defineChain({ id: 31337, name: 'smoke', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const pub = createPublicClient({ chain, transport: http(RPC) });
  for (let i = 0; ; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      if (i > 50) throw new Error('anvil did not start');
      await sleep(200);
    }
  }
  // 2. contracts from a copy
  const copy = join(DIR, 'repo');
  mkdirSync(copy, { recursive: true });
  const rs = spawnSync('rsync', ['-a', '--delete', '--exclude', 'out', '--exclude', 'cache', '--exclude', 'broadcast', `${REPO}/contracts`, `${REPO}/deployments`, copy + '/']);
  if (rs.status !== 0) throw new Error('rsync failed');
  log('deploying contracts (forge script --slow)');
  const forge = spawnSync(bin('forge'), ['script', 'script/Deploy.s.sol', '--rpc-url', RPC, '--broadcast', '--slow', '--private-key', dev0Key], {
    cwd: join(copy, 'contracts'),
    env: { ...process.env, DEMO_SIGNER: dev1.address, FOUNDRY_OUT: join(DIR, 'forge-out'), FOUNDRY_CACHE_PATH: join(DIR, 'forge-cache') },
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (forge.status !== 0) throw new Error('forge script failed: ' + (forge.stderr || forge.stdout).slice(-800));
  const book = JSON.parse(readFileSync(join(copy, 'deployments/book.json'), 'utf8')) as { usdg: Address; vault: Address; book: Address; demoSigner: Address; markets: { ticker: string }[] };
  log(`deployed book ${book.book} vault ${book.vault} reference ${book.demoSigner} usdg ${book.usdg}`);
  const BOOK_ABI = parseAbi([
    'function listMarket(bytes32 symbol, address source, uint8 maxLeverage, uint256 maxStake, uint256 oiCap, uint64 maxStaleness)',
    'function getTicket(uint256 id) view returns ((address owner, bytes32 symbol, bool long, uint8 leverage, uint8 horizon, uint256 stake, uint256 entryPrice8, uint64 openedAt, uint64 expiry, uint256 reserved, uint8 status, uint256 payout, uint256 settlePrice8))',
    'function pause()',
    'function open(bytes32 symbol, bool long, uint8 leverage, uint256 stake, uint8 horizon) returns (uint256)',
  ]);
  const REF_ABI = parseAbi(['function postMany(bytes32[] symbols, uint256[] prices8, uint64[] timestamps, bytes[] signatures)', 'function post(bytes32 symbol, uint256 price8, uint64 timestamp, bytes signature)']);
  const ERC = parseAbi(['function mint(address to, uint256 amount)', 'function approve(address spender, uint256 amount) returns (bool)']);
  const w0 = createWalletClient({ account: dev0, chain, transport: http(RPC) });
  const w1 = createWalletClient({ account: dev1, chain, transport: http(RPC) });
  // two extra listed markets for the non-core warm path (D8 parameters)
  const extra = ['AAPL', 'KO'];
  for (const s of extra) {
    const h = await w0.writeContract({ address: book.book, abi: BOOK_ABI, functionName: 'listMarket', args: [stringToHex(s, { size: 32 }), book.demoSigner, 20, 1000n * 10n ** 6n, 20_000n * 10n ** 6n, 86400n] });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  const core = book.markets.map((m) => m.ticker);
  // 3. stand-in bell
  const TAG = keccak256(toHex('bellswap.v2.DemoSignerReference.post'));
  const warm = new Map<string, number>();
  const rounds = new Map<string, { t: number; price8: string }[]>();
  const price = new Map<string, number>();
  const registered = new Set<string>();
  const token = toHex(crypto.getRandomValues(new Uint8Array(16)));
  let lastTickAt = 0;
  const post = async () => {
    const now = Date.now();
    const syms = [...core, ...[...warm.entries()].filter(([, u]) => u > now).map(([s]) => s)];
    const blk = await pub.getBlock({ blockTag: 'latest' });
    const ts = Number(blk.timestamp);
    const list = syms.filter((s) => (rounds.get(s)?.at(-1)?.t ?? 0) < ts);
    if (!list.length) return;
    const sig: Hex[] = [];
    const p8: bigint[] = [];
    for (const s of list) {
      const p = (price.get(s) ?? 100) * (1 + (Math.random() - 0.5) * 0.004);
      price.set(s, p);
      const v = BigInt(Math.round(p * 1e8));
      p8.push(v);
      const d = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint64' }], [TAG, 31337n, book.demoSigner, stringToHex(s, { size: 32 }), v, BigInt(ts)]));
      sig.push(await dev1.signMessage({ message: { raw: d } }));
    }
    const h = await w1.writeContract({ address: book.demoSigner, abi: REF_ABI, functionName: 'postMany', args: [list.map((s) => stringToHex(s, { size: 32 })), p8, list.map(() => BigInt(ts)), sig] });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status === 'success') list.forEach((s, i) => rounds.set(s, [...(rounds.get(s) ?? []), { t: ts, price8: p8[i]!.toString() }]));
    lastTickAt = Date.now();
  };
  await post();
  let posting = false;
  const poster = setInterval(() => {
    if (posting) return;
    posting = true;
    post()
      .catch((e) => log('post failed ' + String(e).slice(0, 100)))
      .finally(() => (posting = false));
  }, 1500);
  const fresh = (s: string) => (rounds.get(s)?.at(-1)?.t ?? 0) > Date.now() / 1000 - 300;
  const bell = Bun.serve({
    port: BELL_PORT,
    async fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname;
      if (p === '/state') return Response.json({ book: { ticketBook: book.book, vault: book.vault, reference: book.demoSigner, usdg: book.usdg, startBlock: '1' }, replay: { lastTick: { at: lastTickAt } }, feed: { core, lastTickAt }, counts: { bots: registered.size } });
      if (p === '/markets') return Response.json({ markets: [...core, ...extra].map((s) => ({ symbol: s, tradable: true, listed: true, covered: true })) });
      let m = /^\/markets\/([^/]+)$/.exec(p);
      if (m) {
        warm.set(m[1]!, Math.max(warm.get(m[1]!) ?? 0, Date.now() + 90_000));
        return Response.json({ symbol: m[1], tradable: true, fresh: fresh(m[1]!), lastRound: rounds.get(m[1]!)?.at(-1) ?? null });
      }
      m = /^\/warm\/([^/]+)$/.exec(p);
      if (m && req.method === 'POST') {
        warm.set(m[1]!, Date.now() + 30_000);
        return Response.json({ ok: true, symbol: m[1], warmUntil: 0 });
      }
      m = /^\/prices\/([^/]+)$/.exec(p);
      if (m) return Response.json({ symbol: m[1], rounds: rounds.get(m[1]!) ?? [] });
      if (p === '/tickets') return Response.json({ tickets: [] });
      m = /^\/tickets\/(\d+)$/.exec(p);
      if (m) {
        const t = await pub.readContract({ address: book.book, abi: BOOK_ABI, functionName: 'getTicket', args: [BigInt(m[1]!)] });
        if (t.leverage === 0) return Response.json({ error: 'unknown ticket' }, { status: 404 });
        const owner = t.owner.toLowerCase();
        return Response.json({ ticket: { id: m[1], owner, status: t.status === 1 ? 'open' : 'settled', expiry: Number(t.expiry), symbol: s32(t.symbol), bot: registered.has(owner) } });
      }
      if (p === '/admin/bots' && req.method === 'POST') {
        if (req.headers.get('authorization') !== `Bearer ${token}`) return Response.json({ error: 'bad admin token' }, { status: 401 });
        const b = (await req.json()) as { addresses: string[] };
        b.addresses.forEach((a) => registered.add(a.toLowerCase()));
        return Response.json({ ok: true, count: registered.size });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  // 4. bots --once N
  const t0 = Date.now();
  const mnemonic = generateMnemonic(english);
  // async spawn: the stand-in bell answers from this process's event loop
  const runBots = (argv: string[], extraEnv: Record<string, string>, killAfterMs: number) =>
    new Promise<{ status: number | null; out: string }>((done) => {
      const c = spawn('bun', ['run', 'src/index.ts', ...argv], {
        cwd: HERE,
        env: { ...process.env, BOTS_MNEMONIC: mnemonic, BOTS_RPC_URL: RPC, BOTS_BELL_URL: `http://127.0.0.1:${BELL_PORT}`, BELL_ADMIN_TOKEN: token, BOTS_USDG_SLOT: '0', BOTS_COUNT: '24', BOTS_LP: '4', ...extraEnv },
      });
      procs.push(c);
      let buf = '';
      c.stdout!.on('data', (d) => (buf += d));
      c.stderr!.on('data', (d) => (buf += d));
      const kill = setTimeout(() => c.kill('SIGTERM'), killAfterMs);
      c.on('exit', (code) => {
        clearTimeout(kill);
        done({ status: code, out: buf });
      });
    });
  const bots = await runBots(['--once', String(N)], {}, 600_000);
  const out = bots.out;
  console.log(out.split('\n').filter((l) => !/"ids"|^\s+"\d+",?$/.test(l)).join('\n'));
  log(`bots --once ${N} exit ${bots.status} in ${((Date.now() - t0) / 1000).toFixed(1)} s; registered ${registered.size} addresses`);
  // 5. rpc-guard in front of the anvil
  const guard = spawn('bun', ['run', '../rpc-guard/src/index.ts'], { cwd: HERE, env: { ...process.env, RPC_GUARD_PORT: String(GUARD_PORT), RPC_GUARD_UPSTREAM: RPC, RPC_GUARD_REF: book.demoSigner, RPC_GUARD_TARGETS: [book.book, book.vault, book.usdg].join(','), RPC_GUARD_BELL_URL: '' }, stdio: 'ignore' });
  procs.push(guard);
  const G = `http://127.0.0.1:${GUARD_PORT}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(G + '/health')).ok) break;
    } catch {
      if (i > 50) throw new Error('guard did not start');
    }
    await sleep(200);
  }
  const via = (a: Parameters<typeof createWalletClient>[0]['account']) => createWalletClient({ account: a, chain, transport: http(G) });
  const outcome = async (f: () => Promise<Hex>) => {
    try {
      const h = await f();
      const r = await pub.waitForTransactionReceipt({ hash: h });
      return `accepted (${r.status})`;
    } catch (e) {
      const m = String((e as Error).message);
      return /-32003|playground guard/.test(m) ? 'rejected -32003' : 'error ' + m.split('\n')[0]!.slice(0, 80);
    }
  };
  const fresh1 = privateKeyToAccount(generatePrivateKey());
  await pub.request({ method: 'anvil_setBalance' as never, params: [fresh1.address, toHex(10n ** 19n)] as never });
  await pub.waitForTransactionReceipt({ hash: await w0.writeContract({ address: book.usdg, abi: ERC, functionName: 'mint', args: [fresh1.address, 1000n * 10n ** 6n] }) });
  const g0 = await outcome(() => via(dev0).writeContract({ address: book.book, abi: BOOK_ABI, functionName: 'pause', gas: 100_000n }));
  const gRef = await outcome(() => via(fresh1).writeContract({ address: book.demoSigner, abi: REF_ABI, functionName: 'post', args: [stringToHex('NVDA', { size: 32 }), 1n, 1n, '0x'], gas: 200_000n }));
  const gApprove = await outcome(() => via(fresh1).writeContract({ address: book.usdg, abi: ERC, functionName: 'approve', args: [book.book, maxUint256] }));
  const gOpen = await outcome(() => via(fresh1).writeContract({ address: book.book, abi: BOOK_ABI, functionName: 'open', args: [stringToHex('NVDA', { size: 32 }), true, 5, 20n * 10n ** 6n, 0] }));
  log(`guard: dev0 pause ${g0}; fresh post to reference ${gRef}; fresh approve ${gApprove}; fresh open ${gOpen}`);
  let runOk = true;
  if (RUN_MS > 0) {
    const r = await runBots([], { BOTS_ENABLED: '1', BOTS_INTERVAL_MS: '500', BOTS_HEALTH_PORT: String(HEALTH_PORT) }, RUN_MS);
    const lines = r.out.split('\n').filter((l) => /stats|LP .* deposit|fatal|failed/.test(l));
    console.log(lines.slice(-12).join('\n'));
    runOk = lines.some((l) => l.includes('[bots] stats')) && lines.some((l) => / deposit \d+ USDG/.test(l)) && !r.out.includes('fatal');
    log(`long-running fleet for ${RUN_MS / 1000} s: ${runOk ? 'stats line and LP deposit seen' : 'missing stats line or LP deposit'}`);
  }
  const ok = runOk && bots.status === 0 && g0 === 'rejected -32003' && gRef === 'rejected -32003' && gApprove === 'accepted (success)' && gOpen === 'accepted (success)';
  log(ok ? 'SMOKE OK' : 'SMOKE FAILED');
  clearInterval(poster);
  bell.stop(true);
  cleanup();
  process.exit(ok ? 0 : 1);
}

function s32(h: Hex): string {
  return Buffer.from(h.slice(2), 'hex').toString('utf8').replace(/\0+$/, '');
}

main().catch((e) => {
  console.error('[smoke] ' + String((e as Error).stack ?? e).slice(0, 1500));
  cleanup();
  process.exit(1);
});
