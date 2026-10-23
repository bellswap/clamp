// Watch and verdict (route /ticket/:id, STYLE-SPEC 8.3 and 8.4). While open: the playground price polled from the bell
// (GET /markets/:symbol, which also keeps the symbol in the print set), the payout meter, the countdown in wall time to
// the expiry on the playground clock. Settlement is read from the bell (GET /tickets/:id every 2 s), not from chain
// logs, so a venue full of viewers costs no eth_getLogs. At settlement: the print, the move, the payout, the accent
// ring, and a share card rendered to PNG on a canvas (copy and download). The symbol links to the ticker page.
import { useEffect, useRef, useState } from 'react';
import { Monogram } from '../components/Monogram';
import { PayoutMeter } from '../components/PayoutMeter';
import { Page } from '../components/Shell';
import { SideChip } from '../components/TicketCard';
import { DemoTag, Empty, Icon } from '../components/ui';
import { COPY, PRODUCT_NAME } from '../copy';
import { api } from '../lib/api';
import { clockNow, useApp, useTick } from '../lib/app-state';
import { bellWallLeft, fmtAddr, fmtClock, fmtCountdown, fmtPct, fmtPrice, fmtSignedUsd, fmtUsd, wallSecondsUntil } from '../lib/format';
import { horizonName } from '../lib/horizon';
import { useModal } from '../lib/modal';
import { movePct, payoutAt } from '../lib/payout';
import { Link, navigate } from '../lib/router';
import { canvasBlob, drawShareCard, loadShareFont } from '../lib/share-card';
import { useToast } from '../lib/toast';
import type { ActivityItem, BellEta, TicketView } from '../lib/types';

const TICKET_POLL_MS = 2000;
const PRICE_POLL_MS = 3000;

function useCountUp(target: number, from: number, run: boolean): number {
  const [v, setV] = useState(run ? from : target);
  useEffect(() => {
    if (!run) {
      setV(target);
      return undefined;
    }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setV(target);
      return undefined;
    }
    const t0 = performance.now();
    const delay = 260;
    const dur = 380;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, Math.max(0, (t - t0 - delay) / dur));
      const e = 1 - (1 - k) ** 3;
      setV(from + (target - from) * e);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, from, run]);
  return v;
}

function ShareSheet({ t, onClose }: { t: TicketView; onClose: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useModal(dialog);
  const [src, setSrc] = useState<string | null>(null);
  const toast = useToast();
  const link = `${location.origin}/t/${t.symbol}?side=${t.long ? 'short' : 'long'}`;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    let alive = true;
    void loadShareFont().then(() => {
      if (!alive) return;
      drawShareCard(c, t, link);
      setSrc(c.toDataURL('image/png'));
    });
    return () => {
      alive = false;
    };
  }, [t, link]);
  const copyImage = async () => {
    if (!src) return; // the card is drawn after the font loads; until then the canvas is blank
    try {
      const blob = await canvasBlob(ref.current!);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('ok', COPY.toast.copied);
    } catch {
      toast('fail', COPY.toast.failed(COPY.watch.copyImage));
    }
  };
  const download = () => {
    if (!src) return;
    const a = document.createElement('a');
    a.href = src;
    a.download = `bellswap-${t.symbol}-${t.id}.png`;
    a.click();
    toast('ok', COPY.toast.downloaded);
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/ticket/${t.id}`);
      toast('ok', COPY.toast.copied);
    } catch {
      toast('fail', COPY.toast.failed(COPY.watch.copyLink));
    }
  };
  return (
    <div ref={dialog} className="sheet-wrap" role="dialog" aria-modal="true" aria-label={COPY.watch.share}>
      <button type="button" className="scrim" aria-label={COPY.ticket.close} onClick={onClose} />
      <div className="sheet share-sheet">
        <div className="handle" aria-hidden="true" />
        <div className="sheet-body">
          <div className="sheet-head">
            <span className="h-sm">{COPY.watch.share}</span>
            <button type="button" className="icon-btn" onClick={onClose} aria-label={COPY.ticket.close}><Icon name="close" /></button>
          </div>
          <canvas ref={ref} className="hidden-canvas" />
          {src && <img src={src} alt={`${PRODUCT_NAME} ${t.symbol} share card`} className="share-img" />}
          <div className="share-actions">
            <button type="button" className="btn-secondary" onClick={copyImage} disabled={!src}><Icon name="copy" />{COPY.watch.copyImage}</button>
            <button type="button" className="btn-secondary" onClick={download} disabled={!src}><Icon name="download" />{COPY.watch.download}</button>
            <button type="button" className="btn-secondary" onClick={copyLink}><Icon name="link" />{COPY.watch.copyLink}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Watch({ id }: { id: string }) {
  const { clock, bump } = useApp();
  useTick(1000);
  const [t, setT] = useState<TicketView | null | undefined>(undefined);
  const [px, setPx] = useState<number | null>(null);
  const [eta, setEta] = useState<BellEta | null>(null);
  const [acts, setActs] = useState<ActivityItem[]>([]);
  const [share, setShare] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const firstSeenSettled = useRef<boolean | null>(null);
  const settled = !!t && t.payout !== null;

  useEffect(() => {
    let alive = true;
    const load = () => api.ticket(id).then((x) => alive && setT(x), () => alive && setT((cur) => (cur === undefined ? null : cur)));
    void load();
    const timer = settled ? undefined : setInterval(load, TICKET_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id, settled]);

  useEffect(() => {
    if (!t || settled) return undefined;
    let alive = true;
    const sym = t.symbol;
    const fromRounds = () => api.prices(sym).then((r) => alive && r.length && setPx(r[r.length - 1]!.price), () => undefined);
    const load = () =>
      api.market(sym).then(
        (m) => {
          if (!alive) return;
          setEta(m?.eta ?? null);
          if (m?.price) setPx(m.price);
          else void fromRounds();
        },
        () => void fromRounds(),
      );
    void load();
    const timer = setInterval(load, PRICE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [t?.symbol, settled]);

  useEffect(() => {
    if (!t) return;
    api.activity({ symbol: t.symbol, kinds: ['open', 'settle'], limit: 8 }).then((a) => setActs(a.filter((x) => x.symbol === t.symbol && x.id !== t.id && (x.kind === 'open' || x.kind === 'settle')).slice(0, 3)), () => undefined);
  }, [t?.symbol, settled]);

  // The verdict reveal plays when the print arrives while watching, not when an old verdict is opened.
  useEffect(() => {
    if (t === undefined || t === null) return;
    if (firstSeenSettled.current === null) firstSeenSettled.current = settled;
    if (settled && firstSeenSettled.current === false && !revealed) {
      setRevealed(true);
      bump();
    }
  }, [t, settled, revealed, bump]);

  const animate = revealed;
  const payoutShown = useCountUp(t?.payout ?? 0, t?.stake ?? 0, animate);

  if (t === undefined) return <Page><Empty text={COPY.watch.loading} /></Page>;
  if (t === null) return <Page><Empty text={COPY.watch.notFound} action={<Link to="/" className="btn-secondary">{COPY.home}</Link>} /></Page>;

  const now = clockNow(clock);
  // A paused replay has rate 0: the clock holds and the countdown shows the playground time left, unchanging.
  // With the replay schedule the night jump counts as one tick, not as hours of playground time. The bell's own tick
  // count wins when the expiry is one of its three (a session ticket always is): only the bell knows a short session.
  const paused = clock.speed <= 0;
  const speed = paused ? 1 : Math.max(1, clock.speed);
  const sched = paused ? null : clock.sched ?? null;
  const wallLeft = (paused ? null : bellWallLeft(t.expiry, eta, Date.now())) ?? wallSecondsUntil(t.expiry, now, speed, sched);
  const total = Math.max(1, wallSecondsUntil(t.expiry, t.openedAt, speed, sched));
  const progress = settled ? 0 : Math.min(1, wallLeft / total);
  const live = px ?? t.entryPrice;
  const payNow = payoutAt(t.net, t.leverage, t.entryPrice, live, t.long);
  const cap = t.net * t.leverage;
  const print = t.settlePrice ?? live;
  const mv = movePct(t.entryPrice, settled ? print : live);
  const won = settled && (t.payout ?? 0) > t.stake;

  return (
    <Page className="watch-page" testId="watch-page">
      <div className="watch-top">
        <button type="button" className="icon-btn" onClick={() => (history.length > 1 ? history.back() : navigate('/'))} aria-label={COPY.watch.back}><Icon name="back" /></button>
        <span className="muted num">{COPY.watch.ticketNo(t.id)}</span>
      </div>
      <article className={`tcard tcard-big${settled ? ` verdict ${won ? 'won' : 'lost'}` : ''}${animate ? ' reveal' : ''}`} {...(settled ? { 'data-testid': 'watch-verdict' } : {})}>
        {!settled && <div className="progress" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />}
        <div className="call">
          <Monogram symbol={t.symbol} size={40} />
          <Link to={`/t/${t.symbol}`} className="call-sym call-sym-link">{t.symbol}</Link>
          <SideChip long={t.long} />
          <span className="call-meta num">{t.leverage}x · {fmtUsd(t.stake)} USDG{horizonName(t.horizon) ? ` · ${horizonName(t.horizon)}` : ''}</span>
          {t.bot && <DemoTag />}
        </div>
        <div className="perf" aria-hidden="true" />
        {!settled ? (
          <div className="tcard-low watch-low">
            <div className="countdown num" aria-label="Time left">{wallLeft > 0 ? fmtCountdown(wallLeft) : '00:00'}</div>
            {wallLeft <= 0 && <p className="muted center">{COPY.watch.settling}</p>}
            <div className="trio num">
              <span><span className="label">{COPY.watch.entry}</span> {fmtPrice(t.entryPrice)}</span>
              <span><span className="label">{COPY.watch.now}</span> {fmtPrice(live)}</span>
              <span>{fmtPct(mv)}</span>
            </div>
            <PayoutMeter payout={payNow} stake={t.stake} cap={cap} big />
            <p className="muted small center num">{fmtClock(now)} UTC · {paused ? COPY.watch.paused : `${speed}x`}</p>
          </div>
        ) : (
          <div className="tcard-low verdict-low">
            <div className="print-row">
              <span className="label">{COPY.watch.print}</span>
              <span className="print num">{fmtPrice(t.settlePrice)}</span>
              <span className="muted small num">{t.settledAt ? `${fmtClock(t.expiry)} · ${COPY.watch.source}` : COPY.watch.source}</span>
            </div>
            <div className="kv"><span className="label">{COPY.watch.move}</span><span className="num">{fmtPct(mv)}</span></div>
            <div className="kv payout-row">
              <span className="label">{COPY.watch.payout}</span>
              <span className={`payout-fig num ${won ? 'up' : 'down'}`}>{fmtUsd(payoutShown)} USDG</span>
            </div>
            <p className="muted small num right">({fmtSignedUsd((t.payout ?? 0) - t.stake)} USDG)</p>
            {t.status === 'refunded' && <p className="muted small">{COPY.watch.refunded}</p>}
            <div className="verdict-actions">
              <button type="button" className="btn-primary" onClick={() => setShare(true)}>{COPY.watch.share}</button>
              <Link to={`/t/${t.symbol}?side=${t.long ? 'long' : 'short'}`} className="btn-secondary">{COPY.watch.again}</Link>
            </div>
          </div>
        )}
      </article>
      <p className="sr-only" role="status" aria-live="polite">
        {settled ? COPY.watch.settled(fmtUsd(t.payout ?? 0), t.status === 'refunded' ? 'refunded' : (won ? COPY.watch.won : COPY.watch.lost).toLowerCase()) : ''}
      </p>
      {acts.length > 0 && (
        <ul className="mini-acts">
          {acts.map((a) => (
            <li key={`${a.kind}-${a.id}`}>
              <Link to={`/ticket/${a.id}`} className="mini-act num">
                <span>{fmtClock(a.t)}</span>
                <span className="mini-own"><span className="mono-addr">{fmtAddr(a.owner)}</span>{a.bot && <DemoTag />}</span>
                <span>{a.long ? COPY.ticket.long : COPY.ticket.short} {a.leverage}x</span>
                <span>{a.kind === 'open' ? COPY.activity.opened : `${fmtUsd(a.payout ?? 0)}`}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {share && settled && <ShareSheet t={t} onClose={() => setShare(false)} />}
    </Page>
  );
}
