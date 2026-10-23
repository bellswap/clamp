// My tickets (route /me, STYLE-SPEC 8.5): open and settled segments, totals, faucet, key export and the wallet switch.
// Each card opens the ticket and its symbol the ticker page; open tickets count down in wall time. At a zero balance
// the faucet is the first action; a viewer without tickets sees the fork's recent tickets (demo traders tagged).
import { useEffect, useState } from 'react';
import { Page } from '../components/Shell';
import { TicketCompact } from '../components/TicketCard';
import { Empty, Segmented } from '../components/ui';
import { COPY } from '../copy';
import { api } from '../lib/api';
import { useApp, useTick } from '../lib/app-state';
import { fmtAddr, fmtPct, fmtSignedUsd, fmtUsd } from '../lib/format';
import { Link } from '../lib/router';
import { useToast } from '../lib/toast';
import type { TicketView } from '../lib/types';
import { burnerKey, hasInjected } from '../lib/wallet';

export function Me() {
  const { address, kind, bal, epoch, fund, connect, useBurner } = useApp();
  const toast = useToast();
  // Tagged with the address they belong to: after a wallet switch the previous wallet's tickets are never shown, even
  // when the new wallet's requests fail.
  const [mine, setMine] = useState<{ a: string; t: TicketView[] } | null>(null);
  const [seg, setSeg] = useState<'open' | 'settled'>('open');
  const [recent, setRecent] = useState<TicketView[] | null>(null);
  useTick(1000);
  const list = mine && mine.a === address ? mine.t : null;
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.tickets(address).then(
        (t) => alive && setMine({ a: address, t }),
        () => alive && setMine((cur) => (cur && cur.a === address ? cur : { a: address, t: [] })),
      );
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [address, epoch]);
  const none = list !== null && list.length === 0;
  useEffect(() => {
    if (!none) return undefined;
    let alive = true;
    const load = () => api.recentTickets(12).then((t) => alive && setRecent(t), () => alive && setRecent((cur) => cur ?? []));
    void load();
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [none, epoch]);
  const broke = bal !== null && bal.usdg <= 0;
  const open = (list ?? []).filter((t) => t.payout === null);
  const done = (list ?? []).filter((t) => t.payout !== null);
  const staked = done.reduce((a, t) => a + t.stake, 0);
  const pnl = done.reduce((a, t) => a + (t.payout ?? 0) - t.stake, 0);
  const shown = seg === 'open' ? open : done;
  const exportKey = async () => {
    try {
      await navigator.clipboard.writeText(burnerKey());
      toast('info', COPY.me.keyWarning);
    } catch {
      toast('fail', COPY.toast.failed(COPY.me.exportKey));
    }
  };
  return (
    <Page className="narrow">
      <div className="me-head">
        <div>
          <div className="mono-addr">{fmtAddr(address)}</div>
          <div className="muted small num">{bal ? `${fmtUsd(bal.usdg)} USDG · ${bal.eth.toFixed(3)} ETH` : '–'}</div>
        </div>
        <div className="me-actions">
          <button type="button" className={broke ? 'btn-primary btn-inline' : 'btn-secondary'} onClick={() => void fund()}>{COPY.play.getUsdg}</button>
          {kind === 'burner' && <button type="button" className="btn-secondary" onClick={exportKey}>{COPY.me.exportKey}</button>}
          {kind === 'burner' && hasInjected() && <button type="button" className="btn-secondary" onClick={() => void connect()}>{COPY.me.connect}</button>}
          {kind === 'injected' && <button type="button" className="btn-secondary" onClick={useBurner}>{COPY.me.useBurner}</button>}
        </div>
      </div>
      <Segmented label="Tickets" value={seg} onChange={setSeg} options={[{ value: 'open', label: `${COPY.me.open} (${open.length})` }, { value: 'settled', label: `${COPY.me.settled} (${done.length})` }]} />
      {list === null ? (
        <div className="skel" />
      ) : shown.length === 0 ? (
        <Empty text={seg === 'open' ? COPY.play.empty.yourTickets : COPY.play.empty.settled} action={<Link to="/" className="btn-secondary">{COPY.me.openOne}</Link>} />
      ) : (
        <div className="stack">{shown.map((t) => <TicketCompact key={t.id} t={t} testId="me-ticket" />)}</div>
      )}
      {done.length > 0 && <p className="muted small num">{COPY.me.totals(done.length, fmtPct(staked > 0 ? (pnl / staked) * 100 : 0, 1), `${fmtSignedUsd(pnl)} USDG`)}</p>}
      {none && (
        <section className="stack">
          <h2 className="h-sm">{COPY.me.recent}</h2>
          {recent === null ? <div className="skel" /> : recent.length === 0 ? <p className="muted small">{COPY.play.empty.recent}</p> : recent.map((t) => <TicketCompact key={t.id} t={t} owner testId="me-recent-ticket" />)}
        </section>
      )}
    </Page>
  );
}
