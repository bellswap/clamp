// The ticket form, shared by the ticker page's desktop panel and the phone sheet: Long or Short, the multiple (2, 5,
// 10, 20; segments above the market's maxLeverage disabled), the stake with quick chips and the balance, Settles at
// with a wall countdown, the payout meter, the summary rows (Max payout, Max loss, Break even at, Pays nothing
// at, Fee) and one primary button. Opening is approve then open, one toast each; a Stale revert warms the market and
// retries once. Zero balance turns the button into the faucet; an unprinted market shows Preparing market.
import { useState } from 'react';
import { COPY, PRODUCT_NAME } from '../../copy';
import { MOCK } from '../../config';
import { api } from '../../lib/api';
import { clockNow, useApp, useTick } from '../../lib/app-state';
import { fmtPrice, fmtUsd } from '../../lib/format';
import { breakEvenMove, MULTIPLES, parseStake, paysNothingMove, preview, priceAtMove, QUICK_STAKES } from '../../lib/payout';
import { useToast } from '../../lib/toast';
import type { CatalogEntry } from '../../lib/types';
import { isStaleRevert, openTicket } from '../../lib/wallet';
import { TCOPY } from '../../lib/ticker/copy';
import type { Draft } from '../../lib/ticker/hooks';
import { claimOpen, setOpenStep, useOpenStep } from '../../lib/ticker/pending-open';
import { anchorsOf, defaultHorizon, fmtCountdownWall, settleOptions } from '../../lib/ticker/settles-at';
import { printFresh, tickerApi, type TickerMarket } from '../../lib/ticker/ticker-api';
import { Icon } from '../ui';
import { PayoutMeter } from '../PayoutMeter';
import './ticket.css';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait (at most about 8 s) until the market's last print is fresh again after a warm. */
async function waitFresh(symbol: string): Promise<void> {
  for (let i = 0; i < 16; i++) {
    const m = await tickerApi.market(symbol).catch(() => null);
    if (m && printFresh(m)) return;
    await sleep(500);
  }
}

/** Wait (at most 8 s of wall time) until the bell has indexed ticket `id` (its newest ticket id is at least `id`), so the
 *  Watch page's first GET /tickets/:id finds it instead of answering 404 and showing Not found for one poll. Each poll
 *  is raced against the time left, so a stalled bell request (the API's own timeout is 15 s) cannot stretch the wait. */
async function waitIndexed(id: string, budgetMs = 8_000): Promise<void> {
  if (MOCK) return;
  const deadline = Date.now() + budgetMs;
  for (let left = budgetMs; left > 0; left = deadline - Date.now()) {
    const newest = await Promise.race([api.recentTickets(1).catch(() => []), sleep(left).then(() => [])]);
    if (newest[0] && Number(newest[0].id) >= Number(id)) return;
    await sleep(Math.min(300, Math.max(0, deadline - Date.now())));
  }
}

export interface FormLevels { stake: number; net: number; fee: number; maxPayout: number; maxLoss: number; breakEven: number | null; paysNothing: number | null }

/** The summary of a draft at `price`: the preview from payout.ts and the two price levels. */
export function levelsOf(draft: Pick<Draft, 'long' | 'lev' | 'stakeStr'>, price: number | null, feeBps: number): FormLevels {
  const pv = preview(parseStake(draft.stakeStr), draft.lev, feeBps);
  const ok = price !== null && price > 0 && pv.net > 0;
  return {
    ...pv,
    breakEven: ok ? priceAtMove(price, breakEvenMove(pv.stake, pv.net, draft.lev, draft.long)) : null,
    paysNothing: ok ? priceAtMove(price, paysNothingMove(draft.lev, draft.long)) : null,
  };
}

/** The draft's multiple, or the largest one the market allows when the draft's is above its maxLeverage. */
export function effectiveLev(lev: number, maxLev: number): number {
  return lev > maxLev ? Math.max(2, ...MULTIPLES.filter((m) => m <= maxLev)) : lev;
}

export function TicketForm({ entry, market, draft, variant, onOpened, onFaucet }: {
  entry: CatalogEntry;
  market: TickerMarket | null;
  draft: Draft;
  variant: 'panel' | 'sheet';
  onOpened: (id: string) => void;
  onFaucet?: () => void;
}) {
  const { clock, bal, kind, address, bump, refreshBalances, fund } = useApp();
  const toast = useToast();
  useTick(1000);
  // The in-flight open is tab-wide (lib/ticker/pending-open): closing and reopening the sheet keeps the guard.
  const step = useOpenStep();
  const [pick, setPick] = useState(false);
  const [funding, setFunding] = useState(false);

  const now = clockNow(clock);
  const rate = clock.speed;
  const anchors = anchorsOf(market);
  const opts = settleOptions(now, rate, anchors);
  const horizon = draft.horizon ?? defaultHorizon(now, rate, anchors);
  const chosen = opts[horizon] ?? opts[0]!;
  const feeBps = market?.feeBps ?? 100;
  const price = market?.price ?? entry.lastPrice;
  const stake = parseStake(draft.stakeStr);
  const maxLev = market?.maxLeverage ?? 20;
  const lev = effectiveLev(draft.lev, maxLev);
  const lv = levelsOf({ ...draft, lev }, price, feeBps);

  const invalid = !Number.isFinite(stake) || stake <= 0;
  const over = bal !== null && Number.isFinite(stake) && stake > bal.usdg;
  const overMax = market !== null && market.maxStake > 0 && stake > market.maxStake;
  const room = market && market.oiCap > 0 ? market.oiCap - market.oi : Infinity;
  const overCap = Number.isFinite(stake) && stake > room;
  const busy = step !== 'idle';
  const preparing = market !== null && market.tradable && !market.ready;
  const broke = bal !== null && bal.usdg <= 0;
  const canOpen = !!market && market.tradable && market.ready && !invalid && !over && !overMax && !overCap && !busy && bal !== null;
  const sideWord = draft.long ? COPY.ticket.long : COPY.ticket.short;

  const submit = async () => {
    if (!canOpen || !claimOpen()) return;
    let phase = 'approve' as 'approve' | 'open';
    const params = { symbol: entry.symbol, long: draft.long, leverage: lev, stake, horizon };
    const hooks = {
      onApproved: () => {
        phase = 'open';
        toast('ok', COPY.toast.approved);
        setOpenStep('opening');
      },
    };
    try {
      let id: string;
      try {
        id = await openTicket(kind, address, params, hooks);
      } catch (e) {
        if (!isStaleRevert(e)) throw e;
        await tickerApi.warm(entry.symbol);
        await waitFresh(entry.symbol);
        id = await openTicket(kind, address, params, hooks);
      }
      await waitIndexed(id);
      toast('ok', COPY.toast.opened(PRODUCT_NAME), `/ticket/${id}`);
      bump();
      refreshBalances();
      setOpenStep('idle');
      onOpened(id);
    } catch (e) {
      toast('fail', COPY.toast.failed(phase === 'open' ? COPY.ticket.opening : COPY.ticket.approving));
      console.warn(e);
      setOpenStep('idle');
    }
  };

  const faucet = async () => {
    setFunding(true);
    try {
      await fund();
      onFaucet?.();
    } finally {
      setFunding(false);
    }
  };

  const fields = (
    <>
      <div className="tf-side" role="radiogroup" aria-label="Side">
        {(['long', 'short'] as const).map((s) => {
          const on = draft.long === (s === 'long');
          return (
            <button key={s} type="button" role="radio" aria-checked={on} data-testid={`side-${s}`} disabled={busy} className={`tf-side-opt ${s === 'long' ? 'up' : 'down'}${on ? ' on' : ''}`} onClick={() => draft.setLong(s === 'long')}>
              {s === 'long' ? COPY.ticket.long : COPY.ticket.short}
            </button>
          );
        })}
      </div>

      <div className="field">
        <span className="label">{COPY.ticket.multiple}</span>
        <div className="tf-mults" role="radiogroup" aria-label={COPY.ticket.multiple}>
          {MULTIPLES.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={lev === m} data-testid={`mult-${m}`} disabled={busy || m > maxLev} className={`tf-mult num${lev === m ? ' on' : ''}`} onClick={() => draft.setLev(m)}>
              {m}x
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <div className="field-head">
          <span className="label">{COPY.ticket.stake}</span>
          <span className="muted small num">{COPY.ticket.balance(bal ? `${fmtUsd(bal.usdg)} USDG` : '–')}</span>
        </div>
        <label className={`amount${over || overMax || overCap || (draft.stakeStr !== '' && invalid) ? ' bad' : ''}`}>
          <input data-testid="amount-input" inputMode="decimal" disabled={busy} value={draft.stakeStr} onChange={(e) => draft.setStakeStr(e.target.value)} aria-label={COPY.ticket.stake} aria-invalid={over || invalid || overMax || overCap} />
          <span className="suffix">USDG</span>
        </label>
        <div className="chips">
          {QUICK_STAKES.map((q) => (
            <button key={q} type="button" className={`qchip num${stake === q ? ' sel' : ''}`} disabled={busy} onClick={() => draft.setStakeStr(String(q))}>{q}</button>
          ))}
        </div>
      </div>

      <div className="field" data-testid="settles-at">
        <span className="label">{TCOPY.settlesAt}</span>
        <button type="button" className="tf-settle" aria-expanded={pick} disabled={busy} onClick={() => setPick((v) => !v)}>
          <span className="num">{chosen.label}</span>
          <span className={`tf-chev${pick ? ' open' : ''}`}><Icon name="chevron" size={16} /></span>
        </button>
        {pick && (
          <div className="tf-settle-list" role="radiogroup" aria-label={TCOPY.settlesAt}>
            {opts.map((o) => (
              <button key={o.horizon} type="button" role="radio" aria-checked={o.horizon === horizon} data-testid={`settles-at-${o.horizon}`} className={`tf-settle-opt num${o.horizon === horizon ? ' on' : ''}`}
                onClick={() => {
                  draft.setHorizon(o.horizon);
                  setPick(false);
                }}>
                {o.label}
              </button>
            ))}
          </div>
        )}
        <span className="muted small num" aria-live="off">{fmtCountdownWall(chosen.etaWall)}</span>
      </div>

      <PayoutMeter payout={null} stake={lv.stake} cap={lv.maxPayout} />
      <dl className="tf-rows num">
        <div><dt>{TCOPY.maxPayout}</dt><dd>{fmtUsd(lv.maxPayout)} USDG</dd></div>
        <div><dt>{TCOPY.maxLoss}</dt><dd>{fmtUsd(lv.maxLoss)} USDG</dd></div>
        <div><dt>{TCOPY.breakEven}</dt><dd>{fmtPrice(lv.breakEven)}</dd></div>
        <div><dt>{TCOPY.paysNothing}</dt><dd>{fmtPrice(lv.paysNothing)}</dd></div>
        <div><dt>{TCOPY.fee}</dt><dd>{fmtUsd(lv.fee)} USDG</dd></div>
      </dl>
    </>
  );

  const label = step === 'approving' ? `${COPY.ticket.approving}…` : step === 'opening' ? `${COPY.ticket.opening}…`
    : over ? COPY.ticket.tooHigh : overMax ? TCOPY.maxStake(fmtUsd(market?.maxStake ?? 0)) : overCap ? TCOPY.capFull(fmtUsd(Math.max(0, room))) : TCOPY.openBtn(sideWord, fmtUsd(Number.isFinite(stake) ? stake : 0));
  const foot = (
    <>
      {broke && !busy ? (
        <button type="button" className="btn-primary" data-testid="get-usdg" disabled={funding} onClick={() => void faucet()}>{TCOPY.getUsdg}</button>
      ) : preparing && !busy ? (
        <button type="button" className="btn-primary" data-testid="preparing-market" disabled>{TCOPY.preparing}</button>
      ) : (
        <button type="button" className="btn-primary" data-testid="open-button" disabled={!canOpen} onClick={() => void submit()}>{label}</button>
      )}
      <p className="disclaimer">{COPY.confirmLine}</p>
    </>
  );

  if (variant === 'sheet') {
    return (
      <>
        <div className="sheet-body tf-body">{fields}</div>
        <div className="sheet-foot">{foot}</div>
      </>
    );
  }
  return (
    <div className="tf-panel">
      <div className="tf-body">{fields}</div>
      <div className="tf-foot">{foot}</div>
    </div>
  );
}
