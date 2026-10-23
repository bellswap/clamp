// Clients for the private anvil URL: reads, anvil_* and evm_* calls, and signed writes from the house (dev account
// 0) and the demo signer (dev account 1).
import { createPublicClient, createWalletClient, defineChain, http, numberToHex, type Account, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** Receipt polling: anvil automines, so a receipt exists right after the send; a short poll keeps a replay tick
 *  (two to four transactions) well under the tick interval. */
export const RECEIPT_POLL_MS = 20;

/** One write at a time per sender (nonces) and for clock moves. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(f: () => Promise<T>): Promise<T> {
    const p = this.tail.then(f, f);
    this.tail = p.catch(() => undefined);
    return p;
  }
}

export interface TxReq {
  to: Address;
  data?: Hex;
  value?: bigint;
  /** Fixed gas limit (skips estimation, so a reverting call still mines and returns a reverted receipt). */
  gas?: bigint;
}
export interface TxResult {
  hash: Hex;
  status: 'success' | 'reverted';
  blockNumber: bigint;
}

export class Chain {
  readonly pub: PublicClient;
  readonly house: Account;
  readonly signer: Account;
  readonly houseLock = new Mutex();
  readonly signerLock = new Mutex();
  /** Clock moves (evm_mine at an absolute time) and the replay tick that wraps them. */
  readonly clockLock = new Mutex();
  /** Clock moves only: a client that never retries, so the transport cannot send a clock move twice. */
  private readonly clockPub: PublicClient;
  private wallets = new Map<string, WalletClient>();
  readonly chain;

  constructor(readonly url: string, readonly chainId: number, houseKey: Hex, signerKey: Hex) {
    this.chain = defineChain({ id: chainId, name: 'Bellswap playground', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
    // anvil passes the fork upstream's transient "Unknown state" through as -32603; viem retries it.
    this.pub = createPublicClient({ chain: this.chain, transport: http(url, { retryCount: 4, retryDelay: 300, timeout: 60_000 }) }) as PublicClient;
    this.clockPub = createPublicClient({ chain: this.chain, transport: http(url, { retryCount: 0, timeout: 60_000 }) }) as PublicClient;
    this.house = privateKeyToAccount(houseKey);
    this.signer = privateKeyToAccount(signerKey);
  }

  rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return (this.pub.request as (a: { method: string; params: unknown[] }) => Promise<T>)({ method, params });
  }

  async now(): Promise<number> {
    const b = await this.pub.getBlock({ blockTag: 'latest' });
    return Number(b.timestamp);
  }

  /** Uncached: viem caches getBlockNumber for 4 s by default, which delays indexing a ticket opened just before a
   *  close re-post (it is then due one tick later instead of at the close). */
  async head(): Promise<bigint> {
    return this.pub.getBlockNumber({ cacheTime: 0 });
  }

  async hasCode(a: Address): Promise<boolean> {
    const c = await this.pub.getCode({ address: a });
    return !!c && c !== '0x';
  }

  private wallet(a: Account): WalletClient {
    let w = this.wallets.get(a.address);
    if (!w) {
      w = createWalletClient({ account: a, chain: this.chain, transport: http(this.url, { retryCount: 2, timeout: 60_000 }) });
      this.wallets.set(a.address, w);
    }
    return w;
  }

  private lockOf(a: Account): Mutex {
    return a.address === this.signer.address ? this.signerLock : this.houseLock;
  }

  /** Sends one signed transaction and waits for its receipt (anvil automines). */
  send(from: Account, tx: TxReq): Promise<TxResult> {
    return this.lockOf(from).run(async () => {
      const hash = await this.wallet(from).sendTransaction({ account: from, chain: this.chain, to: tx.to, data: tx.data, value: tx.value ?? 0n, ...(tx.gas ? { gas: tx.gas } : {}) });
      const r = await this.pub.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: RECEIPT_POLL_MS });
      return { hash, status: r.status, blockNumber: r.blockNumber };
    });
  }

  /** Sends several transactions with consecutive nonces without waiting in between, then waits for all receipts. */
  sendMany(from: Account, txs: TxReq[]): Promise<TxResult[]> {
    if (!txs.length) return Promise.resolve([]);
    return this.lockOf(from).run(async () => {
      const w = this.wallet(from);
      let nonce = await this.pub.getTransactionCount({ address: from.address, blockTag: 'pending' });
      const gasPrice = await this.pub.getGasPrice();
      const hashes: Hex[] = [];
      for (const tx of txs) {
        hashes.push(await w.sendTransaction({ account: from, chain: this.chain, to: tx.to, data: tx.data, value: tx.value ?? 0n, nonce: nonce++, gas: 400_000n, gasPrice: gasPrice * 2n }));
      }
      const out: TxResult[] = [];
      for (const hash of hashes) {
        const r = await this.pub.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: RECEIPT_POLL_MS });
        out.push({ hash, status: r.status, blockNumber: r.blockNumber });
      }
      return out;
    });
  }

  /** Mines one block at fork time `target` (absolute: evm_mine with a timestamp, sent once without transport
   *  retries). A repeated call mines another block at the same time and never moves the clock twice. When the call
   *  fails, the clock is read back and a move that landed counts. Returns the new block timestamp. */
  async advanceTo(target: number): Promise<number> {
    const t = Math.floor(target);
    try {
      await (this.clockPub.request as (a: { method: string; params: unknown[] }) => Promise<unknown>)({ method: 'evm_mine', params: [numberToHex(t)] });
    } catch (e) {
      const now = await this.now();
      if (now >= t) return now;
      throw e;
    }
    return this.now();
  }

  /** Moves the clock `seconds` past the latest block (absolute target, see advanceTo); returns the new timestamp. */
  async advance(seconds: number): Promise<number> {
    return this.advanceTo((await this.now()) + Math.max(0, Math.floor(seconds)));
  }

  async impersonate(a: Address): Promise<void> {
    await this.rpc('anvil_impersonateAccount', [a]);
    const bal = await this.pub.getBalance({ address: a });
    if (bal < 10n ** 17n) await this.rpc('anvil_setBalance', [a, numberToHex(bal + 10n ** 18n)]);
  }

  async stopImpersonating(a: Address): Promise<void> {
    await this.rpc('anvil_stopImpersonatingAccount', [a]);
  }

  /** eth_sendTransaction from an impersonated account (anvil only); waits for the receipt. */
  async sendImpersonated(from: Address, tx: TxReq): Promise<TxResult> {
    const hash = await this.rpc<Hex>('eth_sendTransaction', [{ from, to: tx.to, data: tx.data, value: numberToHex(tx.value ?? 0n) }]);
    const r = await this.pub.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: RECEIPT_POLL_MS });
    return { hash, status: r.status, blockNumber: r.blockNumber };
  }
}
