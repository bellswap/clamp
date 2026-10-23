// App-wide state: the playground clock (GET /state, interpolated by speed), the catalog, the wallet (burner by default,
// injected on connect) with its balances, and the first-visit faucet call.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Address } from 'viem';
import { COPY } from '../copy';
import { api } from './api';
import { useToast } from './toast';
import type { Balances, CatalogEntry } from './types';
import { clockRate } from './clock-rate';
import { replayClockAfter, replaySchedule, type ReplaySchedule } from './format';
import { balances as readBalances, burnerAccount, connectInjected, markFunded, storeKind, storedKind, wasFunded, type WalletKind } from './wallet';

/** The playground clock at `wallMs`, its rate (playground seconds per wall second), the replay schedule (null in
 *  mock mode or off a US session recording) and the recording it was decided on. */
interface Clock { clockUnix: number; wallMs: number; speed: number; sched?: ReplaySchedule | null; rec?: string }

interface AppState {
  catalog: CatalogEntry[] | null;
  bySymbol: Map<string, CatalogEntry>;
  clock: Clock;
  kind: WalletKind;
  address: Address;
  bal: Balances | null;
  refreshBalances: () => void;
  connect: () => Promise<void>;
  useBurner: () => void;
  fund: () => Promise<void>;
  /** Bumped after every write, so pages refetch. */
  epoch: number;
  bump: () => void;
}

const Ctx = createContext<AppState | null>(null);
export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

/** Playground time now, from the last /state answer and its speed. With the replay schedule the time since the answer
 *  is counted in replay ticks (one bar each, one per night), so it holds across any number of nights; else linear. */
export function clockNow(c: Clock, wallMs = Date.now()): number {
  const played = ((wallMs - c.wallMs) / 1000) * c.speed;
  return c.sched && c.speed > 0 ? replayClockAfter(c.clockUnix, played / c.sched.bar, c.sched) : c.clockUnix + played;
}

/** Re-render every `ms` (the countdown's step). */
export function useTick(ms = 1000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [clock, setClock] = useState<Clock>({ clockUnix: Date.now() / 1000, wallMs: Date.now(), speed: 1 });
  const [kind, setKind] = useState<WalletKind>(storedKind);
  const burner = useMemo(() => burnerAccount().address, []);
  const [injected, setInjected] = useState<Address | null>(null);
  const [bal, setBal] = useState<Balances | null>(null);
  const [epoch, setEpoch] = useState(0);
  const address = kind === 'injected' && injected ? injected : burner;
  const funding = useRef(false);

  // The static fallback catalog has no listed markets (onChain false): keep asking the bell in the background until it
  // answers with the listed set.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      api.catalog().then(
        (c) => {
          if (!alive) return;
          setCatalog(c);
          if (!c.some((e) => e.onChain)) timer = setTimeout(load, 15_000);
        },
        () => {
          if (!alive) return;
          setCatalog((cur) => cur ?? []);
          timer = setTimeout(load, 15_000);
        },
      );
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = () =>
      api.state().then(
        // A null clock (the bell's RPC clock read failed) keeps the previous clock instead of jumping to 1970. The
        // daylight or standard schedule decided on this recording carries over to readings that fit both.
        (s) => {
          if (!alive || !Number.isFinite(s.clockUnix)) return;
          const rec = `${s.replay?.bar ?? ''}|${s.replay?.bars ?? ''}|${s.replay?.source ?? ''}`;
          setClock((prev) => ({ clockUnix: s.clockUnix as number, wallMs: Date.now(), speed: clockRate(s), rec, sched: replaySchedule(s.replay?.bar, s.clockUnix, Date.now(), prev.rec === rec ? prev.sched ?? null : null) }));
        },
        () => undefined,
      );
    void poll();
    const t = setInterval(poll, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // A balance answer counts only while its address is still the active one (a slow answer for the previous wallet
  // must not overwrite the current wallet's balance).
  const current = useRef(address);
  current.current = address;
  useEffect(() => setBal(null), [address]);
  const refreshBalances = useCallback(() => {
    const a = address;
    readBalances(a).then((b) => current.current === a && setBal(b), () => undefined);
  }, [address]);

  useEffect(() => {
    refreshBalances();
    const t = setInterval(refreshBalances, 6000);
    return () => clearInterval(t);
  }, [refreshBalances, epoch]);

  const fund = useCallback(async () => {
    if (funding.current) return;
    funding.current = true;
    try {
      await api.faucet(address);
      markFunded(address);
      toast('ok', COPY.toast.funded);
      setEpoch((e) => e + 1);
    } catch {
      toast('fail', COPY.toast.faucetFailed);
    } finally {
      funding.current = false;
    }
  }, [address, toast]);

  // First visit: fund the burner once.
  useEffect(() => {
    if (kind === 'burner' && !wasFunded(burner)) void fund();
  }, [kind, burner, fund]);

  // Reconnect a remembered injected wallet without a prompt when it is already authorised.
  useEffect(() => {
    if (kind !== 'injected' || injected || !window.ethereum) return;
    window.ethereum.request({ method: 'eth_accounts' }).then((a) => {
      const first = (a as Address[])[0];
      if (first) setInjected(first);
      else setKind('burner');
    }, () => setKind('burner'));
  }, [kind, injected]);

  const connect = useCallback(async () => {
    try {
      const a = await connectInjected();
      setInjected(a);
      setKind('injected');
      storeKind('injected');
    } catch {
      toast('fail', COPY.wallet.noInjected);
    }
  }, [toast]);

  const useBurner = useCallback(() => {
    setKind('burner');
    storeKind('burner');
  }, []);

  const bySymbol = useMemo(() => {
    const m = new Map<string, CatalogEntry>();
    for (const e of catalog ?? []) m.set(e.symbol.toUpperCase(), e);
    for (const e of catalog ?? []) if (!m.has(e.display.toUpperCase())) m.set(e.display.toUpperCase(), e);
    return m;
  }, [catalog]);

  const bump = useCallback(() => setEpoch((e) => e + 1), []);

  const value: AppState = { catalog, bySymbol, clock, kind, address, bal, refreshBalances, connect, useBurner, fund, epoch, bump };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Resolve a route ticker ("sRTX" or "RTX", any case): the exact symbol first, then the display name. */
export function resolveTicker(bySymbol: Map<string, CatalogEntry>, raw: string): CatalogEntry | undefined {
  const k = raw.toUpperCase();
  const exact = bySymbol.get(k);
  if (exact && exact.symbol === k) return exact;
  return bySymbol.get(k) ?? (k.startsWith('S') ? bySymbol.get(k.slice(1)) : undefined);
}
