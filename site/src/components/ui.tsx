// Small shared controls (STYLE-SPEC section 7): the brand glyph, icons, the toggle, segmented controls, the sparkline.
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { COPY } from '../copy';
import { fmtAddr, fmtClock, fmtSignedUsd, fmtUsd } from '../lib/format';
import { Link } from '../lib/router';
import type { ActivityItem } from '../lib/types';
import { useNear, LAZY_ROOT_ATTR } from '../lib/lazy-draw';
import { SPARK_VIEWBOX, sparkPaths, type HomeSeries } from '../lib/spark-paths';

export { LAZY_ROOT_ATTR };

/** The split wick (d1c): two stepped bell halves around a wick that runs from above the crown to below the lip,
 *  a bell and a candlestick in one form, on a 64-unit grid. All parts fill currentColor; the header recolours the wick. */
export function Glyph({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="glyph">
      <path d="M24 12H16V28H12V40H4V48H24Z" fill="currentColor" />
      <path d="M40 12H48V28H52V40H60V48H40Z" fill="currentColor" />
      <rect className="glyph-wick" x="28" y="4" width="8" height="56" fill="currentColor" />
    </svg>
  );
}

const ICONS: Record<string, ReactNode> = {
  search: <><circle cx="9" cy="9" r="5.5" /><path d="m13.2 13.2 3.8 3.8" /></>,
  close: <path d="M5 5l10 10M15 5 5 15" />,
  back: <path d="M12.5 4.5 7 10l5.5 5.5" />,
  chevron: <path d="m7.5 4.5 5.5 5.5-5.5 5.5" />,
  copy: <><rect x="7" y="7" width="9.5" height="9.5" rx="0" /><path d="M13 7V3.5H3.5V13H7" /></>,
  download: <path d="M10 3.5v9m-4-4 4 4 4-4M4 16.5h12" />,
  link: <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.9.9M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.9-.9" />,
  board: <path d="M3.5 5h13M3.5 10h13M3.5 15h13" />,
  tickets: <><rect x="3" y="4.5" width="14" height="11" rx="0" /><path d="M3 10h14" strokeDasharray="1.6 1.6" /></>,
  leaders: <path d="M4 16.5V11M10 16.5V4M16 16.5V8" />,
  more: <><circle cx="5" cy="10" r=".9" /><circle cx="10" cy="10" r=".9" /><circle cx="15" cy="10" r=".9" /></>,
};

export function Icon({ name, size = 20 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      {ICONS[name]}
    </svg>
  );
}

export function Arrow({ up }: { up: boolean }) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" className="arrow">
      {up ? <path d="M4 1 7.5 6.5h-7z" fill="currentColor" /> : <path d="M4 7 .5 1.5h7z" fill="currentColor" />}
    </svg>
  );
}

export function Toggle({ label, checked, onChange, id }: { label: string; checked: boolean; onChange: (v: boolean) => void; id: string }) {
  return (
    <label className="toggle" htmlFor={id}>
      <span className="toggle-label">{label}</span>
      <button id={id} type="button" role="switch" aria-checked={checked} className={`switch${checked ? ' on' : ''}`} onClick={() => onChange(!checked)}>
        <span className="knob" />
      </button>
    </label>
  );
}

export interface SegOption<T extends string | number> { value: T; label: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' }

/** WAI-ARIA radio group: one tab stop (the selected option), arrow keys move and select, Home and End jump. */
export function Segmented<T extends string | number>({ options, value, onChange, label, className, disabled = false }: { options: readonly SegOption<T>[]; value: T; onChange: (v: T) => void; label: string; className?: string; disabled?: boolean }) {
  const group = useRef<HTMLDivElement>(null);
  const cur = options.findIndex((o) => o.value === value);
  const stop = cur >= 0 ? cur : 0;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || options.length === 0) return;
    const n = options.length;
    const from = cur >= 0 ? cur : 0;
    let to: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (from + 1) % n;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (from - 1 + n) % n;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = n - 1;
    else return;
    const next = options[to];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[to]?.focus();
  };
  return (
    <div ref={group} className={`seg${className ? ` ${className}` : ''}`} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} onKeyDown={onKey}>
      {options.map((o, i) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} tabIndex={i === stop ? 0 : -1} className={`seg-opt${o.value === value ? ' sel' : ''}${o.tone ? ` tone-${o.tone}` : ''}`} disabled={disabled} onClick={() => onChange(o.value)}>
          <span className="seg-label">{o.label}</span>
          {o.sub !== undefined && <span className="seg-sub">{o.sub}</span>}
        </button>
      ))}
    </div>
  );
}

/** Sparkline in the shared 240 x 100 box, drawn when it first comes near the viewport. */
export function Spark({ series, lazy = true, className }: { series: HomeSeries | null; lazy?: boolean; className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const near = useNear(ref, lazy);
  const p = series && near ? sparkPaths(series, series.base) : null;
  return (
    <svg ref={ref} className={`spark${p ? ` spark-${p.dir}` : ''}${className ? ` ${className}` : ''}`} viewBox={SPARK_VIEWBOX} preserveAspectRatio="none" aria-hidden="true">
      {p && (
        <>
          {p.refY !== null && <line x1="0" x2="240" y1={p.refY} y2={p.refY} className="spark-base" vectorEffect="non-scaling-stroke" />}
          <path d={p.area} className="spark-area" />
          <path d={p.line} className="spark-line" vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  );
}

export function Empty({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <p>{text}</p>
      {action}
    </div>
  );
}

/** The "demo" tag on every row of a registered demo trader; the title explains it. */
export function DemoTag() {
  return (
    <span className="demo-tag" data-testid="demo-tag" title={COPY.play.demoTitle}>
      {COPY.play.demo}
    </span>
  );
}

/** One activity event in a line: time, owner (demo tag), what happened. Shared by the board's tape and the Vault page. */
export function TapeLine({ a }: { a: ActivityItem }) {
  const what =
    a.kind === 'open' ? (
      <>
        <span className={a.long ? 'up' : 'down'}>{a.long ? COPY.ticket.long : COPY.ticket.short} {a.leverage}x</span>
        <span className="num">{fmtUsd(a.stake)}</span>
      </>
    ) : a.kind === 'settle' ? (
      <>
        <span className="muted">{COPY.play.filters.settle}</span>
        <span className={`num ${(a.payout ?? 0) > a.stake ? 'up' : 'down'}`}>{fmtSignedUsd((a.payout ?? 0) - a.stake)}</span>
      </>
    ) : a.kind === 'market' ? (
      <span className="muted">{COPY.play.filters.market}</span>
    ) : (
      <>
        <span className="muted">{a.kind === 'deposit' ? COPY.play.filters.deposit : COPY.play.filters.withdraw}</span>
        <span className="num">{fmtUsd(a.stake)}</span>
      </>
    );
  return (
    <li className="tape-line">
      <span className="muted num">{fmtClock(a.t)}</span>
      {a.symbol ? <Link to={`/t/${a.symbol}`} className="asym">{a.symbol}</Link> : <span className="mono-addr muted">{fmtAddr(a.owner)}</span>}
      <span className="tape-what">{what}</span>
      <span className="tape-tag">{a.bot && <DemoTag />}</span>
    </li>
  );
}

