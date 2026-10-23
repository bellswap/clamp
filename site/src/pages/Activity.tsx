// Activity (route /activity, STYLE-SPEC 8.8): every event the bell indexes (ticket opens and settlements, vault
// deposits and withdrawals, market listings), filtered by kind and by address (?a=0x...), polled every 3 s. Symbols
// link to the ticker page, ticket rows to the ticket, addresses to their own filter; demo traders carry the demo tag.
import { useEffect, useRef, useState } from 'react';
import { Page } from '../components/Shell';
import { DemoTag, Empty } from '../components/ui';
import { COPY } from '../copy';
import { api } from '../lib/api';
import { useApp } from '../lib/app-state';
import { fmtAddr, fmtClock, fmtSignedUsd, fmtUsd } from '../lib/format';
import { appendActivityPage, isFullAddress, mergeActivityHead } from '../lib/normalize';
import { Link, navigate } from '../lib/router';
import { ACTIVITY_KINDS, type ActivityItem, type ActivityKind } from '../lib/types';

const POLL_MS = 3000;
const PAGE = 200;
type KindFilter = 'all' | ActivityKind;
const FILTERS: readonly KindFilter[] = ['all', ...ACTIVITY_KINDS];

export const kindLabel = (k: ActivityKind): string => COPY.play.filters[k];

function Detail({ i }: { i: ActivityItem }) {
  if (i.kind === 'open' || i.kind === 'settle') {
    return (
      <>
        <span className={i.long ? 'up' : 'down'}>{i.long ? COPY.ticket.long : COPY.ticket.short} {i.leverage}x</span>
        <span className="num muted">{fmtUsd(i.stake)}</span>
        <Link to={`/ticket/${i.id}`} className={`num aval${i.kind === 'settle' ? ((i.payout ?? 0) > i.stake ? ' up' : ' down') : ' muted'}`}>
          {i.kind === 'open' ? `#${i.id}` : fmtSignedUsd((i.payout ?? 0) - i.stake)}
        </Link>
      </>
    );
  }
  if (i.kind === 'market') return <span className="adetail muted" />;
  return <span className="num aval adetail">{fmtUsd(i.stake)} USDG</span>;
}

interface Rows {
  /** The polled head, then the rows pushed out of it and the older pages (GET /activity?before=seq), newest first. */
  rows: ActivityItem[];
  /** Older pages were loaded or one is in flight: polls keep the rows below the head instead of replacing the list, so
   *  the rows a page joins stay. */
  paged: boolean;
  /** The last page fetched was full, so older events may exist. */
  full: boolean;
}

export function Activity({ addr }: { addr: string }) {
  const { epoch } = useApp();
  const [data, setData] = useState<Rows | null>(null);
  const [more, setMore] = useState(false);
  const [kind, setKind] = useState<KindFilter>('all');
  const [q, setQ] = useState(addr);
  // Bumped on every filter change: a page reply for an earlier filter is dropped.
  const gen = useRef(0);
  useEffect(() => setQ(addr), [addr]);
  useEffect(() => {
    let alive = true;
    gen.current++;
    setData(null);
    setMore(false);
    const q0 = { ...(addr ? { address: addr } : {}), ...(kind !== 'all' ? { kinds: [kind] } : {}), limit: PAGE };
    const fresh = (a: ActivityItem[]): Rows => ({ rows: a, paged: false, full: a.length >= PAGE });
    const load = () =>
      api.activity(q0).then(
        (a) => alive && setData((cur) => {
          if (!cur?.paged) return fresh(a);
          const rows = mergeActivityHead(cur.rows, a, PAGE);
          return rows ? { ...cur, rows } : fresh(a);
        }),
        () => alive && setData((cur) => cur ?? { rows: [], paged: false, full: false }),
      );
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [epoch, kind, addr]);
  const query = { ...(addr ? { address: addr } : {}), ...(kind !== 'all' ? { kinds: [kind] } : {}) };
  const all = data?.rows ?? [];
  const lastSeq = all.length ? all[all.length - 1]!.seq : undefined;
  const canMore = lastSeq !== undefined && lastSeq > 1 && !!data?.full;
  const loadMore = () => {
    if (more || lastSeq === undefined) return;
    const g = gen.current;
    const before = lastSeq;
    setMore(true);
    setData((cur) => (cur ? { ...cur, paged: true } : cur));
    api.activity({ ...query, before, limit: PAGE }).then(
      (a) => {
        if (g !== gen.current) return;
        setData((cur) => {
          const rows = cur ? appendActivityPage(cur.rows, before, a) : null;
          return cur && rows ? { rows, paged: true, full: a.length >= PAGE } : cur;
        });
      },
      () => undefined,
    ).finally(() => g === gen.current && setMore(false));
  };
  const f = q.trim().toLowerCase();
  // The typed filter narrows the loaded rows at once by substring; the bell query (exact address) follows on blur only
  // for a complete address or an empty field.
  const shown = all.filter((i) => !f || i.owner.toLowerCase().includes(f));
  const setAddr = (a: string) => navigate(a ? `/activity?a=${a}` : '/activity', true);
  const commit = () => {
    const a = q.trim();
    if (!a || isFullAddress(a)) setAddr(a);
  };
  return (
    <Page className="narrow">
      <h1 className="h-md">{COPY.nav.activity}</h1>
      <div className="act-filters">
        <div className="kchips" role="group" aria-label={COPY.activity.kind}>
          {FILTERS.map((k) => (
            <button key={k} type="button" className={`kchip${kind === k ? ' sel' : ''}`} aria-pressed={kind === k} data-testid={`activity-filter-${k}`} onClick={() => setKind(k)}>
              {k === 'all' ? COPY.play.filters.all : kindLabel(k)}
            </button>
          ))}
        </div>
        <label className="search search-sm">
          <input value={q} placeholder={COPY.activity.address} onChange={(e) => setQ(e.target.value)} onBlur={commit} aria-label={COPY.activity.address} spellCheck={false} />
          {q && <button type="button" className="link-btn" onClick={() => { setQ(''); setAddr(''); }}>{COPY.activity.clear}</button>}
        </label>
      </div>
      {data === null ? (
        <div className="skel" />
      ) : shown.length === 0 ? (
        <Empty text={COPY.play.empty.activity} />
      ) : (
        <ul className="arows">
          {shown.map((i) => (
            <li key={`${i.kind}-${i.seq ?? ''}-${i.id}-${i.owner}-${i.symbol}-${i.t}`} className={`arow arow-${i.kind}`} data-testid="activity-row" data-kind={i.kind}>
              <span className="muted num at">{fmtClock(i.t)}</span>
              <span className="aowner">
                {i.owner ? <button type="button" className="mono-addr link-btn" onClick={() => { setQ(i.owner); setAddr(i.owner); }}>{fmtAddr(i.owner)}</button> : <span />}
                {i.bot && <DemoTag />}
              </span>
              <span className="arow-main">
                {i.symbol ? <Link to={`/t/${i.symbol}`} className="asym">{i.symbol}</Link> : <span className="asym muted">{COPY.nav.vault}</span>}
                <span className={`akind akind-${i.kind}`}>{kindLabel(i.kind)}</span>
                <Detail i={i} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {data !== null && canMore && <button type="button" className="btn-secondary" onClick={loadMore} disabled={more}>{COPY.nav.more}</button>}
    </Page>
  );
}
