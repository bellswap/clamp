// A small path router over the History API: usePath re-renders on navigation, Link prevents the full page load.
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { scrollsToTop } from './route-match';

export const EVENT = 'bellswap:navigate';

export function navigate(to: string, replace = false): void {
  const from = location.pathname;
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.dispatchEvent(new Event(EVENT));
  if (!replace && scrollsToTop(from, to)) window.scrollTo?.(0, 0);
}

export interface Loc { path: string; search: URLSearchParams; hash: string }

function read(): Loc {
  return { path: location.pathname.replace(/\/+$/, '') || '/', search: new URLSearchParams(location.search), hash: location.hash };
}

export function useLocation(): Loc {
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => setLoc(read());
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    window.addEventListener(EVENT, on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('hashchange', on);
      window.removeEventListener(EVENT, on);
    };
  }, []);
  return loc;
}

export { match } from './route-match';

export function Link({ to, className, children, ariaLabel, ariaCurrent }: { to: string; className?: string; children: ReactNode; ariaLabel?: string; ariaCurrent?: boolean }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} onClick={onClick} aria-label={ariaLabel} aria-current={ariaCurrent ? 'page' : undefined}>
      {children}
    </a>
  );
}
