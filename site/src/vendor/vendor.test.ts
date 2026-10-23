// The ticker chart's library is vendored, not installed (the bellswap.fun trade chart's pattern,
// site-lp/site/src/pages/trade/licences.test.ts): Lightweight Charts v5.2.1 standalone module, pinned by its sha256,
// with its Apache 2.0 licence and notice in public/licenses; no package entry.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const site = fileURLToPath(new URL('../../', import.meta.url));
const MODULE = `${site}src/vendor/lightweight-charts/lightweight-charts.standalone.production.mjs`;
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('vendored Lightweight Charts', () => {
  test('the module is v5.2.1 with the pinned sha256', () => {
    expect(sha(MODULE)).toBe('1bb1ee79f9d4dd17261b53d930f7a8995748276f80e7ba0e24412b5068062f5f');
    expect(readFileSync(MODULE).subarray(0, 300).toString('utf8')).toContain('TradingView Lightweight Charts™ v5.2.1');
  });
  test('its licence and notice ship in public/licenses', () => {
    for (const [f, want] of [
      ['LICENSE-lightweight-charts.txt', '70c9d5382506dd184465425c08a99ad9bd6d9ac1313c252968ba0b585e5ef823'],
      ['NOTICE-lightweight-charts.txt', 'f76c6afab94884448f0426e30d6e9d555ca7247894cd3484e477d2f87513036e'],
    ] as const) {
      const path = `${site}public/licenses/${f}`;
      expect([f, existsSync(path)]).toEqual([f, true]);
      expect([f, sha(path)]).toEqual([f, want]);
    }
    expect(readFileSync(`${site}public/licenses/LICENSE-lightweight-charts.txt`, 'utf8')).toContain('Apache License');
  });
  test('package.json has no lightweight-charts entry (the file hash is the integrity check)', () => {
    const pkg = JSON.parse(readFileSync(`${site}package.json`, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect('lightweight-charts' in (pkg.dependencies ?? {})).toBe(false);
    expect('lightweight-charts' in (pkg.devDependencies ?? {})).toBe(false);
  });
  test('the chart keeps the TradingView attribution logo on', () => {
    const src = readFileSync(`${site}src/components/chart/useChartInstance.ts`, 'utf8');
    expect(src.match(/attributionLogo: true/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(src.includes('attributionLogo: false')).toBe(false);
  });
});
