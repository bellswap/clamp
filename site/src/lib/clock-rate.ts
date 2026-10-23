// Playground clock rate from the bell's GET /state answer.
import type { BellState } from './types';

/** Playground seconds per wall second. The bell's speed is recorded bars per wall minute (replay.bar playground
 * seconds each), so the rate is speed * bar / 60; without a bar length (mock mode) speed is the rate itself. A paused
 * replay (replay.running false) holds the clock: the rate is 0. */
export function clockRate(s: Pick<BellState, 'speed' | 'replay'>): number {
  if (s.replay?.running === false) return 0;
  const bar = Number(s.replay?.bar);
  const rate = Number.isFinite(bar) && bar > 0 ? (s.speed * bar) / 60 : s.speed;
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}
