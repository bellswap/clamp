// Settler: every few seconds, settle every expired open ticket (permissionless call with an empty proof, sent from
// dev account 0). A ticket whose settle call would revert (no reference round at or after expiry yet) is backed off
// for BACKOFF_MS and the pass moves on to the next expired ticket, so failing tickets never starve later ones. Each
// such preflight revert is reported (onNotYet), so the feed's watchdog prints that symbol until the ticket settles.
import { encodeFunctionData, type Abi, type Address } from 'viem';
import type { Chain } from './chain';
import type { StateData } from './store';

export function expiredOpen(d: StateData, clock: number, max = 25): string[] {
  return Object.values(d.tickets)
    .filter((t) => t.status === 'open' && t.expiry <= clock)
    .sort((a, b) => a.expiry - b.expiry || Number(BigInt(a.id) - BigInt(b.id)))
    .slice(0, max)
    .map((t) => t.id);
}

export const SETTLE_BATCH = 25;
/** Short: the watchdog prints the symbol at the next tick (one wall second at speed 60), so the retry should follow
 *  soon after; a due ticket must not wait more than about 30 wall seconds in total. */
export const BACKOFF_MS = 5_000;

/** One pass: up to SETTLE_BATCH settlements, trying the expired open tickets in expiry order. `skip` holds ids
 *  settled in an earlier pass that the indexer has not seen yet; `backoff` maps ids whose preflight failed to the
 *  wall time (ms) of their next try. Returns the settled ids. */
export async function settleOnce(d: StateData, chain: Chain, book: Address, abi: Abi, log: (...a: unknown[]) => void, skip: Set<string> = new Set(), backoff: Map<string, number> = new Map(), nowMs = Date.now(), onNotYet?: (id: string, symbol: string) => void): Promise<string[]> {
  const clock = await chain.now();
  for (const [id, at] of backoff) if (at <= nowMs || d.tickets[id]?.status !== 'open') backoff.delete(id);
  const done: string[] = [];
  for (const id of expiredOpen(d, clock, Number.MAX_SAFE_INTEGER)) {
    if (done.length >= SETTLE_BATCH) break;
    if (skip.has(id) || backoff.has(id)) continue;
    const data = encodeFunctionData({ abi, functionName: 'settle', args: [BigInt(id), '0x'] });
    try {
      await chain.pub.call({ account: chain.house.address, to: book, data });
    } catch (e) {
      backoff.set(id, nowMs + BACKOFF_MS);
      onNotYet?.(id, d.tickets[id]!.symbol);
      log(`settle ${id}: not yet (${(e as Error).message.split('\n')[0]})`);
      continue;
    }
    const r = await chain.send(chain.house, { to: book, data });
    if (r.status === 'success') done.push(id);
    else {
      backoff.set(id, nowMs + BACKOFF_MS);
      log(`settle ${id}: reverted, tx ${r.hash}`);
    }
  }
  return done;
}
