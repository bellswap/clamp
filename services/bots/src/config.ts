// Env of the bots service. Every bot key comes from BOTS_MNEMONIC (never the anvil dev keys).
export interface BotsEnv {
  mnemonic: string;
  count: number;
  lp: number;
  enabled: boolean;
  intervalMs: number;
  rpcUrl: string;
  bellUrl: string;
  adminToken: string;
  healthPort: number;
  /** Optional override of the core symbols (else the bell's /state feed.core, else DEFAULT_CORE). */
  core: string[] | null;
  /** Base slot of the USDG balances mapping: 1 for the fork's USDG (default), 0 for the bare-anvil MockUSDG. */
  usdgSlot: bigint;
}

/** The 14 markets of deployments/book.json (BELL_CORE_SYMBOLS default). */
export const DEFAULT_CORE = ['RTX', 'NOC', 'CPER', 'SOXL', 'DRAM', 'GD', 'MARA', 'UUUU', 'SPY', 'QQQ', 'NVDA', 'MU', 'SNDK', 'TSLA'];

function int(v: string | undefined, d: number, min: number, max: number): number {
  const n = v === undefined || v === '' ? d : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`expected a number from ${min} to ${max}, got ${v}`);
  return Math.floor(n);
}

export function loadEnv(e: Record<string, string | undefined> = process.env): BotsEnv {
  const core = (e.BOTS_CORE ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  return {
    mnemonic: (e.BOTS_MNEMONIC ?? '').trim(),
    count: int(e.BOTS_COUNT, 24, 0, 200),
    lp: int(e.BOTS_LP, 4, 0, 50),
    enabled: e.BOTS_ENABLED === '1' || e.BOTS_ENABLED === 'true',
    intervalMs: int(e.BOTS_INTERVAL_MS, 3000, 50, 3_600_000),
    rpcUrl: e.BOTS_RPC_URL || 'http://anvil:8545',
    bellUrl: (e.BOTS_BELL_URL || 'http://bell:8787').replace(/\/+$/, ''),
    adminToken: e.BELL_ADMIN_TOKEN ?? '',
    healthPort: int(e.BOTS_HEALTH_PORT, 8790, 0, 65535),
    core: core.length ? core : null,
    usdgSlot: BigInt(int(e.BOTS_USDG_SLOT, 1, 0, 1000)),
  };
}
