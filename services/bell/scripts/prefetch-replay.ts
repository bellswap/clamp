// Records the replay series for the whole catalog from a workstation before a reseed, so the bell never fetches
// Yahoo during the demo. Writes <out>/replay-5d-5m.json (ReplaySeries format, the bell's charts dir file) and
// <out>/coverage.json (eligible and missing catalog symbols under the coverage rule).
//   bun run scripts/prefetch-replay.ts --out <dir> [--catalog vendor/catalog.json] [--range 7d] [--sessions 5] [--min 0.9]
//   bun run scripts/prefetch-replay.ts --out <dir> --from <replay-5d-5m.json> --min 0.5   (no fetch: coverage.json only)
// Yahoo etiquette: batches of 20, one at a time, user agent Mozilla/5.0, doubling waits after a 429.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { yahooOf } from '../src/charts';
import { loadCatalog, SERVICE_DIR } from '../src/config';
import { eligibleOfMin } from '../src/feed';
import { COVERAGE_RULE, fetchRecording, type ReplaySeries } from '../src/replay';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const out = arg('out');
if (!out) {
  console.error('usage: bun run scripts/prefetch-replay.ts --out <dir> [--catalog path] [--range 7d] [--sessions 5]');
  process.exit(2);
}
const catalog = loadCatalog(resolve(arg('catalog', join(SERVICE_DIR, 'vendor/catalog.json'))!));
const symbols = catalog.map((e) => ({ symbol: e.symbol.toUpperCase(), yahoo: e.yahooSymbol || yahooOf(e.symbol) }));
const sessions = Number(arg('sessions', '5'));
const log = (...a: unknown[]) => console.error(`[prefetch ${new Date().toISOString()}]`, ...a);
log(`catalog ${symbols.length} symbols, range ${arg('range', '7d')}, ${sessions} sessions`);

const min = Number(arg('min', '0.9'));
const from = arg('from');
const s: ReplaySeries = from ? (JSON.parse(readFileSync(from, 'utf8')) as ReplaySeries) : await fetchRecording(symbols, { range: arg('range', '7d'), sessions, log });
const { eligible, missing } = eligibleOfMin(s, symbols.map((x) => x.symbol), min);
const cov = Object.values(s.coverage ?? {});
const eligibleAt = Object.fromEntries([0.9, 0.8, 0.7, 0.6, 0.5, 0.3].map((th) => [th.toFixed(2), cov.filter((v) => v >= th).length]));
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const coverage = {
  fetchedAt: s.fetchedAt,
  source: s.source,
  rule: COVERAGE_RULE.replace('0.90', min.toFixed(2)),
  min,
  eligibleAt,
  bars: s.t.length,
  sessions: s.sessions,
  first: day(s.t[0]!),
  last: day(s.t[s.t.length - 1]!),
  symbols: symbols.length,
  eligibleCount: eligible.length,
  eligible,
  missing,
  noData: missing.filter((m) => !s.prices[m]),
  coverage: s.coverage,
};
mkdirSync(out, { recursive: true });
const write = (name: string, body: string) => {
  const f = join(out, name);
  writeFileSync(`${f}.tmp`, body);
  renameSync(`${f}.tmp`, f);
};
if (!from) write('replay-5d-5m.json', JSON.stringify(s));
write('coverage.json', JSON.stringify(coverage, null, 1));
log(`wrote ${join(out, 'replay-5d-5m.json')}: ${Object.keys(s.prices).length} symbols, ${s.t.length} bars, ${s.sessions} sessions ${coverage.first} to ${coverage.last}`);
log(`eligible ${eligible.length} of ${symbols.length}; missing ${missing.join(' ')}`);
