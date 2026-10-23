// Pure decisions of the trader fleet. Everything random takes an Rng so the tests are seeded.
export type Rng = () => number;

/** Seeded PRNG (mulberry32); Math.random in production. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exponential inter-arrival time: a Poisson process with mean `meanMs` between events. */
export function expDelay(meanMs: number, rng: Rng): number {
  const u = Math.min(rng(), 1 - 1e-12);
  return -meanMs * Math.log(1 - u);
}

export function weighted<T>(items: readonly (readonly [T, number])[], rng: Rng): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = rng() * total;
  for (const [v, w] of items) {
    if (x < w) return v;
    x -= w;
  }
  return items[items.length - 1]![0];
}

export const MULTIPLES = [[2, 25], [5, 35], [10, 25], [20, 15]] as const;
/** Horizon codes of TicketBook (0 session = today's close, 1 day, 2 week) at 55/30/15. */
export const HORIZONS = [[0, 55], [1, 30], [2, 15]] as const;
export const CORE_SHARE = 0.4;

/** 2/5/10/20 at 25/35/25/15 %, never above the market's maxLeverage (falls back to the largest allowed). */
export function pickMultiple(rng: Rng, maxLeverage = 20): number {
  const m = weighted(MULTIPLES, rng);
  if (m <= maxLeverage) return m;
  const ok = MULTIPLES.map(([x]) => x as number).filter((x) => x <= maxLeverage);
  return ok.length ? ok[ok.length - 1]! : Math.max(1, Math.floor(maxLeverage));
}

export function pickHorizon(rng: Rng): number {
  return weighted(HORIZONS, rng);
}

export const USDG = 1_000_000n;
export const MIN_AMOUNT_USDG = 5;
export const MAX_AMOUNT_USDG = 250;

/** 5 to 250 USDG skewed small (u^2.5: median about 48), rounded to 1, 5 or 10 USDG; capped by maxStake. */
export function pickAmountRaw(rng: Rng, maxStakeRaw: bigint = 1000n * USDG): bigint {
  const u = rng();
  let usd = MIN_AMOUNT_USDG + (MAX_AMOUNT_USDG - MIN_AMOUNT_USDG) * Math.pow(u, 2.5);
  usd = usd < 20 ? Math.round(usd) : usd < 100 ? Math.round(usd / 5) * 5 : Math.round(usd / 10) * 10;
  usd = Math.min(MAX_AMOUNT_USDG, Math.max(MIN_AMOUNT_USDG, usd));
  const raw = BigInt(usd) * USDG;
  return raw > maxStakeRaw ? maxStakeRaw : raw;
}

/** Side from the last 3 5-minute closes: half the bots follow the move (momentum), half fade it (reversal). */
export function pickSide(rng: Rng, closes: readonly number[]): boolean {
  const c = closes.filter((x) => Number.isFinite(x)).slice(-3);
  const momentum = rng() < 0.5;
  if (c.length < 2 || c[c.length - 1] === c[0]) return rng() < 0.5;
  const up = c[c.length - 1]! > c[0]!;
  return momentum ? up : !up;
}

/** 40 % core, 60 % uniform over the tradable non-core symbols (whichever list is non-empty when one is empty). */
export function pickSymbol(rng: Rng, core: readonly string[], nonCore: readonly string[]): { symbol: string; core: boolean } | null {
  if (!core.length && !nonCore.length) return null;
  const useCore = !nonCore.length || (core.length > 0 && rng() < CORE_SHARE);
  const list = useCore ? core : nonCore;
  return { symbol: list[Math.floor(rng() * list.length) % list.length]!, core: useCore };
}

export const LIMITS = {
  vaultFreeMinPct: 40n,
  oiMaxPct: 80n,
  perBot: 6,
  fleet: 150,
  tickMaxAgeMs: 20_000,
  revertsBeforeBackoff: 5,
  backoffMs: 60_000,
} as const;

export interface GuardIn {
  vaultFree: bigint;
  vaultAssets: bigint;
  oi: bigint;
  oiCap: bigint;
  amount: bigint;
  botOpen: number;
  fleetOpen: number;
  tickAgeMs: number;
  backoffUntil: number;
  now: number;
}

/** The first guard that blocks an open, or null. */
export function guardReason(g: GuardIn): string | null {
  if (g.now < g.backoffUntil) return 'backoff';
  if (!(g.tickAgeMs <= LIMITS.tickMaxAgeMs)) return 'bell-stalled';
  if (g.vaultAssets <= 0n || g.vaultFree * 100n < g.vaultAssets * LIMITS.vaultFreeMinPct) return 'vault-free';
  if (g.oiCap <= 0n || (g.oi + g.amount) * 100n > g.oiCap * LIMITS.oiMaxPct) return 'oi-cap';
  if (g.fleetOpen >= LIMITS.fleet) return 'fleet-cap';
  if (g.botOpen >= LIMITS.perBot) return 'bot-cap';
  return null;
}

/** Wall ms since the bell's last replay tick; accepts ms or s timestamps; Infinity when unknown. */
export function tickAgeMs(lastTickAt: number | null | undefined, nowMs: number): number {
  if (lastTickAt === null || lastTickAt === undefined || !Number.isFinite(lastTickAt) || lastTickAt <= 0) return Infinity;
  const ms = lastTickAt < 1e12 ? lastTickAt * 1000 : lastTickAt;
  return Math.max(0, nowMs - ms);
}

/** Most distinct reason keys a counter keeps; later new reasons count under 'other'. */
export const MAX_REASON_KEYS = 24;

/** A bounded reason key: numbers and hex blobs replaced (viem messages embed amounts), at most 60 characters. */
export function reasonKey(counts: Record<string, number>, reason: string): string {
  const k = reason.replace(/0x[0-9a-fA-F]+/g, 'HEX').replace(/\d+/g, 'N').slice(0, 60);
  return k in counts || Object.keys(counts).length < MAX_REASON_KEYS ? k : 'other';
}

/** Consecutive-revert counter with the 60 s back-off after 5 in a row. */
export class RevertTracker {
  streak = 0;
  backoffUntil = 0;
  readonly byReason: Record<string, number> = {};
  total = 0;
  revert(reason: string, now: number): void {
    this.total += 1;
    const k = reasonKey(this.byReason, reason);
    this.byReason[k] = (this.byReason[k] ?? 0) + 1;
    this.streak += 1;
    if (this.streak >= LIMITS.revertsBeforeBackoff) {
      this.backoffUntil = now + LIMITS.backoffMs;
      this.streak = 0;
    }
  }
  ok(): void {
    this.streak = 0;
  }
}

/** LP plan: first deposit 25k to 150k USDG (whole thousands), then a deposit or withdraw of at most 10 %. */
export function lpFirstDepositRaw(rng: Rng): bigint {
  return BigInt(25 + Math.floor(rng() * 126)) * 1000n * USDG;
}

export function lpRebalance(rng: Rng, positionRaw: bigint, maxWithdrawRaw: bigint): { kind: 'deposit' | 'withdraw'; amount: bigint } | null {
  if (positionRaw <= 0n) return null;
  const pct = BigInt(2 + Math.floor(rng() * 9)); // 2 to 10 %
  const deposit = rng() < 0.5;
  let amount = (positionRaw * pct) / 100n;
  amount = (amount / USDG) * USDG; // whole USDG
  if (!deposit && amount > maxWithdrawRaw) amount = (maxWithdrawRaw / USDG) * USDG;
  if (amount <= 0n) return null;
  return { kind: deposit ? 'deposit' : 'withdraw', amount };
}

/** About every 20 wall minutes: 15 to 25 minutes. */
export function lpNextMs(rng: Rng): number {
  return (15 + rng() * 10) * 60_000;
}
