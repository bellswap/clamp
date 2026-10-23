// The disclosure line (one per surface, STYLE-SPEC section 10). scripts/naming-lint.ts checks that FOOTER_DISCLOSURES
// carries the non-affiliation sentence. The app footer and the share card render FOOTER_LINE; the ticket confirm
// renders CONFIRM_LINE (src/copy.ts re-exports both).
export interface Disclosure { id: string; text: string }

export const NON_AFFILIATION = 'Bellswap is not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc.';

/** The playground sentence of the footer line. */
export const PLAYGROUND_LINE = 'Playground on a fork of Robinhood Chain. Recorded prices, no real money.';

/** The share card's footer line (short form, the card has room for one short line). */
export const SHARE_LINE = PLAYGROUND_LINE;

/** The one line in the ticket confirm. */
export const CONFIRM_LINE = 'Play money on a fork. The loss stops at the stake.';

/** The footer's items; the app renders them as one line (FOOTER_LINE). */
export const FOOTER_DISCLOSURES: readonly Disclosure[] = [
  { id: 'playground', text: PLAYGROUND_LINE },
  { id: 'affiliation', text: NON_AFFILIATION },
];

/** The one footer line of the app. */
export const FOOTER_LINE = FOOTER_DISCLOSURES.map((d) => d.text).join(' ');
