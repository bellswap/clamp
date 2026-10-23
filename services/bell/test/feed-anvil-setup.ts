// Ephemeral anvil (no fork, free port, chain id 46633) with MockUSDG, HouseVault, TicketBook and DemoSignerReference
// deployed from a temporary forge build, every symbol listed, the vault seeded, traders funded and approved, and a
// real App (replay loop off: the tests drive ticks) on a temporary state, book, catalog and recording.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { App } from '../src/app';
import { ANVIL_KEY_0, ANVIL_KEY_1, loadEnv, REPO_DIR } from '../src/config';
import { symbolToBytes32 } from '../src/math';
import { DAY, type ReplaySeries } from '../src/replay';

const HOME = process.env.HOME ?? '';
export const ANVIL = Bun.which('anvil') ?? (existsSync(`${HOME}/.foundry/bin/anvil`) ? `${HOME}/.foundry/bin/anvil` : null);
export const FORGE = Bun.which('forge') ?? (existsSync(`${HOME}/.foundry/bin/forge`) ? `${HOME}/.foundry/bin/forge` : null);
export const HAVE_FOUNDRY = !!(ANVIL && FORGE);
export const CHAIN_ID = 46633;
/** Public anvil dev keys 2 to 9 (test traders). */
export const TRADER_KEYS: Hex[] = [
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
];
const D0 = 1791811800; // a recorded 13:30 UTC

/** `days` recorded sessions of 78 bars; symbol k at bar j costs 10 * (k + 1) + j / 100. */
export function anvilSeries(symbols: string[], days = 2): ReplaySeries {
  const t: number[] = [];
  for (let d = 0; d < days; d++) for (let i = 0; i < 78; i++) t.push(D0 + d * DAY + i * 300);
  const prices: Record<string, number[]> = {};
  symbols.forEach((s, k) => (prices[s] = t.map((_, j) => Math.round((10 * (k + 1) + j / 100) * 1e4) / 1e4)));
  return { bar: 300, t, prices, source: 'anvil test', fetchedAt: Math.floor(Date.now() / 1000), coverage: Object.fromEntries(symbols.map((s) => [s, 1])) };
}

export interface AnvilSystem {
  app: App;
  pub: PublicClient;
  art: Record<string, { abi: Abi; bytecode: Hex }>;
  addr: { usdg: Address; vault: Address; book: Address; ref: Address };
  series: ReplaySeries;
  traders: PrivateKeyAccount[];
  url: string;
  kill(): void;
  roundCount(sym: string): Promise<number>;
  latest(sym: string): Promise<[bigint, bigint, number]>;
  /** TicketBook.open from a trader; returns the receipt status. */
  open(trader: PrivateKeyAccount, sym: string, long: boolean, leverage: number, stake: bigint, horizon: number): Promise<'success' | 'reverted'>;
}

async function freePort(): Promise<number> {
  const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const p = l.port;
  l.stop(true);
  return p;
}

export async function startAnvilSystem(symbols: string[], core: string[], o: { days?: number; traders?: number } = {}): Promise<AnvilSystem> {
  const dir = mkdtempSync(join(tmpdir(), 'feed-anvil-'));
  const out = join(dir, 'out');
  const b = Bun.spawnSync([FORGE!, 'build', '--out', out, '--cache-path', join(dir, 'cache'), 'src/TicketBook.sol', 'src/HouseVault.sol', 'src/references/DemoSignerReference.sol', 'test/mocks/MockUSDG.sol'], { cwd: join(REPO_DIR, 'contracts'), stdout: 'pipe', stderr: 'pipe' });
  if (b.exitCode !== 0) throw new Error(`forge build failed: ${b.stderr.toString().slice(0, 400)}`);
  const art: AnvilSystem['art'] = {};
  for (const n of ['TicketBook', 'HouseVault', 'DemoSignerReference', 'MockUSDG']) {
    const j = JSON.parse(readFileSync(join(out, `${n}.sol`, `${n}.json`), 'utf8'));
    art[n] = { abi: j.abi, bytecode: j.bytecode.object };
  }
  const port = await freePort();
  const proc = Bun.spawn([ANVIL!, '--port', String(port), '--chain-id', String(CHAIN_ID), '--hardfork', 'cancun', '--gas-limit', '100000000', '--silent'], { stdout: 'ignore', stderr: 'ignore' });
  try {
    return await setUp(proc, port, art, symbols, core, o, dir);
  } catch (e) {
    proc.kill(); // a failed setup must not leave anvil running
    throw e;
  }
}

async function setUp(proc: ReturnType<typeof Bun.spawn>, port: number, art: AnvilSystem['art'], symbols: string[], core: string[], o: { days?: number; traders?: number }, dir: string): Promise<AnvilSystem> {
  const url = `http://127.0.0.1:${port}`;
  const chain = defineChain({ id: CHAIN_ID, name: 'anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const pub = createPublicClient({ chain, transport: http(url), pollingInterval: 25 }) as PublicClient;
  for (let k = 0; k < 100; k++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      await Bun.sleep(50);
    }
  }
  const dev0 = privateKeyToAccount(ANVIL_KEY_0);
  const w0 = createWalletClient({ account: dev0, chain, transport: http(url) });
  const deploy = async (n: string, args: unknown[]) => (await pub.waitForTransactionReceipt({ hash: await w0.deployContract({ abi: art[n]!.abi, bytecode: art[n]!.bytecode, args } as never) })).contractAddress!;
  const send = async (to: Address, abi: Abi, functionName: string, args: unknown[], account: PrivateKeyAccount = dev0) => {
    const hash = await createWalletClient({ account, chain, transport: http(url) }).writeContract({ address: to, abi, functionName, args } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${functionName} reverted`);
  };
  const usdg = await deploy('MockUSDG', []);
  const vault = await deploy('HouseVault', [usdg, dev0.address]);
  const book = await deploy('TicketBook', [usdg, vault, dev0.address, 100]);
  await send(vault, art.HouseVault!.abi, 'setBook', [book]);
  const ref = await deploy('DemoSignerReference', [privateKeyToAccount(ANVIL_KEY_1).address]);
  const deployBlock = Number(await pub.getBlockNumber());
  for (const sym of symbols) await send(book, art.TicketBook!.abi, 'listMarket', [symbolToBytes32(sym), ref, 20, 1_000_000_000n, 20_000_000_000n, 86_400n]);
  await send(usdg, art.MockUSDG!.abi, 'mint', [dev0.address, 2_000_000_000_000n]);
  await send(usdg, art.MockUSDG!.abi, 'approve', [vault, 1_000_000_000_000n]);
  await send(vault, art.HouseVault!.abi, 'deposit', [1_000_000_000_000n, dev0.address]);
  const traders = TRADER_KEYS.slice(0, o.traders ?? 1).map((k) => privateKeyToAccount(k));
  for (const t of traders) {
    await send(usdg, art.MockUSDG!.abi, 'mint', [t.address, 100_000_000_000n]);
    await send(usdg, art.MockUSDG!.abi, 'approve', [book, 100_000_000_000n], t);
  }
  const series = anvilSeries(symbols, o.days ?? 2);
  const charts = join(dir, 'charts');
  mkdirSync(charts, { recursive: true });
  writeFileSync(join(charts, 'replay-5d-5m.json'), JSON.stringify(series));
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(symbols.map((x) => ({ symbol: x, name: x, listedByRobinhood: false, sector: null, marketCap: null }))));
  writeFileSync(join(dir, 'book.json'), JSON.stringify({ chainId: CHAIN_ID, deployBlock, usdg, vault, book, demoSigner: ref, markets: core.map((ticker) => ({ ticker })) }));
  const app = new App(loadEnv({ BELL_RPC_URL: url, BELL_STATE_FILE: join(dir, 'state.json'), BELL_BOOK: join(dir, 'book.json'), BELL_CATALOG: join(dir, 'catalog.json'), BELL_CHARTS_DIR: charts, BELL_CHARTS: 'off', BELL_REPLAY: 'off', BELL_ADMIN_TOKEN: 'test' }));
  await app.indexTick();
  const addr = { usdg, vault, book, ref };
  return {
    app,
    pub,
    art,
    addr,
    series,
    traders,
    url,
    kill: () => proc.kill(),
    roundCount: async (sym) => Number((await pub.readContract({ address: ref, abi: art.DemoSignerReference!.abi, functionName: 'roundCount', args: [symbolToBytes32(sym)] })) as bigint),
    latest: async (sym) => (await pub.readContract({ address: ref, abi: art.DemoSignerReference!.abi, functionName: 'latest', args: [symbolToBytes32(sym)] })) as [bigint, bigint, number],
    open: async (trader, sym, long, leverage, stake, horizon) => {
      const w = createWalletClient({ account: trader, chain, transport: http(url) });
      try {
        const hash = await w.writeContract({ address: book, abi: art.TicketBook!.abi, functionName: 'open', args: [symbolToBytes32(sym), long, leverage, stake, horizon], gas: 600_000n } as never);
        return (await pub.waitForTransactionReceipt({ hash })).status;
      } catch {
        return 'reverted';
      }
    },
  };
}
