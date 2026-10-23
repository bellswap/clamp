/// <reference lib="dom" />
// Demo verification (by data-testid). Usage:
//   bun run scripts/demo-check.ts [--base URL] [--bell URL] [--widths 1440,390,375] [--quick] [--out DIR]
//     --base     the app (default http://127.0.0.1:5188, the VITE_MOCK=1 dev server)
//     --bell     the bell service; default https://api-play.bellswap.fun for play.bellswap.fun, none otherwise.
//                Without a bell the run is in mock mode: counts come from the dev server's ticker data module and the
//                tradable count is reported, not compared with /replay/coverage.
//     --quick    layout and data checks only (no ticket opens, no settlement wait)
//     --out      directory for a screenshot per page and width (none by default)
// Checks, per width: Board has at least 500 rows and its tradable rows equal the coverage's eligible count (live; a
// /replay/coverage answer without an eligible array fails); 5 ticker pages (2 core, 3 long tail) render candles (chart
// pixels in the --up and --down colours) with at least 100 5m candles, 5m to 1h changes the candles, the rendered
// candles change within 5 s (pane rows near horizontal lines, the preview lines, left out), no empty stats cell,
// Settles at has a selected default; Leaders, Vault, Activity and Me have rows, and (live) each page polled the bell
// twice within 15 s of opening and renders the newest answer (Activity its newest ticket event, Leaders only its
// addresses, Vault its assets, Me only the owner's tickets); demo tags show when the rendered Activity rows include a
// bot event of the newest answer; no console errors, no bell 4xx or 5xx,
// scrollWidth equals innerWidth. At every width (not with --quick) tickets are opened with the page's burner wallet
// (Get test USDG when the balance is zero; the faucet may take 120 s): one core and 3 long-tail at the widest width,
// one long-tail at the others; the first ticket of each width is watched to its verdict right after it opened, within
// its ETA plus 10 s counted from the open; side, multiple and stake are checked on the form; Me lists the opened
// tickets (Open or Settled tab). Exit 1 when any check fails, 2 on bad arguments.
import { chromium, type Browser, type Page, type Response } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}
const base = (arg('base', 'http://127.0.0.1:5188') as string).replace(/\/$/, '');
const bellDefault = /\/\/play\.bellswap\.fun/.test(base) ? 'https://api-play.bellswap.fun' : undefined;
const bell = arg('bell', bellDefault)?.replace(/\/$/, '');
const widths = (arg('widths', '1440,390,375') as string).split(',').map(Number).filter(Boolean);
if (widths.length === 0) {
  console.error('demo-check: --widths gave no widths (example: --widths 1440,390,375)');
  process.exit(2);
}
const quick = arg('quick') === 'true';
const outDir = arg('out') ? resolve(arg('out') as string) : null;
if (outDir) mkdirSync(outDir, { recursive: true });
const mock = !bell;
const CORE = ['NVDA', 'RTX'];
// The 14 markets of Deploy.s.sol; long-tail picks come from the other tradable rows.
const CORE_ALL = ['RTX', 'NOC', 'CPER', 'SOXL', 'DRAM', 'GD', 'MARA', 'UUUU', 'SPY', 'QQQ', 'NVDA', 'MU', 'SNDK', 'TSLA'];
const LONG_TAIL_FALLBACK = ['PLTR', 'KO', 'AAPL'];

type Result = { ok: boolean; name: string; detail: string };
const results: Result[] = [];
function check(ok: boolean, name: string, detail = ''): boolean {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  return ok;
}
function note(name: string, detail: string) {
  console.log(`NOTE ${name}: ${detail}`);
}

// Network log: bell responses (status, url) and /candles payloads, per page.
interface Net {
  errors: string[];
  console: string[];
  candles: { url: string; at: number; body: { candles?: { t: number; c: number }[] } }[];
  /** Bell answers; body is kept for the polled page endpoints (ENDPOINT), to compare with what the page renders. */
  hits: { url: string; status: number; at: number; body?: unknown }[];
}
function isBell(url: string): boolean {
  if (bell) return url.startsWith(bell);
  return /:(8787|18787)\//.test(url) || /\/\/api-play\./.test(url);
}
async function open(browser: Browser, width: number): Promise<{ p: Page; net: Net }> {
  const height = width >= 1000 ? 900 : width >= 380 ? 844 : 667;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'dark' });
  const p = await ctx.newPage();
  const net: Net = { errors: [], console: [], candles: [], hits: [] };
  p.on('pageerror', (e) => net.console.push(`pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') net.console.push(`console: ${m.text()}`); });
  p.on('response', async (r: Response) => {
    const url = r.url();
    if (!isBell(url)) return;
    const hit: Net['hits'][number] = { url, status: r.status(), at: Date.now() };
    net.hits.push(hit);
    if (r.ok() && Object.values(ENDPOINT).some((re) => re.test(url))) {
      try { hit.body = await r.json(); } catch { /* body gone on navigation */ }
    }
    if (r.status() >= 400) net.errors.push(`${r.status()} ${r.request().method()} ${url}`);
    if (/\/candles\//.test(url) && r.ok()) {
      try { net.candles.push({ url, at: Date.now(), body: await r.json() }); } catch { /* body gone on navigation */ }
    }
  });
  return { p, net };
}
async function shot(p: Page, name: string, width: number) {
  if (outDir) await p.screenshot({ path: join(outDir, `demo-${name}-${width}.png`), fullPage: false });
}
async function noHScroll(p: Page, where: string, width: number) {
  if (width > 400) return;
  const [sw, iw] = await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  check(sw === iw, `no horizontal scroll ${where} at ${width}`, `scrollWidth ${sw}, innerWidth ${iw}`);
}
const tid = (id: string) => `[data-testid="${id}"]`;

// Candles for a symbol and interval: the latest matching /candles response (live), else the dev server's ticker data
// module (mock mode, served by Vite at /src/...).
async function candles(p: Page, net: Net, symbol: string, tf: string, limit = 300): Promise<{ t: number; c: number }[] | null> {
  const hit = [...net.candles].reverse().find((x) => x.url.includes(`/candles/${symbol}`) && x.url.includes(`tf=${tf}`) && !/limit=[1-9]\b/.test(x.url));
  if (hit?.body.candles) return hit.body.candles;
  if (!mock) return null;
  return p.evaluate(async ([s, f, n]) => {
    try {
      const mod = '/src/lib/ticker/ticker-api.ts';
      const m = await import(/* @vite-ignore */ mod);
      const r = await m.tickerApi.candles(s, f, n);
      return r.candles.map((c: { t: number; c: number }) => ({ t: c.t, c: c.c }));
    } catch {
      return null;
    }
  }, [symbol, tf, limit] as const);
}
function spacing(cs: { t: number }[]): number {
  const d = cs.slice(1).map((c, i) => c.t - cs[i]!.t).sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)]! : 0;
}
// The chart's canvases: the pixels in the candle colours (--up and --down, the colours the ticker chart draws candles
// in). Axes, grid and lines use --muted, --border and --faint, so up and down pixels together prove candles were drawn.
async function chartPixels(p: Page): Promise<{ colours: number; up: number; down: number }> {
  return p.evaluate((sel) => {
    const root = document.querySelector(sel);
    const cs = root ? Array.from(root.querySelectorAll('canvas')) : [];
    const css = getComputedStyle(document.documentElement);
    const rgb = (v: string): [number, number, number] | null => {
      const x = v.trim();
      const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(x);
      if (h) {
        const d = h[1]!.length === 3 ? h[1]!.split('').map((c) => c + c).join('') : h[1]!;
        return [parseInt(d.slice(0, 2), 16), parseInt(d.slice(2, 4), 16), parseInt(d.slice(4, 6), 16)];
      }
      const m = /rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(x);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const upC = rgb(css.getPropertyValue('--up')) ?? [0xcc, 0xff, 0x00];
    const downC = rgb(css.getPropertyValue('--down')) ?? [0xff, 0x6a, 0x3d];
    const near = (r: number, g: number, b: number, c: [number, number, number]) =>
      Math.abs(r - c[0]) <= 24 && Math.abs(g - c[1]) <= 24 && Math.abs(b - c[2]) <= 24;
    const seen = new Set<number>();
    let up = 0;
    let down = 0;
    for (const c of cs) {
      if (!c.width || !c.height) continue;
      const g = c.getContext('2d');
      if (!g) continue;
      const d = g.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i]!, gg = d[i + 1]!, b = d[i + 2]!, a = d[i + 3]!;
        const v = (r << 16) | (gg << 8) | b;
        if (!a) continue;
        if (seen.size < 5000) seen.add(v);
        if (a > 200) {
          if (near(r, gg, b, upC)) up++;
          else if (near(r, gg, b, downC)) down++;
        }
      }
    }
    return { colours: seen.size, up, down };
  }, tid('ticker-chart'));
}

// Candle pixels of the chart pane (the largest canvases; the price and time axes are smaller ones) in --up or --down,
// compared with the snapshot of the previous call. The ticket form's preview lines follow the market price, not the
// candles, and are drawn in --down and --muted (CandleChart price lines), so every row that reads as a horizontal line
// in either snapshot (one of those colours over at least a quarter of the pane width, spread over at least half of
// it) is left out with 14 px around it (the line and its 11 px title): a moved preview line alone is no candle update.
async function candleDiff(p: Page, snap: boolean): Promise<{ comparable: boolean; changed: number; masked: number }> {
  return p.evaluate(([sel, first]) => {
    const root = document.querySelector(sel);
    const cs = root ? Array.from(root.querySelectorAll('canvas')).filter((c) => c.width > 0 && c.height > 0) : [];
    const area = Math.max(0, ...cs.map((c) => c.width * c.height));
    const css = getComputedStyle(document.documentElement);
    const rgb = (v: string): [number, number, number] | null => {
      const x = v.trim();
      const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(x);
      if (h) {
        const d = h[1]!.length === 3 ? h[1]!.split('').map((c) => c + c).join('') : h[1]!;
        return [parseInt(d.slice(0, 2), 16), parseInt(d.slice(2, 4), 16), parseInt(d.slice(4, 6), 16)];
      }
      const m = /rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(x);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const cols: [number, number, number][] = [
      rgb(css.getPropertyValue('--up')) ?? [0xcc, 0xff, 0x00],
      rgb(css.getPropertyValue('--down')) ?? [0xff, 0x6a, 0x3d],
      rgb(css.getPropertyValue('--muted')) ?? [0x8e, 0x94, 0x8a],
    ];
    // 1 up, 2 down, 3 muted, 0 anything else
    const masks = cs.filter((c) => c.width * c.height === area).map((c) => {
      const m = new Uint8Array(c.width * c.height);
      const d = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
      if (d) {
        for (let i = 0, j = 0; i < d.length; i += 4, j++) {
          if (d[i + 3]! <= 200) continue;
          const k = cols.findIndex((q) => Math.abs(d[i]! - q[0]) <= 24 && Math.abs(d[i + 1]! - q[1]) <= 24 && Math.abs(d[i + 2]! - q[2]) <= 24);
          m[j] = k + 1;
        }
      }
      return { w: c.width, h: c.height, m };
    });
    const store = window as unknown as { __demoCandles?: typeof masks };
    const prev = store.__demoCandles;
    store.__demoCandles = masks;
    if (first || !prev || prev.length !== masks.length || prev.some((x, k) => x.w !== masks[k]!.w || x.h !== masks[k]!.h)) {
      return { comparable: false, changed: 0, masked: 0 };
    }
    const lineRows = (x: { w: number; h: number; m: Uint8Array }) => {
      const rows: number[] = [];
      for (let y = 0; y < x.h; y++) {
        for (const cls of [2, 3]) {
          let n = 0, lo = x.w, hi = -1;
          for (let i = 0; i < x.w; i++) if (x.m[y * x.w + i] === cls) { n++; if (i < lo) lo = i; hi = i; }
          if (n * 4 >= x.w && (hi - lo) * 2 >= x.w) { rows.push(y); break; }
        }
      }
      return rows;
    };
    let changed = 0;
    let masked = 0;
    masks.forEach((cur, k) => {
      const old = prev[k]!;
      const skip = new Uint8Array(cur.h);
      for (const y of [...lineRows(old), ...lineRows(cur)]) for (let dy = -14; dy <= 14; dy++) if (y + dy >= 0 && y + dy < cur.h) skip[y + dy] = 1;
      for (let y = 0; y < cur.h; y++) {
        if (skip[y]) { masked++; continue; }
        for (let i = y * cur.w; i < (y + 1) * cur.w; i++) {
          const a = old.m[i]!, b = cur.m[i]!;
          if (a !== b && (a === 1 || a === 2 || b === 1 || b === 2)) changed++;
        }
      }
    });
    return { comparable: true, changed, masked };
  }, [tid('ticker-chart'), snap] as const);
}

async function board(p: Page, width: number): Promise<{ all: string[]; tradable: string[] }> {
  await p.goto(`${base}/`);
  const first = await p.waitForSelector('[data-testid^="board-row-"]', { timeout: 20000 }).catch(() => null);
  if (!check(!!first, `board-row ids at ${width}`, first ? '' : 'no [data-testid^="board-row-"] on /')) return { all: [], tradable: [] };
  // Rows may be drawn lazily: scroll to the end until the count stops growing.
  const seen = new Set<string>();
  const trad = new Set<string>();
  for (let i = 0, last = -1; i < 60 && seen.size !== last; i++) {
    last = seen.size;
    const rows = await p.$$eval('[data-testid^="board-row-"]', (els) => els.map((e) => ({
      sym: (e.getAttribute('data-testid') || '').slice('board-row-'.length),
      // Tradable: the row offers Long and Short (links to /t/SYM?side= or buttons labelled Long, Short).
      trad: !!e.querySelector('a[href*="side=long"], a[href*="side=short"], [data-side]') ||
        Array.from(e.querySelectorAll('button, a')).some((b) => /^\s*(long|short)\b/i.test(b.textContent || '')),
    })));
    for (const r of rows) { seen.add(r.sym); if (r.trad) trad.add(r.sym); }
    await p.mouse.wheel(0, 20000);
    await p.waitForTimeout(250);
  }
  check(seen.size >= 500, `board rows at ${width}`, `${seen.size} rows, ${trad.size} tradable`);
  await shot(p, 'board', width);
  await p.evaluate(() => window.scrollTo(0, 0));
  const search = await p.$(tid('board-search'));
  if (check(!!search, `board-search present at ${width}`)) {
    await search!.fill('NVDA');
    await p.waitForTimeout(400);
    const n = await p.$$eval('[data-testid^="board-row-"]', (els) => els.length);
    const hasNvda = !!(await p.$(tid('board-row-NVDA')));
    check(hasNvda && n < 20, `board search NVDA at ${width}`, `${n} rows shown`);
    await search!.fill('');
  }
  await noHScroll(p, 'on the Board', width);
  return { all: [...seen], tradable: [...trad] };
}

async function ticker(p: Page, net: Net, sym: string, width: number) {
  net.candles.length = 0;
  await p.goto(`${base}/t/${sym}`);
  const okPage = check(!!(await p.waitForSelector(tid('ticker-page'), { timeout: 20000 }).catch(() => null)), `ticker-page /t/${sym} at ${width}`);
  if (!okPage) return;
  if (await p.$(tid('no-price-feed'))) { check(false, `/t/${sym} has a price feed at ${width}`, 'No price feed shown'); return; }
  await p.waitForSelector(`${tid('ticker-chart')} canvas`, { timeout: 15000 }).catch(() => null);
  await p.waitForTimeout(1500);
  const px = await chartPixels(p);
  check(px.up > 0 && px.down > 0 && px.up + px.down >= 100, `candles drawn /t/${sym} at ${width}`,
    `${px.up} up and ${px.down} down candle pixels, ${px.colours} colours`);
  const c5 = await candles(p, net, sym, '5m');
  if (c5) check(c5.length >= 100, `5m candles /t/${sym} at ${width}`, `${c5.length} candles`);
  else check(false, `5m candles /t/${sym} at ${width}`, 'no /candles answer seen');
  // The rendered candles change within 5 s (the canvas pixels, not the API: a chart that froze while /candles kept
  // answering must fail; and only candle pixels away from horizontal lines count, so preview lines that follow the
  // market price cannot pass it). The data movement is reported alongside.
  const before = c5?.[c5.length - 1];
  await candleDiff(p, true);
  let drawn = false;
  let dataMoved = false;
  let masked = 0;
  for (let i = 0; i < 10 && !drawn; i++) {
    await p.waitForTimeout(500);
    const tail = mock ? await candles(p, net, sym, '5m', 3) : [...net.candles].reverse().find((x) => x.url.includes(`/candles/${sym}`))?.body.candles ?? null;
    const last = tail?.[tail.length - 1];
    if (last && before && (last.t !== before.t || last.c !== before.c)) dataMoved = true;
    const d = await candleDiff(p, false);
    if (d.comparable) { masked = Math.max(masked, d.masked); if (d.changed > 0) drawn = true; }
  }
  check(drawn, `rendered candles update within 5 s /t/${sym} at ${width}`, `last candle data ${dataMoved ? 'moved' : 'unchanged'}, ${masked} pane rows near horizontal lines left out`);
  const tf1h = await p.$(tid('tf-1h'));
  if (check(!!tf1h, `tf-1h present /t/${sym} at ${width}`)) {
    await tf1h!.click();
    await p.waitForTimeout(1500);
    const c1 = await candles(p, net, sym, '1h');
    const changed = !!c1 && !!c5 && (c1.length !== c5.length || spacing(c1) !== spacing(c5));
    check(changed, `5m to 1h changes the candles /t/${sym} at ${width}`, `5m ${c5?.length ?? '?'} (spacing ${c5 ? spacing(c5) : '?'} s), 1h ${c1?.length ?? '?'} (spacing ${c1 ? spacing(c1) : '?'} s)`);
    const t5 = await p.$(tid('tf-5m'));
    if (t5) await t5.click();
  }
  const empty = await p.$$eval(`${tid('ticker-stats')} *`, (els) => els
    .filter((e) => e.children.length === 0 && !e.closest('svg') && e.getAttribute('aria-hidden') !== 'true')
    .map((e) => (e.textContent || '').trim())
    .filter((t) => ['', '—', '–', '-', 'NaN', 'undefined', 'null', '$NaN'].includes(t) || /NaN|undefined/.test(t)).length);
  const hasStats = !!(await p.$(tid('ticker-stats')));
  check(hasStats && empty === 0, `stats filled /t/${sym} at ${width}`, hasStats ? `${empty} empty cells` : 'ticker-stats missing');
  // On a phone the ticket form sits in the sheet behind the sticky Long/Short bar.
  if (width < 600 && !(await p.$(tid('settles-at')))) {
    const sticky = await p.$(tid('sticky-long'));
    if (sticky) { await sticky.click(); await p.waitForSelector(tid('settles-at'), { timeout: 5000 }).catch(() => null); }
  }
  const sa = await p.$(`${tid('settles-at')}:visible`);
  if (check(!!sa, `settles-at present /t/${sym} at ${width}`) && sa) {
    const def = await settlesAtSelected(p);
    check(def.selected === 1, `Settles at has a default /t/${sym} at ${width}`, def.detail);
  }
  if (width < 600) check(!!(await p.$(tid('sticky-long'))) && !!(await p.$(tid('sticky-short'))), `sticky Long/Short bar /t/${sym} at ${width}`);
  await shot(p, `ticker-${sym}`, width);
  await noHScroll(p, `on /t/${sym}`, width);
}

// The selected Settles at option: a <select> value, or exactly one checked option. The ticket form lists its options
// only while the picker is open (a button with aria-expanded inside settles-at), so the picker is opened, read and
// closed again. Label text alone is not a selection.
async function settlesAtSelected(p: Page): Promise<{ selected: number; detail: string }> {
  const field = p.locator(`${tid('settles-at')}:visible`).first();
  const sel = field.locator('select');
  if (await sel.count()) {
    const v = await sel.first().inputValue();
    return { selected: v ? 1 : 0, detail: `select value "${v}"` };
  }
  const toggle = field.locator('button[aria-expanded]').first();
  const hasToggle = (await toggle.count()) > 0;
  const wasOpen = hasToggle && (await toggle.getAttribute('aria-expanded')) === 'true';
  if (hasToggle && !wasOpen) await toggle.click();
  await p.waitForTimeout(150);
  const on = field.locator('[role="radio"][aria-checked="true"], [aria-pressed="true"], [aria-selected="true"], input[type="radio"]:checked');
  const n = await on.count();
  const label = n ? ((await on.first().textContent()) || '').trim() : '';
  const options = await field.locator('[role="radio"], input[type="radio"]').count();
  if (hasToggle && !wasOpen && (await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
  return { selected: n, detail: `${n} of ${options} options selected${label ? ` (${label})` : ''}` };
}

// Opens one ticket on /t/SYM and returns the ticket URL path (/ticket/<id>), the wall ETA in seconds when shown and the
// wall time of the open (the moment the ticket page appeared).
type Opened = { path: string | null; etaS: number | null; openedAt: number };
async function openTicket(p: Page, sym: string, width: number): Promise<Opened> {
  await p.goto(`${base}/t/${sym}`);
  await p.waitForSelector(tid('ticker-page'), { timeout: 20000 });
  if (width < 600) {
    const sticky = await p.$(`${tid('sticky-long')}:visible`);
    if (sticky) await sticky.click();
  }
  const faucet = await p.$(`${tid('get-usdg')}:visible`);
  if (faucet) {
    await faucet.click();
    // The faucet answers within the client's 90 s timeout, retries included; the button goes once the balance shows.
    const funded = await p.waitForSelector(`${tid('get-usdg')}:visible`, { state: 'detached', timeout: 120000 }).then(() => true).catch(() => false);
    check(funded, `faucet funds the burner /t/${sym} at ${width}`, funded ? '' : 'Get test USDG still shown after 120 s');
  }
  for (const id of ['side-long', 'mult-2']) {
    const e = await p.$(`${tid(id)}:visible`);
    if (!check(!!e, `${id} present /t/${sym} at ${width}`)) continue;
    await e!.click();
    const on = await e!.evaluate((x) => x.getAttribute('aria-checked') === 'true' || x.getAttribute('aria-pressed') === 'true' || x.classList.contains('on'));
    check(on, `${id} selected after the click /t/${sym} at ${width}`);
  }
  const amt = await p.$(`${tid('amount-input')}:visible`);
  if (check(!!amt, `amount-input present /t/${sym} at ${width}`)) {
    await amt!.fill('5');
    check((await amt!.inputValue()) === '5', `amount-input holds 5 /t/${sym} at ${width}`);
  }
  const etaText = (await p.$eval(tid('settles-at'), (e) => e.textContent || '').catch(() => '')) as string;
  const m = /(\d+)\s*m(?:in)?\s*(\d+)?\s*s?/.exec(etaText) || /(\d+)\s*s\b/.exec(etaText);
  const etaS = m ? (m.length > 2 && m[2] !== undefined ? Number(m[1]) * 60 + Number(m[2]) : /m/.test(m[0]) ? Number(m[1]) * 60 : Number(m[1])) : null;
  const btn = await p.waitForSelector(`${tid('open-button')}:not([disabled]):visible`, { timeout: 30000 }).catch(() => null);
  if (!check(!!btn, `open-button enabled /t/${sym} at ${width}`)) return { path: null, etaS, openedAt: Date.now() };
  await btn!.click();
  const ok = await p.waitForURL(/\/ticket\/\d+/, { timeout: 45000 }).then(() => true).catch(() => false);
  const openedAt = Date.now();
  check(ok, `ticket opened on ${sym} at ${width}`, ok ? new URL(p.url()).pathname : 'no /ticket/<id> page');
  return { path: ok ? new URL(p.url()).pathname : null, etaS, openedAt };
}

// Watches an opened ticket to its verdict. The deadline (ETA plus 10 s) counts from the open, not from this call.
async function watchTicket(p: Page, t: Opened, width: number) {
  if (!t.path) return;
  if (new URL(p.url()).pathname !== t.path) await p.goto(`${base}${t.path}`);
  const limit = ((t.etaS ?? 140) + 10) * 1000;
  const left = Math.max(1000, t.openedAt + limit - Date.now());
  const v = await p.waitForSelector(tid('watch-verdict'), { timeout: left }).catch(() => null);
  const took = Math.round((Date.now() - t.openedAt) / 1000);
  check(!!(await p.$(tid('watch-page'))), `watch-page at ${width}`);
  check(!!v && took <= limit / 1000, `verdict within ETA plus 10 s at ${width}`, `${took} s after the open, ETA ${t.etaS ?? 'unknown (140 s assumed)'}`);
  await shot(p, 'verdict', width);
}

// Live freshness: the page fetched its data from the bell after it opened and polled again within 15 s (Activity polls
// every 3 s, Me 5 s, Vault 6 s, Leaders 10 s), and what it renders matches the newest answer, given 4 s to render: a
// page that keeps cached rows while its polls answer 200 fails.
const ENDPOINT: Record<string, RegExp> = {
  '/leaders': /\/leaderboard\b/,
  '/vault': /\/vault\b/,
  '/activity': /\/activity\b/,
  '/me': /\/tickets\?[^#]*owner=/i,
};
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const listOf = (x: unknown, key: string): Obj[] => (Array.isArray(x) ? x : isObj(x) && Array.isArray(x[key]) ? (x[key] as unknown[]) : []).filter(isObj);
// The event kinds the site renders (site lib/normalize.ts KINDS: kind first, then type); others are dropped.
const KINDS = new Set(['open', 'settle', 'deposit', 'withdraw', 'market', 'TicketOpened', 'TicketSettled', 'Deposit', 'Withdraw', 'MarketListed']);
const TICKET_KINDS = new Set(['open', 'settle', 'TicketOpened', 'TicketSettled']);
const kindOf = (e: Obj): string | null => (KINDS.has(String(e.kind)) ? String(e.kind) : KINDS.has(String(e.type)) ? String(e.type) : null);
// USD as the site reads it (normalize.ts usd and usdAt): <key>Raw first; an integer string is raw 6-decimal USDG.
const usdOf = (o: Obj, key: string): number => {
  const v = o[`${key}Raw`] !== undefined && o[`${key}Raw`] !== null ? o[`${key}Raw`] : o[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v) / 1e6;
  return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN;
};
const ticketLinks = (p: Page, rowId: string) =>
  p.$$eval(`${tid(rowId)} a[href*="/ticket/"]`, (as) => as.map((a) => (a.getAttribute('href') || '').replace(/.*\/ticket\//, '').replace(/[?#].*$/, '')));
type Shown = { ok: boolean; detail: string; none?: boolean };
// Per route: the rendered rows against the newest answer (the head poll, not an older page with before=); answers is
// every answer since the page opened, for the paged owner tickets of Me.
const RENDERED: Record<string, (p: Page, body: unknown, answers: unknown[]) => Promise<Shown>> = {
  // Activity polls the head unfiltered, newest first: its newest ticket event is among the rendered rows.
  '/activity': async (p, body) => {
    const ev = listOf(body, 'events').filter((e) => kindOf(e) !== null);
    const newest = ev.find((e) => TICKET_KINDS.has(kindOf(e)!) && String(e.id ?? '') !== '');
    if (!newest) return { ok: true, none: true, detail: `the newest answer has no ticket event (${ev.length} events)` };
    const id = String(newest.id);
    const shown = await ticketLinks(p, 'activity-row');
    return { ok: shown.includes(id), detail: `newest ticket event #${id} of the answer ${shown.includes(id) ? 'shown' : `not among ${shown.length} rendered ticket links`}` };
  },
  // Every ranked row is an address of the newest answer.
  '/leaders': async (p, body) => {
    const addrs = new Set(listOf(body, 'rows').map((r) => String(r.address ?? '').toLowerCase()).filter(Boolean));
    if (!addrs.size) return { ok: true, none: true, detail: 'the newest answer has no rows' };
    const shown = await p.$$eval(`${tid('leaders-row')} a[href*="a="]`, (as) => as.map((a) => (/[?&]a=([^&#]+)/.exec(a.getAttribute('href') || '')?.[1] || '').toLowerCase()));
    const stale = shown.filter((a) => !addrs.has(a));
    return { ok: shown.length > 0 && stale.length === 0, detail: `${shown.length} rendered rows, ${stale.length} not in the newest answer (${addrs.size} rows)${stale.length ? `: ${stale.slice(0, 3).join(', ')}` : ''}` };
  },
  // The assets figure shows the newest answer's assets, rounded to whole USDG.
  '/vault': async (p, body) => {
    const want = isObj(body) ? Math.round(usdOf(body, 'assets')) : NaN;
    if (!Number.isFinite(want)) return { ok: false, detail: 'the newest /vault answer has no assets' };
    const text = ((await p.$eval(tid('vault-assets'), (e) => e.textContent || '').catch(() => '')) as string).trim();
    return { ok: text.replace(/\D/g, '') === String(Math.abs(want)), detail: `vault-assets "${text}", newest answer ${want} USDG` };
  },
  // Every rendered ticket belongs to the owner's answers (the list is paged, so all answers since the page opened).
  '/me': async (p, _body, answers) => {
    const ids = new Set(answers.flatMap((b) => listOf(b, 'tickets').map((t) => String(t.id ?? ''))).filter(Boolean));
    const shown = await ticketLinks(p, 'me-ticket');
    if (!shown.length) return { ok: true, none: true, detail: `no me-ticket rows rendered (${ids.size} tickets in the answers)` };
    const stale = shown.filter((id) => !ids.has(id));
    return { ok: stale.length === 0, detail: `${shown.length} rendered tickets, ${stale.length} not in the owner's answers${stale.length ? `: ${stale.slice(0, 3).join(', ')}` : ''}` };
  },
};
async function fresh(p: Page, net: Net, route: string, t0: number, width: number) {
  if (mock) return note(`fresh data on ${route} at ${width}`, 'mock: no bell to measure against');
  const re = ENDPOINT[route]!;
  const ok = () => net.hits.filter((h) => h.at >= t0 && h.status < 300 && re.test(h.url));
  for (let i = 0; i < 30 && ok().length < 2; i++) await p.waitForTimeout(500);
  const hits = ok();
  check(hits.length >= 2, `bell polled twice on ${route} at ${width}`, `${hits.length} bell answers for ${re.source} within 15 s of opening`);
  let r: Shown = { ok: false, detail: 'no answer body captured' };
  for (let i = 0; i < 8; i++) {
    const all = ok().filter((h) => h.body !== undefined);
    const head = all.filter((h) => !/[?&]before=/.test(h.url)).pop();
    if (head) {
      r = await RENDERED[route]!(p, head.body, all.map((h) => h.body));
      if (r.ok) break;
    }
    await p.waitForTimeout(500);
  }
  if (r.none) note(`rendered data matches the newest answer on ${route} at ${width}`, r.detail);
  else check(r.ok, `rendered data matches the newest answer on ${route} at ${width}`, r.detail);
}

// Bot events among the rendered Activity rows: the newest head answer the page polled, in the order it renders it (the
// kinds it drops left out), cut to the rendered row count. Registered bots alone put no demo tag on the page.
function botsShown(net: Net, t0: number, rows: number): boolean | null {
  if (mock) return true;
  const head = net.hits.filter((h) => h.at >= t0 && h.status < 300 && ENDPOINT['/activity']!.test(h.url) && !/[?&]before=/.test(h.url) && h.body !== undefined).pop();
  if (!head) return null;
  return listOf(head.body, 'events').filter((e) => kindOf(e) !== null).slice(0, rows).some((e) => e.bot === true);
}

async function pages(p: Page, net: Net, width: number, opened: string[]) {
  for (const [route, id] of [['/leaders', 'leaders-row'], ['/vault', 'vault-assets'], ['/activity', 'activity-row'], ['/me', 'me-ticket']] as const) {
    const t0 = Date.now();
    await p.goto(`${base}${route}`);
    let el = await p.waitForSelector(tid(id), { timeout: id === 'me-ticket' ? 8000 : 15000 }).catch(() => null);
    if (id === 'me-ticket') {
      // Opened tickets may have settled already: the Settled tab of Me lists them.
      const ids = new Set<string>();
      const collect = async () => {
        for (const h of await p.$$eval(`${tid('me-ticket')} a[href*="/ticket/"]`, (as) => as.map((a) => a.getAttribute('href') || ''))) ids.add(h.replace(/.*\/ticket\//, ''));
      };
      await collect();
      const settledTab = p.locator('[role="radio"]', { hasText: /^\s*Settled\b/ }).first();
      if (opened.some((o) => !ids.has(o)) && (await settledTab.count())) {
        await settledTab.click();
        el = (await p.waitForSelector(tid('me-ticket'), { timeout: 10000 }).catch(() => null)) ?? el;
        await collect();
      }
      if (opened.length) {
        const missing = opened.filter((o) => !ids.has(o));
        check(missing.length === 0, `me-ticket rows for the opened tickets on /me at ${width}`, missing.length ? `missing ${missing.join(', ')} (listed ${[...ids].join(', ') || 'none'})` : `${opened.length} tickets listed`);
      } else {
        note(`me-ticket on /me at ${width}`, `no ticket opened at this width (--quick): ${el ? 'rows shown' : 'no rows, as expected for a fresh burner'}`);
      }
    } else if (id === 'vault-assets') check(!!el && /\d/.test((await el.textContent()) || ''), `vault-assets has a number at ${width}`);
    else check(!!el, `${id} rows on ${route} at ${width}`, el ? `${(await p.$$(tid(id))).length} rows` : 'none');
    await fresh(p, net, route, t0, width);
    if (id === 'activity-row' && el) {
      const ages = await p.$$eval(tid(id), (els) => els.slice(0, 5).map((e) => {
        const t = e.querySelector('time[datetime]');
        if (t) return (Date.now() - Date.parse(t.getAttribute('datetime') || '')) / 1000;
        const s = (e.textContent || '').toLowerCase();
        if (/just now|\bnow\b/.test(s)) return 0;
        const m = /(\d+)\s*s ago/.exec(s);
        return m ? Number(m[1]) : null;
      }));
      const known = ages.filter((a): a is number => a !== null && Number.isFinite(a));
      if (known.length) check(Math.min(...known) <= 60, `activity newest row within 60 s at ${width}`, `${Math.round(Math.min(...known))} s`);
      else note(`activity row times at ${width}`, 'rows show the fork clock, not a wall time; freshness measured from the bell polls');
      const tags = (await p.$$(tid('demo-tag'))).length;
      const rows = (await p.$$(tid(id))).length;
      const want = botsShown(net, t0, rows);
      if (want === null) check(false, `demo-tag on bot rows at ${width}`, 'no /activity answer body captured from the page');
      else if (want) check(tags > 0, `demo-tag on bot rows at ${width}`, `${tags} tags; the rendered rows include bot events of the newest answer`);
      else note(`demo-tag at ${width}`, `no bot event among the ${rows} rendered rows of the newest answer; ${tags} tags`);
    }
    await shot(p, route.slice(1), width);
    await noHScroll(p, `on ${route}`, width);
  }
}

const browser = await chromium.launch();
try {
  let eligible: number | null = null;
  if (bell) {
    try {
      const r = await fetch(`${bell}/replay/coverage`);
      const cov = await r.json().catch(() => null) as { eligible?: unknown } | null;
      if (r.ok && Array.isArray(cov?.eligible)) eligible = cov.eligible.length;
      else check(false, 'bell /replay/coverage', `HTTP ${r.status}, ${JSON.stringify(cov).slice(0, 160)}: no eligible array, the tradable count cannot be compared`);
    } catch (e) { check(false, 'bell /replay/coverage', String(e)); }
  }
  for (const width of widths) {
    const { p, net } = await open(browser, width);
    try {
    const b = await board(p, width);
    if (eligible !== null) check(b.tradable.length === eligible, `tradable rows equal coverage eligible at ${width}`, `${b.tradable.length} vs ${eligible}`);
    else note(`tradable rows at ${width}`, `${b.tradable.length} (mock: not compared with /replay/coverage)`);
    const longTail = b.tradable.filter((s) => !CORE_ALL.includes(s)).slice(0, 3);
    const tail = longTail.length === 3 ? longTail : LONG_TAIL_FALLBACK;
    for (const sym of [...CORE, ...tail]) await ticker(p, net, sym, width);
    const widest = width === Math.max(...widths);
    const opened: string[] = [];
    if (!quick) {
      // Every width opens tickets (a flow broken at one width must fail there); the first one is watched at once, so
      // its deadline is not spent on the later opens.
      const syms = widest ? [CORE[0]!, ...tail] : [tail[0]!];
      for (const [i, s] of syms.entries()) {
        const r = await openTicket(p, s, width);
        if (r.path) opened.push(r.path.replace(/.*\/ticket\//, ''));
        if (i === 0) {
          if (r.path) await watchTicket(p, r, width);
          else check(false, `verdict within ETA plus 10 s at ${width}`, `no ticket opened on ${s} to watch`);
        }
      }
    }
    await pages(p, net, width, opened);
    check(net.console.length === 0, `no console errors at ${width}`, net.console.slice(0, 5).join(' | '));
    check(net.errors.length === 0, `no bell 4xx or 5xx at ${width}`, net.errors.slice(0, 5).join(' | '));
    } catch (e) {
      check(false, `run at ${width}`, (e as Error).message.split('\n')[0] ?? String(e));
    }
    await p.context().close();
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\ndemo-check ${mock ? 'mock' : 'live'} ${base}: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
