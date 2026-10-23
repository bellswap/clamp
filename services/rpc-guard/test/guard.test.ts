import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { encodeFunctionData, parseAbi, stringToHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { ANVIL_MNEMONIC, checkCall, dataHasAddress, devAddresses, makePolicy, REJECT_CODE } from '../src/guard';
import { addressBook, bellBook, refsFromEnv } from '../src/index';
import { isNotification, makeGuard } from '../src/server';

// deployments/book.json
const BOOK: Address = '0xA2Ec435D67B35893b81a87212815DCDd20EE4f9B';
const REF: Address = '0x980ea9f1a0C36e1E5f3B6BD451bEf8a7Fe661f97';
const VAULT: Address = '0xB8357F7f41125d4b24AD052c1b7288BeF5C43446';
const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const TARGETS = [BOOK, VAULT, USDG];
const MULTICALL: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const CHAIN = 46633;

const bookAbi = parseAbi(['function open(bytes32 symbol, bool long, uint8 leverage, uint256 stake, uint8 horizon) returns (uint256)', 'function pause()']);
const refAbi = parseAbi(['function post(bytes32 symbol, uint256 price8, uint64 timestamp, bytes signature)']);
const mcAbi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[])']);

const dev0 = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 });
const dev9 = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 9 });
const fresh = privateKeyToAccount(generatePrivateKey());

const openData = encodeFunctionData({ abi: bookAbi, functionName: 'open', args: [stringToHex('NVDA', { size: 32 }), true, 5, 20_000_000n, 0] });
const postData = encodeFunctionData({ abi: refAbi, functionName: 'post', args: [stringToHex('NVDA', { size: 32 }), 100n * 10n ** 8n, 1n, '0x'] });

async function sign(a: typeof fresh | typeof dev0, to: Address, data: Hex, extra: Record<string, unknown> = {}): Promise<Hex> {
  return a.signTransaction({ chainId: CHAIN, type: 'eip1559', to, data, nonce: 0, gas: 400_000n, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 1n, value: 0n, ...extra } as never);
}

const policy = makePolicy({ refs: () => [REF], targets: () => TARGETS });
const raw = (tx: Hex, id: unknown = 1) => ({ jsonrpc: '2.0', id, method: 'eth_sendRawTransaction', params: [tx] });

describe('dev accounts', () => {
  test('derived from the anvil mnemonic: dev 0 is the book owner, dev 1 the demo signer', () => {
    const d = devAddresses();
    expect(d.length).toBe(10);
    expect(d[0]).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(d[1]).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    expect(d[9]).toBe('0xa0Ee7A142d267C1f36714E4a8F75612F20a79720');
  });
});

describe('policy', () => {
  test('rejects a dev key 0 transaction (pause on the book)', async () => {
    const tx = await sign(dev0, BOOK, encodeFunctionData({ abi: bookAbi, functionName: 'pause' }));
    const v = await checkCall(raw(tx), policy);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('dev accounts');
  });
  test('rejects dev key 9 too', async () => {
    const v = await checkCall(raw(await sign(dev9, BOOK, openData)), policy);
    expect(v.ok).toBe(false);
  });
  test('rejects a fresh key posting to the reference', async () => {
    const v = await checkCall(raw(await sign(fresh, REF, postData)), policy);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('price reference');
  });
  test('rejects a reference address in lower case config', async () => {
    const p = makePolicy({ refs: () => [REF.toLowerCase()], targets: () => TARGETS });
    expect((await checkCall(raw(await sign(fresh, REF, postData)), p)).ok).toBe(false);
  });
  test('rejects a relay of a post through a multicall (reference in calldata)', async () => {
    const data = encodeFunctionData({ abi: mcAbi, functionName: 'aggregate3', args: [[{ target: REF, allowFailure: false, callData: postData }]] });
    const v = await checkCall(raw(await sign(fresh, MULTICALL, data)), policy);
    expect(v.ok).toBe(false);
  });
  test('passes a fresh key opening a ticket', async () => {
    const v = await checkCall(raw(await sign(fresh, BOOK, openData)), policy);
    expect(v).toEqual({ ok: true });
  });
  test('passes a legacy transaction from a fresh key', async () => {
    const tx = await fresh.signTransaction({ chainId: CHAIN, type: 'legacy', to: BOOK, data: openData, nonce: 3, gas: 300_000n, gasPrice: 10n ** 9n, value: 0n });
    expect((await checkCall(raw(tx), policy)).ok).toBe(true);
  });
  test('rejects a legacy transaction from dev 0', async () => {
    const tx = await dev0.signTransaction({ chainId: CHAIN, type: 'legacy', to: BOOK, data: openData, nonce: 3, gas: 300_000n, gasPrice: 10n ** 9n, value: 0n });
    expect((await checkCall(raw(tx), policy)).ok).toBe(false);
  });
  test('rejects an EIP-7702 authorization signed by dev 0, sent by a fresh key', async () => {
    const auth = await dev0.signAuthorization!({ address: MULTICALL, chainId: CHAIN, nonce: 5 });
    const tx = await fresh.signTransaction({ chainId: CHAIN, type: 'eip7702', authorizationList: [auth], to: BOOK, data: '0x', nonce: 0, gas: 400_000n, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 1n, value: 0n });
    const v = await checkCall(raw(tx), policy);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('EIP-7702');
  });
  test('rejects an EIP-7702 authorization signed by a fresh key too (delegation to relay code)', async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const auth = await other.signAuthorization!({ address: MULTICALL, chainId: CHAIN, nonce: 0 });
    const tx = await fresh.signTransaction({ chainId: CHAIN, type: 'eip7702', authorizationList: [auth], to: BOOK, data: openData, nonce: 0, gas: 400_000n, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 1n, value: 0n });
    expect((await checkCall(raw(tx), policy)).ok).toBe(false);
  });
  test('rejects contract creation (a relay that rebuilds the reference address at runtime)', async () => {
    // initcode without the reference literal: the relay would read TicketBook.markets(sym).ref and post through it
    const tx = await fresh.signTransaction({ chainId: CHAIN, type: 'eip1559', data: '0x6080604052348015600e575f80fd5b50', nonce: 0, gas: 900_000n, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 1n, value: 0n } as never);
    const v = await checkCall(raw(tx), policy);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('contract creation');
  });
  test('rejects a call to a contract other than TicketBook, HouseVault and USDG (an already deployed relay)', async () => {
    const relay = privateKeyToAccount(generatePrivateKey()).address;
    const v = await checkCall(raw(await sign(fresh, relay, openData)), policy);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('only calls to the playground');
  });
  test('passes approve on USDG and deposit on the vault from a fresh key', async () => {
    const erc = parseAbi(['function approve(address spender, uint256 amount) returns (bool)', 'function deposit(uint256 assets, address receiver) returns (uint256)']);
    expect((await checkCall(raw(await sign(fresh, USDG, encodeFunctionData({ abi: erc, functionName: 'approve', args: [BOOK, 1n] }))), policy)).ok).toBe(true);
    expect((await checkCall(raw(await sign(fresh, VAULT, encodeFunctionData({ abi: erc, functionName: 'deposit', args: [1n, fresh.address] }))), policy)).ok).toBe(true);
  });
  test('a reference or dev address configured as a target is never a target', async () => {
    const p = makePolicy({ refs: () => [REF], targets: () => [REF, dev0.address, BOOK] });
    expect([...p.targets()]).toEqual([BOOK.toLowerCase()]);
    expect((await checkCall(raw(await sign(fresh, REF, postData)), p)).ok).toBe(false);
  });
  test('rejects garbage raw transactions and the Sync variant from dev 0', async () => {
    expect((await checkCall(raw('0x1234' as Hex), policy)).ok).toBe(false);
    expect((await checkCall({ id: 1, method: 'eth_sendRawTransaction', params: [42] }, policy)).ok).toBe(false);
    const tx = await sign(dev0, BOOK, openData);
    expect((await checkCall({ id: 1, method: 'eth_sendRawTransactionSync', params: [tx] }, policy)).ok).toBe(false);
  });
  test('rejects unsigned sends and admin namespaces unless allowed', async () => {
    const send = { id: 1, method: 'eth_sendTransaction', params: [{ from: dev0.address, to: BOOK, data: '0x' }] };
    expect((await checkCall(send, policy)).ok).toBe(false);
    expect((await checkCall({ id: 1, method: 'anvil_setBalance', params: [fresh.address, '0x1'] }, policy)).ok).toBe(false);
    expect((await checkCall({ id: 1, method: 'evm_increaseTime', params: ['0x1'] }, policy)).ok).toBe(false);
    expect((await checkCall({ id: 1, method: 'eth_sign', params: [dev0.address, '0x00'] }, policy)).ok).toBe(false);
    const admin = makePolicy({ refs: () => [REF], targets: () => TARGETS, allowAdmin: true });
    expect((await checkCall({ id: 1, method: 'anvil_setBalance', params: [fresh.address, '0x1'] }, admin)).ok).toBe(true);
    expect((await checkCall(send, admin)).ok).toBe(false); // dev sender stays blocked
    expect((await checkCall({ id: 1, method: 'eth_sendTransaction', params: [{ from: fresh.address, to: REF }] }, admin)).ok).toBe(false);
    expect((await checkCall({ id: 1, method: 'eth_sendTransaction', params: [{ from: fresh.address, to: BOOK, data: openData }] }, admin)).ok).toBe(true);
  });
  test('reads pass', async () => {
    for (const m of ['eth_call', 'eth_getLogs', 'eth_chainId', 'eth_blockNumber', 'eth_estimateGas']) {
      expect((await checkCall({ id: 1, method: m, params: [{ to: REF, data: '0x' }] }, policy)).ok).toBe(true);
    }
  });
  test('anvil send aliases are blocked like eth_sendTransaction (unsigned, Sync, wallet_*, any case)', async () => {
    const admin = makePolicy({ refs: () => [REF], targets: () => TARGETS, allowAdmin: true });
    for (const m of ['eth_sendUnsignedTransaction', 'eth_sendTransactionSync', 'wallet_sendTransaction', 'odyssey_sendTransaction', 'ETH_SENDTRANSACTION', 'eth_signTransaction']) {
      const toRef = { id: 1, method: m, params: [{ from: fresh.address, to: REF, data: postData }] };
      const fromDev = { id: 1, method: m, params: [{ from: dev0.address, to: BOOK, data: '0x' }] };
      expect((await checkCall(toRef, policy)).ok).toBe(false);
      expect((await checkCall(fromDev, policy)).ok).toBe(false);
      expect((await checkCall(fromDev, admin)).ok).toBe(false);
      expect((await checkCall(toRef, admin)).ok).toBe(false);
    }
    expect((await checkCall({ id: 1, method: 'ANVIL_setBalance', params: [fresh.address, '0x1'] }, policy)).ok).toBe(false);
  });
  test('no target known: every raw send is rejected (fail closed), reads still pass', async () => {
    const p = makePolicy({ refs: () => [] });
    expect((await checkCall(raw(await sign(dev0, BOOK, openData)), p)).ok).toBe(false);
    expect((await checkCall(raw(await sign(fresh, REF, postData)), p)).ok).toBe(false);
    const v = await checkCall(raw(await sign(fresh, BOOK, openData)), p);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('not known yet');
    expect((await checkCall({ id: 1, method: 'eth_call', params: [{ to: BOOK, data: '0x' }] }, p)).ok).toBe(true);
  });
  test('targets known, reference not: a post to the reference is still rejected', async () => {
    const p = makePolicy({ refs: () => [], targets: () => TARGETS });
    expect((await checkCall(raw(await sign(fresh, REF, postData)), p)).ok).toBe(false);
    expect((await checkCall(raw(await sign(fresh, BOOK, openData)), p)).ok).toBe(true);
  });
  test('dataHasAddress matches byte-aligned occurrences only', () => {
    const refs = new Set([REF.toLowerCase()]);
    expect(dataHasAddress('0x' + '00'.repeat(12) + REF.slice(2).toLowerCase(), refs)).toBe(true);
    expect(dataHasAddress('0x0' + REF.slice(2).toLowerCase() + '0', refs)).toBe(false);
    expect(dataHasAddress('0x', refs)).toBe(false);
  });
  test('refsFromEnv keeps valid addresses only', () => {
    expect(refsFromEnv(` ${REF}, nope ,${BOOK}`)).toEqual([REF.toLowerCase(), BOOK.toLowerCase()]);
    expect(refsFromEnv(undefined)).toEqual([]);
  });
});

describe('proxy', () => {
  let up: ReturnType<typeof Bun.serve>;
  let seen: string[] = [];
  beforeAll(() => {
    up = Bun.serve({
      port: 0,
      async fetch(req) {
        const text = await req.text();
        seen.push(text);
        let j: unknown;
        try {
          j = JSON.parse(text);
        } catch {
          return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        }
        const one = (c: { id?: unknown; method?: string }) => ({ jsonrpc: '2.0', id: c.id ?? null, result: `ok:${c.method}` });
        // JSON-RPC 2.0: notifications (no id member) get no answer
        if (Array.isArray(j)) {
          const answers = (j as Record<string, unknown>[]).filter((c) => 'id' in c).map((c) => one(c as never));
          return answers.length ? Response.json(answers) : new Response(null, { status: 200 });
        }
        return Response.json(one(j as never));
      },
    });
  });
  afterAll(() => up.stop(true));
  const guard = () => makeGuard({ upstream: `http://127.0.0.1:${up.port}`, policy, log: () => {} });
  const post = (g: ReturnType<typeof guard>, body: string) => g.fetch(new Request('http://guard/', { method: 'POST', headers: { 'content-type': 'application/json' }, body }));

  test('forwards an accepted call byte for byte and returns the upstream answer', async () => {
    seen = [];
    const g = guard();
    const body = `{"jsonrpc":"2.0", "id":7,"method":"eth_sendRawTransaction","params":["${await sign(fresh, BOOK, openData)}"]}`;
    const r = await post(g, body);
    expect(seen).toEqual([body]);
    expect(await r.json()).toEqual({ jsonrpc: '2.0', id: 7, result: 'ok:eth_sendRawTransaction' });
  });
  test('answers a rejected call with -32003 and never forwards it', async () => {
    seen = [];
    const g = guard();
    const r = await post(g, JSON.stringify(raw(await sign(dev0, BOOK, openData), 9)));
    expect(seen).toEqual([]);
    const j = (await r.json()) as { id: number; error: { code: number; message: string } };
    expect(j.id).toBe(9);
    expect(j.error.code).toBe(REJECT_CODE);
    expect(j.error.message).toContain('dev accounts');
    expect(g.stats.rejected).toBe(1);
  });
  test('batch: all accepted goes through unchanged', async () => {
    seen = [];
    const g = guard();
    const body = JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }, { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] }]);
    const r = await post(g, body);
    expect(seen).toEqual([body]);
    expect(((await r.json()) as unknown[]).length).toBe(2);
  });
  test('batch: mixed keeps order, forwards only accepted calls', async () => {
    seen = [];
    const g = guard();
    const body = JSON.stringify([
      { jsonrpc: '2.0', id: 'a', method: 'eth_chainId', params: [] },
      raw(await sign(fresh, REF, postData), 'b'),
      raw(await sign(fresh, BOOK, openData), 'c'),
    ]);
    const r = (await (await post(g, body)).json()) as { id: string; result?: string; error?: { code: number } }[];
    expect(r.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(r[0]!.result).toBe('ok:eth_chainId');
    expect(r[1]!.error!.code).toBe(REJECT_CODE);
    expect(r[2]!.result).toBe('ok:eth_sendRawTransaction');
    expect(seen.length).toBe(1);
    expect((JSON.parse(seen[0]!) as { id: string }[]).map((x) => x.id)).toEqual(['a', 'c']);
  });
  test('batch: all rejected never reaches the upstream', async () => {
    seen = [];
    const g = guard();
    const r = (await (await post(g, JSON.stringify([raw(await sign(dev0, BOOK, openData), 1), { id: 2, method: 'anvil_mine', params: [] }]))).json()) as { error: { code: number } }[];
    expect(seen).toEqual([]);
    expect(r.map((x) => x.error.code)).toEqual([REJECT_CODE, REJECT_CODE]);
  });
  test('batch: an accepted notification does not shift or duplicate answers', async () => {
    seen = [];
    const g = guard();
    const body = JSON.stringify([
      { jsonrpc: '2.0', method: 'eth_chainId', params: [] },
      { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
      raw(await sign(dev0, BOOK, openData), 2),
    ]);
    const r = (await (await post(g, body)).json()) as { id: number; result?: string; error?: { code: number } }[];
    expect(r.map((x) => x.id)).toEqual([1, 2]);
    expect(r[0]!.result).toBe('ok:eth_blockNumber');
    expect(r[1]!.error!.code).toBe(REJECT_CODE);
  });
  test('batch: duplicate ids fall back to position among answered calls, notifications skipped', async () => {
    seen = [];
    const g = guard();
    const body = JSON.stringify([
      { jsonrpc: '2.0', id: 5, method: 'eth_chainId', params: [] },
      { jsonrpc: '2.0', method: 'eth_gasPrice', params: [] },
      { jsonrpc: '2.0', id: 5, method: 'eth_blockNumber', params: [] },
      { jsonrpc: '2.0', id: 6, method: 'anvil_mine', params: [] },
    ]);
    const r = (await (await post(g, body)).json()) as { id: number; result?: string; error?: { code: number } }[];
    expect(r.map((x) => x.result ?? x.error!.code)).toEqual(['ok:eth_chainId', 'ok:eth_blockNumber', REJECT_CODE]);
  });
  test('batch: rejected notifications only get no body', async () => {
    seen = [];
    const g = guard();
    const r = await post(g, JSON.stringify([{ jsonrpc: '2.0', method: 'anvil_mine', params: [] }, { jsonrpc: '2.0', method: 'evm_mine', params: [] }]));
    expect(seen).toEqual([]);
    expect(await r.text()).toBe('');
    expect(isNotification({ id: null, method: 'x' })).toBe(false);
    expect(isNotification({ method: 'x' })).toBe(true);
  });
  test('invalid JSON goes to the upstream as is', async () => {
    seen = [];
    const r = await post(guard(), '{nope');
    expect(seen).toEqual(['{nope']);
    expect(((await r.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });
  test('health answers locally', async () => {
    seen = [];
    const r = await guard().fetch(new Request('http://guard/health'));
    expect(r.status).toBe(200);
    expect((await r.json()) as { ok: boolean; ready: boolean }).toMatchObject({ ok: true, ready: true });
    expect(seen).toEqual([]);
    const cold = makeGuard({ upstream: 'http://127.0.0.1:1', policy: makePolicy({ refs: () => [] }), log: () => {} });
    expect(((await (await cold.fetch(new Request('http://guard/health'))).json()) as { ready: boolean }).ready).toBe(false);
  });
  test('upstream down: 502 with a JSON-RPC error', async () => {
    const g = makeGuard({ upstream: 'http://127.0.0.1:1', policy, log: () => {} });
    const r = await post(g, JSON.stringify({ id: 1, method: 'eth_chainId', params: [] }));
    expect(r.status).toBe(502);
  });
});

describe('bell book', () => {
  test('reads the reference and the target contracts from /state', async () => {
    const f = (async () => Response.json({ book: { reference: REF, ticketBook: BOOK, vault: VAULT, usdg: USDG, startBlock: '1' } })) as unknown as typeof fetch;
    expect(await bellBook('http://bell:8787/', f)).toEqual({ reference: REF.toLowerCase(), targets: TARGETS.map((x) => x.toLowerCase()) });
    const g = (async () => Response.json({ book: null })) as unknown as typeof fetch;
    expect(await bellBook('http://bell:8787', g)).toBeNull();
  });
  test('addressBook merges env and bell, keeps the last bell answer across outages', () => {
    const b = addressBook([REF.toLowerCase()], []);
    expect(b.targets()).toEqual([]);
    expect(b.set({ reference: REF.toLowerCase(), targets: [BOOK.toLowerCase()] })).toBe(true);
    expect(b.set(null)).toBe(false);
    expect(b.targets()).toEqual([BOOK.toLowerCase()]);
    expect(b.refs()).toEqual([REF.toLowerCase(), REF.toLowerCase()]);
  });
});
