// Header (brand, Mainnet | Playground switch, desktop nav, wallet pill), the one disclaimer line (hidden on /t/* under
// 600 px), and the phone tab bar (STYLE-SPEC 8, Navigation).
import type { ReactNode } from 'react';
import { COPY } from '../copy';
import { useApp } from '../lib/app-state';
import { fmtAddr, fmtUsd } from '../lib/format';
import { Link, useLocation } from '../lib/router';
import { Glyph, Icon } from './ui';

const NAV = [
  { to: '/', label: COPY.nav.board, icon: 'board' },
  { to: '/me', label: COPY.nav.me, icon: 'tickets' },
  { to: '/leaders', label: COPY.nav.leaders, icon: 'leaders' },
  { to: '/vault', label: COPY.nav.vault, icon: '' },
  { to: '/activity', label: COPY.nav.activity, icon: '' },
] as const;

function active(path: string, to: string): boolean {
  if (to === '/') return path === '/' || path.startsWith('/t/');
  return path === to || path.startsWith(`${to}/`);
}

export function Header({ path }: { path: string }) {
  const { address, bal, kind } = useApp();
  return (
    <header className="hdr">
      <div className="hdr-in">
        <Link to="/" className="brand" ariaLabel="bellswap">
          <Glyph />
          <span className="wordmark">{COPY.brand}</span>
        </Link>
        <div className="netsw" role="group" aria-label="Network">
          <a className="netsw-a" href="https://bellswap.fun/#/trade">{COPY.net.mainnet}</a>
          <a className="netsw-a on" href="https://play.bellswap.fun" aria-current="page" title={COPY.net.forknetTitle}>{COPY.net.forknet}</a>
        </div>
        <nav className="nav-top" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={`nav-a${active(path, n.to) ? ' on' : ''}`} ariaCurrent={active(path, n.to)}>
              {n.label}
            </Link>
          ))}
        </nav>
        <Link to="/me" className="pill" ariaLabel="Wallet">
          <span className="mono-addr">{fmtAddr(address)}</span>
          <span className="pill-sep" aria-hidden="true" />
          <span className="num pill-bal">{bal ? fmtUsd(bal.usdg) : '–'} USDG</span>
          {kind === 'injected' && <span className="pill-kind">ext</span>}
        </Link>
      </div>
    </header>
  );
}

export function TabBar({ path }: { path: string }) {
  const tabs = [NAV[0], NAV[1], NAV[2], { to: '/more', label: COPY.nav.more, icon: 'more' }] as const;
  const moreOn = path === '/more' || path === '/vault' || path === '/activity';
  return (
    <nav className="tabbar" aria-label="Tabs">
      {tabs.map((t) => {
        const on = t.to === '/more' ? moreOn : active(path, t.to);
        return (
          <Link key={t.to} to={t.to} className={`tab${on ? ' on' : ''}`} ariaCurrent={on}>
            <Icon name={t.icon} />
            <span>{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/** The disclaimer line. On a ticker page (/t/*) under 600 px it is hidden: the sticky Long and Short bar sits there,
 *  and the ticket panel carries its own disclaimer line. */
export function Footer() {
  const { path } = useLocation();
  return (
    <footer className={`foot${path.startsWith('/t/') ? ' foot-ticker' : ''}`}>
      <p>{COPY.footer}</p>
    </footer>
  );
}

export function Page({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  return <main className={`page${className ? ` ${className}` : ''}`} {...(testId ? { 'data-testid': testId } : {})}>{children}</main>;
}
