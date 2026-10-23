/// <reference lib="dom" />
// Live walkthrough of the deployed playground. A fresh browser context per run, against the live site.
// Usage:
//   bun run scripts/walkthrough-live.ts <desktop|phone> [site url] [bell url] [out dir]
//   defaults https://play.bellswap.fun, https://api-play.bellswap.fun, ../docs/screenshots
// desktop is 1440 by 900, phone is 390 by 844 (dark scheme, device scale 2 on phone, 1 on desktop).
// Steps: burner created, faucet credited, 10x short session ticket on sSOXL, watch, 5x long day ticket on sRTX, watch,
// both settled by the bell (demo signer replay plus settler), verdicts, share card, leaderboard row, Board search for
// NVDA (the Robinhood toggle on boards before the full catalog), activity rows, vault page figures. Each opened ticket
// is checked against the bell: symbol, side, multiple and horizon (0 Today's close, 1 In 24 h). Prints one JSON line
// per step ({step, pass, detail, ms}); exit 1 when a step fails or the page logged a console error, a page error or an
// HTTP 4xx/5xx. Screenshots: live-NN-<name>-<width>.png (names in SHOTS below).
import { chromium, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const mode = process.argv[2] === 'phone' ? 'phone' : 'desktop';
const base = process.argv[3] ?? 'https://play.bellswap.fun';
const bell = process.argv[4] ?? 'https://api-play.bellswap.fun';
const out = resolve(process.argv[5] ?? join(import.meta.dir, '..', '..', 'docs', 'screenshots'));
const SESSION_TIMEOUT_MS = Number(process.env.SESSION_TIMEOUT_MS ?? 360_000);
const DAY_TIMEOUT_MS = Number(process.env.DAY_TIMEOUT_MS ?? 900_000);
const width = mode === 'phone' ? 390 : 1440;
const height = mode === 'phone' ? 844 : 900;
mkdirSync(out, { recursive: true });

// The brief's file names for the key screens; every other screen gets live-x-<name>-<width>.png.
const SHOTS: Record<string, Record<string, string>> = {
  desktop: { board: 'live-01-board-1440', ticket: 'live-02-ticket-1440', watch: 'live-03-watch-1440', verdict: 'live-04-verdict-1440', leaders: 'live-05-leaders-1440' },
  phone: { board: 'live-06-board-390', ticket: 'live-07-ticket-390' },
};

type Result = { step: string; pass: boolean; detail: string; ms: number };
const results: Result[] = [];
const errors: string[] = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: mode === 'phone' ? 2 : 1, colorScheme: 'dark' });
const p: Page = await ctx.newPage();
p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
p.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 160)}`));
p.on('response', (r) => r.status() >= 400 && errors.push(`http ${r.status()} ${r.request().method()} ${r.url()}`));

async function shot(name: string) {
  await p.waitForTimeout(600);
  const file = SHOTS[mode]?.[name] ?? `live-x-${name}-${width}`;
  await p.screenshot({ path: join(out, `${file}.png`) });
}
async function step(name: string, fn: () => Promise<string>): Promise<boolean> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ step: name, pass: true, detail, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ step: name, pass: false, detail: String((e as Error).message ?? e).split('\n')[0] ?? '', ms: Date.now() - t0 });
    await p.screenshot({ path: join(out, `live-fail-${name}-${width}.png`) }).catch(() => undefined);
  }
  const r = results[results.length - 1]!;
  console.log(JSON.stringify(r));
  return r.pass;
}
const bellJson = async (path: string) => (await fetch(`${bell}${path}`)).json();
type BellTicket = { symbol?: string; long?: boolean; leverage?: number; owner?: string; horizon?: number; status?: string; payout?: string; settlePrice?: string };
async function bellTicket(id: string, want: (t: BellTicket) => boolean, tries = 30): Promise<BellTicket | null> {
  for (let i = 0; i < tries; i++) {
    const t = await bellJson(`/tickets/${id}`).catch(() => null);
    const tk: BellTicket | null = t?.ticket ?? null;
    if (tk && want(tk)) return tk;
    await p.waitForTimeout(1000);
  }
  return null;
}

async function openTicket(sym: string, side: 'long' | 'short', mult: string, horizon: 'Session' | 'Day', shotName?: string): Promise<string> {
  await p.goto(`${base}/t/${sym}`);
  // /t/:symbol is a full ticker page; on a phone the form is in the sheet behind the sticky
  // Long/Short bar. Builds before the ticker page render the ticket sheet directly (the .sheet selectors below).
  const page = await p.waitForSelector('[data-testid="ticker-page"], .sheet .btn-primary', { timeout: 60000 });
  if (await page.getAttribute('data-testid') === 'ticker-page') {
    if (mode === 'phone') await p.click(`[data-testid="sticky-${side}"]:visible`);
    await p.waitForSelector('[data-testid="open-button"]:visible', { timeout: 60000 });
    await p.click(`[data-testid="side-${side}"]:visible`);
    await p.click(`[data-testid="mult-${mult.replace(/x$/, '')}"]:visible`);
    // Settles at: 0 = Today's close (was Session), 1 = In 24 h (was Day).
    await pickSettlesAt(horizon === 'Session' ? 0 : 1);
    if (shotName) await shot(shotName);
    await p.click('[data-testid="open-button"]:not([disabled]):visible', { timeout: 60000 });
  } else {
    await p.click(`.seg-side .seg-opt:nth-child(${side === 'long' ? 1 : 2})`);
    await p.locator('.sheet .seg-opt', { hasText: new RegExp(`^${mult}$`) }).click();
    await p.locator('.sheet .field').filter({ hasText: /horizon/i }).locator('.seg-opt', { hasText: horizon }).click();
    if (shotName) await shot(shotName);
    await p.click('.sheet .btn-primary');
  }
  await p.waitForURL(/\/ticket\/\d+/, { timeout: 120000 });
  return p.url().match(/\/ticket\/(\d+)/)?.[1] ?? '';
}

// The ticket form shows the Settles at options only while its picker is open (the button with aria-expanded inside
// [data-testid="settles-at"]); options are settles-at-<horizon>, else the picker's radios in horizon order.
async function pickSettlesAt(h: 0 | 1): Promise<void> {
  const field = p.locator('[data-testid="settles-at"]:visible').first();
  await field.waitFor({ timeout: 30000 });
  const byId = p.locator(`[data-testid="settles-at-${h}"]:visible`);
  if ((await byId.count()) === 0) {
    const toggle = field.locator('button[aria-expanded]').first();
    if (await toggle.count()) await toggle.click();
  }
  const opt = (await byId.count()) ? byId.first() : field.locator('[role="radio"]').nth(h);
  await opt.click({ timeout: 10000 });
}

let address = '';
const ids: { session: string; day: string } = { session: '', day: '' };
try {
  await step('burner', async () => {
    await p.goto(`${base}/`);
    await p.waitForSelector('[data-testid^="board-row-"], .row-body', { timeout: 60000 });
    const n = await p.evaluate(() => Object.keys(localStorage).filter((k) => /^0x[0-9a-fA-F]{64}$/.test(localStorage.getItem(k) ?? '')).length);
    if (n !== 1) throw new Error(`${n} burner keys in localStorage`);
    await shot('board');
    return 'one burner key in localStorage';
  });

  await step('faucet', async () => {
    await p.waitForFunction(() => document.querySelector('.pill .num')?.textContent?.includes('1,000'), null, { timeout: 120000 });
    return `wallet pill shows ${(await p.textContent('.pill .num'))?.trim()}`;
  });

  const s1 = await step('open-10x-short-sSOXL-session', async () => {
    ids.session = await openTicket('SOXL', 'short', '10x', 'Session', 'ticket');
    const tk = await bellTicket(ids.session, (t) => !!t.owner);
    if (!tk) throw new Error(`bell has no ticket ${ids.session}`);
    if (tk.symbol !== 'SOXL' || tk.long !== false || Number(tk.leverage) !== 10) throw new Error(`bell ticket ${tk.symbol} long=${tk.long} ${tk.leverage}x`);
    if (tk.horizon === undefined || tk.horizon === null || Number(tk.horizon) !== 0) throw new Error(`bell ticket horizon ${tk.horizon}, expected 0 (Today's close)`);
    address = tk.owner ?? '';
    return `ticket ${ids.session} (bell: ${tk.symbol} short ${tk.leverage}x, horizon ${tk.horizon}, owner ${address})`;
  });

  if (s1) await step('watch-session', async () => {
    await p.waitForSelector('.countdown, .verdict', { timeout: 30000 });
    if (await p.locator('.verdict').count()) return 'settled before the watch view loaded';
    await p.waitForTimeout(2500);
    await shot('watch');
    return `countdown ${(await p.textContent('.countdown'))?.trim()}`;
  });

  const s2 = await step('open-5x-long-sRTX-day', async () => {
    ids.day = await openTicket('RTX', 'long', '5x', 'Day', 'ticket-day');
    const tk = await bellTicket(ids.day, (t) => !!t.owner);
    if (!tk) throw new Error(`bell has no ticket ${ids.day}`);
    if (tk.symbol !== 'RTX' || tk.long !== true || Number(tk.leverage) !== 5) throw new Error(`bell ticket ${tk.symbol} long=${tk.long} ${tk.leverage}x`);
    if (tk.horizon === undefined || tk.horizon === null || Number(tk.horizon) !== 1) throw new Error(`bell ticket horizon ${tk.horizon}, expected 1 (In 24 h)`);
    await p.waitForSelector('.countdown, .verdict', { timeout: 30000 });
    await p.waitForTimeout(2500);
    await shot('watch-day');
    return `ticket ${ids.day} (bell: ${tk.symbol} long ${tk.leverage}x, horizon ${tk.horizon ?? 'n/a'}), countdown ${(await p.textContent('.countdown').catch(() => ''))?.trim()}`;
  });

  if (s1) {
    await step('session-settled-by-replay', async () => {
      await p.goto(`${base}/ticket/${ids.session}`);
      await p.waitForSelector('.verdict', { timeout: SESSION_TIMEOUT_MS });
      const tk = await bellTicket(ids.session, (t) => t.status === 'settled', 20);
      if (!tk) throw new Error(`bell ticket ${ids.session} not settled`);
      return `bell status ${tk?.status}, payout ${tk?.payout}, settle print ${tk?.settlePrice ?? ''}`;
    });
    await step('session-verdict', async () => {
      await p.waitForTimeout(1500);
      await shot('verdict');
      return ((await p.textContent('.verdict')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
    });
    await step('share-card', async () => {
      await p.click('.verdict-actions .btn-primary');
      await p.waitForSelector('.share-img', { timeout: 15000 });
      const src = await p.evaluate(() => (document.querySelector('.share-img') as HTMLImageElement).src.slice(0, 22));
      if (src !== 'data:image/png;base64,') throw new Error('share card is not a PNG');
      await shot('share');
      return 'share card PNG rendered';
    });
  }

  if (s2) {
    await step('day-settled-by-replay', async () => {
      await p.goto(`${base}/ticket/${ids.day}`);
      await p.waitForSelector('.verdict', { timeout: DAY_TIMEOUT_MS });
      const tk = await bellTicket(ids.day, (t) => t.status === 'settled', 20);
      if (!tk) throw new Error(`bell ticket ${ids.day} not settled`);
      await p.waitForTimeout(1500);
      await shot('verdict-day');
      const v = ((await p.textContent('.verdict')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
      return `bell status ${tk?.status}, payout ${tk?.payout}, settle print ${tk?.settlePrice ?? ''}; ${v}`;
    });
  }

  await step('leaderboard', async () => {
    await p.goto(`${base}/leaders`);
    await p.waitForSelector('.lrow.you', { timeout: 30000 });
    const txt = ((await p.textContent('.lrow.you')) ?? '').replace(/\s+/g, ' ').trim();
    if (address && !txt.toLowerCase().includes(address.slice(0, 6).toLowerCase())) throw new Error(`you row "${txt}" lacks ${address}`);
    await shot('leaders');
    return `you row: ${txt}`;
  });

  await step('board-search-nvda', async () => {
    await p.goto(`${base}/`);
    await p.waitForSelector('[data-testid="board-search"], #rh-toggle', { timeout: 30000 });
    if (await p.$('[data-testid="board-search"]')) {
      // Full catalog Board: NVDA is a row like any other; the search narrows the list to it.
      const total = await p.locator('[data-testid^="board-row-"]').count();
      await p.fill('[data-testid="board-search"]', 'NVDA');
      await p.waitForSelector('[data-testid="board-row-NVDA"]', { timeout: 10000 });
      await p.waitForTimeout(400);
      const shown = await p.locator('[data-testid^="board-row-"]').count();
      await shot('board-search');
      await p.fill('[data-testid="board-search"]', '');
      if (!(shown >= 1 && shown < 20)) throw new Error(`search NVDA shows ${shown} rows (of ${total})`);
      return `search NVDA: ${shown} rows of ${total}`;
    }
    // Boards before the full catalog: the Robinhood toggle shows and hides NVDA.
    await p.goto(`${base}/#q=NVDA`);
    await p.waitForSelector('#rh-toggle', { timeout: 30000 });
    const rows = () => p.locator('.row-body[aria-label^="NVDA"], .row-body[aria-label^="sNVDA"]').count();
    if ((await p.getAttribute('#rh-toggle', 'aria-checked')) !== 'false') throw new Error('toggle not off by default');
    const off = await rows();
    await p.click('#rh-toggle');
    await p.waitForSelector('.switch.on');
    await p.waitForTimeout(400);
    const on = await rows();
    await shot('toggle-on');
    await p.click('#rh-toggle');
    await p.waitForTimeout(400);
    const off2 = await rows();
    if (!(off === 0 && on >= 1 && off2 === 0)) throw new Error(`NVDA rows off ${off}, on ${on}, off again ${off2}`);
    return `NVDA rows: off ${off}, on ${on}, off again ${off2}`;
  });

  await step('activity', async () => {
    await p.goto(`${base}/activity`);
    await p.waitForSelector('.arow', { timeout: 30000 });
    const found: string[] = [];
    for (const id of [ids.session, ids.day].filter(Boolean)) {
      const n = await p.locator(`.arow a[href="/ticket/${id}"]`).count();
      if (n === 0) throw new Error(`no activity row links to ticket ${id}`);
      found.push(`${id}: ${n} rows`);
    }
    await shot('activity');
    return `rows link to the tickets (${found.join(', ')})`;
  });

  await step('vault', async () => {
    await p.goto(`${base}/vault`);
    await p.waitForFunction(() => {
      const els = Array.from(document.querySelectorAll('.fig-v')).slice(0, 3);
      return els.length >= 3 && els.every((e) => /\d/.test(e.textContent ?? ''));
    }, null, { timeout: 30000 });
    const figs = await p.$$eval('.fig', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
    if (figs.length === 0) throw new Error('vault page shows no figures');
    await shot('vault');
    return figs.join('; ').slice(0, 160);
  });
} finally {
  await browser.close();
}
console.log(JSON.stringify({ mode, address, ids, errors: errors.slice(0, 20) }));
if (errors.length) console.log(JSON.stringify({ step: 'no-console-or-http-errors', pass: false, detail: `${errors.length} errors, first: ${errors[0]}`, ms: 0 }));
process.exit(results.every((r) => r.pass) && results.length >= 13 && errors.length === 0 ? 0 : 1);
