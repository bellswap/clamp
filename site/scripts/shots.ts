/// <reference lib="dom" />
// Headless snapshots of the app in mock mode (VITE_MOCK=1 dev server). Usage:
//   bun run shots [base url] [out dir]   (defaults http://127.0.0.1:5188 and ../docs/screenshots)
// Writes site-mock-*.png for every page at phone (390 by 844) and desktop (1440 by 900) widths: the board, the ticker
// pages /t/NVDA and /t/RTX (core) and one long-tail ticker (SHOTS_LONGTAIL, default PLTR), Me, Leaders, Vault,
// Activity and More; then, at both widths, a ticket opened from /t/RTX and watched through its verdict and share card,
// and the Board searched for NVDA (the full catalog Board; boards before it show NVDA behind the Robinhood toggle).
// Ticker pages are matched by the data-testid ids (ticker-page) or, before that page lands, by the
// ticket sheet. Exit 1 on a page error, a console error or a missing element.
import { chromium, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:5188';
const out = resolve(process.argv[3] ?? join(import.meta.dir, '..', '..', 'docs', 'screenshots'));
mkdirSync(out, { recursive: true });

const errors: string[] = [];
const browser = await chromium.launch();

async function page(width: number, height: number): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  return p;
}

async function shot(p: Page, name: string) {
  await p.waitForTimeout(400);
  await p.screenshot({ path: join(out, `site-mock-${name}.png`) });
  console.log(`saved site-mock-${name}.png`);
}

const longTail = (process.env.SHOTS_LONGTAIL || 'PLTR').toUpperCase();
// Route, file name, and the selector that proves the page rendered.
const TICKER = '[data-testid="ticker-page"], .sheet';
const routes: [string, string, string][] = [
  ['/t/NVDA', 'ticker-NVDA', TICKER],
  ['/t/RTX', 'ticker-RTX', TICKER],
  [`/t/${longTail}`, `ticker-${longTail}`, TICKER],
  ['/me', 'me', '.page'],
  ['/leaders', 'leaders', '.page'],
  ['/vault', 'vault', '.page'],
  ['/activity', 'activity', '.page'],
  ['/more', 'more', '.page'],
];

try {
  for (const [label, w, h] of [['phone', 390, 844], ['desktop', 1440, 900]] as const) {
    const p = await page(w, h);
    await p.goto(`${base}/`);
    await p.waitForSelector('.row-body, [data-testid^="board-row-"]', { timeout: 15000 });
    await p.waitForSelector('.spark-line', { timeout: 15000 });
    await p.waitForFunction(() => document.querySelector('.pill .num')?.textContent?.includes('1,000'), null, { timeout: 15000 });
    await shot(p, `board-${label}`);
    for (const [route, name, sel] of routes) {
      await p.goto(`${base}${route}`);
      try {
        await p.waitForSelector(sel, { timeout: 15000 });
      } catch {
        errors.push(`${route} at ${w}: ${sel} not found`);
      }
      await p.waitForTimeout(800);
      await shot(p, `${name}-${label}`);
      const sw = await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      if (sw[0]! > sw[1]!) errors.push(`${route} at ${w}: horizontal scroll (scrollWidth ${sw[0]} > ${sw[1]})`);
    }
    {
      // The watch flow: open a short ticket on RTX and follow it to its verdict. On a phone the ticker page opens the
      // sheet from its sticky bar (sticky-short); the desktop page has the panel; the old route renders the sheet.
      await p.goto(`${base}/t/RTX?side=short`);
      await p.waitForSelector(TICKER, { timeout: 15000 });
      // ?side= opens the sheet on a phone by itself; the sticky bar is only clicked when no form shows.
      const formShown = await p.waitForSelector('[data-testid="open-button"]:visible', { timeout: 3000 }).then(() => true).catch(() => false);
      if (!formShown && (await p.$('[data-testid="sticky-short"]:visible'))) await p.click('[data-testid="sticky-short"]:visible');
      const OPEN = '[data-testid="open-button"]:not([disabled]):visible, .sheet .btn-primary:not([disabled])';
      await p.waitForSelector(OPEN, { timeout: 15000 });
      if (await p.$('[data-testid="side-short"]:visible')) await p.click('[data-testid="side-short"]:visible');
      else await p.click('.seg-side .seg-opt:nth-child(2)');
      await p.click(OPEN);
      await p.waitForURL(/\/ticket\/\d+/, { timeout: 15000 });
      await p.waitForSelector('.countdown');
      await p.waitForTimeout(1500);
      await shot(p, `watch-${label}`);
      await p.waitForSelector('.verdict', { timeout: 90000 });
      await p.waitForTimeout(1200);
      await shot(p, `verdict-${label}`);
      await p.click('.verdict-actions .btn-primary');
      await p.waitForSelector('.share-img', { timeout: 10000 });
      await shot(p, `share-${label}`);
      const png = await p.evaluate(() => (document.querySelector('.share-img') as HTMLImageElement).src.slice(0, 22));
      if (png !== 'data:image/png;base64,') errors.push('share card is not a PNG');
      // Board search: the full catalog Board narrows to NVDA on #q=NVDA; boards before it read #rh=1 (toggle on).
      await p.goto(`${base}/#rh=1&q=NVDA`);
      try {
        await p.waitForSelector('[data-testid="board-row-NVDA"], .switch.on', { timeout: 15000 });
        await shot(p, `board-search-${label}`);
        const n = await p.locator('[data-testid^="board-row-"]').count();
        console.log(n ? `board search NVDA: ${n} rows` : `toggle on: ${await p.textContent('.list-head .num')}`);
      } catch {
        errors.push(`board search NVDA at ${w}: no board-row-NVDA and no toggle`);
      }
    }
  }
} finally {
  await browser.close();
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('shots ok');
