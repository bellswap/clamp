// The playground wallet. A burner key is created in the browser on first visit and kept in localStorage (the launchpad
// demo's pattern, lib/demo-wallet.ts, with its own key so the two never mix); it signs locally and sends through the
// playground RPC. The connect button switches to an injected wallet (EIP-1193 window.ethereum) after adding and
// selecting the playground chain 46633, so a real wallet never signs for Robinhood Chain mainnet (4663) here.
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  maxUint256,
  MethodNotFoundRpcError,
  numberToHex,
  parseEventLogs,
  parseUnits,
  stringToHex,
  toFunctionSelector,
  type Address,
  type EIP1193Provider,
  type Hash,
  type WalletClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { bookAbi, erc20Abi, vaultAbi } from '../abi';
import { BOOK, CHAIN_ID, FEE_BPS_DEFAULT, MOCK, RPC_URL, USDG_DECIMALS, playChain } from '../config';
import { withHeadroom } from './gas';
import * as mock from './mock';
import type { Balances } from './types';

export const KEY_STORAGE = 'bellswap.v2.key';
export const KIND_STORAGE = 'bellswap.v2.wallet';
export const FUNDED_STORAGE = 'bellswap.v2.funded';
const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;

export type WalletKind = 'burner' | 'injected';

function lsGet(k: string): string | null {
  try {
    return globalThis.localStorage?.getItem(k) ?? null;
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string): void {
  try {
    globalThis.localStorage?.setItem(k, v);
  } catch {
    /* storage blocked: lives for this page load */
  }
}

let memKey: `0x${string}` | null = null;
/** The burner key for this page load: resolved once (the stored key, or a new one that is stored; a malformed stored
 * value is replaced) and then fixed, so the shown address, the signer and the export never diverge when another tab
 * writes a different key. */
export function burnerKey(): `0x${string}` {
  if (memKey) return memKey;
  const v = lsGet(KEY_STORAGE);
  if (v && HEX_KEY.test(v)) return (memKey = v as `0x${string}`);
  memKey = generatePrivateKey();
  lsSet(KEY_STORAGE, memKey);
  return memKey;
}

export const burnerAccount = () => privateKeyToAccount(burnerKey());

export const publicClient = createPublicClient({ chain: playChain, transport: http(RPC_URL, { retryCount: 2 }) });

// The public RPC allowlist has no eth_fillTransaction (eRPC answers 401). viem tries it before every write and only
// stops after a method-not-found error, so the burner transport answers it locally that way and forwards the rest.
const burnerTransport = custom(
  {
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method === 'eth_fillTransaction') throw new MethodNotFoundRpcError(new Error('eth_fillTransaction is not available'));
      return publicClient.request({ method, params } as never);
    },
  },
  { retryCount: 0 },
);

export function wasFunded(a: string): boolean {
  return (lsGet(FUNDED_STORAGE) ?? '').split(',').includes(a.toLowerCase());
}
export function markFunded(a: string): void {
  const cur = (lsGet(FUNDED_STORAGE) ?? '').split(',').filter(Boolean);
  if (!cur.includes(a.toLowerCase())) lsSet(FUNDED_STORAGE, [...cur, a.toLowerCase()].join(','));
}
export function storedKind(): WalletKind {
  return lsGet(KIND_STORAGE) === 'injected' ? 'injected' : 'burner';
}
export function storeKind(k: WalletKind): void {
  lsSet(KIND_STORAGE, k);
}

declare global {
  interface Window { ethereum?: EIP1193Provider }
}

export function hasInjected(): boolean {
  return typeof window !== 'undefined' && !!window.ethereum;
}

/** Ask the injected wallet for an account, add the playground chain and switch to it. */
export async function connectInjected(): Promise<Address> {
  const eth = window.ethereum;
  if (!eth) throw new Error('no injected wallet');
  const [addr] = (await eth.request({ method: 'eth_requestAccounts' })) as Address[];
  if (!addr) throw new Error('no account');
  const chainId = numberToHex(CHAIN_ID);
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch {
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId, chainName: playChain.name, nativeCurrency: playChain.nativeCurrency, rpcUrls: [RPC_URL] }],
    });
  }
  return addr;
}

type GasParams = Parameters<typeof publicClient.estimateContractGas>[0];

/** The write parameters with a gas limit 30% over the estimate (lib/gas.ts), so a clock block landing between the
 * estimate and inclusion cannot run the transaction out of gas. */
async function withGas<const P extends GasParams>(p: P): Promise<P & { gas: bigint }> {
  return { ...p, gas: withHeadroom(await publicClient.estimateContractGas(p)) };
}

function walletFor(kind: WalletKind, address: Address): WalletClient {
  if (kind === 'injected' && window.ethereum) return createWalletClient({ account: address, chain: playChain, transport: custom(window.ethereum) });
  return createWalletClient({ account: burnerAccount(), chain: playChain, transport: burnerTransport });
}

const addr = (a: string | undefined): Address => {
  if (!a) throw new Error('contracts not deployed (VITE_BOOK_JSON is empty)');
  return a as Address;
};
const toRaw = (v: number) => parseUnits(v.toFixed(USDG_DECIMALS), USDG_DECIMALS);
const fromRaw = (v: bigint) => Number(v) / 10 ** USDG_DECIMALS;
export const symbolBytes = (s: string) => stringToHex(s, { size: 32 });

export async function balances(address: string): Promise<Balances> {
  if (MOCK) return mock.mockBalances(address);
  const a = address as Address;
  const [eth, usdg] = await Promise.all([
    publicClient.getBalance({ address: a }),
    BOOK.usdg ? publicClient.readContract({ address: addr(BOOK.usdg), abi: erc20Abi, functionName: 'balanceOf', args: [a] }) : Promise.resolve(0n),
  ]);
  return { eth: Number(eth) / 1e18, usdg: fromRaw(usdg) };
}

let feeBpsP: Promise<number> | null = null;
export function feeBps(): Promise<number> {
  if (MOCK) return Promise.resolve(mock.MOCK_FEE_BPS);
  feeBpsP ??= BOOK.book
    ? publicClient.readContract({ address: addr(BOOK.book), abi: bookAbi, functionName: 'feeBps' }).then(Number, () => FEE_BPS_DEFAULT)
    : Promise.resolve(FEE_BPS_DEFAULT);
  return feeBpsP;
}

export interface OpenParams { symbol: string; long: boolean; leverage: number; stake: number; horizon: number }
export interface OpenHooks { onApproved?: () => void }

/** Approve (when the allowance is short) and open: two transactions, the hook fires between them. Returns the id. */
export async function openTicket(kind: WalletKind, owner: Address, p: OpenParams, hooks: OpenHooks = {}): Promise<string> {
  if (MOCK) {
    await mock.mockApprove();
    hooks.onApproved?.();
    return mock.mockOpen({ owner, ...p });
  }
  const w = walletFor(kind, owner);
  const book = addr(BOOK.book);
  const usdg = addr(BOOK.usdg);
  const stake = toRaw(p.stake);
  const allowance = await publicClient.readContract({ address: usdg, abi: erc20Abi, functionName: 'allowance', args: [owner, book] });
  if (allowance < stake) {
    const h = await w.writeContract(await withGas({ account: w.account!, chain: playChain, address: usdg, abi: erc20Abi, functionName: 'approve', args: [book, maxUint256] }));
    await mustSucceed(h);
  }
  hooks.onApproved?.();
  const args = [symbolBytes(p.symbol), p.long, p.leverage, stake, p.horizon] as const;
  const sim = await publicClient.simulateContract({ account: w.account!, address: book, abi: bookAbi, functionName: 'open', args });
  const h = await w.writeContract(await withGas(sim.request));
  const receipt = await mustSucceed(h);
  const logs = parseEventLogs({ abi: bookAbi, logs: receipt.logs, eventName: 'TicketOpened' });
  return String(logs[0]?.args.id ?? sim.result);
}

async function mustSucceed(hash: Hash) {
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error('transaction reverted');
  return r;
}

export interface VaultPosition { /** USDG the shares are worth (ownership). */ owned: number; /** USDG withdrawable now (free liquidity bound). */ withdrawable: number }

/** The owner's vault position: convertToAssets(balanceOf) for ownership, maxWithdraw for the withdraw limit. */
export async function vaultPosition(address: string): Promise<VaultPosition> {
  if (MOCK) {
    const v = await mock.mockShare(address);
    return { owned: v, withdrawable: v };
  }
  if (!BOOK.vault) return { owned: 0, withdrawable: 0 };
  const vault = addr(BOOK.vault);
  const a = address as Address;
  const [shares, max] = await Promise.all([
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'balanceOf', args: [a] }).catch(() => 0n),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'maxWithdraw', args: [a] }).catch(() => 0n),
  ]);
  const owned = shares > 0n ? await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'convertToAssets', args: [shares] }).catch(() => max) : 0n;
  return { owned: fromRaw(owned), withdrawable: fromRaw(max) };
}

/** Deposit (approve when short, then deposit) or withdraw, in USDG. */
export async function vaultMove(kind: WalletKind, owner: Address, amount: number, deposit: boolean, hooks: OpenHooks = {}): Promise<void> {
  if (MOCK) {
    if (deposit) {
      await mock.mockApprove();
      hooks.onApproved?.();
    }
    return mock.mockVaultMove(owner, amount, deposit);
  }
  const w = walletFor(kind, owner);
  const vault = addr(BOOK.vault);
  const raw = toRaw(amount);
  if (deposit) {
    const usdg = addr(BOOK.usdg);
    const allowance = await publicClient.readContract({ address: usdg, abi: erc20Abi, functionName: 'allowance', args: [owner, vault] });
    if (allowance < raw) await mustSucceed(await w.writeContract(await withGas({ account: w.account!, chain: playChain, address: usdg, abi: erc20Abi, functionName: 'approve', args: [vault, maxUint256] })));
    hooks.onApproved?.();
    await mustSucceed(await w.writeContract(await withGas({ account: w.account!, chain: playChain, address: vault, abi: vaultAbi, functionName: 'deposit', args: [raw, owner] })));
  } else {
    await mustSucceed(await w.writeContract(await withGas({ account: w.account!, chain: playChain, address: vault, abi: vaultAbi, functionName: 'withdraw', args: [raw, owner, owner] })));
  }
}

/** Watch TicketSettled for one id (live mode); returns the unwatch. Polls eth_getLogs every 2 s: the public RPC
 * allowlist has no filter methods, and watchContractEvent would try eth_newFilter first. */
export function watchSettled(id: string, cb: () => void): () => void {
  if (MOCK || !BOOK.book) return () => undefined;
  const address = addr(BOOK.book);
  let stopped = false;
  let from: bigint | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      const head = await publicClient.getBlockNumber({ cacheTime: 0 });
      const start = from ?? head;
      if (head >= start) {
        const logs = await publicClient.getContractEvents({ address, abi: bookAbi, eventName: 'TicketSettled', args: { id: BigInt(id) }, fromBlock: start, toBlock: head });
        from = head + 1n;
        if (logs.length && !stopped) cb();
      }
    } catch {
      // next tick
    }
    if (!stopped) timer = setTimeout(tick, 2000);
  };
  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** Selector of DemoSignerReference's NoRound(bytes32). The open is simulated with the TicketBook ABI, which does not
 * carry the reference's errors, so viem reports NoRound by its selector only. */
export const NO_ROUND_SELECTOR = toFunctionSelector('NoRound(bytes32)');

/** The open reverted because the reference had no print within maxStaleness (TicketBook Stale) or no round at all
 * (DemoSignerReference NoRound): the market needs a warm print first. viem names a known custom error in its message
 * chain and gives an unknown one's selector (signature, raw data or message). */
export function isStaleRevert(e: unknown): boolean {
  const named = (m: string) => /\b(Stale|NoRound)\b/.test(m) || m.toLowerCase().includes(NO_ROUND_SELECTOR);
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const o = cur as { errorName?: unknown; signature?: unknown; data?: unknown; shortMessage?: unknown; message?: unknown; cause?: unknown };
    const data = o.data as { errorName?: unknown } | string | undefined;
    const name = o.errorName ?? (typeof data === 'object' && data !== null ? data.errorName : undefined);
    if (name === 'Stale' || name === 'NoRound') return true;
    if (typeof o.signature === 'string' && o.signature.toLowerCase() === NO_ROUND_SELECTOR) return true;
    if (typeof data === 'string' && data.toLowerCase().startsWith(NO_ROUND_SELECTOR)) return true;
    for (const m of [o.shortMessage, o.message]) if (typeof m === 'string' && named(m)) return true;
    cur = o.cause;
  }
  return typeof e === 'string' && named(e);
}
