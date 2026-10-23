// HTTP front of the guard: POST bodies are JSON-RPC (single or batch). A request the policy accepts goes to the
// upstream byte for byte and its answer comes back unchanged; rejected calls get a JSON-RPC error -32003 and never
// reach the upstream. In a mixed batch only the accepted calls are forwarded and the answers are merged back in
// request order; notifications (no `id` member) get no answer, accepted or not. GET /health answers locally with
// `ready` (a target contract is known; until then every raw send is rejected).
import { checkCall, rejection, type Policy, type RpcCall } from './guard';

export interface GuardOpts {
  upstream: string;
  policy: Policy;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface GuardStats {
  requests: number;
  forwarded: number;
  rejected: number;
  byReason: Record<string, number>;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/** A JSON-RPC notification: a call object without an `id` member (the server sends no answer for it). */
export const isNotification = (c: unknown): boolean => c !== null && typeof c === 'object' && !Array.isArray(c) && !('id' in c);

export function makeGuard(o: GuardOpts) {
  const f = o.fetchImpl ?? fetch;
  const log = o.log ?? ((l: string) => console.log(l));
  const stats: GuardStats = { requests: 0, forwarded: 0, rejected: 0, byReason: {} };

  const forward = async (req: Request, body: ArrayBuffer | string | null): Promise<Response> => {
    const headers = new Headers();
    const ct = req.headers.get('content-type');
    if (ct) headers.set('content-type', ct);
    const accept = req.headers.get('accept');
    if (accept) headers.set('accept', accept);
    const url = new URL(req.url);
    const target = o.upstream.replace(/\/+$/, '') + (url.pathname === '/' ? '' : url.pathname) + url.search;
    const r = await f(target || o.upstream, { method: req.method, headers, body, signal: AbortSignal.timeout(o.timeoutMs ?? 120_000) });
    stats.forwarded += 1;
    const out = new Headers();
    const rct = r.headers.get('content-type');
    if (rct) out.set('content-type', rct);
    return new Response(await r.arrayBuffer(), { status: r.status, headers: out });
  };

  const reject = (c: RpcCall, reason: string) => {
    stats.rejected += 1;
    stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1;
    log(`[rpc-guard] rejected ${String(c?.method)}: ${reason}`);
    return rejection(c?.id, reason);
  };

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true, ready: o.policy.targets().size > 0, ...stats });
    stats.requests += 1;
    if (req.method !== 'POST') return forward(req, req.method === 'GET' || req.method === 'HEAD' ? null : await req.arrayBuffer());
    const bytes = await req.arrayBuffer();
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return forward(req, bytes); // the upstream answers the parse error
    }
    if (Array.isArray(parsed)) {
      const calls = parsed as RpcCall[];
      const verdicts = await Promise.all(calls.map((c) => checkCall(c, o.policy)));
      if (verdicts.every((v) => v.ok)) return forward(req, bytes);
      const keep = calls.filter((_, i) => verdicts[i]!.ok);
      // the calls the upstream answers: accepted ones that are not notifications
      const asked = keep.filter((c) => !isNotification(c));
      let answers: unknown[] = [];
      if (keep.length) {
        const r = await forward(req, JSON.stringify(keep));
        const got = await r.json().catch(() => null);
        answers = Array.isArray(got) ? got : asked.map((c) => ({ jsonrpc: '2.0', id: c?.id ?? null, error: { code: -32603, message: 'upstream error' } }));
      }
      // Match by id when ids are unique, else by position among the answered calls.
      const ids = asked.map((c) => JSON.stringify(c?.id ?? null));
      const unique = new Set(ids).size === ids.length;
      const byId = new Map<string, unknown>();
      if (unique) for (const a of answers) byId.set(JSON.stringify((a as { id?: unknown })?.id ?? null), a);
      let k = 0;
      const merged: unknown[] = [];
      calls.forEach((c, i) => {
        const v = verdicts[i]!;
        const note = isNotification(c);
        if (!v.ok) {
          const e = reject(c, v.reason);
          if (!note) merged.push(e);
          return;
        }
        if (note) return;
        const pos = k++;
        merged.push((unique ? byId.get(ids[pos]!) : undefined) ?? answers[pos] ?? { jsonrpc: '2.0', id: c?.id ?? null, error: { code: -32603, message: 'no upstream answer' } });
      });
      // JSON-RPC 2.0: a batch of notifications only gets no body at all
      if (!merged.length) return new Response(null, { status: 200 });
      return new Response(JSON.stringify(merged), { status: 200, headers: JSON_HEADERS });
    }
    const c = parsed as RpcCall;
    const v = await checkCall(c, o.policy);
    if (!v.ok) return new Response(JSON.stringify(reject(c, v.reason)), { status: 200, headers: JSON_HEADERS });
    return forward(req, bytes);
  }

  return {
    stats,
    async fetch(req: Request): Promise<Response> {
      try {
        return await handle(req);
      } catch (e) {
        log(`[rpc-guard] upstream failed: ${(e as Error).message.split('\n')[0]}`);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'upstream unavailable' } }), { status: 502, headers: JSON_HEADERS });
      }
    },
  };
}
