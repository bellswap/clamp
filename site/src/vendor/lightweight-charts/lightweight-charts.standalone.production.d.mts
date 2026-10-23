// Hand-written declaration of the part of TradingView Lightweight Charts v5.2.1 (Apache 2.0, vendored next to this file
// as lightweight-charts.standalone.production.mjs; licence and notice in public/licenses) that the ticker chart uses
// (components/chart/useChartInstance.ts, CandleChart.tsx). Copied from the bellswap.fun trade chart's declaration and
// extended with update, data, the crosshair subscription, the touch and scale handling and the time formatters. Only
// these names are declared; the module exports more.

export type UTCTimestamp = number & { readonly __utc?: never };
export type Time = UTCTimestamp | number;

export declare const LineType: { readonly Simple: 0; readonly WithSteps: 1; readonly Curved: 2 };
export type LineType = 0 | 1 | 2;
export declare const LineStyle: { readonly Solid: 0; readonly Dotted: 1; readonly Dashed: 2; readonly LargeDashed: 3; readonly SparseDotted: 4 };
export type LineStyle = 0 | 1 | 2 | 3 | 4;
export declare const ColorType: { readonly Solid: 'solid'; readonly VerticalGradient: 'gradient' };

export interface LineData {
  time: Time;
  value: number;
}
export interface CandlestickData {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PriceLineOptions {
  price: number;
  color?: string;
  lineWidth?: number;
  lineStyle?: LineStyle;
  lineVisible?: boolean;
  axisLabelVisible?: boolean;
  axisLabelColor?: string;
  axisLabelTextColor?: string;
  title?: string;
}
export interface IPriceLine {
  applyOptions(options: Partial<PriceLineOptions>): void;
}

export interface AutoscaleInfo {
  priceRange: { minValue: number; maxValue: number } | null;
}

export interface SeriesOptions {
  color?: string;
  lineWidth?: number;
  lineType?: LineType;
  lineStyle?: LineStyle;
  lineVisible?: boolean;
  pointMarkersVisible?: boolean;
  pointMarkersRadius?: number;
  priceScaleId?: string;
  priceLineVisible?: boolean;
  lastValueVisible?: boolean;
  crosshairMarkerVisible?: boolean;
  title?: string;
  visible?: boolean;
  upColor?: string;
  downColor?: string;
  borderUpColor?: string;
  borderDownColor?: string;
  wickUpColor?: string;
  wickDownColor?: string;
  priceFormat?: { type: 'price'; precision: number; minMove: number };
  autoscaleInfoProvider?: (base: () => AutoscaleInfo | null) => AutoscaleInfo | null;
}

export interface ISeriesApi<D> {
  setData(data: readonly D[]): void;
  /** Replace the last bar (same time) or append one (later time). */
  update(bar: D): void;
  data(): readonly D[];
  applyOptions(options: SeriesOptions): void;
  createPriceLine(options: PriceLineOptions): IPriceLine;
  removePriceLine(line: IPriceLine): void;
  priceToCoordinate(price: number): number | null;
}

export interface SeriesDefinition<D> {
  readonly type: string;
  readonly __data?: D;
}
export declare const LineSeries: SeriesDefinition<LineData>;
export declare const CandlestickSeries: SeriesDefinition<CandlestickData>;

export interface PriceScaleOptions {
  visible?: boolean;
  borderColor?: string;
  borderVisible?: boolean;
  scaleMargins?: { top: number; bottom: number };
  autoScale?: boolean;
}
export interface IPriceScaleApi {
  applyOptions(options: PriceScaleOptions): void;
}

export interface LogicalRange {
  from: number;
  to: number;
}
export interface ITimeScaleApi {
  getVisibleLogicalRange(): LogicalRange | null;
  scrollToRealTime(): void;
  scrollPosition(): number;
  setVisibleRange(range: { from: Time; to: Time }): void;
  setVisibleLogicalRange(range: LogicalRange): void;
  fitContent(): void;
  subscribeVisibleLogicalRangeChange(handler: (range: LogicalRange | null) => void): void;
  unsubscribeVisibleLogicalRangeChange(handler: (range: LogicalRange | null) => void): void;
}

export interface ChartOptions {
  width?: number;
  height?: number;
  autoSize?: boolean;
  layout?: {
    background?: { type?: 'solid'; color: string };
    textColor?: string;
    fontFamily?: string;
    fontSize?: number;
    attributionLogo?: boolean;
  };
  grid?: { vertLines?: { color?: string; visible?: boolean }; horzLines?: { color?: string; visible?: boolean } };
  rightPriceScale?: PriceScaleOptions;
  leftPriceScale?: PriceScaleOptions;
  timeScale?: {
    borderColor?: string;
    rightOffset?: number;
    barSpacing?: number;
    minBarSpacing?: number;
    timeVisible?: boolean;
    secondsVisible?: boolean;
    fixLeftEdge?: boolean;
    fixRightEdge?: boolean;
    shiftVisibleRangeOnNewBar?: boolean;
    tickMarkFormatter?: (time: Time, tickMarkType: number, locale: string) => string | null;
  };
  crosshair?: { mode?: 0 | 1 | 2 | 3; vertLine?: { color?: string; labelBackgroundColor?: string }; horzLine?: { color?: string; labelBackgroundColor?: string } };
  handleScroll?: boolean | { mouseWheel?: boolean; pressedMouseMove?: boolean; horzTouchDrag?: boolean; vertTouchDrag?: boolean };
  handleScale?: boolean | { mouseWheel?: boolean; pinch?: boolean; axisPressedMouseMove?: boolean | { time?: boolean; price?: boolean }; axisDoubleClickReset?: boolean };
  localization?: { priceFormatter?: (price: number) => string; timeFormatter?: (time: Time) => string };
}

export interface MouseEventParams {
  time?: Time;
  logical?: number;
  point?: { x: number; y: number };
  seriesData: Map<ISeriesApi<unknown>, unknown>;
}

export interface IChartApi {
  subscribeCrosshairMove(handler: (param: MouseEventParams) => void): void;
  unsubscribeCrosshairMove(handler: (param: MouseEventParams) => void): void;
  addSeries<D>(definition: SeriesDefinition<D>, options?: SeriesOptions, paneIndex?: number): ISeriesApi<D>;
  removeSeries(series: ISeriesApi<unknown>): void;
  applyOptions(options: ChartOptions): void;
  resize(width: number, height: number, forceRepaint?: boolean): void;
  timeScale(): ITimeScaleApi;
  priceScale(id: string): IPriceScaleApi;
  remove(): void;
}

export declare function createChart(container: HTMLElement, options?: ChartOptions): IChartApi;
export declare const version: () => string;
