// The payout meter (STYLE-SPEC component 6): a bar from 0 to the cap, a tick at the stake (break even), the fill at the
// current payout in up or down. Without a payout it shows the static range with the stake tick only.
import { COPY } from '../copy';
import { fmtUsd } from '../lib/format';
import { meterFill } from '../lib/payout';

export function PayoutMeter({ payout, stake, cap, big = false }: { payout: number | null; stake: number; cap: number; big?: boolean }) {
  const tick = meterFill(stake, cap) * 100;
  const fill = payout === null ? 0 : meterFill(payout, cap) * 100;
  const tone = payout === null ? '' : payout >= stake ? 'up' : 'down';
  return (
    <div className={`meter${big ? ' meter-big' : ''}`}>
      <div className="meter-head">
        <span className="label">{COPY.ticket.payout}</span>
        {payout !== null && <span className={`meter-fig num${tone ? ` ${tone}` : ''}`}>{fmtUsd(payout)} USDG</span>}
      </div>
      <div className="meter-bar" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={payout ?? 0} aria-label={COPY.ticket.payout}>
        {payout !== null && <div className={`meter-fill ${tone}`} style={{ width: `${fill}%` }} />}
        <div className="meter-tick" style={{ left: `${tick}%` }} />
      </div>
      <div className="meter-axis num">
        <span>0</span>
        <span>{fmtUsd(cap)}</span>
      </div>
    </div>
  );
}
