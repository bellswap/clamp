// Policy of the playground RPC guard (sits between eRPC and anvil). The anvil dev keys 0 to 9 are public, so a
// visitor could sign as the house (dev 0: TicketBook owner, pause, listMarket) or post rounds to the reference (dev 1
// signs DemoSignerReference rounds, and post() accepts any sender with a valid signature). The guard therefore accepts
// a signed transaction only when it is a plain call into the playground's own contracts:
//   - eth_sendRawTransaction and every eth_sendRaw* variant pass only when the recovered sender is not a dev key, `to`
//     is one of the targets (TicketBook, HouseVault, USDG from RPC_GUARD_TARGETS and the bell's /state book), the
//     calldata does not carry a reference address, and there is no EIP-7702 authorization list. Contract creation
//     (`to` empty) is rejected, so a relay that rebuilds the reference address at runtime cannot be deployed. While
//     no target is known (bell not answered yet, RPC_GUARD_TARGETS unset) every raw send is rejected (fail closed).
//   - every other eth_send* method (eth_sendTransaction, eth_sendTransactionSync, eth_sendUnsignedTransaction, ...),
//     eth_sign* (eth_signTransaction included) and the wallet_* and odyssey_* namespaces: anvil signs these for its
//     unlocked dev accounts or for any `from`; with RPC_GUARD_ALLOW_ADMIN=1 the send methods pass unless `from` is a
//     dev key or `to` (or the calldata) is a reference;
//   - the anvil_*, evm_*, hardhat_*, personal_* namespaces, unless RPC_GUARD_ALLOW_ADMIN=1 (eRPC's method allowlist
//     already drops them; this is the second layer).
// Method names are compared in lower case. Everything else (reads) passes unchanged.
import { getAddress, isAddress, isHex, parseTransaction, recoverTransactionAddress, type Address, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

/** The mnemonic anvil derives its dev accounts from (public, printed by anvil at start). */
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

/** JSON-RPC error code for a rejected transaction (EIP-1474: "Transaction rejected"). */
export const REJECT_CODE = -32003;

export function devAddresses(n = 10): Address[] {
  return Array.from({ length: n }, (_, i) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }).address);
}

export interface Policy {
  /** Lower-case dev addresses. */
  dev: Set<string>;
  /** Lower-case reference addresses (RPC_GUARD_REF plus the bell's /state reference). */
  refs(): Set<string>;
  /** Lower-case contracts a raw transaction may call (TicketBook, HouseVault, USDG); empty means not ready. */
  targets(): Set<string>;
  allowAdmin: boolean;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

const OK: Verdict = { ok: true };
const MSG = {
  dev: 'rejected by the playground guard: transactions from the public anvil dev accounts are not accepted',
  ref: 'rejected by the playground guard: transactions to the price reference are not accepted',
  refData: 'rejected by the playground guard: transactions that carry the price reference address are not accepted',
  auth: 'rejected by the playground guard: EIP-7702 authorizations are not accepted',
  create: 'rejected by the playground guard: contract creation is not accepted',
  target: 'rejected by the playground guard: only calls to the playground TicketBook, HouseVault and USDG are accepted',
  notReady: 'rejected by the playground guard: the playground contracts are not known yet, try again shortly',
  decode: 'rejected by the playground guard: the transaction could not be decoded',
  admin: 'rejected by the playground guard: this method is not available',
} as const;

const lowerAddrs = (xs: Iterable<string>) => new Set([...xs].filter((a) => isAddress(a)).map((a) => a.toLowerCase()));

export function makePolicy(opts: { refs: () => Iterable<string>; targets?: () => Iterable<string>; allowAdmin?: boolean; devCount?: number }): Policy {
  const dev = new Set(devAddresses(opts.devCount ?? 10).map((a) => a.toLowerCase()));
  const refs = () => lowerAddrs(opts.refs());
  return {
    dev,
    refs,
    // a reference is never a target, whatever the configuration says
    targets: () => {
      const r = refs();
      return new Set([...lowerAddrs(opts.targets?.() ?? [])].filter((a) => !r.has(a) && !dev.has(a)));
    },
    allowAdmin: opts.allowAdmin ?? false,
  };
}

const ADMIN_PREFIXES = ['anvil_', 'evm_', 'hardhat_', 'personal_'];
/** Namespaces where anvil sends or signs on behalf of an unlocked, impersonated or arbitrary `from`. */
const SEND_PREFIXES = ['eth_send', 'eth_sign', 'wallet_', 'odyssey_'];

/** eth_sendRawTransaction and its variants (Sync, Conditional, any future eth_sendRaw*). */
export function isRawSend(method: string): boolean {
  return method.toLowerCase().startsWith('eth_sendraw');
}

/** Methods that make anvil sign or send for a `from` the caller does not prove a key for. */
export function isUnsignedSend(method: string): boolean {
  const m = method.toLowerCase();
  return !isRawSend(m) && SEND_PREFIXES.some((x) => m.startsWith(x));
}

/** True when the hex calldata contains one of the addresses (20 bytes, any alignment on a nibble pair). */
export function dataHasAddress(data: string | undefined | null, addrs: Set<string>): boolean {
  if (!data || addrs.size === 0) return false;
  const d = data.toLowerCase().replace(/^0x/, '');
  for (const a of addrs) {
    const needle = a.replace(/^0x/, '');
    let i = d.indexOf(needle);
    while (i !== -1) {
      if (i % 2 === 0) return true;
      i = d.indexOf(needle, i + 1);
    }
  }
  return false;
}

export async function checkRaw(raw: unknown, p: Policy): Promise<Verdict> {
  if (typeof raw !== 'string' || !isHex(raw)) return { ok: false, reason: MSG.decode };
  let tx: ReturnType<typeof parseTransaction>;
  let from: Address;
  try {
    tx = parseTransaction(raw as Hex);
    from = await recoverTransactionAddress({ serializedTransaction: raw as never });
  } catch {
    return { ok: false, reason: MSG.decode };
  }
  if (p.dev.has(from.toLowerCase())) return { ok: false, reason: MSG.dev };
  if (!tx.to) return { ok: false, reason: MSG.create };
  const to = tx.to.toLowerCase();
  const refs = p.refs();
  if (refs.has(to)) return { ok: false, reason: MSG.ref };
  // EIP-7702 delegates an account to arbitrary code; the playground never needs it
  if ((tx as { authorizationList?: unknown[] }).authorizationList?.length) return { ok: false, reason: MSG.auth };
  const targets = p.targets();
  if (targets.size === 0) return { ok: false, reason: MSG.notReady };
  if (!targets.has(to)) return { ok: false, reason: MSG.target };
  if (dataHasAddress((tx as { data?: string }).data, refs)) return { ok: false, reason: MSG.refData };
  return OK;
}

function checkUnsigned(param: unknown, p: Policy): Verdict {
  if (!param || typeof param !== 'object') return OK; // anvil answers the malformed call itself
  const t = param as { from?: unknown; to?: unknown; data?: unknown; input?: unknown };
  if (typeof t.from === 'string' && p.dev.has(t.from.toLowerCase())) return { ok: false, reason: MSG.dev };
  const refs = p.refs();
  if (typeof t.to === 'string' && refs.has(t.to.toLowerCase())) return { ok: false, reason: MSG.ref };
  for (const d of [t.data, t.input]) if (typeof d === 'string' && dataHasAddress(d, refs)) return { ok: false, reason: MSG.refData };
  return OK;
}

export interface RpcCall {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** The verdict for one JSON-RPC call object. */
export async function checkCall(c: RpcCall, p: Policy): Promise<Verdict> {
  const m = typeof c?.method === 'string' ? c.method : '';
  const params = Array.isArray(c?.params) ? c.params : [];
  if (isRawSend(m)) return checkRaw(params[0], p);
  if (isUnsignedSend(m)) {
    // anvil signs these for unlocked or impersonated accounts (eth_sendUnsignedTransaction for any `from`); eRPC never
    // forwards them
    if (!p.allowAdmin) return { ok: false, reason: MSG.admin };
    return checkUnsigned(params[0], p);
  }
  const lm = m.toLowerCase();
  if (!p.allowAdmin && ADMIN_PREFIXES.some((x) => lm.startsWith(x))) return { ok: false, reason: MSG.admin };
  return OK;
}

export function rejection(id: unknown, reason: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code: REJECT_CODE, message: reason } };
}

export const normalizeAddress = (a: string): string | null => (isAddress(a) ? getAddress(a) : null);
