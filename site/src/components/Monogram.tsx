// The ticker monogram (STYLE-SPEC section 6): the first two letters of the symbol in a 28 by 28 rounded square,
// surface-2 fill, muted text. Adapted from the first Bellswap demo without the per-ticker hues,
// which the v2 style drops.
export function monoLetters(symbol: string): string {
  const s = symbol.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return s.length >= 2 ? s.slice(0, 2) : (s + s).slice(0, 2);
}

export function Monogram({ symbol, size = 28 }: { symbol: string; size?: 28 | 40 | 96 }) {
  return (
    <span className={`mono mono-${size}`} aria-hidden="true">
      {monoLetters(symbol)}
    </span>
  );
}
