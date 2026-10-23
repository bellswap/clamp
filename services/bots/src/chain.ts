// Chain access of the fleet: wallets from BOTS_MNEMONIC, anvil funding (anvil_setBalance, and the USDG balance slot
// keccak256(abi.encode(holder, 1))), approvals, and simulate-then-send writes.
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  maxUint256,
  numberToHex,
  pad,
  parseEventLogs,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  stringToHex,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { BOOK, ERC20, VAULT } from './abi';

export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
export const USDG_BALANCE_SLOT = 1n;
export const ETH_TARGET = 10n ** 19n; // 10 ETH
export const ETH_MIN = 10n ** 18n;
/** TicketBook.STATUS_OPEN (contracts/src/TicketBook.sol:72). */
export const TICKET_STATUS_OPEN = 1;

export interface Wallets {
  traders: Account[];
  lps: Account[];
}

/** Traders at indexes 0..count-1, LPs after them. Refuses the anvil mnemonic and any anvil dev key 0 to 9. */
export function deriveWallets(mnemonic: string, count: number, lp: number): Wallets {
  if (!mnemonic) throw new Error('BOTS_MNEMONIC is not set');
  const dev = new Set(Array.from({ length: 10 }, (_, i) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }).address.toLowerCase()));
  const all = Array.from({ length: count + lp }, (_, i) => mnemonicToAccount(mnemonic, { addressIndex: i }) as Account);
  if (all.some((a) => dev.has(a.address.toLowerCase()))) throw new Error('BOTS_MNEMONIC derives an anvil dev key (0 to 9); use a fresh mnemonic');
  return { traders: all.slice(0, count), lps: all.slice(count) };
}

export function usdgSlot(holder: Address, base: bigint = USDG_BALANCE_SLOT): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, base]));
}

/** The revert name of a failed simulate or send (custom error name, reason string, or a short message). */
export function revertName(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r) return r.data?.errorName ?? r.reason ?? (r.signature ? `sig:${r.signature}` : 'reverted');
    return e.shortMessage.split('\n')[0]!.slice(0, 60);
  }
  return String((e as Error)?.message ?? e).split('\n')[0]!.slice(0, 60);
}

export interface WriteReq {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** Checked inside the wallet lock, before the simulation and again right before the send: a non-null reason drops the write unsent. */
  guard?: () => string | null;
}

export type SendResult = { ok: true; hash: Hex; logs: unknown[] } | { ok: false; stage: 'sim' | 'tx' | 'guard'; reason: string; hash?: Hex };

/** Gas limit 30% over the estimate, rounded up: a clock block landing between the estimate and inclusion runs a
 * bare-estimate transaction out of gas (seen on the rig, fixed there in infra/ops/rig/open-ticket.sh). */
export function withHeadroom(estimate: bigint): bigint {
  return (estimate * 13n + 9n) / 10n;
}

/** One write at a time per wallet (nonces). */
class Lock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(f: () => Promise<T>): Promise<T> {
    const p = this.tail.then(f, f);
    this.tail = p.catch(() => undefined);
    return p;
  }
}

export class ChainIO {
  readonly pub: PublicClient;
  private wallets = new Map<string, WalletClient>();
  private locks = new Map<string, Lock>();
  private chain;

  constructor(readonly url: string, readonly chainId: number, readonly balanceSlot: bigint = USDG_BALANCE_SLOT) {
    this.chain = defineChain({ id: chainId, name: 'Bellswap playground', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
    this.pub = createPublicClient({ chain: this.chain, transport: http(url, { retryCount: 4, retryDelay: 300, timeout: 60_000 }) }) as PublicClient;
  }

  static async connect(url: string, balanceSlot: bigint = USDG_BALANCE_SLOT): Promise<ChainIO> {
    const probe = createPublicClient({ transport: http(url, { retryCount: 4, retryDelay: 500, timeout: 30_000 }) });
    return new ChainIO(url, await probe.getChainId(), balanceSlot);
  }

  rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
    return (this.pub.request as (a: { method: string; params: unknown[] }) => Promise<T>)({ method, params });
  }

  private wallet(a: Account): WalletClient {
    let w = this.wallets.get(a.address);
    if (!w) {
      w = createWalletClient({ account: a, chain: this.chain, transport: http(this.url, { retryCount: 2, timeout: 60_000 }) });
      this.wallets.set(a.address, w);
    }
    return w;
  }

  /** One lock per address: its writes and its USDG slot writes never interleave. */
  private lock(a: Account | Address): Lock {
    const key = (typeof a === 'string' ? a : a.address).toLowerCase();
    let l = this.locks.get(key);
    if (!l) this.locks.set(key, (l = new Lock()));
    return l;
  }

  /** anvil_setBalance to 10 ETH when below 1 ETH. Returns true when it topped up. */
  async ensureEth(a: Address): Promise<boolean> {
    const bal = await this.pub.getBalance({ address: a });
    if (bal >= ETH_MIN) return false;
    await this.rpc('anvil_setBalance', [a, numberToHex(ETH_TARGET)]);
    return true;
  }

  /**
   * Writes the USDG balance slot to `target` when the balance is below `min`; verifies the write. Runs under the
   * address's write lock, so neither a concurrent top-up nor the wallet's own open moves the balance in between; a
   * payout landing in between only raises it, hence the `<` check.
   */
  ensureUsdg(usdg: Address, a: Address, min: bigint, target: bigint): Promise<boolean> {
    return this.lock(a).run(async () => {
      const bal = await this.usdgBalance(usdg, a);
      if (bal >= min) return false;
      await this.rpc('anvil_setStorageAt', [usdg, usdgSlot(a, this.balanceSlot), pad(numberToHex(target), { size: 32 })]);
      const after = await this.usdgBalance(usdg, a);
      if (after < target) throw new Error(`USDG slot write did not take: balanceOf ${a} is ${after}, expected ${target}`);
      return true;
    });
  }

  usdgBalance(usdg: Address, a: Address): Promise<bigint> {
    return this.pub.readContract({ address: usdg, abi: ERC20, functionName: 'balanceOf', args: [a] });
  }

  /** One max approve when the allowance is below 2^128 (fresh wallet or a fork reset). */
  async ensureApproval(a: Account, token: Address, spender: Address): Promise<SendResult | null> {
    const cur = await this.pub.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [a.address, spender] });
    if (cur >= 2n ** 128n) return null;
    return this.write(a, { address: token, abi: ERC20 as Abi, functionName: 'approve', args: [spender, maxUint256] });
  }

  /** Simulates, estimates gas (sent with 30% headroom), then sends and waits for the receipt (anvil automines). */
  write(a: Account, req: WriteReq): Promise<SendResult> {
    return this.lock(a).run(async () => {
      const held = req.guard?.() ?? null;
      if (held) return { ok: false, stage: 'guard', reason: held } as const;
      let request: unknown;
      try {
        const call = { account: a, address: req.address, abi: req.abi, functionName: req.functionName as never, args: req.args as never };
        const sim = await this.pub.simulateContract(call);
        // The estimate runs with the bare address: viem 2.38 given a local account pre-estimates gas inside
        // prepareTransactionRequest and caps the real estimate at that first result, so a state change between the two
        // would fail the second one.
        request = { ...sim.request, gas: withHeadroom(await this.pub.estimateContractGas({ ...call, account: a.address })) };
      } catch (e) {
        return { ok: false, stage: 'sim', reason: revertName(e) } as const;
      }
      const late = req.guard?.() ?? null;
      if (late) return { ok: false, stage: 'guard', reason: late } as const;
      let hash: Hex;
      try {
        hash = await this.wallet(a).writeContract(request as never);
      } catch (e) {
        return { ok: false, stage: 'tx', reason: revertName(e) } as const;
      }
      const r = await this.pub.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 100 });
      if (r.status !== 'success') return { ok: false, stage: 'tx', reason: 'reverted', hash } as const;
      return { ok: true, hash, logs: r.logs } as const;
    });
  }

  head(): Promise<bigint> {
    return this.pub.getBlockNumber();
  }

  async vaultState(vault: Address): Promise<{ free: bigint; assets: bigint }> {
    const [free, assets] = await Promise.all([
      this.pub.readContract({ address: vault, abi: VAULT, functionName: 'free' }),
      this.pub.readContract({ address: vault, abi: VAULT, functionName: 'totalAssets' }),
    ]);
    return { free, assets };
  }

  async market(book: Address, symbol: string): Promise<MarketOnChain> {
    const r = await this.pub.readContract({ address: book, abi: BOOK, functionName: 'markets', args: [stringToHex(symbol, { size: 32 })] });
    return { listed: r[2], maxLeverage: Number(r[1]), maxStake: r[4], oiCap: r[5], oi: r[6] };
  }

  /** True while ticket `id` is open on chain (the authority when the bell has not indexed it yet). */
  async ticketOpen(book: Address, id: string): Promise<boolean> {
    const t = await this.pub.readContract({ address: book, abi: BOOK, functionName: 'getTicket', args: [BigInt(id)] });
    return Number(t.status) === TICKET_STATUS_OPEN;
  }

  async lpPosition(vault: Address, lp: Address): Promise<{ shares: bigint; assets: bigint; maxWithdraw: bigint }> {
    const shares = await this.pub.readContract({ address: vault, abi: VAULT, functionName: 'balanceOf', args: [lp] });
    if (shares === 0n) return { shares, assets: 0n, maxWithdraw: 0n };
    const [assets, maxWithdraw] = await Promise.all([
      this.pub.readContract({ address: vault, abi: VAULT, functionName: 'convertToAssets', args: [shares] }),
      this.pub.readContract({ address: vault, abi: VAULT, functionName: 'maxWithdraw', args: [lp] }),
    ]);
    return { shares, assets, maxWithdraw };
  }
}

export interface MarketOnChain {
  listed: boolean;
  maxLeverage: number;
  maxStake: bigint;
  oiCap: bigint;
  oi: bigint;
}

/** What the fleet needs from the chain (ChainIO in production, a fake in the tests). */
export type ChainPort = Pick<ChainIO, 'ensureEth' | 'ensureUsdg' | 'usdgBalance' | 'ensureApproval' | 'write' | 'head' | 'vaultState' | 'market' | 'lpPosition' | 'ticketOpen'>;

/** Ticket id and expiry from an open's receipt logs. */
export function openedTicket(logs: unknown[]): { id: string; expiry: number } | null {
  const ev = parseEventLogs({ abi: BOOK, logs: logs as never, eventName: 'TicketOpened' });
  const e = ev[0];
  return e ? { id: e.args.id.toString(), expiry: Number(e.args.expiry) } : null;
}
