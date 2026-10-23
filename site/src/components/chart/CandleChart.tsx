// The ticker page's candle chart: intervals 5m to 1d, a crosshair OHLC legend, the viewer's entry lines and the
// ticket form's preview lines (Pays nothing at, Max payout at). It loads a window per interval, then polls the last
// three candles every 1.5 s while the page is visible and folds them in place (lib/ticker/candles.ts mergeTail), so the
// forming candle moves, a new one appends and the zoom stays where the viewer left it. Candles in --up and --down;
// lines in --muted and --down, never the accent (STYLE-SPEC section 13).
import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtClock, fmtPct, fmtPrice } from '../../lib/format';
import { legendOf, mergeTail, rebaseRange, TFS, type Candle, type Tf } from '../../lib/ticker/candles';
import { TCOPY, TF_LABELS } from '../../lib/ticker/copy';
import { tickerApi } from '../../lib/ticker/ticker-api';
import { CandlestickSeries, LineStyle, type CandlestickData, type ISeriesApi, type MouseEventParams, type UTCTimestamp } from '../../vendor/lightweight-charts/lightweight-charts.standalone.production.mjs';
import { chartRemoved, useChartInstance } from './useChartInstance';
import './chart.css';

export interface ChartLine { price: number; title: string; tone: 'muted' | 'down'; style: 'dashed' | 'dotted' }

const WINDOW = 300;
/** Above this many candles the window drops its oldest back to WINDOW, so the merge per poll stays bounded. */
const MAX_KEEP = 2 * WINDOW;
const POLL_MS = 1500;

const bar = (k: Candle): CandlestickData => ({ time: k.t as UTCTimestamp, open: k.o, high: k.h, low: k.l, close: k.c });

export function CandleChart({ symbol, tf, onTf, lines, compact }: { symbol: string; tf: Tf; onTf: (tf: Tf) => void; lines: readonly ChartLine[]; compact: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const { chart, palette } = useChartInstance(box, panel);
  const [series, setSeries] = useState<ISeriesApi<CandlestickData> | null>(null);
  const candles = useRef<Candle[]>([]);
  const [ver, setVer] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [empty, setEmpty] = useState(false);
  const compactRef = useRef(compact);
  compactRef.current = compact;

  // One series per symbol and interval: load the window, then poll the tail.
  useEffect(() => {
    if (!chart || !palette) return undefined;
    const s = chart.addSeries(CandlestickSeries, {
      upColor: palette.up, downColor: palette.down, borderUpColor: palette.up, borderDownColor: palette.down, wickUpColor: palette.up, wickDownColor: palette.down,
      priceLineVisible: false, lastValueVisible: true,
    });
    setSeries(s);
    candles.current = [];
    let alive = true;
    let busy = false;
    let loaded = false;
    const full = async (keepRange: boolean) => {
      const r = await tickerApi.candles(symbol, tf, WINDOW);
      if (!alive) return;
      // A recovery reload replaces the window: carry the viewer's range over by candle time, not by index.
      const seen = keepRange ? chart.timeScale().getVisibleLogicalRange() : null;
      const range = seen ? rebaseRange(seen, candles.current, r.candles) : null;
      candles.current = r.candles;
      const last = r.candles[r.candles.length - 1]?.c ?? 1;
      const precision = Math.abs(last) < 1 ? 4 : 2;
      s.applyOptions({ priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision } });
      s.setData(r.candles.map(bar));
      if (range) chart.timeScale().setVisibleLogicalRange(range);
      else {
        const n = r.candles.length;
        const show = compactRef.current ? 44 : 110;
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(-2, n - show), to: n + 3 });
      }
      setEmpty(r.candles.length === 0);
      setVer((v) => v + 1);
      loaded = true;
    };
    const tail = async () => {
      // Until the window has loaded, a poll loads it (a tail merged into an empty window would start a second load).
      if (!loaded) return full(false);
      const r = await tickerApi.candles(symbol, tf, 3);
      if (!alive) return;
      const m = mergeTail(candles.current, r.candles);
      if (m.reset) await full(true);
      else if (m.updates.length) {
        if (m.candles.length > MAX_KEEP) {
          const drop = m.candles.length - WINDOW;
          // The visible range indexes the chart's data before this merge; carry it over by candle time.
          const seen = chart.timeScale().getVisibleLogicalRange();
          const prev = candles.current;
          candles.current = m.candles.slice(drop);
          s.setData(candles.current.map(bar));
          const range = seen ? rebaseRange(seen, prev, candles.current) : null;
          if (range) chart.timeScale().setVisibleLogicalRange(range);
        } else {
          candles.current = m.candles;
          for (const k of m.updates) s.update(bar(k));
        }
        setVer((v) => v + 1);
      }
    };
    // One request at a time: the first load and every poll run under the same busy flag.
    const guarded = async (fn: () => Promise<void>) => {
      if (busy) return;
      busy = true;
      try {
        await fn();
      } catch {
        // next poll
      } finally {
        busy = false;
      }
    };
    void guarded(() => full(false));
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void guarded(tail);
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      setSeries(null);
      // On unmount the chart itself is removed first (useChartInstance's cleanup runs before this one); removing the
      // series from a removed chart would schedule a draw on its disposed canvases.
      if (chartRemoved(chart)) return;
      try {
        chart.removeSeries(s as ISeriesApi<unknown>);
      } catch {
        /* chart already removed */
      }
    };
  }, [chart, palette, symbol, tf]);

  useEffect(() => {
    if (!chart) return undefined;
    const on = (p: MouseEventParams) => setHover(p.time === undefined ? null : Number(p.time));
    chart.subscribeCrosshairMove(on);
    return () => chart.unsubscribeCrosshairMove(on);
  }, [chart]);

  const key = JSON.stringify(lines);
  useEffect(() => {
    if (!series || !palette) return undefined;
    const made = (JSON.parse(key) as ChartLine[]).filter((l) => Number.isFinite(l.price) && l.price > 0).map((l) =>
      series.createPriceLine({ price: l.price, color: l.tone === 'down' ? palette.down : palette.muted, lineWidth: 1, lineStyle: l.style === 'dotted' ? LineStyle.Dotted : LineStyle.Dashed, axisLabelVisible: true, axisLabelColor: palette.border, axisLabelTextColor: l.tone === 'down' ? palette.down : palette.text, title: l.title }),
    );
    return () => {
      if (chart && chartRemoved(chart)) return; // the lines went with the removed chart
      try {
        made.forEach((x) => series.removePriceLine(x));
      } catch {
        /* series already removed with its lines */
      }
    };
  }, [series, palette, key]);

  // ver changes after each load and poll, so the legend follows the forming candle
  const legend = useMemo(() => legendOf(candles.current, hover), [hover, ver]);
  const dir = legend ? (legend.c >= legend.o ? 'up' : 'down') : '';

  return (
    <section className="tk-chart" data-testid="ticker-chart" ref={panel}>
      <div className="tk-chart-head">
        <div className="tf-chips" role="radiogroup" aria-label={TCOPY.interval}>
          {TFS.map((t) => (
            <button key={t} type="button" role="radio" aria-checked={t === tf} data-testid={`tf-${t}`} className={`tf${t === tf ? ' on' : ''}`} onClick={() => onTf(t)}>
              {TF_LABELS[t]}
            </button>
          ))}
        </div>
        {legend && (
          <div className="tk-legend num" aria-live="off">
            <span className="tk-legend-t">{fmtClock(legend.t).slice(0, 5)}</span>
            <span>O <b>{fmtPrice(legend.o)}</b></span>
            <span>H <b>{fmtPrice(legend.h)}</b></span>
            <span>L <b>{fmtPrice(legend.l)}</b></span>
            <span>C <b>{fmtPrice(legend.c)}</b></span>
            <span className={dir}>{fmtPct(legend.movePct)}</span>
          </div>
        )}
      </div>
      <div className="tk-chart-wrap">
        <div className="tk-chart-box" ref={box} />
        {empty && <p className="tk-chart-empty muted small">{TCOPY.noFeed}</p>}
      </div>
      <p className="tk-source">{TCOPY.source}</p>
    </section>
  );
}
