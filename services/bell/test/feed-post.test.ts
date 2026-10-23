import { describe, expect, test } from 'bun:test';
import { healthyFirst, MAX_SINGLES, postChunked, postManyGas } from '../src/feed/post';

function sender(bad: Set<number>, o: { throwAt?: number } = {}) {
  const calls: { kind: 'many' | 'one'; rows: number[] }[] = [];
  return {
    calls,
    send: {
      many: async (rows: number[]) => {
        calls.push({ kind: 'many' as const, rows });
        if (o.throwAt !== undefined && rows.includes(o.throwAt)) throw new Error('rpc down');
        return !rows.some((r) => bad.has(r));
      },
      one: async (r: number) => {
        calls.push({ kind: 'one' as const, rows: [r] });
        return !bad.has(r);
      },
    },
  };
}
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('chunked postMany', () => {
  test('chunks of at most 64; one bad row is isolated by halving, every other row lands', async () => {
    const s = sender(new Set([77]));
    const ok: number[] = [];
    const st = await postChunked(range(130), s.send, (r) => ok.push(r));
    expect(Math.max(...s.calls.filter((c) => c.kind === 'many').map((c) => c.rows.length))).toBe(64);
    expect(ok.length).toBe(129);
    expect(ok).not.toContain(77);
    expect(st).toMatchObject({ ok: 129, failed: 1, singles: 2 });
    expect(s.calls.filter((c) => c.kind === 'one').map((c) => c.rows[0])).toEqual([76, 77]);
  });

  test('never more than 8 single posts in one call', async () => {
    const bad = new Set(range(20).map((i) => i * 3));
    const s = sender(bad);
    const st = await postChunked(range(64), s.send, () => undefined);
    expect(st.singles).toBe(MAX_SINGLES);
    expect(s.calls.filter((c) => c.kind === 'one').length).toBe(MAX_SINGLES);
    expect(st.ok + st.failed).toBe(64);
  });

  test('a healthy row behind eight rows that revert lands at the next call: reverting rows go last', async () => {
    const s = sender(new Set(range(8)));
    const rows = range(9); // rows 0 to 7 revert on their own, row 8 is healthy
    const reverted = new Set<number>();
    const ok: number[] = [];
    const st = await postChunked(rows, s.send, (r) => ok.push(r), {}, (r) => reverted.add(r));
    expect(ok).toEqual([]); // the single-post budget ran out before row 8
    expect(st.singles).toBe(MAX_SINGLES);
    expect([...reverted].sort((a, b) => a - b)).toEqual(range(8)); // row 8 was skipped, not reported
    await postChunked(healthyFirst(rows, (r) => reverted.has(r)), s.send, (r) => ok.push(r), {}, (r) => reverted.add(r));
    expect(ok).toEqual([8]);
    expect(healthyFirst([1, 2, 3, 4], (r) => r % 2 === 1)).toEqual([2, 4, 1, 3]);
  });

  test('a transport error ends the call; earlier chunks stay posted', async () => {
    const s = sender(new Set(), { throwAt: 70 });
    const ok: number[] = [];
    await expect(postChunked(range(130), s.send, (r) => ok.push(r))).rejects.toThrow('rpc down');
    expect(ok).toEqual(range(64));
  });

  test('gas is 80k plus 90k per row', () => {
    expect(postManyGas(64)).toBe(80_000n + 90_000n * 64n);
  });
});
