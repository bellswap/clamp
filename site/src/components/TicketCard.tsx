// The compact ticket card (STYLE-SPEC component 2) for lists: the call above the perforation, the state below it.
// The card opens the ticket (a stretched link); the symbol inside it opens the ticker page. Open tickets count down in
// wall time to their settlement on the playground clock.
import { COPY } from '../copy';
import { clockNow, useApp } from '../lib/app-state';
import { fmtAddr, fmtPct, fmtSettlesIn, fmtSignedUsd, fmtUsd, wallSecondsUntil } from '../lib/format';
import { horizonName } from '../lib/horizon';
import { movePct } from '../lib/payout';
import { Link } from '../lib/router';
import type { TicketView } from '../lib/types';
import { Monogram } from './Monogram';
import { DemoTag } from './ui';

export function SideChip({ long }: { long: boolean }) {
  return <span className={`chip ${long ? 'up' : 'down'}`}>{long ? COPY.ticket.long : COPY.ticket.short}</span>;
}

export function TicketCall({ t, symLink = false }: { t: TicketView; symLink?: boolean }) {
  return (
    <div className="call">
      <Monogram symbol={t.symbol} />
      {symLink ? <Link to={`/t/${t.symbol}`} className="call-sym call-sym-link">{t.symbol}</Link> : <span className="call-sym">{t.symbol}</span>}
      <SideChip long={t.long} />
      <span className="call-meta num">
        {t.leverage}x · {fmtUsd(t.stake)} USDG{horizonName(t.horizon) ? ` · ${horizonName(t.horizon)}` : ''}
      </span>
    </div>
  );
}

export function TicketCompact({ t, testId, owner = false }: { t: TicketView; testId?: string; owner?: boolean }) {
  const { clock } = useApp();
  const now = clockNow(clock);
  const settled = t.payout !== null;
  const left = wallSecondsUntil(t.expiry, now, clock.speed, clock.sched);
  return (
    <article className={`tcard tcard-compact${settled ? ` ${t.status}` : ''}`} {...(testId ? { 'data-testid': testId } : {})}>
      <Link to={`/ticket/${t.id}`} className="tcard-link">
        <span className="sr-only">{COPY.watch.ticketNo(t.id)}</span>
      </Link>
      <TicketCall t={t} symLink />
      <div className="perf" aria-hidden="true" />
      <div className="tcard-low">
        {settled ? (
          <>
            <span className="muted num">{fmtPct(movePct(t.entryPrice, t.settlePrice ?? t.entryPrice))}</span>
            <span className={`num strong ${t.payout! > t.stake ? 'up' : 'down'}`}>
              {fmtUsd(t.payout!)} USDG <span className="muted">({fmtSignedUsd(t.payout! - t.stake)})</span>
            </span>
          </>
        ) : (
          <>
            <span className="muted num">{fmtSettlesIn(left)}</span>
            <span className="tcard-id muted num">
              {owner && <span className="mono-addr">{fmtAddr(t.owner)}</span>}
              {t.bot && <DemoTag />}
              <span>#{t.id}</span>
            </span>
          </>
        )}
      </div>
      {settled && (owner || t.bot) && (
        <div className="tcard-own muted small">
          {owner && <span className="mono-addr">{fmtAddr(t.owner)}</span>}
          {t.bot && <DemoTag />}
        </div>
      )}
    </article>
  );
}
