// Chunked round posting: postMany in chunks of at most 64 rows (fixed gas 80k + 90k per row, so a bad
// row mines a reverted receipt instead of failing estimation); a reverted chunk is split in halves down to single
// rows, and one post call never sends more than 8 single posts. A transport error (send throws) ends the call: the
// rows left are not posted, and the caller retries. Rows that revert on their own are reported (onRevert), so the
// caller can post them after the healthy rows next time (least recently reverted first, so the single-post budget
// rotates over them); rows skipped by the single-post budget are not reported.
export const POST_CHUNK = 64;
export const MAX_SINGLES = 8;

export const postManyGas = (n: number): bigint => 80_000n + 90_000n * BigInt(n);
export const POST_ONE_GAS = 200_000n;

export interface ChunkSender<R> {
  /** One postMany for `rows`; true when the receipt succeeded. */
  many(rows: R[]): Promise<boolean>;
  /** One post for `row`; true when the receipt succeeded. */
  one(row: R): Promise<boolean>;
}

export interface PostStats {
  ok: number;
  failed: number;
  txs: number;
  singles: number;
}

/** Rows whose last attempt reverted on their own go after the others, so they land in their own chunk and spend the
 *  single-post budget among themselves instead of starving a healthy row. `bad` is false or undefined for a healthy
 *  row, true or the sequence number of the row's latest revert otherwise: bad rows go least recently reverted first
 *  (true counts as oldest), so rows that reverted again move to the back and the budget reaches every bad row in
 *  turn (one that recovered gets its single post). Stable otherwise. */
export function healthyFirst<R>(rows: R[], bad: (r: R) => boolean | number | undefined): R[] {
  const ok: R[] = [];
  const b: { r: R; k: number; j: number }[] = [];
  rows.forEach((r, j) => {
    const x = bad(r);
    if (x === undefined || x === false) ok.push(r);
    else b.push({ r, k: x === true ? 0 : x, j });
  });
  b.sort((x, y) => x.k - y.k || x.j - y.j);
  return [...ok, ...b.map((x) => x.r)];
}

export async function postChunked<R>(rows: R[], send: ChunkSender<R>, onOk: (r: R) => void, o: { chunk?: number; maxSingles?: number } = {}, onRevert?: (r: R) => void): Promise<PostStats> {
  const chunk = o.chunk ?? POST_CHUNK;
  const maxSingles = o.maxSingles ?? MAX_SINGLES;
  const st: PostStats = { ok: 0, failed: 0, txs: 0, singles: 0 };
  const run = async (part: R[]): Promise<void> => {
    if (part.length === 1) {
      if (st.singles >= maxSingles) {
        st.failed++;
        return;
      }
      st.singles++;
      st.txs++;
      if (await send.one(part[0]!)) {
        onOk(part[0]!);
        st.ok++;
      } else {
        st.failed++;
        onRevert?.(part[0]!);
      }
      return;
    }
    st.txs++;
    if (await send.many(part)) {
      for (const r of part) onOk(r);
      st.ok += part.length;
      return;
    }
    const h = Math.ceil(part.length / 2);
    await run(part.slice(0, h));
    await run(part.slice(h));
  };
  for (let k = 0; k < rows.length; k += chunk) await run(rows.slice(k, k + chunk));
  return st;
}
