// One Lightweight Charts instance on the chart box (vendored v5.2.1, src/vendor/lightweight-charts), adapted from the
// bellswap.fun trade chart (site-lp/site/src/pages/trade/chart/useChartInstance.ts): created once at the box's size
// with autoSize off; the box has size containment (chart.css), so the canvas cannot set the height of its own box; a
// ResizeObserver on the box and on its panel refits it, debounced 60 ms, skipping a size of 0 (a hidden box). Colours
// are the play tokens (src/styles/tokens.css) the box sees, read when the chart is created: --muted text, --border
// scale edges and grid, --faint crosshair, --up and --down candles. The accent never reaches the canvas (STYLE-SPEC
// section 13). A vertical swipe on a phone scrolls the page (vertTouchDrag off); a horizontal drag pans the chart.
import { useEffect, useState, type RefObject } from 'react';
import { createChart, type IChartApi } from '../../vendor/lightweight-charts/lightweight-charts.standalone.production.mjs';

export interface ChartPalette {
  bg: string;
  text: string;
  muted: string;
  border: string;
  faint: string;
  up: string;
  down: string;
  font: string;
}

/** Charts whose remove() ran. A series or price-line removal on such a chart schedules a frame that then draws on
 *  its disposed canvases ("Object is disposed" in a requestAnimationFrame callback, outside any try/catch). */
const removedCharts = new WeakSet<IChartApi>();
export const chartRemoved = (c: IChartApi): boolean => removedCharts.has(c);

/** The palette from the play tokens an element sees. */
export function readPalette(el: Element): ChartPalette {
  const cs = getComputedStyle(el);
  const v = (n: string, fallback: string) => cs.getPropertyValue(n).trim() || fallback;
  return {
    bg: v('--bg', '#000000'),
    text: v('--text', '#F4F5F0'),
    muted: v('--muted', '#8E948A'),
    border: v('--border', '#23261F'),
    faint: v('--faint', '#5E6459'),
    up: v('--up', '#CCFF00'),
    down: v('--down', '#FF6A3D'),
    font: v('--font-sans', 'Arial, sans-serif'),
  };
}

/** The chart on `box` (refit on size changes of `box` and `panel`) and its palette; null until mounted. */
export function useChartInstance(box: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>): { chart: IChartApi | null; palette: ChartPalette | null } {
  const [chart, setChart] = useState<IChartApi | null>(null);
  const [palette, setPalette] = useState<ChartPalette | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const p = readPalette(el);
    const c = createChart(el, {
      autoSize: false,
      width: el.clientWidth,
      height: el.clientHeight,
      layout: { background: { type: 'solid', color: p.bg }, textColor: p.muted, fontFamily: p.font, fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: p.border }, horzLines: { color: p.border } },
      rightPriceScale: { borderColor: p.border, scaleMargins: { top: 0.1, bottom: 0.08 } },
      timeScale: { borderColor: p.border, rightOffset: 4, barSpacing: 7, minBarSpacing: 1, timeVisible: true, secondsVisible: false, shiftVisibleRangeOnNewBar: true },
      crosshair: { mode: 0, vertLine: { color: p.faint, labelBackgroundColor: p.border }, horzLine: { color: p.faint, labelBackgroundColor: p.border } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
    });
    setPalette(p);
    setChart(c);
    let last = { w: el.clientWidth, h: el.clientHeight };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fit = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) return;
      if (w === last.w && h === last.h) return;
      last = { w, h };
      c.resize(w, h);
    };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fit, 60);
    });
    ro?.observe(el);
    if (panel.current) ro?.observe(panel.current);
    return () => {
      ro?.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      setChart(null);
      removedCharts.add(c);
      c.remove();
    };
  }, [box, panel]);
  return { chart, palette };
}
