// Ticket horizons (docs/INTERFACES.md): 0 session (next 21:00 UTC on the playground clock, the daily close),
// 1 day (24 h), 2 week (7 d), the day and week expiries rounded up to the next full hour like TicketBook.expiryFor.
// The contract computes the real expiry; this mirrors it for the sheet's labels. Decision D7 names the three
// "Today's close", "In 24 h" and "In 7 d" (the "Settles at" control, lib/ticker/settles-at.ts).
import { TCOPY } from './ticker/copy';

export const HORIZONS = [0, 1, 2] as const;
export type Horizon = (typeof HORIZONS)[number];
export const SESSION_CLOSE_UTC_HOUR = 21;

const ceilHour = (t: number) => Math.ceil(t / 3600) * 3600;

export function expiryOf(horizon: number, now: number): number {
  if (horizon === 1) return ceilHour(now + 86400);
  if (horizon === 2) return ceilHour(now + 7 * 86400);
  const d = new Date(now * 1000);
  let close = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), SESSION_CLOSE_UTC_HOUR) / 1000;
  if (close <= now) close += 86400;
  return close;
}

/** A service horizon value (0, 1, 2 as number or string) or null when absent or anything else. */
export function horizonOf(v: unknown): Horizon | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d$/.test(v.trim()) ? Number(v) : NaN;
  return (HORIZONS as readonly number[]).includes(n) ? (n as Horizon) : null;
}

/** The horizon's name ("Today's close", "In 24 h", "In 7 d"), or null when the ticket does not carry one (then no
 * label is shown). */
export function horizonName(h: number | null): string | null {
  return h === null ? null : TCOPY.horizonNames[h as Horizon] ?? null;
}
