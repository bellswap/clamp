// Routes (docs/INTERFACES.md, Site): / board, /t/:symbol the ticker page (chart, ticket panel, tabs; ?side= preselects
// the side), /ticket/:id watch and verdict, /me, /leaders, /vault, /activity, and /more on phones.
import { Component, lazy, Suspense, type ReactNode } from 'react';
import { Footer, Header, Page, TabBar } from './components/Shell';
import { Empty } from './components/ui';
import { COPY } from './copy';
import { AppProvider } from './lib/app-state';
import { chunkLoaded, isChunkError, mayReload } from './lib/chunk-reload';
import { Link, match, useLocation } from './lib/router';
import { TCOPY } from './lib/ticker/copy';
import { ToastProvider } from './lib/toast';
import { Activity } from './pages/Activity';
import { Board } from './pages/Board';
import { Leaders } from './pages/Leaders';
import { Me } from './pages/Me';
import { More } from './pages/More';
import { Vault } from './pages/Vault';
import { Watch } from './pages/Watch';

// The ticker page carries the chart library (about 200 kB); it loads on the first /t/ visit, not with the board. A
// load that succeeds re-arms the one automatic reload (mayReload).
const TickerPage = lazy(() => import('./pages/ticker/TickerPage').then((m) => {
  chunkLoaded();
  return { default: m.TickerPage };
}));

/** Catches a render error of one route (keyed by path, so navigating away resets it). A failed chunk import reloads the
 * page once to fetch the new build; anything else, or a second failure, shows a reload button instead of a blank app. */
class RouteBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(e: unknown): void {
    console.warn(e);
    if (isChunkError(e) && mayReload()) window.location.reload();
  }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <Page><Empty text={TCOPY.loadFailed} action={<button type="button" className="btn-secondary" onClick={() => window.location.reload()}>{TCOPY.reload}</button>} /></Page>;
  }
}

function Routes() {
  const { path, search } = useLocation();
  let body;
  const t = match('/t/:symbol', path);
  const w = match('/ticket/:id', path);
  const side = search.get('side');
  if (path === '/') body = <Board sheet={null} side={null} />;
  else if (t) body = <Suspense fallback={<Page><div className="skel" /></Page>}><TickerPage key={t.symbol} raw={t.symbol!} side={side === 'short' || side === 'long' ? side : null} /></Suspense>;
  else if (w) body = <Watch key={w.id} id={w.id!} />;
  else if (path === '/me') body = <Me />;
  else if (path === '/leaders') body = <Leaders />;
  else if (path === '/vault') body = <Vault />;
  else if (path === '/activity') body = <Activity addr={search.get('a') ?? ''} />;
  else if (path === '/more') body = <More />;
  else body = <Page><Empty text={COPY.notFound} action={<Link to="/" className="btn-secondary">{COPY.home}</Link>} /></Page>;
  return (
    <div className="app">
      <Header path={path} />
      <RouteBoundary key={path}>{body}</RouteBoundary>
      <Footer />
      <TabBar path={path} />
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <AppProvider>
        <Routes />
      </AppProvider>
    </ToastProvider>
  );
}
