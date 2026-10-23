// The house vault (route /vault, STYLE-SPEC 8.7 and component 11): size, reserved, free, your share, share price,
// utilization, LP count, the reserved bar, the hourly history of the assets, the 7 day PnL, the latest deposits and
// withdrawals (demo LPs tagged), and deposit or withdraw for the playground.
import { useEffect, useState } from 'react';
import { Page } from '../components/Shell';
import { Empty, Segmented, TapeLine } from '../components/ui';
import { COPY } from '../copy';
import { api } from '../lib/api';
import { useApp } from '../lib/app-state';
import { fmtPct, fmtSignedUsd, fmtUsd } from '../lib/format';
import { parseStake } from '../lib/payout';
import { areaPath, linePath } from '../lib/sparkline';
import { useToast } from '../lib/toast';
import type { ActivityItem, VaultView } from '../lib/types';
import { vaultMove, vaultPosition, type VaultPosition } from '../lib/wallet';

const NO_POSITION: VaultPosition = { owned: 0, withdrawable: 0 };

export function Vault() {
  const { address, kind, bal, epoch, bump, refreshBalances } = useApp();
  const toast = useToast();
  const [v, setV] = useState<VaultView | null>(null);
  // Tagged with its wallet: after a switch the previous wallet's position (and its withdraw limit) is not shown while the
  // new wallet's reads are pending or failing.
  const [posOf, setPosOf] = useState<{ a: string; p: VaultPosition } | null>(null);
  const pos: VaultPosition = posOf && posOf.a === address ? posOf.p : NO_POSITION;
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [amt, setAmt] = useState('100');
  const [busy, setBusy] = useState(false);
  const [moves, setMoves] = useState<ActivityItem[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.vault().then((x) => alive && setV(x), () => undefined);
      vaultPosition(address).then((x) => alive && setPosOf({ a: address, p: x }), () => undefined);
      api.activity({ kinds: ['deposit', 'withdraw'], limit: 12 }).then((a) => alive && setMoves(a), () => alive && setMoves((cur) => cur ?? []));
    };
    load();
    const t = setInterval(load, 6000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [address, epoch]);
  const n = parseStake(amt);
  const max = mode === 'deposit' ? bal?.usdg ?? 0 : pos.withdrawable;
  const bad = !Number.isFinite(n) || n <= 0 || n > max;
  const submit = async () => {
    if (bad || busy) return;
    setBusy(true);
    try {
      await vaultMove(kind, address, n, mode === 'deposit', { onApproved: () => toast('ok', COPY.toast.approved) });
      toast('ok', mode === 'deposit' ? COPY.toast.deposited : COPY.toast.withdrawn);
      bump();
      refreshBalances();
    } catch (e) {
      console.warn(e);
      toast('fail', COPY.toast.failed(mode === 'deposit' ? COPY.vault.deposit : COPY.vault.withdraw));
    } finally {
      setBusy(false);
    }
  };
  const used = v && v.assets > 0 ? (v.reserved / v.assets) * 100 : 0;
  const box = { width: 240, height: 48, pad: 2 };
  const hist = v?.history?.map((h) => h.assets) ?? [];
  const util = v?.utilization ?? (v && v.assets > 0 ? v.reserved / v.assets : null);
  const fig = (label: string, value: string, testId?: string) => (
    <div className="fig">
      <span className="label">{label}</span>
      <span className="fig-v num" {...(testId ? { 'data-testid': testId } : {})}>{value}</span>
    </div>
  );
  return (
    <Page className="narrow">
      <h1 className="h-md">{COPY.nav.vault}</h1>
      <section className="panel">
        <div className="grid4">
          {fig(COPY.vault.size, v ? fmtUsd(Math.round(v.assets)) : '–', 'vault-assets')}
          {fig(COPY.vault.reserved, v ? fmtUsd(Math.round(v.reserved)) : '–')}
          {fig(COPY.vault.free, v ? fmtUsd(Math.round(v.free)) : '–')}
          {fig(COPY.vault.share, v && v.assets > 0 ? fmtPct((pos.owned / v.assets) * 100).replace('+', '') : '–')}
          {fig(COPY.play.sharePrice, v?.sharePrice ? v.sharePrice.toFixed(4) : '–')}
          {fig(COPY.play.utilization, util !== null ? fmtPct(util * 100, 1).replace('+', '') : '–')}
          {fig(COPY.play.strip.lps, v ? fmtUsd(v.lpCount) : '–')}
          {fig(COPY.vault.pnl7d, v && v.pnl7d.length > 1 ? `${fmtSignedUsd(v.pnl7dTotal)}` : '–')}
        </div>
        <div className="stackbar" role="img" aria-label={`${used.toFixed(1)} percent reserved`}><span style={{ width: `${used}%` }} /></div>
        {hist.length > 1 && (
          <div className="pnl7">
            <span className="label">{COPY.play.strip.vaultHolds}</span>
            <svg viewBox="0 0 240 48" preserveAspectRatio="none" className={`spark spark-${hist[hist.length - 1]! < hist[0]! ? 'down' : 'up'} pnl-spark`} aria-hidden="true">
              <path d={areaPath(hist, box)} className="spark-area" />
              <path d={linePath(hist, box)} className="spark-line" vectorEffect="non-scaling-stroke" />
            </svg>
            <span className="num">{fmtUsd(Math.round(hist[hist.length - 1]!))} USDG</span>
          </div>
        )}
        {v && v.pnl7d.length > 1 && (
          <div className="pnl7">
            <span className="label">{COPY.vault.pnl7d}</span>
            <svg viewBox="0 0 240 48" preserveAspectRatio="none" className={`spark spark-${v.pnl7dTotal < 0 ? 'down' : 'up'} pnl-spark`} aria-hidden="true">
              <path d={areaPath(v.pnl7d, box)} className="spark-area" />
              <path d={linePath(v.pnl7d, box)} className="spark-line" vectorEffect="non-scaling-stroke" />
            </svg>
            <span className={`num ${v.pnl7dTotal < 0 ? 'down' : 'up'}`}>{fmtSignedUsd(v.pnl7dTotal)} USDG</span>
          </div>
        )}
      </section>
      <section className="panel">
        <Segmented label="Vault action" value={mode} onChange={setMode} options={[{ value: 'deposit', label: COPY.vault.deposit }, { value: 'withdraw', label: COPY.vault.withdraw }]} />
        <div className="field-head">
          <span className="label">{COPY.vault.amount}</span>
          <span className="muted small num">{mode === 'deposit' ? COPY.ticket.balance(`${fmtUsd(bal?.usdg ?? 0)} USDG`) : `${fmtUsd(pos.withdrawable)} USDG`}</span>
        </div>
        <label className={`amount${amt !== '' && bad ? ' bad' : ''}`}>
          <input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} aria-label={COPY.vault.amount} />
          <span className="suffix">USDG</span>
        </label>
        <button type="button" className="btn-primary" disabled={bad || busy} onClick={submit}>{mode === 'deposit' ? COPY.vault.deposit : COPY.vault.withdraw}</button>
      </section>
      <section className="panel tape">
        <h2 className="h-sm">{COPY.play.filters.deposit} · {COPY.play.filters.withdraw}</h2>
        {moves === null ? <div className="skel skel-sm" /> : moves.length === 0 ? <Empty text={COPY.play.empty.vault} /> : <ul className="tape-lines">{moves.map((a) => <TapeLine key={`${a.kind}-${a.seq ?? ''}-${a.owner}-${a.t}`} a={a} />)}</ul>}
      </section>
      <ul className="how muted small">{COPY.vault.how.map((l) => <li key={l}>{l}</li>)}</ul>
    </Page>
  );
}
