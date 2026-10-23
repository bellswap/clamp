// The ticker page (route /t/:symbol): a stats strip on top, the candle chart (two thirds) and the ticket panel (one
// third) at desktop widths, the tabs Your tickets, Recent on SYM and Settled below. Under 1024 px the stats compact
// into a grid, the chart is 290 px, and a sticky Long / Short bar above the tab bar opens the ticket sheet with the
// side set. ?side= preselects the side on desktop and opens the sheet on phones. The page warms the symbol on mount and
// every 30 s while visible, so the bell keeps printing it; until the market's last print is fresh the form shows
// Preparing market. Symbols without a recorded series show No price feed instead of a dead button.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CandleChart, type ChartLine } from '../../components/chart/CandleChart';
import { Monogram } from '../../components/Monogram';
import { Page } from '../../components/Shell';
import { levelsOf, TicketForm, effectiveLev } from '../../components/ticket/TicketForm';
import { Arrow, Empty } from '../../components/ui';
import { COPY } from '../../copy';
import { clockNow, resolveTicker, useApp, useTick } from '../../lib/app-state';
import { fmtAddr, fmtClock, fmtPct, fmtPrice, fmtSignedUsd, fmtUsd } from '../../lib/format';
import { maxPayoutMove, movePct, payoutAt, priceAtMove } from '../../lib/payout';
import { Link, navigate } from '../../lib/router';
import { isTf, type Tf } from '../../lib/ticker/candles';
import { TCOPY } from '../../lib/ticker/copy';
import { useDraft, useMedia, useTickerMarket, useTickerTickets, useWarm, type TabsData } from '../../lib/ticker/hooks';
import { anchorsOf, etaWall, fmtCountdownWall, fmtEta, fmtSettleTime, marketNow, type EtaAnchors } from '../../lib/ticker/settles-at';
import type { TickerMarket, TickerTicket } from '../../lib/ticker/ticker-api';
import { expiryOf } from '../../lib/horizon';
import { TicketSheet } from '../TicketSheet';
import './ticker.css';

const TF_KEY = 'bellswap.v2.ticker.tf';
function storedTf(): Tf {
  try {
    const v = globalThis.localStorage?.getItem(TF_KEY);
    return isTf(v) ? v : '5m';
  } catch {
    return '5m';
  }
}
function storeTf(tf: Tf): void {
  try {
    globalThis.localStorage?.setItem(TF_KEY, tf);
  } catch {
    /* storage blocked */
  }
}

function DemoTag() {
  return <span className="demo-tag" data-testid="demo-tag" title={TCOPY.demoTitle}>{TCOPY.demo}</span>;
}

function SideChip({ t }: { t: TickerTicket }) {
  return <span className={`chip ${t.long ? 'up' : 'down'}`}>{TCOPY.sideLev(t.long ? COPY.ticket.long : COPY.ticket.short, t.leverage)}</span>;
}

function Stat({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`tk-stat${className ? ` ${className}` : ''}`}>
      <span className="tk-stat-l">{label}</span>
      <span className="tk-stat-v num">{children}</span>
    </div>
  );
}

function Stats({ sym, name, m, now, rate }: { sym: string; name: string; m: TickerMarket | null; now: number; rate: number }) {
  const since = m && m.price !== null && m.sessionOpen ? (m.price / m.sessionOpen - 1) * 100 : null;
  const anchors = anchorsOf(m);
  const at = marketNow(now, anchors);
  const close = expiryOf(0, at);
  const eta = etaWall(close, at, rate, anchors);
  const next = `${fmtSettleTime(close, at)}${eta !== null ? ` · ${fmtEta(eta)}` : ''}`;
  const dir = since === null ? '' : since < 0 ? 'down' : 'up';
  return (
    <section className="tk-stats" data-testid="ticker-stats" aria-label={sym}>
      <div className="tk-id">
        <Monogram symbol={sym} size={40} />
        <div className="tk-id-t">
          <span className="tk-sym">{sym}</span>
          <span className="tk-name">{name}</span>
        </div>
        <div className="tk-id-px">
          <span className="tk-px num">{fmtPrice(m?.price)}</span>
          <span className={`tk-chg num ${dir}`}>{since !== null && <Arrow up={since >= 0} />}{fmtPct(since)}</span>
        </div>
      </div>
      <div className="tk-cells">
        <Stat label={TCOPY.lastPrint} className="tk-wide-only">{fmtPrice(m?.lastRound?.price ?? m?.price)}</Stat>
        <Stat label={TCOPY.sinceOpen} className={`tk-wide-only ${dir}`}>{fmtPct(since)}</Stat>
        <Stat label={TCOPY.sessionHigh}>{fmtPrice(m?.sessionHigh)}</Stat>
        <Stat label={TCOPY.sessionLow}>{fmtPrice(m?.sessionLow)}</Stat>
        <Stat label={TCOPY.openOn(sym)}>{m ? TCOPY.ofCap(fmtUsd(Math.round(m.oi)), fmtUsd(m.oiCap)) : '–'}</Stat>
        <Stat label={TCOPY.split} className="tk-wide-only"><span className="up">{m ? fmtUsd(Math.round(m.longOpen)) : '–'}</span> / <span className="down">{m ? fmtUsd(Math.round(m.shortOpen)) : '–'}</span></Stat>
        <Stat label={TCOPY.exposure}>{m ? `${fmtUsd(Math.round(m.exposure))} USDG` : '–'}</Stat>
        <Stat label={TCOPY.nextSettlement}>{next}</Stat>
        <Stat label={TCOPY.clock}>{fmtClock(now)}</Stat>
      </div>
    </section>
  );
}

type TabKey = 'yours' | 'recent' | 'settled';

function Trader({ t, me }: { t: TickerTicket; me: string }) {
  const you = t.owner.toLowerCase() === me.toLowerCase();
  return (
    <span className="tk-trader">
      <Link to={`/activity?a=${t.owner}`} className="mono-addr">{fmtAddr(t.owner)}</Link>
      {you && <span className="muted small">{TCOPY.you}</span>}
      {t.bot && <DemoTag />}
    </span>
  );
}

function Tabs({ sym, data, price, now, rate, anchors, me }: { sym: string; data: TabsData; price: number | null; now: number; rate: number; anchors: EtaAnchors | null; me: string }) {
  const [tab, setTab] = useState<TabKey | null>(null);
  const yoursN = data.yours?.length ?? null;
  // First answer decides the opening tab: the viewer's own tickets when there are any, else the recent ones.
  useEffect(() => {
    if (tab === null && yoursN !== null) setTab(yoursN > 0 ? 'yours' : 'recent');
  }, [tab, yoursN]);
  const cur: TabKey = tab ?? 'yours';
  const rows = data[cur];
  const empty = cur === 'yours' ? TCOPY.emptyYours : cur === 'recent' ? TCOPY.emptyRecent(sym) : TCOPY.emptySettled;
  const labels: Record<TabKey, string> = { yours: `${TCOPY.tabs.yours}${yoursN ? ` (${yoursN})` : ''}`, recent: TCOPY.tabs.recent(sym), settled: TCOPY.tabs.settled };
  return (
    <section className="tk-tabs">
      <div className="tk-tabbar" role="tablist">
        {(['yours', 'recent', 'settled'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={cur === k} data-testid={`tab-${k}`} className={`tk-tab${cur === k ? ' on' : ''}`} onClick={() => setTab(k)}>{labels[k]}</button>
        ))}
      </div>
      {rows === null ? (
        <div className="skel tk-skel" />
      ) : rows.length === 0 ? (
        <Empty text={empty} />
      ) : (
        <ul className={`tk-rows tk-rows-${cur}`}>
          {cur === 'yours' && (
            <li className="tk-row tk-head" aria-hidden="true">
              <span>{TCOPY.col.side}</span><span>{TCOPY.col.stake}</span><span>{TCOPY.col.entry}</span><span>{TCOPY.col.now}</span><span>{TCOPY.col.move}</span><span>{TCOPY.col.payoutNow}</span><span>{TCOPY.col.settles}</span><span />
            </li>
          )}
          {cur === 'recent' && (
            <li className="tk-row tk-head" aria-hidden="true">
              <span>{TCOPY.col.time}</span><span>{TCOPY.col.trader}</span><span>{TCOPY.col.side}</span><span>{TCOPY.col.stake}</span><span>{TCOPY.col.entry}</span><span>{TCOPY.col.settles}</span>
            </li>
          )}
          {cur === 'settled' && (
            <li className="tk-row tk-head" aria-hidden="true">
              <span>{TCOPY.col.time}</span><span>{TCOPY.col.trader}</span><span>{TCOPY.col.side}</span><span>{TCOPY.col.entry}</span><span>{TCOPY.col.print}</span><span>{TCOPY.col.move}</span><span>{TCOPY.col.payout}</span>
            </li>
          )}
          {rows.map((t) => {
            if (cur === 'yours') {
              const settled = t.payout !== null;
              const px = settled ? t.settlePrice : price;
              const mv = px !== null ? movePct(t.entryPrice, px) : null;
              const pay = settled ? t.payout : px !== null ? payoutAt(t.net, t.leverage, t.entryPrice, px, t.long) : null;
              return (
                <li key={t.id} className="tk-row" data-testid="tk-row">
                  <span><SideChip t={t} /></span>
                  <span className="num" data-l={TCOPY.col.stake}>{fmtUsd(t.stake)} USDG</span>
                  <span className="num" data-l={TCOPY.col.entry}>{fmtPrice(t.entryPrice)}</span>
                  <span className="num" data-l={TCOPY.col.now}>{fmtPrice(px)}</span>
                  <span className={`num ${mv === null ? '' : mv < 0 ? 'down' : 'up'}`} data-l={TCOPY.col.move}>{fmtPct(mv)}</span>
                  <span className={`num ${pay === null ? '' : pay >= t.stake ? 'up' : 'down'}`} data-l={TCOPY.col.payoutNow}>{pay === null ? '–' : `${fmtUsd(pay)} USDG`}</span>
                  <span className="num muted" data-l={TCOPY.col.settles}>{settled ? TCOPY.tabs.settled : fmtCountdownWall(etaWall(t.expiry, now, rate, anchors))}</span>
                  <span className="tk-act"><Link to={`/ticket/${t.id}`} className="tk-watch">{TCOPY.watch}</Link></span>
                </li>
              );
            }
            if (cur === 'recent') {
              return (
                <li key={t.id} className="tk-row" data-testid="tk-row">
                  <span className="num muted">{fmtClock(t.openedAt).slice(0, 5)}</span>
                  <Trader t={t} me={me} />
                  <span><SideChip t={t} /></span>
                  <span className="num" data-l={TCOPY.col.stake}>{fmtUsd(t.stake)} USDG</span>
                  <span className="num" data-l={TCOPY.col.entry}>{fmtPrice(t.entryPrice)}</span>
                  <span className="num muted" data-l={TCOPY.col.settles}>{fmtSettleTime(t.expiry, now)}</span>
                </li>
              );
            }
            const mv = t.settlePrice !== null ? movePct(t.entryPrice, t.settlePrice) : null;
            const pnl = t.payout === null ? null : t.payout - t.stake;
            return (
              <li key={t.id} className="tk-row" data-testid="tk-row">
                <span className="num muted">{fmtClock(t.settledAt ?? t.expiry).slice(0, 5)}</span>
                <Trader t={t} me={me} />
                <span><SideChip t={t} /></span>
                <span className="num" data-l={TCOPY.col.entry}>{fmtPrice(t.entryPrice)}</span>
                <span className="num" data-l={TCOPY.col.print}>{fmtPrice(t.settlePrice)}</span>
                <span className={`num ${mv === null ? '' : mv < 0 ? 'down' : 'up'}`} data-l={TCOPY.col.move}>{fmtPct(mv)}</span>
                <span className={`num ${pnl === null ? '' : pnl >= 0 ? 'up' : 'down'}`} data-l={TCOPY.col.payout}>{pnl === null ? '–' : `${fmtSignedUsd(pnl)} USDG`}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function How() {
  return (
    <details className="tk-how">
      <summary>{TCOPY.howTitle}</summary>
      <ol>{TCOPY.how.map((l) => <li key={l}>{l}</li>)}</ol>
    </details>
  );
}

export function TickerPage({ raw, side }: { raw: string; side: 'long' | 'short' | null }) {
  const { bySymbol, catalog, clock, address, epoch } = useApp();
  useTick(1000);
  const entry = resolveTicker(bySymbol, raw);
  const sym = entry?.symbol ?? null;
  const wide = useMedia('(min-width: 1024px)');
  const { market, loaded, failed } = useTickerMarket(sym, epoch);
  const covered = !!market && market.covered && market.tradable;
  useWarm(sym, covered);
  const tabs = useTickerTickets(sym, address, epoch);
  const draft = useDraft(side);
  const [tf, setTf] = useState<Tf>(storedTf);
  const [sheet, setSheet] = useState(false);
  const now = clockNow(clock);
  const rate = clock.speed;

  // ?side= on a phone opens the sheet with that side once the market is known.
  useEffect(() => {
    if (!wide && side && covered) setSheet(true);
  }, [wide, side, covered]);
  useEffect(() => {
    if (wide) setSheet(false);
  }, [wide]);

  const price = market?.price ?? null;
  const lines = useMemo<ChartLine[]>(() => {
    const out: ChartLine[] = [];
    for (const t of tabs.yours ?? []) {
      if (t.payout !== null) continue;
      out.push({ price: t.entryPrice, title: TCOPY.sideLev(t.long ? COPY.ticket.long : COPY.ticket.short, t.leverage), tone: 'muted', style: 'dashed' });
    }
    if (price !== null) {
      const lev = effectiveLev(draft.lev, market?.maxLeverage ?? 20);
      const lv = levelsOf({ ...draft, lev }, price, market?.feeBps ?? 100);
      if (lv.paysNothing !== null) out.push({ price: lv.paysNothing, title: TCOPY.paysNothing, tone: 'down', style: 'dotted' });
      out.push({ price: priceAtMove(price, maxPayoutMove(lev, draft.long)), title: TCOPY.maxPayoutAt, tone: 'muted', style: 'dotted' });
    }
    return out;
    // the preview follows the price at whole cents only, so the lines do not churn on every poll
  }, [tabs.yours, price === null ? null : Math.round(price * 100), draft.long, draft.lev, draft.stakeStr, market?.maxLeverage, market?.feeBps]);

  const pickTf = (t: Tf) => {
    setTf(t);
    storeTf(t);
  };

  if (!entry) {
    return (
      <Page className="tk-page">
        <div data-testid="ticker-page">
          {catalog === null ? <div className="skel" /> : <Empty text={TCOPY.unknown} action={<Link to="/" className="btn-secondary">{TCOPY.board}</Link>} />}
        </div>
      </Page>
    );
  }

  // A failed request keeps the layout (the next poll retries); only an answer without a series is No price feed.
  const noFeed = loaded && !failed && !covered;
  return (
    <Page className={`tk-page${wide ? '' : ' tk-phone'}`}>
      <div className="tk" data-testid="ticker-page">
        <nav className="tk-crumb"><Link to="/" className="link-btn">{TCOPY.board}</Link><span className="muted small" aria-hidden="true">/</span><span className="small">{entry.symbol}</span></nav>
        <Stats sym={entry.symbol} name={entry.name} m={market} now={now} rate={rate} />
        {noFeed ? (
          <div className="tk-nofeed" data-testid="no-price-feed">
            <p className="tk-nofeed-t">{TCOPY.noFeed}</p>
            <Link to="/" className="btn-secondary">{TCOPY.board}</Link>
          </div>
        ) : (
          <div className="tk-grid">
            <div className="tk-left">
              <CandleChart symbol={entry.symbol} tf={tf} onTf={pickTf} lines={lines} compact={!wide} />
              {wide && <How />}
            </div>
            {wide && (
              <aside className="tk-panel">
                <TicketForm entry={entry} market={market} draft={draft} variant="panel" onOpened={(id) => navigate(`/ticket/${id}`)} />
              </aside>
            )}
          </div>
        )}
        {!noFeed && <Tabs sym={entry.symbol} data={tabs} price={price} now={now} rate={rate} anchors={anchorsOf(market)} me={address} />}
        {!wide && !noFeed && <How />}
      </div>
      {!wide && !noFeed && (
        <div className="tk-sticky" role="group" aria-label="Side">
          <button type="button" className="tk-sticky-btn up" data-testid="sticky-long" disabled={!covered} onClick={() => { draft.setLong(true); setSheet(true); }}>{COPY.ticket.long}</button>
          <button type="button" className="tk-sticky-btn down" data-testid="sticky-short" disabled={!covered} onClick={() => { draft.setLong(false); setSheet(true); }}>{COPY.ticket.short}</button>
        </div>
      )}
      {!wide && sheet && <TicketSheet raw={entry.symbol} side={draft.long ? 'long' : 'short'} draft={draft} market={market} onClose={() => setSheet(false)} />}
    </Page>
  );
}
