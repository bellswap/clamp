// Leaders (route /leaders, STYLE-SPEC 8.6 and component 10): ranked by realized ROI, minimum settled stake shown once,
// never ranked by volume or ticket count; the viewer's row pinned on top. The minimum filter runs before the 100-row
// cap (lib/leaders.ts), in the bell's order and with the bell's floor. Polled every 10 s; demo traders carry
// the demo tag.
import { useEffect, useState } from 'react';
import { Page } from '../components/Shell';
import { DemoTag, Empty } from '../components/ui';
import { COPY } from '../copy';
import { api } from '../lib/api';
import { useApp } from '../lib/app-state';
import { fmtAddr, fmtPct, fmtSignedUsd } from '../lib/format';
import { Link } from '../lib/router';
import { LEADER_MIN_STAKED, rankLeaders } from '../lib/leaders';
import type { Leaderboard, LeaderRow } from '../lib/types';

const POLL_MS = 10_000;

export function Leaders() {
  const { address, epoch } = useApp();
  const [board, setBoard] = useState<Leaderboard | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.leaderboard().then((b) => alive && setBoard(b), () => alive && setBoard((cur) => cur ?? { minStaked: LEADER_MIN_STAKED, rows: [] }));
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [epoch]);
  const rows = board?.rows ?? null;
  const min = board?.minStaked ?? LEADER_MIN_STAKED;
  const ranked = rankLeaders(rows ?? [], min);
  const isMe = (r: LeaderRow) => r.address.toLowerCase() === address.toLowerCase();
  // A ranked viewer is marked in place; only an unranked viewer gets the pinned row above the ranking.
  const mine = ranked.some(isMe) ? undefined : (rows ?? []).find(isMe);
  const line = (r: LeaderRow, rank: string, pinned = false) => (
    <li key={`${rank}-${r.address}`} className={`lrow${pinned || isMe(r) ? ' you' : ''}`} data-testid={pinned ? 'leaders-you' : 'leaders-row'}>
      <span className="muted num lrank">{rank}</span>
      <span className="laddr">
        <Link to={`/activity?a=${r.address}`} className="mono-addr">{fmtAddr(r.address)}</Link>
        {r.bot && <DemoTag />}
      </span>
      <span className="muted num lcount">{COPY.leaders.tickets(r.settled)}</span>
      <span className={`num lroi ${r.roiPct < 0 ? 'down' : 'up'}`}>{fmtPct(r.roiPct, 1)}</span>
      <span className="num lpnl">{fmtSignedUsd(r.pnl)}</span>
    </li>
  );
  return (
    <Page className="narrow">
      <h1 className="h-md">{COPY.leaders.title}</h1>
      <p className="muted small">{COPY.leaders.header(String(min))}</p>
      {rows === null ? (
        <div className="skel" />
      ) : ranked.length === 0 && !mine ? (
        <Empty text={COPY.play.empty.leaders} />
      ) : (
        <ul className="lrows">
          {mine && line(mine, COPY.leaders.you, true)}
          {ranked.map((r, i) => line(r, String(i + 1)))}
        </ul>
      )}
    </Page>
  );
}
