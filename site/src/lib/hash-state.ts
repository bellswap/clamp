// The board's view state in the URL hash ("#rh=1&sort=name&r=5d&q=nv"), so a link carries the toggle, the sort, the
// window and the search. Defaults are left out: an empty hash is the default board (toggle off, sort by move, 1D).
export type SortKey = 'move' | 'name' | 'cap';
export type RangeKey = '1d' | '5d' | '1m';
export interface BoardState { rh: boolean; sort: SortKey; range: RangeKey; q: string }

export const DEFAULT_BOARD: BoardState = { rh: false, sort: 'move', range: '1d', q: '' };
const SORTS: readonly SortKey[] = ['move', 'name', 'cap'];
const RANGES: readonly RangeKey[] = ['1d', '5d', '1m'];

export function parseHash(hash: string): BoardState {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const sort = p.get('sort');
  const range = p.get('r');
  return {
    rh: p.get('rh') === '1',
    sort: SORTS.includes(sort as SortKey) ? (sort as SortKey) : DEFAULT_BOARD.sort,
    range: RANGES.includes(range as RangeKey) ? (range as RangeKey) : DEFAULT_BOARD.range,
    q: (p.get('q') ?? '').slice(0, 40),
  };
}

export function toHash(s: BoardState): string {
  const p = new URLSearchParams();
  if (s.rh) p.set('rh', '1');
  if (s.sort !== DEFAULT_BOARD.sort) p.set('sort', s.sort);
  if (s.range !== DEFAULT_BOARD.range) p.set('r', s.range);
  if (s.q.trim()) p.set('q', s.q.trim());
  const out = p.toString();
  return out ? `#${out}` : '';
}
