import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app';
import { loadEnv } from '../src/config';
import { clientKey, handler, originAllowed } from '../src/server';

const dir = mkdtempSync(join(tmpdir(), 'bell-test-'));
const env = loadEnv({ BELL_RPC_URL: 'http://127.0.0.1:1', BELL_STATE_FILE: join(dir, 'state.json'), BELL_BOOK: join(dir, 'none.json'), BELL_CHARTS: 'off', BELL_ADMIN_TOKEN: 'test-token' });
const app = new App(env);
const h = handler(app);

describe('server', () => {
  test('origins: list, Pages preview suffix over https only', () => {
    expect(originAllowed(env, 'https://play.bellswap.fun')).toBe(true);
    expect(originAllowed(env, 'https://abc123.bellswap-play.pages.dev')).toBe(true);
    expect(originAllowed(env, 'http://abc123.bellswap-play.pages.dev')).toBe(false);
    expect(originAllowed(env, 'https://evil.example')).toBe(false);
    expect(originAllowed(env, null)).toBe(false);
  });
  test('client key is the right-most X-Forwarded-For entry', () => {
    expect(clientKey(new Request('http://x/', { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } }), '9.9.9.9')).toBe('2.2.2.2');
    expect(clientKey(new Request('http://x/'), '9.9.9.9')).toBe('9.9.9.9');
  });
  test('GET /state answers with chain id 46633 even when the chain is down', async () => {
    const r = await h(new Request('http://x/state', { headers: { origin: 'https://play.bellswap.fun' } }));
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://play.bellswap.fun');
    const b = (await r.json()) as { chainId: number; speed: number; counts: Record<string, number>; error?: string };
    expect(b.chainId).toBe(46633);
    expect(b.speed).toBe(60);
    expect(b.counts.tickets).toBe(0);
    expect(b.error).toBeDefined();
  });
  test('GET /catalog carries 513 entries with onChain false before any listing', async () => {
    const b = (await (await h(new Request('http://x/catalog'))).json()) as { symbol: string; onChain: boolean; listedByRobinhood: boolean }[];
    expect(b.length).toBe(513);
    expect(b.every((e) => e.onChain === false && typeof e.listedByRobinhood === 'boolean')).toBe(true);
  });
  test('POST from a foreign origin is refused; bad faucet body is 400', async () => {
    expect((await h(new Request('http://x/faucet', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }))).status).toBe(403);
    expect((await h(new Request('http://x/faucet', { method: 'POST', body: '{"address":"nope"}' }))).status).toBe(400);
  });
  test('admin /replay needs the bearer token', async () => {
    expect((await h(new Request('http://x/replay', { method: 'POST', body: '{"speed":120}' }))).status).toBe(401);
    const r = await h(new Request('http://x/replay', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: '{"speed":120}' }));
    expect(r.status).toBe(200);
    expect(app.speed).toBe(120);
    expect((await h(new Request('http://x/replay', { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: '{"speed":0}' }))).status).toBe(400);
  });
  test('unknown routes 404, unknown ticket 404, prices of an unknown symbol 404', async () => {
    expect((await h(new Request('http://x/nope'))).status).toBe(404);
    expect((await h(new Request('http://x/tickets/7'))).status).toBe(404);
    expect((await h(new Request('http://x/prices/NOTATICKER'))).status).toBe(404);
    expect((await h(new Request('http://x/prices/NVDA'))).status).toBe(200);
  });
});
