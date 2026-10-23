// Bots service entry. Long-running by default (kill switch: BOTS_ENABLED=0 keeps the process idle with /health up,
// or `docker compose stop bots`). `bun run src/index.ts --once N` funds the fleet, opens N tickets, checks that the
// bell lists them with bot true, prints a JSON summary and exits 0 only when all N opened with 0 reverted
// transactions.
import { Bell } from './bell';
import { ChainIO, deriveWallets } from './chain';
import { loadEnv } from './config';
import { Fleet } from './fleet';
import { serveHealth } from './health';

export function parseArgs(argv: string[]): { once: number | null } {
  const i = argv.indexOf('--once');
  if (i === -1) return { once: null };
  const n = Number(argv[i + 1] ?? 50);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error('--once takes a ticket count from 1 to 1000');
  return { once: n };
}

async function main() {
  const env = loadEnv();
  const { once } = parseArgs(process.argv.slice(2));
  if (!env.enabled && once === null) {
    console.log('[bots] BOTS_ENABLED is not 1: idle (health on :' + env.healthPort + ')');
    serveHealth(env.healthPort, () => ({ ok: true, enabled: false }));
    return;
  }
  const w = deriveWallets(env.mnemonic, env.count, env.lp);
  const chain = await ChainIO.connect(env.rpcUrl, env.usdgSlot);
  const bell = new Bell(env.bellUrl, env.adminToken);
  const fleet = new Fleet(w.traders, w.lps, chain, bell, { intervalMs: env.intervalMs, core: env.core });
  console.log(`[bots] chain ${chain.chainId}, ${w.traders.length} traders, ${w.lps.length} LPs, mean interval ${env.intervalMs} ms, bell ${env.bellUrl}`);
  if (once !== null) {
    const r = await fleet.once(once);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
  serveHealth(env.healthPort, () => {
    const age = Date.now() - fleet.stats.lastLoopAt;
    return { ok: fleet.stats.lastLoopAt === 0 || age < Math.max(120_000, env.intervalMs * 10), enabled: true, opens: fleet.stats.opens, txReverts: fleet.stats.txReverts, simRejects: fleet.stats.simRejects, open: fleet.fleetOpen(), lpOps: fleet.stats.lpOps, resets: fleet.stats.resets, status: fleet.stats.lastStatus };
  });
  const stop = () => {
    fleet.stop();
    console.log('[bots] stopping');
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await fleet.run();
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`[bots] fatal: ${(e as Error).message.split('\n')[0]}`);
    process.exit(1);
  });
}
