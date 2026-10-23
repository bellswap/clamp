/// <reference lib="dom" />
// Live walkthrough of the playground: a fresh browser against a built site (bun run preview)
// that talks to the live RPC and bell. Usage:
//   bun run scripts/walkthrough.ts [site url] [bell url] [out dir]
//   defaults http://localhost:4173, https://api-play.bellswap.fun, ../docs/screenshots
// Steps: burner created, faucet credited, 10x long session ticket on sRTX, watch, settlement by the bell settler,
// verdict, share card, leaderboard row, toggle shows and hides NVDA, activity row. Writes int-*.png and prints one
// JSON line per step ({step, pass, detail}); exit 1 when a step fails.
import { chromium, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const base = process.argv[2] ?? 'http://localhost:4173';
const bell = process.argv[3] ?? 'https://api-play.bellswap.fun';
const out = resolve(process.argv[4] ?? join(import.meta.dir, '..', '..', 'docs', 'screenshots'));
const SETTLE_TIMEOUT_MS = Number(process.env.SETTLE_TIMEOUT_MS ?? 360_000);
mkdirSync(out, { recursive: true });

type Result = { step: string; pass: boolean; detail: string; ms: number };
const results: Result[] = [];
const errors: string[] = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const p: Page = await ctx.newPage();
p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
p.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
if (process.env.WALK_DEBUG) {
  const t0 = Date.now();
  p.on('request', (r) => r.url().includes('rpc-play') && console.error(`[rpc +${Date.now() - t0}ms] -> ${(r.postData() ?? '').match(/"method":"(\w+)"/g)?.join(',')}`));
  p.on('requestfinished', (r) => r.url().includes('rpc-play') && console.error(`[rpc +${Date.now() - t0}ms] <- ${(r.postData() ?? '').match(/"method":"(\w+)"/g)?.join(',')}`));
  p.on('requestfailed', (r) => console.error(`[req failed] ${r.url()} ${r.failure()?.errorText}`));
  p.on('console', (m) => console.error(`[console ${m.type()}] ${m.text().slice(0, 200)}`));
}
p.on('response', (r) => r.status() >= 400 && errors.push(`http ${r.status()} ${r.request().method()} ${r.url()} ${(r.request().postData() ?? '').slice(0, 120)}`));

async function shot(name: string) {
  await p.waitForTimeout(500);
  await p.screenshot({ path: join(out, `int-${name}.png`) });
}
async function step(name: string, fn: () => Promise<string>): Promise<boolean> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ step: name, pass: true, detail, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ step: name, pass: false, detail: String((e as Error).message ?? e).split('\n')[0] ?? '', ms: Date.now() - t0 });
    await p.screenshot({ path: join(out, `int-fail-${name}.png`) }).catch(() => undefined);
  }
  const r = results[results.length - 1]!;
  console.log(JSON.stringify(r));
  return r.pass;
}
const bellJson = async (path: string) => (await fetch(`${bell}${path}`)).json();

let address = '';
let ticketId = '';
try {
  await step('burner', async () => {
    await p.goto(`${base}/`);
    await p.waitForSelector('.row-body', { timeout: 30000 });
    const n = await p.evaluate(() => Object.keys(localStorage).filter((k) => /^0x[0-9a-fA-F]{64}$/.test(localStorage.getItem(k) ?? '')).length);
    if (n !== 1) throw new Error(`${n} burner keys in localStorage`);
    await shot('01-board');
    return 'burner key in localStorage';
  });

  await step('faucet', async () => {
    await p.waitForFunction(() => document.querySelector('.pill .num')?.textContent?.includes('1,000'), null, { timeout: 60000 });
    const pill = (await p.textContent('.pill .num'))?.trim() ?? '';
    return `wallet pill shows ${pill}`;
  });

  const opened = await step('open-10x-long-sRTX-session', async () => {
    await p.goto(`${base}/t/sRTX`);
    await p.waitForSelector('.sheet .btn-primary:not([disabled])', { timeout: 30000 });
    await p.click('.seg-side .seg-opt:nth-child(1)');
    await p.locator('.sheet .seg-opt', { hasText: /^10x$/ }).click();
    await p.locator('.sheet .field').filter({ hasText: /horizon/i }).locator('.seg-opt').first().click();
    await shot('02-ticket-sheet');
    await p.click('.sheet .btn-primary');
    await p.waitForURL(/\/ticket\/\d+/, { timeout: 90000 });
    ticketId = p.url().match(/\/ticket\/(\d+)/)?.[1] ?? '';
    let tk: { symbol?: string; long?: boolean; leverage?: number; owner?: string; horizon?: number } | null = null;
    for (let i = 0; i < 20 && !tk?.owner; i++) {
      const t = await bellJson(`/tickets/${ticketId}`).catch(() => null);
      tk = t?.ticket ?? null;
      if (!tk?.owner) await p.waitForTimeout(1000);
    }
    if (!tk?.owner) throw new Error(`bell has no ticket ${ticketId}`);
    if (tk.symbol !== 'RTX' || tk.long !== true || Number(tk.leverage) !== 10) throw new Error(`bell ticket ${tk.symbol} long=${tk.long} ${tk.leverage}x`);
    address = tk.owner;
    return `ticket ${ticketId} (bell: ${tk.symbol} long ${tk.leverage}x, owner ${tk.owner})`;
  });

  if (opened) {
    await step('watch', async () => {
      // A session ticket opened seconds before the playground close can settle before the watch view loads; then the
      // verdict is what the watch view shows, and the step records that.
      await p.waitForSelector('.countdown, .verdict', { timeout: 30000 });
      if (await p.locator('.verdict').count()) return 'settled before the watch view loaded (opened just before the session close)';
      await p.waitForTimeout(2500);
      await shot('03-watch');
      return `countdown ${(await p.textContent('.countdown'))?.trim()}`;
    });

    await step('settled-by-settler', async () => {
      await p.waitForSelector('.verdict', { timeout: SETTLE_TIMEOUT_MS });
      const t = await bellJson(`/tickets/${ticketId}`).catch(() => null);
      const tk = t?.ticket ?? t;
      return `verdict after settlement${tk ? ` (bell status ${tk.status}, payout ${tk.payout}, settle ${tk.settlePrice ?? tk.settlePrice8 ?? ''})` : ''}`;
    });

    await step('verdict', async () => {
      await p.waitForTimeout(1500);
      await shot('04-verdict');
      return ((await p.textContent('.verdict')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    });

    await step('share-card', async () => {
      await p.click('.verdict-actions .btn-primary');
      await p.waitForSelector('.share-img', { timeout: 15000 });
      const src = await p.evaluate(() => (document.querySelector('.share-img') as HTMLImageElement).src.slice(0, 22));
      if (src !== 'data:image/png;base64,') throw new Error('share card is not a PNG');
      await shot('05-share');
      return 'share card PNG rendered';
    });
  }

  await step('leaderboard', async () => {
    await p.goto(`${base}/leaders`);
    await p.waitForSelector('.lrow.you', { timeout: 30000 });
    const txt = ((await p.textContent('.lrow.you')) ?? '').replace(/\s+/g, ' ').trim();
    if (address && !txt.toLowerCase().includes(address.slice(0, 6).toLowerCase())) throw new Error(`you row "${txt}" lacks ${address}`);
    await shot('06-leaders');
    return `you row: ${txt}`;
  });

  await step('toggle-nvda', async () => {
    await p.goto(`${base}/#q=NVDA`);
    await p.waitForSelector('#rh-toggle', { timeout: 30000 });
    const rows = () => p.locator('.row-body[aria-label^="NVDA"], .row-body[aria-label^="sNVDA"]').count();
    if ((await p.getAttribute('#rh-toggle', 'aria-checked')) !== 'false') throw new Error('toggle not off by default');
    const off = await rows();
    await p.click('#rh-toggle');
    await p.waitForSelector('.switch.on');
    await p.waitForTimeout(400);
    const on = await rows();
    await shot('07-toggle-on');
    await p.click('#rh-toggle');
    await p.waitForTimeout(400);
    const off2 = await rows();
    if (!(off === 0 && on >= 1 && off2 === 0)) throw new Error(`NVDA rows off ${off}, on ${on}, off again ${off2}`);
    return `NVDA rows: off ${off}, on ${on}, off again ${off2}`;
  });

  await step('activity', async () => {
    await p.goto(`${base}/activity`);
    await p.waitForSelector('.arow', { timeout: 30000 });
    const link = p.locator(`.arow a[href="/ticket/${ticketId}"]`);
    const n = await link.count();
    if (!ticketId || n === 0) throw new Error(`no activity row links to ticket ${ticketId}`);
    const row = ((await p.locator('.arow', { has: p.locator(`a[href="/ticket/${ticketId}"]`) }).first().textContent()) ?? '').replace(/\s+/g, ' ');
    if (address && !row.toLowerCase().includes(address.slice(0, 6).toLowerCase())) throw new Error(`activity row "${row}" lacks the owner`);
    if (/00:00:00/.test(row)) throw new Error(`activity row "${row}" has no time`);
    await shot('08-activity');
    return `${n} rows link to /ticket/${ticketId} (open and settle), owner and time shown`;
  });
} finally {
  await browser.close();
}
console.log(JSON.stringify({ address, ticketId, errors }));
process.exit(results.every((r) => r.pass) && results.length >= 10 ? 0 : 1);
