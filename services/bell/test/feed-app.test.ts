// App loop bookkeeping without a chain: the timer registry holds only pending timers.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app';
import { loadEnv } from '../src/config';

describe('App loops', () => {
  test('completed loop timers leave the registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'feed-app-'));
    const app = new App(
      loadEnv({
        BELL_RPC_URL: 'http://127.0.0.1:1',
        BELL_STATE_FILE: join(dir, 'state.json'),
        BELL_BOOK: join(dir, 'missing-book.json'),
        BELL_CHARTS_DIR: join(dir, 'charts'),
        BELL_CHARTS: 'off',
        BELL_REPLAY: 'off',
        BELL_INDEX_SECONDS: '0.005',
        BELL_SETTLE_SECONDS: '0.005',
        BELL_ADMIN_TOKEN: 'test',
      }),
    );
    let runs = 0;
    const idx = app.indexTick.bind(app);
    app.indexTick = () => {
      runs++;
      return idx();
    };
    app.start();
    await Bun.sleep(1200);
    expect(runs).toBeGreaterThan(50); // the indexer loop ran many times
    expect(app.pendingTimers()).toBeLessThanOrEqual(3); // one pending timer per loop at most
    app.stop();
    expect(app.pendingTimers()).toBe(0);
  });
});
