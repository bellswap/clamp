import { describe, expect, test } from 'bun:test';
import { activityPath, appendActivityPage, applyActivityQuery, filterMarkets, isFullAddress, mergeActivityHead, moveSinceOpen, sortMarkets, toActivity, toCatalog, toLeaderboard, toMarket, toMarkets, toRounds, toTicket, toTickets, toVault } from './normalize';
import type { MarketRow } from './types';

describe('normalisers', () => {
  test('raw and display encodings of a ticket read the same', () => {
    const a = toTicket({ id: 7, owner: '0xa', symbol: 'RTX', long: false, leverage: 5, stake: '20000000', reserved: '99000000', entryPrice8: '18474330000', expiry: 10, status: 1, payout: '25000000', settlePrice8: '18000000000' });
    const b = toTicket({ ticket: { id: '7', owner: '0xa', symbol: 'RTX', long: false, leverage: 5, stake: 20, net: 19.8, entryPrice: 184.7433, expiry: 10, status: 'won', payout: 25, settlePrice: 180 } });
    expect(a).toEqual(b);
    expect(a?.status).toBe('won');
  });
  test('an open ticket has no payout', () => {
    expect(toTicket({ id: 1, stake: 20, status: 0, payout: '0' })?.payout).toBeNull();
  });
  test('catalog defaults a missing onChain to false (static fallback) and upper-cases', () => {
    expect(toCatalog([{ symbol: 'rtx', name: 'RTX Corp' }])[0]).toMatchObject({ symbol: 'RTX', display: 'srtx', onChain: false });
    expect(toCatalog({ entries: [{ symbol: 'RTX', onChain: true }] })[0]?.onChain).toBe(true);
  });
  test('the service netStake (raw) is the net stake: fee taken off', () => {
    const t = toTicket({ id: '3', owner: '0xa', symbol: 'RTX', long: true, leverage: 5, stake: '20000000', fee: '200000', netStake: '19800000', maxPayout: '99000000', entryPrice8: '18000000000', expiry: 10, status: 'open' });
    expect(t?.net).toBe(19.8);
    expect(t!.net * t!.leverage).toBe(99);
  });
  test('a missing horizon stays null (no label), a given one is read', () => {
    expect(toTicket({ id: '1', stake: '20000000', status: 'open' })?.horizon).toBeNull();
    expect(toTicket({ id: '1', stake: '20000000', status: 'open', horizon: 2 })?.horizon).toBe(2);
    expect(toTicket({ id: '1', stake: '20000000', status: 'open', horizon: null })?.horizon).toBeNull();
    expect(toTicket({ id: '1', stake: '20000000', status: 'open', horizon: '1' })?.horizon).toBe(1);
    expect(toTicket({ id: '1', stake: '20000000', status: 'open', horizon: 0 })?.horizon).toBe(0);
    expect(toTicket({ id: '1', stake: '20000000', status: 'open', horizon: 7 })?.horizon).toBeNull();
    expect(toTicket({ id: '1', stake: '20000000', status: 'open', horizon: 'x' })?.horizon).toBeNull();
  });
  test('rounds sorted, raw prices scaled', () => {
    expect(toRounds({ rounds: [{ t: 2, price8: '200000000' }, { timestamp: 1, price: 1.5 }] })).toEqual([{ t: 1, price: 1.5 }, { t: 2, price: 2 }]);
  });
});

describe('toActivity with the bell v2 event shape', () => {
  test('deposit, withdraw and market events are kept with their kind, amount and time', () => {
    const a = toActivity({ events: [
      { kind: 'deposit', address: '0xa', amount: '1000000', at: 1, seq: 11, bot: true },
      { kind: 'withdraw', address: '0xa', amount: '2500000', at: 2, seq: 12 },
      { kind: 'market', symbol: 'AAL', at: 3, seq: 13 },
      { kind: 'open', id: '9', address: '0xb', symbol: 'RTX', long: false, leverage: 2, amount: '5000000', at: 4, seq: 14 },
    ] });
    expect(a.map((e) => [e.kind, e.id])).toEqual([['deposit', ''], ['withdraw', ''], ['market', ''], ['open', '9']]);
    expect(a[0]).toMatchObject({ kind: 'deposit', owner: '0xa', stake: 1, t: 1, seq: 11, bot: true });
    expect(a[1]).toMatchObject({ kind: 'withdraw', owner: '0xa', stake: 2.5, t: 2, seq: 12 });
    expect(a[1]!.bot).toBeUndefined();
    expect(a[2]).toMatchObject({ kind: 'market', symbol: 'AAL', owner: '', stake: 0, t: 3 });
    expect(a[3]).toMatchObject({ kind: 'open', stake: 5, long: false, leverage: 2 });
  });
  test('event type names of the chain logs map to the same kinds; unknown kinds are dropped', () => {
    const a = toActivity({ events: [{ type: 'Deposit', address: '0xa', assets: '3000000', at: 1 }, { type: 'Withdraw', address: '0xa', amount: '1000000', at: 2 }, { type: 'MarketListed', symbol: 'NVDA', at: 3 }, { kind: 'pause', at: 4 }] });
    expect(a.map((e) => e.kind)).toEqual(['deposit', 'withdraw', 'market']);
    expect(a[0]!.stake).toBe(3);
  });
  test('reads address, amount and at', () => {
    const [e] = toActivity({ events: [{ kind: 'settle', id: '5', address: '0x43b3959fe361afce6a81fc508133a3fa370db91c', symbol: 'RTX', long: true, leverage: 10, amount: '20000000', price8: '18694000000', payout: '19303441', block: 91943133, at: 1794058200 }] });
    expect(e).toMatchObject({ kind: 'settle', id: '5', owner: '0x43b3959fe361afce6a81fc508133a3fa370db91c', symbol: 'RTX', long: true, leverage: 10, stake: 20, payout: 19.303441, t: 1794058200 });
  });
});

describe('bot flags', () => {
  test('tickets, activity and leader rows carry bot only when the bell says true', () => {
    expect(toTicket({ id: '1', stake: '1000000', status: 'open', bot: true })?.bot).toBe(true);
    expect(toTicket({ id: '1', stake: '1000000', status: 'open', bot: false })?.bot).toBeUndefined();
    expect(toTickets({ tickets: [{ id: '2', bot: true }] })[0]?.bot).toBe(true);
    const lb = toLeaderboard({ minStakedRaw: '100000000', rows: [{ address: '0xa', stakedRaw: '200000000', pnlRaw: '-5000000', settled: 3, wins: 1, bot: true }, { address: '0xb', stakedRaw: '100000000', pnlRaw: '1000000' }] });
    expect(lb.rows.map((r) => r.bot)).toEqual([true, undefined]);
    expect(lb.minStaked).toBe(100);
  });
});

describe('GET /markets', () => {
  const answer = {
    clockUnix: 1000,
    nextClose: 4600,
    markets: [
      { symbol: 'NVDA', listed: true, covered: true, tradable: true, hot: true, price: 216.4, prevClose: 210, chg: 0.0305, sessionOpen: 213.7, sessionHigh: 217, sessionLow: 212, spark: [213.7, 215, 216.4], openCount: 4, oiRaw: '120000000', longOpenRaw: '80000000', shortOpenRaw: '40000000', oiCapRaw: '50000000000', maxStakeRaw: '1000000000', maxLeverage: 20, volume24hRaw: '300000000', lastRound: { t: 990, price8: '21640000000' } },
      { symbol: 'SATS', listed: false, covered: false, tradable: false, hot: false, price: null, prevClose: null, chg: null, sessionOpen: null, sessionHigh: null, sessionLow: null, spark: [], openCount: 0, oiRaw: '0', longOpenRaw: '0', shortOpenRaw: '0', oiCapRaw: '0', maxStakeRaw: '0', maxLeverage: 0, volume24hRaw: '0', lastRound: null },
    ],
  };
  test('raw USDG strings scale, prices stay numbers, lastRound price8 scales', () => {
    const v = toMarkets(answer);
    expect(v.clockUnix).toBe(1000);
    expect(v.nextClose).toBe(4600);
    expect(v.markets[0]).toMatchObject({ symbol: 'NVDA', tradable: true, price: 216.4, sessionOpen: 213.7, oi: 120, longOpen: 80, shortOpen: 40, oiCap: 50000, maxStake: 1000, maxLeverage: 20, volume24h: 300, openCount: 4, lastRound: { t: 990, price: 216.4 } });
    expect(v.markets[1]).toMatchObject({ symbol: 'SATS', tradable: false, covered: false, price: null, lastRound: null, spark: [] });
  });
  test('tradable defaults to listed and covered when the field is missing', () => {
    expect(toMarkets({ markets: [{ symbol: 'a', listed: true, covered: true }] }).markets[0]).toMatchObject({ symbol: 'A', tradable: true });
    expect(toMarkets({ markets: [{ symbol: 'b', listed: true, covered: false }] }).markets[0]!.tradable).toBe(false);
  });
  test('the single route reads the same row', () => {
    expect(toMarket({ ...answer.markets[0], exposureRaw: '1', fresh: true })?.price).toBe(216.4);
    expect(toMarket({})).toBeNull();
    expect(toMarket({ ...answer.markets[0] })?.eta).toBeNull();
    const m = toMarket({ ...answer.markets[0], expiries: { session: 100, day: 200, week: '300' }, etaWall: { session: 1.5, day: null, week: 9 } }, 5000);
    expect(m?.eta).toEqual({ atMs: 5000, points: [{ expiry: 100, wallS: 1.5 }, { expiry: 300, wallS: 9 }] });
  });
  test('move since the open uses the playground price over the session open', () => {
    expect(moveSinceOpen({ price: 216.435, sessionOpen: 213.735, chg: 0.5 })!).toBeCloseTo(1.2632, 3);
    expect(moveSinceOpen({ price: null, sessionOpen: null, chg: 0.01 })).toBeCloseTo(1);
    expect(moveSinceOpen({ price: null, sessionOpen: null, chg: null })).toBeNull();
  });
  const row = (symbol: string, o: Partial<MarketRow>): MarketRow => ({ ...toMarkets({ markets: [{ symbol, listed: true, covered: true }] }).markets[0]!, ...o });
  const rows = [
    row('AAA', { openCount: 1, volume24h: 10, price: 10, sessionOpen: 10 }),
    row('BBB', { openCount: 5, volume24h: 0, price: 9, sessionOpen: 10 }),
    row('CCC', { openCount: 1, volume24h: 50, price: 10.5, sessionOpen: 10 }),
    row('DDD', { tradable: false, openCount: 0, price: null, sessionOpen: null }),
  ];
  test('sorts: most active, movers, A to Z; rows without a feed always last', () => {
    expect(sortMarkets(rows, 'active').map((r) => r.symbol)).toEqual(['BBB', 'CCC', 'AAA', 'DDD']);
    expect(sortMarkets(rows, 'move').map((r) => r.symbol)).toEqual(['BBB', 'CCC', 'AAA', 'DDD']);
    expect(sortMarkets([...rows].reverse(), 'name').map((r) => r.symbol)).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
  });
  test('search matches symbol or name, case-insensitive', () => {
    const names: Record<string, string> = { AAA: 'Alpha Corp', BBB: 'Beta Inc', CCC: 'Gamma', DDD: 'Delta' };
    expect(filterMarkets(rows, 'beta', (s) => names[s]!).map((r) => r.symbol)).toEqual(['BBB']);
    expect(filterMarkets(rows, 'cc', (s) => names[s]!).map((r) => r.symbol)).toEqual(['CCC']);
    expect(filterMarkets(rows, '  ', (s) => names[s]!).length).toBe(4);
  });
});

describe('GET /activity query', () => {
  test('path carries address, symbol, kinds, a clamped limit and before', () => {
    expect(activityPath()).toBe('/activity');
    expect(activityPath({ address: '0xa', symbol: 'RTX', kinds: ['deposit', 'withdraw'], limit: 900, before: 40 })).toBe('/activity?address=0xa&symbol=RTX&kind=deposit%2Cwithdraw&limit=500&before=40');
  });
  test('client filter has the bell meaning (an older bell ignores the query)', () => {
    const items = toActivity({ events: [
      { kind: 'open', id: '1', address: '0xA', symbol: 'RTX', at: 3, seq: 3 },
      { kind: 'deposit', address: '0xb', amount: '1', at: 2, seq: 2 },
      { kind: 'market', symbol: 'NVDA', at: 1, seq: 1 },
    ] });
    expect(applyActivityQuery(items, { address: '0xa' }).map((i) => i.seq)).toEqual([3]);
    expect(applyActivityQuery(items, { kinds: ['deposit', 'market'] }).map((i) => i.seq)).toEqual([2, 1]);
    expect(applyActivityQuery(items, { symbol: 'nvda' }).map((i) => i.seq)).toEqual([1]);
    expect(applyActivityQuery(items, { before: 3, limit: 1 }).map((i) => i.seq)).toEqual([2]);
  });
});

describe('GET /vault', () => {
  test('raw amounts, share price, utilization and the hourly history', () => {
    const v = toVault({ deployed: true, assets: '10000000000000', reserved: '2500000000000', free: '7500000000000', lpCount: 5, sharePrice: 1.0123, utilization: 0.25, pnl7d: null, history: [{ t: 7200, assetsRaw: '2000000', reservedRaw: '0', sharePrice: 1.01 }, { t: 3600, assetsRaw: '1000000', reservedRaw: '500000', sharePrice: 1 }] });
    expect(v).toMatchObject({ assets: 10_000_000, reserved: 2_500_000, free: 7_500_000, lpCount: 5, sharePrice: 1.0123, utilization: 0.25, pnl7d: [], pnl7dTotal: 0 });
    expect(v.history).toEqual([{ t: 3600, assets: 1, reserved: 0.5, sharePrice: 1 }, { t: 7200, assets: 2, reserved: 0, sharePrice: 1.01 }]);
  });
  test('an older bell: utilization from reserved over assets, no history', () => {
    const v = toVault({ assets: '4000000', reserved: '1000000', free: '3000000', lpCount: 1 });
    expect(v.utilization).toBe(0.25);
    expect(v.sharePrice).toBeNull();
    expect(v.history).toEqual([]);
  });
});

describe('Activity head merge and the address filter', () => {
  const ev = (seq: number) => ({ kind: 'open' as const, id: String(seq), owner: '0xa', symbol: 'NVDA', long: true, leverage: 2, stake: 10, payout: null, t: seq, seq });
  const range = (hi: number, lo: number) => Array.from({ length: hi - lo + 1 }, (_, i) => ev(hi - i));

  test('events pushed out of the head stay between the head and the older pages', () => {
    const shown = [...range(1000, 801), ...range(800, 601)];
    const out = mergeActivityHead(shown, range(1001, 802), 200)!;
    expect(out.map((x) => x.seq)).toEqual(range(1001, 601).map((x) => x.seq));
  });

  test('a full head that does not reach the shown rows, or rows without seq, cannot be joined', () => {
    expect(mergeActivityHead(range(1000, 801), range(1400, 1201), 200)).toBeNull();
    expect(mergeActivityHead([{ ...ev(5), seq: undefined }], [{ ...ev(6), seq: undefined }], 200)).toBeNull();
    expect(mergeActivityHead(range(10, 1), [], 200)).toBeNull();
  });

  test('only a complete address is sent to the bell', () => {
    expect(isFullAddress(`0x${'aB'.repeat(20)}`)).toBe(true);
    expect(isFullAddress('0x63f5')).toBe(false);
    expect(isFullAddress('')).toBe(false);
  });

  test('a poll that lands while the first older page is in flight keeps the row the page joins', () => {
    // Shown 1000..801, More asks before=801 and marks the list paged; a poll returns 1001..802 first.
    const merged = mergeActivityHead(range(1000, 801), range(1001, 802), 200)!;
    const out = appendActivityPage(merged, 801, range(800, 601))!;
    expect(out.map((x) => x.seq)).toEqual(range(1001, 601).map((x) => x.seq));
  });

  test('an older page no longer joins a list a poll replaced while it was in flight', () => {
    expect(appendActivityPage(range(1300, 1101), 801, range(800, 601))).toBeNull();
    expect(appendActivityPage([], 801, range(800, 601))).toBeNull();
    expect(appendActivityPage(range(10, 6), 6, [...range(7, 5), { ...ev(4), seq: undefined }])?.map((x) => x.seq)).toEqual([10, 9, 8, 7, 6, 5]);
  });
});
