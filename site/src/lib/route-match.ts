// Path pattern matching for the router (lib/router.tsx re-exports it); kept free of React so tests import it directly.
/** Match "/t/:symbol" style patterns; returns the params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const v = b[i]!;
    if (p.startsWith(':')) {
      try {
        out[p.slice(1)] = decodeURIComponent(v);
      } catch {
        return null; // a malformed escape (/t/%) is no match, so the route falls through to not found
      }
    } else if (p !== v) return null;
  }
  return out;
}

/** A pushed navigation starts the new page at the top, also when its URL carries the board's state hash (a board row
 * opens /t/SYM#...); only a hash change on the same path (filters, a sheet) keeps the scroll. */
export function scrollsToTop(fromPath: string, to: string): boolean {
  if (!to.includes('#')) return true;
  const path = to.split(/[?#]/)[0] || fromPath;
  return path.replace(/\/+$/, '') !== fromPath.replace(/\/+$/, '');
}
