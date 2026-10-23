// Vault totals and hourly history from the indexed events, so GET /vault can show a share price history and the
// house pnl over 7 fork days without reading the chain per hour. HouseVault.totalAssets = USDG balance - openNet;
// the balance moves with Deposit (+assets), Withdraw (-assets), TicketOpened (+stake, collected into the vault) and
// TicketSettled (-payout); openNet with the net stake of each open ticket; reserved is carried by the vault's
// Reserved and Released events (totalReserved). A USDG transfer straight to the vault is not a vault event: GET /vault
// reads the chain at the indexed block and vaultSync absorbs the difference, and carries the history to that block's
// time so hours without events still get a point.
import { DAY_S, HOUR } from '../math';
import { emptyVault, VAULT_HISTORY_MAX, type StateData, type VaultAcc, type VaultPoint } from '../store';

const big = (s: string | undefined) => BigInt(s ?? '0');

export function vaultOf(d: StateData): VaultAcc {
  if (!d.vault || !Array.isArray(d.vault.history)) d.vault = emptyVault();
  return d.vault;
}

/** Share value of one whole vault share (12 decimals) in USDG; ERC4626 with decimals offset 6 and virtual shares. */
export function sharePriceOf(assets: bigint, supply: bigint): number {
  return Number((10n ** 12n * (assets + 1n)) / (supply + 10n ** 6n)) / 1e6;
}

export function assetsOf(v: VaultAcc): bigint {
  const a = big(v.balanceRaw) - big(v.openNetRaw);
  return a > 0n ? a : 0n;
}

export function pointOf(v: VaultAcc, t: number): VaultPoint {
  const assets = assetsOf(v);
  return { t, assetsRaw: assets.toString(), reservedRaw: v.reservedRaw, sharePrice: sharePriceOf(assets, big(v.supplyRaw)), pnlRaw: (assets - big(v.depositsRaw)).toString() };
}

/** Before an event at fork time `at`: one point per fork hour from the last point to the hour of `at`, each with
 *  the totals as they stood (carried forward over hours without events), capped at VAULT_HISTORY_MAX. */
export function vaultClock(d: StateData, at: number): void {
  const v = vaultOf(d);
  const h = Math.floor(at / HOUR) * HOUR;
  const hist = v.history;
  const last = hist[hist.length - 1];
  if (last && h <= last.t) return;
  let from = last ? last.t + HOUR : h;
  if ((h - from) / HOUR >= VAULT_HISTORY_MAX) from = h - (VAULT_HISTORY_MAX - 1) * HOUR;
  for (let t = from; t <= h; t += HOUR) hist.push(pointOf(v, t));
  if (hist.length > VAULT_HISTORY_MAX) hist.splice(0, hist.length - VAULT_HISTORY_MAX);
}

/** Brings the indexed totals in line with the chain at the indexed block (`live`, read there; `at` is that block's
 *  fork time): carries the hourly history to `at`, then takes the chain's assets, supply and reserved, so what no
 *  indexed event shows (a USDG transfer straight to the vault) counts from the next hour on. A partial state (indexed
 *  before these totals existed) is rebased on the chain values and starts a new history. Returns true on a change. */
export function vaultSync(d: StateData, at: number, live: { assets: bigint; supply: bigint; reserved: bigint }): boolean {
  if (vaultOf(d).partial) {
    const a = live.assets.toString();
    d.vault = { balanceRaw: a, openNetRaw: '0', reservedRaw: live.reserved.toString(), supplyRaw: live.supply.toString(), depositsRaw: a, history: [] };
    vaultClock(d, at);
    return true;
  }
  const v = vaultOf(d);
  const n = v.history.length;
  vaultClock(d, at);
  let changed = v.history.length !== n;
  const drift = live.assets - (big(v.balanceRaw) - big(v.openNetRaw));
  if (drift !== 0n) (v.balanceRaw = (big(v.balanceRaw) + drift).toString()), (changed = true);
  if (big(v.supplyRaw) !== live.supply) (v.supplyRaw = live.supply.toString()), (changed = true);
  if (big(v.reservedRaw) !== live.reserved) (v.reservedRaw = live.reserved.toString()), (changed = true);
  return changed;
}

export type VaultMove =
  | { kind: 'deposit'; assets: bigint; shares: bigint }
  | { kind: 'withdraw'; assets: bigint; shares: bigint }
  | { kind: 'open'; stake: bigint; net: bigint }
  | { kind: 'settle'; payout: bigint; net: bigint }
  | { kind: 'reserved'; total: bigint };

export function vaultMove(d: StateData, at: number, m: VaultMove): void {
  vaultClock(d, at);
  const v = vaultOf(d);
  const add = (k: 'balanceRaw' | 'openNetRaw' | 'supplyRaw' | 'depositsRaw', x: bigint) => (v[k] = (big(v[k]) + x).toString());
  switch (m.kind) {
    case 'deposit':
      add('balanceRaw', m.assets);
      add('supplyRaw', m.shares);
      add('depositsRaw', m.assets);
      break;
    case 'withdraw':
      add('balanceRaw', -m.assets);
      add('supplyRaw', -m.shares);
      add('depositsRaw', -m.assets);
      break;
    case 'open':
      add('balanceRaw', m.stake);
      add('openNetRaw', m.net);
      break;
    case 'settle':
      add('balanceRaw', -m.payout);
      add('openNetRaw', -m.net);
      break;
    case 'reserved':
      v.reservedRaw = m.total.toString();
      break;
  }
}

/** House pnl over the last 7 fork days in USDG, relative to the first point of the window, with the current totals
 *  as the last point; null with fewer than two points. The last point before the window opens it (totals carry
 *  forward over hours without events). */
export function pnl7d(d: StateData, now: number): number[] | null {
  const v = vaultOf(d);
  if (v.partial) return null;
  const since = now - 7 * DAY_S;
  let k = v.history.length;
  while (k > 0 && v.history[k - 1]!.t >= since) k--;
  const pts = v.history.slice(k > 0 ? k - 1 : 0).map((p) => big(p.pnlRaw));
  pts.push(big(pointOf(v, now).pnlRaw));
  if (pts.length < 2) return null;
  const base = pts[0]!;
  return pts.map((p) => Number(p - base) / 1e6);
}

/** History for GET /vault: { t, assetsRaw, reservedRaw, sharePrice } per fork hour, oldest first. */
export function vaultHistory(d: StateData): { t: number; assetsRaw: string; reservedRaw: string; sharePrice: number }[] {
  const v = vaultOf(d);
  if (v.partial) return [];
  return v.history.map((p) => ({ t: p.t, assetsRaw: p.assetsRaw, reservedRaw: p.reservedRaw, sharePrice: p.sharePrice }));
}
