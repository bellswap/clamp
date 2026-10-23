// The ticket sheet (STYLE-SPEC 8.2 and 11): a bottom sheet with the shared ticket form (components/ticket/TicketForm)
// and its primary button pinned at the foot. The ticker page opens it on phones from the sticky Long / Short bar with
// the side set, and passes its draft and market row so the sheet and the chart's preview lines stay in step. Without
// them (the board's older call) it keeps its own draft and polls the market itself.
import { useEffect, useRef } from 'react';
import { Monogram } from '../components/Monogram';
import { TicketForm } from '../components/ticket/TicketForm';
import { Icon } from '../components/ui';
import { COPY, PRODUCT_NAME } from '../copy';
import { resolveTicker, useApp } from '../lib/app-state';
import { fmtPrice } from '../lib/format';
import { useModal } from '../lib/modal';
import { navigate } from '../lib/router';
import { useDraft, useTickerMarket, type Draft } from '../lib/ticker/hooks';
import type { TickerMarket } from '../lib/ticker/ticker-api';

export function TicketSheet({ raw, side, onClose, chartLast, draft: given, market: givenMarket }: {
  raw: string;
  side: 'long' | 'short' | null;
  onClose: () => void;
  chartLast?: (sym: string) => number | null;
  draft?: Draft;
  market?: TickerMarket | null;
}) {
  const { bySymbol, catalog, epoch } = useApp();
  const entry = resolveTicker(bySymbol, raw);
  const own = useDraft(side);
  const draft = given ?? own;
  const fetched = useTickerMarket(givenMarket === undefined && entry ? entry.symbol : null, epoch);
  const market = givenMarket === undefined ? fetched.market : givenMarket;
  const dialog = useRef<HTMLDivElement>(null);
  useModal(dialog, entry?.symbol ?? null);

  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);

  const price = market?.price ?? (entry ? chartLast?.(entry.symbol) ?? entry.lastPrice : null);

  return (
    <div ref={dialog} className="sheet-wrap" role="dialog" aria-modal="true" aria-label={entry ? COPY.ticket.title(entry.symbol) : PRODUCT_NAME}>
      <button type="button" className="scrim" aria-label={COPY.ticket.close} onClick={onClose} />
      <div className="sheet">
        <div className="handle" aria-hidden="true" />
        {!entry ? (
          <div className="sheet-body">
            <div className="sheet-head">
              <span className="muted">{catalog === null ? COPY.board.loading : COPY.ticket.unknown}</span>
              <button type="button" className="icon-btn" onClick={onClose} aria-label={COPY.ticket.close}><Icon name="close" /></button>
            </div>
          </div>
        ) : (
          <>
            <div className="sheet-body tf-sheet-head">
              <div className="sheet-head">
                <Monogram symbol={entry.symbol} />
                <div className="sheet-title">
                  <span className="sheet-sym">{entry.symbol}</span>
                  <span className="sheet-name">{entry.name}</span>
                </div>
                <span className="sheet-px num">{fmtPrice(price)}</span>
                <button type="button" className="icon-btn" onClick={onClose} aria-label={COPY.ticket.close}><Icon name="close" /></button>
              </div>
            </div>
            <TicketForm entry={entry} market={market} draft={draft} variant="sheet" onOpened={(id) => navigate(`/ticket/${id}`)} />
          </>
        )}
      </div>
    </div>
  );
}
