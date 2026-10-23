// The board (route /, STYLE-SPEC 8.1) on GET /markets: every catalog symbol with its playground price (the value the
// next print carries, so the board and a new ticket's entry agree), the move since the session open, the session
// sparkline and the open-ticket count. Sort Most active, Movers or A to Z and search, kept in the URL hash. Long and
// Short on every tradable row go to the ticker page with the side set; the rest say No price feed. Above the list the
// playground strip (tickets, open, LPs, vault, demo traders); on desktop a right rail with the viewer's open tickets,
// the vault and the live tape (GET /activity?limit=12).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Monogram } from '../components/Monogram';
import { Page } from '../components/Shell';
import { TicketCompact } from '../components/TicketCard';
import { Arrow, Empty, Icon, LAZY_ROOT_ATTR, Segmented, Spark, TapeLine } from '../components/ui';
import { COPY } from '../copy';
import { api, marketsFromCatalog } from '../lib/api';
import { useApp } from '../lib/app-state';
import { fmtPct, fmtPrice, fmtUsd } from '../lib/format';
import { filterMarkets, MARKET_SORTS, moveSinceOpen, sortMarkets, type MarketSort } from '../lib/normalize';
import { EVENT as NAVIGATE_EVENT, Link, navigate } from '../lib/router';
import type { HomeSeries } from '../lib/spark-paths';
import type { ActivityItem, BellState, MarketRow, MarketsView, TicketView, VaultView } from '../lib/types';
import { TicketSheet } from './TicketSheet';

const MARKETS_POLL_MS = 5000;
const TAPE_POLL_MS = 4000;
const STRIP_POLL_MS = 10_000;

interface BoardHash { sort: MarketSort; q: string }

/** "#sort=move&q=nv": defaults (Most active, no search) are left out, so an empty hash is the default board. */
export function parseBoardHash(hash: string): BoardHash {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const sort = p.get('sort');
  return { sort: MARKET_SORTS.includes(sort as MarketSort) ? (sort as MarketSort) : 'active', q: (p.get('q') ?? '').slice(0, 40) };
}
export function toBoardHash(s: BoardHash): string {
  const p = new URLSearchParams();
  if (s.sort !== 'active') p.set('sort', s.sort);
  if (s.q.trim()) p.set('q', s.q.trim());
  const out = p.toString();
  return out ? `#${out}` : '';
}

function useBoardHash(): [BoardHash, (p: Partial<BoardHash>) => void] {
  const [s, setS] = useState(() => parseBoardHash(location.hash));
  useEffect(() => {
    const on = () => setS(parseBoardHash(location.hash));
    // The router's own navigation (pushState, no hashchange) also resets the state from the new hash.
    window.addEventListener('hashchange', on);
    window.addEventListener('popstate', on);
    window.addEventListener(NAVIGATE_EVENT, on);
    return () => {
      window.removeEventListener('hashchange', on);
      window.removeEventListener('popstate', on);
      window.removeEventListener(NAVIGATE_EVENT, on);
    };
  }, []);
  const update = (p: Partial<BoardHash>) => {
    const next = { ...s, ...p };
    setS(next);
    history.replaceState(null, '', `${location.pathname}${location.search}${toBoardHash(next)}`);
  };
  return [s, update];
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** Poll `load` every `ms` while mounted and the tab is visible (a hidden tab polls again when it shows); the last good
 *  answer stays on a failed poll, and `onFail` hears every failure. */
function usePoll<T>(load: () => Promise<T>, ms: number, onFail?: () => void): T | null {
  const [v, setV] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    const run = () => {
      if (hidden()) return;
      load().then((x) => alive && setV(x), () => alive && onFail?.());
    };
    run();
    const t = setInterval(run, ms);
    const vis = () => !hidden() && run();
    document.addEventListener('visibilitychange', vis);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);
  return v;
}

/** The rows in the order of the last explicit sort: polls update the figures in place and only a sort or search change
 *  (or a new visit) reorders, so rows do not move under the pointer while bots open tickets. New symbols go last. */
export function stableOrder(rows: MarketRow[], prev: readonly string[] | null): MarketRow[] {
  if (!prev) return rows;
  const at = new Map(prev.map((s, i) => [s, i]));
  const known = rows.filter((r) => at.has(r.symbol)).sort((a, b) => at.get(a.symbol)! - at.get(b.symbol)!);
  return [...known, ...rows.filter((r) => !at.has(r.symbol))];
}

/** The session sparkline of a row: the session closes with the playground price as the last point, based on the open. */
export function seriesOf(m: MarketRow): HomeSeries | null {
  const pts = m.price !== null ? [...m.spark, m.price] : m.spark;
  if (pts.length < 2) return null;
  return { pts, chgPct: moveSinceOpen(m), last: m.price, base: m.sessionOpen, k: 1 };
}

function Row({ m, name, s }: { m: MarketRow; name: string; s: HomeSeries | null }) {
  const chg = moveSinceOpen(m);
  const dir = chg === null ? '' : chg < 0 ? 'down' : 'up';
  const go = (side?: 'long' | 'short') => navigate(`/t/${m.symbol}${side ? `?side=${side}` : ''}`);
  return (
    <li className={`row${m.tradable ? '' : ' row-off'}`} data-testid={`board-row-${m.symbol}`} {...{ [LAZY_ROOT_ATTR]: '' }}>
      <button type="button" className="row-body" onClick={() => go()} aria-label={`${m.symbol}, ${name}`}>
        <Monogram symbol={m.symbol} />
        <span className="row-id">
          <span className="row-sym">{m.symbol}</span>
          <span className="row-name">{name}</span>
        </span>
        <Spark series={s} className="row-spark" />
        <span className="row-px">
          <span className="num">{fmtPrice(m.price)}</span>
          <span className={`num row-chg ${dir}`}>
            {chg !== null && <Arrow up={chg >= 0} />}
            {fmtPct(chg)}
          </span>
        </span>
        <span className="row-oc">{m.openCount > 0 && <span className="ochip num">{COPY.play.strip.open} {m.openCount}</span>}</span>
      </button>
      <span className="row-act">
        {m.tradable ? (
          <>
            <button type="button" className="btn-side up" onClick={() => go('long')}>{COPY.board.long}</button>
            <button type="button" className="btn-side down" onClick={() => go('short')}>{COPY.board.short}</button>
          </>
        ) : (
          <span className="row-nofeed muted">{COPY.play.noFeed}</span>
        )}
      </span>
    </li>
  );
}

function Strip({ state, vault }: { state: BellState | null; vault: VaultView | null }) {
  const c = state?.counts ?? {};
  const cell = (label: string, v: string) => (
    <div className="strip-cell">
      <dt className="label">{label}</dt>
      <dd className="num">{v}</dd>
    </div>
  );
  const n = (k: string) => (c[k] !== undefined ? fmtUsd(c[k]) : '–');
  return (
    <dl className="strip" aria-label={COPY.net.forknet}>
      {cell(COPY.play.strip.tickets, n('tickets'))}
      {cell(COPY.play.strip.open, n('open'))}
      {cell(COPY.play.strip.lps, c.lps !== undefined ? n('lps') : vault ? fmtUsd(vault.lpCount) : '–')}
      {cell(COPY.play.strip.vaultHolds, vault ? `${fmtUsd(Math.round(vault.assets))} USDG` : '–')}
      {cell(COPY.play.strip.bots, n('bots'))}
    </dl>
  );
}

function Tape({ items, n, className }: { items: ActivityItem[] | null; n: number; className?: string }) {
  return (
    <section className={`panel tape${className ? ` ${className}` : ''}`}>
      <h2 className="h-sm"><Link to="/activity">{COPY.nav.activity}</Link></h2>
      {items === null ? <div className="skel skel-sm" /> : items.length === 0 ? <p className="muted small">{COPY.play.empty.activity}</p> : <ul className="tape-lines">{items.slice(0, n).map((a, i) => <TapeLine key={a.seq !== undefined ? `s${a.seq}` : `${a.kind}-${a.id}-${a.owner}-${a.t}-${i}`} a={a} />)}</ul>}
    </section>
  );
}

function Rail({ vault, tape }: { vault: VaultView | null; tape: ActivityItem[] | null }) {
  const { address, epoch } = useApp();
  const [open, setOpen] = useState<TicketView[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.tickets(address).then((t) => alive && setOpen(t.filter((x) => x.payout === null).slice(0, 4)), () => alive && setOpen([]));
    void load();
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [address, epoch]);
  const used = vault && vault.assets > 0 ? (vault.reserved / vault.assets) * 100 : 0;
  return (
    <aside className="rail">
      <section className="panel">
        <h2 className="h-sm">{COPY.board.yourOpen}</h2>
        {open === null ? <div className="skel skel-sm" /> : open.length === 0 ? <p className="muted small">{COPY.board.noOpen}</p> : <div className="stack">{open.map((t) => <TicketCompact key={t.id} t={t} />)}</div>}
      </section>
      {vault && (
        <section className="panel">
          <h2 className="h-sm"><Link to="/vault">{COPY.nav.vault}</Link></h2>
          <div className="kv"><span className="muted">{COPY.play.strip.vaultHolds}</span><span className="num">{fmtUsd(Math.round(vault.assets))}</span></div>
          <div className="kv"><span className="muted">{COPY.vault.free}</span><span className="num">{fmtUsd(Math.round(vault.free))}</span></div>
          <div className="stackbar" aria-hidden="true"><span style={{ width: `${used}%` }} /></div>
        </section>
      )}
      <Tape items={tape} n={12} />
    </aside>
  );
}

/** `sheet` and `side` come from /t/:symbol while the App still routes it to the board (before the ticker page owns that
 *  route): the ticket sheet then opens over the board, so Long, Short and the row body always lead to a ticket. */
export function Board({ sheet = null, side = null }: { sheet?: string | null; side?: 'long' | 'short' | null } = {}) {
  const { bySymbol, catalog } = useApp();
  const [st, set] = useBoardHash();
  // GET /markets failing before its first answer (network error or 5xx; a 404 already falls back inside the client):
  // the board lists the catalog instead of skeleton rows.
  const [failed, setFailed] = useState(false);
  const live = usePoll<MarketsView>(() => api.markets(), MARKETS_POLL_MS, () => setFailed(true));
  const [fallback, setFallback] = useState<MarketsView | null>(null);
  useEffect(() => {
    if (!failed || live || !catalog) return undefined;
    let alive = true;
    marketsFromCatalog(catalog, (s) => api.prices(s)).then((v) => alive && setFallback(v), () => undefined);
    return () => {
      alive = false;
    };
  }, [failed, live === null, catalog]);
  const view = live ?? fallback;
  const state = usePoll<BellState>(() => api.state(), STRIP_POLL_MS);
  const vault = usePoll<VaultView>(() => api.vault(), STRIP_POLL_MS);
  const tape = usePoll<ActivityItem[]>(() => api.activity({ limit: 12 }), TAPE_POLL_MS);
  const nameOf = (s: string) => bySymbol.get(s)?.name ?? '';
  const series = useMemo(() => {
    const m = new Map<string, HomeSeries | null>();
    for (const r of view?.markets ?? []) m.set(r.symbol, seriesOf(r));
    return m;
  }, [view]);
  const order = useRef<{ key: string; syms: string[] } | null>(null);
  const rows = useMemo(() => {
    if (!view) return null;
    const key = `${st.sort}|${st.q}`;
    const hit = filterMarkets(view.markets, st.q, nameOf);
    const out = order.current?.key === key ? stableOrder(hit, order.current.syms) : sortMarkets(hit, st.sort);
    order.current = { key, syms: out.map((r) => r.symbol) };
    return out;
  }, [view, st.q, st.sort, bySymbol]);
  const hash = toBoardHash(st);

  return (
    <Page className="board-page">
      <div className="board-main">
        <Strip state={state} vault={vault} />
        <div className="filters">
          <label className="search">
            <Icon name="search" />
            <input type="search" data-testid="board-search" value={st.q} placeholder={COPY.board.search} onChange={(e) => set({ q: e.target.value })} aria-label={COPY.board.search} autoComplete="off" spellCheck={false} />
          </label>
          <div className="filter-row">
            <Segmented label={COPY.board.sortLabel} options={MARKET_SORTS.map((k) => ({ value: k, label: COPY.play.filters[k] }))} value={st.sort} onChange={(k) => set({ sort: k })} className="seg-compact" />
          </div>
        </div>
        <Tape items={tape} n={3} className="tape-phone" />
        <div className="list-head">
          <h1 className="h-sm">{st.sort === 'move' ? COPY.board.moversTitle : COPY.nav.board}</h1>
          {rows && <span className="muted small num">{COPY.board.count(rows.length)}</span>}
        </div>
        {rows === null ? (
          <ul className="rows">{Array.from({ length: 8 }, (_, i) => <li key={i} className="row skel-row" />)}</ul>
        ) : rows.length === 0 ? (
          <Empty text={COPY.play.empty.board} />
        ) : (
          <ul className="rows">{rows.map((m) => <Row key={m.symbol} m={m} name={nameOf(m.symbol)} s={series.get(m.symbol) ?? null} />)}</ul>
        )}
      </div>
      <Rail vault={vault} tape={tape} />
      {sheet !== null && <TicketSheet raw={sheet} side={side} onClose={() => navigate(`/${hash}`)} chartLast={(sym) => view?.markets.find((r) => r.symbol === sym)?.price ?? null} />}
    </Page>
  );
}
