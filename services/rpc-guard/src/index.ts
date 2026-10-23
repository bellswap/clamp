// rpc-guard: JSON-RPC proxy between eRPC and anvil (docs in src/guard.ts). Env:
//   RPC_GUARD_PORT       listen port (default 8546)
//   RPC_GUARD_UPSTREAM   anvil URL (default http://anvil:8545)
//   RPC_GUARD_REF        comma-separated reference addresses (optional; merged with the bell's)
//   RPC_GUARD_TARGETS    comma-separated contracts a raw transaction may call (TicketBook, HouseVault, USDG from
//                        deployments/book.json; optional, merged with the bell's book). Until one target is known
//                        every raw send is rejected, so set it when the guard must work before the bell answers.
//   RPC_GUARD_BELL_URL   bell base URL whose /state book (reference, ticketBook, vault, usdg) is merged in, every
//                        5 s until a target is known, then every 60 s (default http://bell:8787; empty disables)
//   RPC_GUARD_ALLOW_ADMIN=1 lets anvil_*, evm_*, eth_sign* and the unsigned eth_send* methods through (dev senders
//                        stay blocked)
import { isAddress } from 'viem';
import { makePolicy } from './guard';
import { makeGuard } from './server';

export function refsFromEnv(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => isAddress(x))
    .map((x) => x.toLowerCase());
}

export interface BellBook {
  reference: string | null;
  /** TicketBook, HouseVault and USDG (lower case, valid addresses only). */
  targets: string[];
}

const addr = (v: unknown): string | null => (typeof v === 'string' && isAddress(v) ? v.toLowerCase() : null);

/** The reference and the target contracts of the bell's /state book; null when the bell has no book yet. */
export async function bellBook(bellUrl: string, f: typeof fetch = fetch): Promise<BellBook | null> {
  const r = await f(bellUrl.replace(/\/+$/, '') + '/state', { signal: AbortSignal.timeout(5_000) });
  if (!r.ok) return null;
  const s = (await r.json()) as { book?: Record<string, unknown> | null };
  const b = s?.book;
  if (!b || typeof b !== 'object') return null;
  const targets = [b.ticketBook, b.vault, b.usdg].map(addr).filter((x): x is string => x !== null);
  const reference = addr(b.reference);
  return reference || targets.length ? { reference, targets } : null;
}

/** The guard's address sets: fixed env values merged with the last bell answer (kept across bell outages). */
export function addressBook(fixedRefs: string[], fixedTargets: string[]) {
  let fromBell: BellBook | null = null;
  return {
    refs: (): string[] => (fromBell?.reference ? [...fixedRefs, fromBell.reference] : fixedRefs),
    targets: (): string[] => [...fixedTargets, ...(fromBell?.targets ?? [])],
    /** Applies a bell answer; returns true when it changed the sets. */
    set(b: BellBook | null): boolean {
      if (!b) return false;
      const changed = JSON.stringify(b) !== JSON.stringify(fromBell);
      fromBell = b;
      return changed;
    },
  };
}

if (import.meta.main) {
  const port = Number(process.env.RPC_GUARD_PORT || 8546);
  const upstream = process.env.RPC_GUARD_UPSTREAM || 'http://anvil:8545';
  const bellUrl = process.env.RPC_GUARD_BELL_URL ?? 'http://bell:8787';
  const book = addressBook(refsFromEnv(process.env.RPC_GUARD_REF), refsFromEnv(process.env.RPC_GUARD_TARGETS));
  const policy = makePolicy({ refs: book.refs, targets: book.targets, allowAdmin: process.env.RPC_GUARD_ALLOW_ADMIN === '1' });
  const ready = () => policy.targets().size > 0;
  let warned = 0;
  const refresh = async () => {
    if (bellUrl) {
      try {
        const b = await bellBook(bellUrl);
        if (book.set(b)) console.log(`[rpc-guard] book from the bell: reference ${b!.reference ?? '-'}, targets ${b!.targets.join(',') || '-'}`);
      } catch {
        // bell down or not started (profile bell): keep the last known book
      }
    }
    if (!ready() && Date.now() - warned > 60_000) {
      warned = Date.now();
      console.log('[rpc-guard] not ready: no target contract known (RPC_GUARD_TARGETS unset, bell unreachable); every raw transaction is rejected until one is');
    }
    setTimeout(refresh, ready() ? 60_000 : 5_000);
  };
  await refresh();
  const guard = makeGuard({ upstream, policy });
  Bun.serve({ port, hostname: '0.0.0.0', maxRequestBodySize: 16 * 1024 * 1024, idleTimeout: 120, fetch: guard.fetch });
  console.log(`[rpc-guard] listening on :${port}, upstream ${upstream}, ${policy.dev.size} dev senders blocked, admin methods ${policy.allowAdmin ? 'allowed' : 'blocked'}`);
  setInterval(() => {
    const s = guard.stats;
    if (s.rejected) console.log(`[rpc-guard] stats requests=${s.requests} forwarded=${s.forwarded} rejected=${s.rejected}`);
  }, 300_000);
}
