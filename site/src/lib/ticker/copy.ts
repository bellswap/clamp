// User-facing strings of the ticker page (/t/:symbol), its ticket form and its chart. The strings marked C0 are the
// copy picks of the play UI copy round, verbatim; the rest follow the bellswap.fun voice rules (labels and values,
// present tense, no "we"). Shared ticket words (Long, Short, Multiple, Stake, Balance) come from src/copy.ts.
// src/lib/ticker/copy.test.ts runs the banned-word, brand-word and no-emoji checks over this tree.

export const TF_LABELS = { '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' } as const;

export const TCOPY = {
  // C0: Settles at, Today's close, In 24 h, In 7 d ({time} = playground settlement time, {eta} = wall ETA)
  settlesAt: 'Settles at',
  horizonNames: ["Today's close", 'In 24 h', 'In 7 d'] as const,
  option: [
    (time: string, eta: string) => `Today's close, ${time} (${eta})`,
    (time: string, eta: string) => `In 24 h, ${time} (${eta})`,
    (time: string, eta: string) => `In 7 d, ${time} (${eta})`,
  ] as const,
  // C0: countdown format
  countdown: (m: number, s: number) => `Settles in ${m} min ${s} s`,
  countdownSec: (s: number) => `Settles in ${s} s`,
  settling: 'Settling',
  countdownLong: (eta: string) => `Settles in ${eta}`,
  optionNoEta: (name: string, time: string) => `${name}, ${time}`,
  // C0: the summary rows
  breakEven: 'Break even at',
  paysNothing: 'Pays nothing at',
  maxPayout: 'Max payout',
  maxLoss: 'Max loss',
  fee: 'Fee',
  // C0: market states and the faucet
  preparing: 'Preparing market',
  noFeed: 'No price feed',
  getUsdg: 'Get test USDG',
  // C0: demo tag and its explanation
  demo: 'demo',
  demoTitle: 'Demo trader. Opens tickets on a timer.',
  // C0: chart source note
  source: 'Recorded 5-minute prices, replayed on the playground clock.',
  // C0: How a ticket works
  howTitle: 'How a ticket works',
  how: [
    'Pick Long or Short and a multiple.',
    'Stake USDG. Max loss is the stake.',
    'Pick when it settles.',
    'Payout is between 0 and (stake minus fee) times the multiple.',
  ] as const,
  // C0: empty states
  emptyYours: 'No tickets.',
  emptyRecent: (sym: string) => `No tickets on ${sym}.`,
  emptySettled: 'No settled tickets.',

  // Not covered by C0 (voice rules: labels and values)
  maxPayoutAt: 'Max payout at',
  lastPrint: 'Last print',
  sinceOpen: 'Since open',
  sessionHigh: 'Session high',
  sessionLow: 'Session low',
  openOn: (sym: string) => `Open on ${sym}`,
  split: 'Long / Short',
  exposure: 'Vault exposure',
  nextSettlement: 'Next settlement',
  clock: 'Playground clock',
  ofCap: (oi: string, cap: string) => `${oi} / ${cap}`,
  tabs: { yours: 'Your tickets', recent: (sym: string) => `Recent on ${sym}`, settled: 'Settled' },
  col: { time: 'Time', trader: 'Trader', side: 'Side', stake: 'Stake', entry: 'Entry', now: 'Now', print: 'Print', move: 'Move', payoutNow: 'Payout now', payout: 'Payout', settles: 'Settles' },
  watch: 'Watch',
  board: 'Board',
  openBtn: (side: string, amount: string) => `Open ${side} · ${amount} USDG`,
  sideLev: (side: string, lev: number) => `${side} ${lev}x`,
  maxStake: (v: string) => `Max ${v} USDG per ticket`,
  capFull: (v: string) => `${v} USDG left under the cap`,
  you: 'you',
  interval: 'Interval',
  unknown: 'Unknown ticker.',
  loadFailed: 'This page did not load.',
  reload: 'Reload',
} as const;

export type TCopy = typeof TCOPY;
