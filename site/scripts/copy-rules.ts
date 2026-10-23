// Launch copy word rules and the separation check, ported from
// a launch copy checker in earlier design notes, not in this repository (NEVER, NEG_ONLY, CHANNEL_NEVER, the
// Robinhood rule and separation()), for rendered site markup. Used by the token page tests
// (src/pages/token/TokenView.test.tsx). Rules are applied per text line; markup is split into lines at tags.

export type Channel = 'site' | 'reference';
export interface CopyViolation { line: string; rule: string; match: string }

const NEG = /\b(no|not|never|nothing|none|nor|without)\b|n't/i;
const NEVER = [
  /stock tokens?/gi, /tokeni[sz]ed (stocks?|etfs?|shares?)/gi, /\$bwet\b/gi, /\bmoon\w*/gi, /\b\d{2,}x\b/gi,
  /\bpump\w*/gi, /\bgems?\b/gi, /\bsoon\b/gi, /\blisting\w*/gi, /\bairdrop\w*/gi, /\bbuyback\w*/gi, /\bburn\w*/gi,
  /\bapy\b/gi, /\bstak(e|es|ing)\b/gi, /\bupside\b/gi, /\bpremium\b/gi, /\bdiscount\w*/gi, /fair value/gi,
  /\barbitrage\w*/gi, /backed by/gi, /\bguarantee\w*/gi, /passive income/gi, /\bpartnership\w*/gi, /\bwhitepaper\w*/gi,
];
const NEG_ONLY = [
  /\broadmaps?\b/gi, /\bmilestones?\b/gi, /\bpresales?\b/gi, /\bredeem\w*/gi, /\bredemptions?\b/gi, /\btreasur\w*/gi,
  /\bpeg\w*/gi, /\bdividend\w*/gi, /\byield\w*/gi, /\btrack\w*/gi, /\breturns\b/gi, /\binvest\w*/gi, /\bproceeds\b/gi,
  /\bpromis\w*/gi, /\bworth\w*/gi, /\bprofit\w*/gi, /\bplan(s|ned|ning)?\b/gi, /\bfutures?\b/gi, /\bequal\w*/gi,
  /\bfollow\w*/gi, /\badmin\w*/gi, /\btax\w*/gi,
];
const CHANNEL_NEVER: Record<Channel, RegExp[]> = {
  // check_copy.py CHANNEL_NEVER["site"] (= the meme channel list).
  site: [/\bbuildathon\w*/gi, /\bhackathon\w*/gi, /\bprize\w*/gi, /\bgrants?\b/gi, /\bfund\w*/gi, /\bdevelop\w*/gi, /\bupcoming\b/gi, /will be/gi, /\bwe will\b/gi, /\bwe'll\b/gi, /going to/gi],
  reference: [/\[NAME\]/g, /\[TICKER\]/g, /\bmeme\w*/gi, /\bbuy\w*/gi],
};

/** Text lines of markup: comments removed, entities decoded, one line per text run between tags. */
export function textLines(html: string): string[] {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script|title)[\s\S]*?<\/\1>/gi, '\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

export function wordRules(lines: readonly string[], channels: readonly Channel[]): CopyViolation[] {
  const out: CopyViolation[] = [];
  for (const line of lines) {
    for (const re of [...NEVER, ...channels.flatMap((c) => CHANNEL_NEVER[c])]) {
      for (const m of line.matchAll(re)) out.push({ line, rule: `banned ${re.source}`, match: m[0] });
    }
    for (const re of NEG_ONLY) {
      for (const m of line.matchAll(re)) if (!NEG.test(line)) out.push({ line, rule: `only on a negating line ${re.source}`, match: m[0] });
    }
    for (const m of line.matchAll(/robinhood/gi)) {
      if (line.slice(m.index, m.index + 15).toLowerCase() !== 'robinhood chain' && !line.toLowerCase().includes('not issued')) {
        out.push({ line, rule: 'Robinhood outside "Robinhood Chain" and the not-issued line', match: m[0] });
      }
    }
  }
  return out;
}

/** The banned words alone: NEVER plus the channels' CHANNEL_NEVER, without the NEG_ONLY words and without the Robinhood
 *  rule (naming-lint.ts covers that one for site text). Used by the docs wiki test; wordRules above is unchanged. */
export function neverRules(lines: readonly string[], channels: readonly Channel[]): CopyViolation[] {
  const out: CopyViolation[] = [];
  for (const line of lines) {
    for (const re of [...NEVER, ...channels.flatMap((c) => CHANNEL_NEVER[c])]) {
      for (const m of line.matchAll(re)) out.push({ line, rule: `banned ${re.source}`, match: m[0] });
    }
  }
  return out;
}

/** check_copy.py separation(): ids ref-price and meme-price in different <section> elements, an element with class
 *  "wall" (here any class containing "wall") between them in document order. Returns the problems found. */
export function separation(html: string): string[] {
  const problems: string[] = [];
  const stack: (string | null)[] = [];
  const found: Record<string, { section: string | null; at: number }> = {};
  let wall = -1;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [, close, tag, attrs = ''] = m;
    const at = m.index;
    if (tag === 'section') {
      if (close) stack.pop();
      else stack.push(/\bid="([^"]+)"/.exec(attrs)?.[1] ?? null);
      continue;
    }
    if (close) continue;
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    if (id === 'ref-price' || id === 'meme-price') found[id] = { section: stack[stack.length - 1] ?? null, at };
    const cls = /\bclass="([^"]+)"/.exec(attrs)?.[1] ?? '';
    if (wall < 0 && cls.split(/\s+/).some((c) => c === 'wall' || c.endsWith('-wall'))) wall = at;
  }
  const r = found['ref-price'];
  const p = found['meme-price'];
  if (!r || !p) return [`expected ids ref-price and meme-price, found ${Object.keys(found).join(', ') || 'none'}`];
  if (r.section === null || p.section === null || r.section === p.section) problems.push(`reference (${r.section}) and pool price (${p.section}) are not in separate sections`);
  if (!(r.at < wall && wall < p.at)) problems.push('separator is not between the reference and the pool price');
  return problems;
}
