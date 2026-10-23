// Leaderboard order, mirrored from the bell (services/bell/src/math.ts rankByRoi, /leaderboard in server.ts): only
// addresses with at least the minimum settled gross stake are ranked, by realized ROI (pnl / staked) descending, ties
// by points descending and then address ascending; the 100-row cap is taken after that filter and sort, so a
// ranked address is never dropped for a busier one below the floor.
import type { LeaderRow } from './types';

/** Minimum settled gross stake to be ranked, in USDG; the bell's minStakedRaw wins when it answers one. */
export const LEADER_MIN_STAKED = 100;
/** Rows shown, taken after the minimum filter and the ROI sort. */
export const LEADER_LIMIT = 100;

const U6 = 1_000_000;
const raw = (v: number) => BigInt(Math.round(v * U6));

/** The eligible rows in ROI order, at most `limit`. Exact on raw units (6 decimals), like the bell. */
export function rankLeaders(rows: readonly LeaderRow[], minStaked = LEADER_MIN_STAKED, limit = LEADER_LIMIT): LeaderRow[] {
  const min = raw(minStaked);
  return rows
    .filter((r) => raw(r.staked) > 0n && raw(r.staked) >= min)
    .sort((a, b) => {
      // pnlA / stakedA vs pnlB / stakedB without division (both stakes positive)
      const l = raw(b.pnl) * raw(a.staked);
      const r = raw(a.pnl) * raw(b.staked);
      return l > r ? 1 : l < r ? -1 : (b.points ?? 0) - (a.points ?? 0) || a.address.localeCompare(b.address);
    })
    .slice(0, limit);
}

/** The bell's whole order: ranked rows first, then the rest in their given order (what /leaderboard returns). */
export function leaderOrder(rows: readonly LeaderRow[], minStaked = LEADER_MIN_STAKED): LeaderRow[] {
  const ranked = rankLeaders(rows, minStaked, Infinity);
  const inRank = new Set(ranked);
  return [...ranked, ...rows.filter((r) => !inRank.has(r))];
}
