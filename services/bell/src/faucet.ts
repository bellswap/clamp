// POST /faucet {address}: 0.05 ETH and 1,000 USDG from dev account 0 (the house), rate limited per address
// (persistent, BELL_FAUCET_COOLDOWN_S) and per client IP (in memory). Playground funds on the fork only.
import { encodeFunctionData, getAddress, isAddress, type Address } from 'viem';
import { ERC20 } from './abi';
import type { Chain } from './chain';

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** Per-address cooldown kept in the state file's faucet log, plus a fixed window per client IP. */
export class FaucetLimiter {
  private ips = new Map<string, { start: number; n: number }>();
  constructor(readonly log: Record<string, number>, readonly cooldownS: number, readonly ipMax = 6, readonly ipWindowS = 3600) {}

  /** Throws 429 when the address is inside its cooldown or the IP used up its window; otherwise claims both. */
  claim(address: string, ip: string, nowS: number): void {
    const k = address.toLowerCase();
    const last = this.log[k];
    if (last !== undefined && nowS - last < this.cooldownS) {
      throw new HttpError(429, 'this address was funded recently', { nextAllowedAt: last + this.cooldownS });
    }
    const e = this.ips.get(ip);
    if (e && nowS - e.start < this.ipWindowS && e.n >= this.ipMax) {
      throw new HttpError(429, 'too many faucet calls from this network', { nextAllowedAt: e.start + this.ipWindowS });
    }
    if (!e || nowS - e.start >= this.ipWindowS) this.ips.set(ip, { start: nowS, n: 1 });
    else e.n += 1;
    this.log[k] = nowS;
  }

  /** Gives the address its window back after a failed send. */
  release(address: string, ip: string): void {
    delete this.log[address.toLowerCase()];
    const e = this.ips.get(ip);
    if (e && e.n > 0) e.n -= 1;
  }
}

export interface FaucetCtx {
  chain: Chain;
  limiter: FaucetLimiter;
  enabled: boolean;
  ethWei: bigint;
  usdgRaw: bigint;
  usdg(): Address | null;
  /** The TicketBook, when deployed: the faucet reads allowance(user, book) once so the fork has fetched that slot. */
  spender?(): Address | null;
  save(): void;
}

export async function faucet(ctx: FaucetCtx, addressQ: unknown, ip: string) {
  if (!ctx.enabled) throw new HttpError(403, 'faucet is off');
  if (typeof addressQ !== 'string' || !isAddress(addressQ)) throw new HttpError(400, 'body must be {"address":"0x..."}');
  const to = getAddress(addressQ);
  const nowS = Math.floor(Date.now() / 1000);
  ctx.limiter.claim(to, ip, nowS);
  ctx.save();
  // Quotas go back only when nothing reached the address; once the ETH transfer landed they stay claimed.
  let landed = false;
  try {
    const c = ctx.chain;
    const code = await c.pub.getCode({ address: to });
    if (code && code !== '0x' && !code.toLowerCase().startsWith('0xef0100')) throw new HttpError(400, 'the faucet funds externally owned accounts only');
    const usdgAddr = ctx.usdg();
    const usdg = usdgAddr && (await c.hasCode(usdgAddr)) ? usdgAddr : null;
    if (usdg) {
      const bal = await c.pub.readContract({ address: usdg, abi: ERC20, functionName: 'balanceOf', args: [c.house.address] });
      if (bal < ctx.usdgRaw) throw new HttpError(503, 'the faucet has no USDG left; try again later');
    }
    const eth = await c.send(c.house, { to, value: ctx.ethWei });
    if (eth.status !== 'success') throw new HttpError(500, `ETH transfer reverted, tx ${eth.hash}`);
    landed = true;
    let usdgTx: string | null = null;
    let usdgSent = 0n;
    if (usdg) {
      const r = await c.send(c.house, { to: usdg, data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [to, ctx.usdgRaw] }) });
      if (r.status !== 'success') throw new HttpError(500, `USDG transfer reverted, tx ${r.hash}`);
      usdgTx = r.hash;
      usdgSent = ctx.usdgRaw;
      // On the fork every unseen storage slot is fetched from the upstream archive RPC, which can take many retries.
      // Reading allowance(user, book) here moves that wait into the first-visit faucet call instead of the first open.
      const spender = ctx.spender?.();
      if (spender) await c.pub.readContract({ address: usdg, abi: ERC20, functionName: 'allowance', args: [to, spender] }).catch(() => undefined);
    }
    return {
      address: to,
      ethSentWei: ctx.ethWei.toString(),
      ethTx: eth.hash,
      usdgSentRaw: usdgSent.toString(),
      usdgTx,
      usdg: usdg ?? null,
      nextAllowedAt: nowS + ctx.limiter.cooldownS,
    };
  } catch (e) {
    if (!landed) {
      ctx.limiter.release(to, ip);
      ctx.save();
    }
    throw e;
  }
}
