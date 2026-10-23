// Full-page screenshots of the live landing at 1440 by 900 and 390 by 844 (dark scheme).
// Usage: bun run scripts/landing-shots.ts [landing url] [out dir]; writes live-08-landing-1440.png, live-09-landing-390.png.
import { chromium } from '@playwright/test';
import { join, resolve } from 'node:path';

const url = process.argv[2] ?? 'https://v2.bellswap.fun';
const out = resolve(process.argv[3] ?? join(import.meta.dir, '..', '..', 'docs', 'screenshots'));
const browser = await chromium.launch();
for (const [w, h, name, scale] of [[1440, 900, 'live-08-landing-1440', 1], [390, 844, 'live-09-landing-390', 2]] as const) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale, colorScheme: 'dark' });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  const r = await p.goto(url, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await p.screenshot({ path: join(out, `${name}.png`), fullPage: true });
  console.log(JSON.stringify({ name, status: r?.status(), horizontalOverflowPx: overflow, errors }));
  await ctx.close();
}
await browser.close();
