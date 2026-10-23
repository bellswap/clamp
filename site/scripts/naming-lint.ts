// Global naming lint (SPEC 14.1 and gate G6, docs/SPEC.md section 14.1 and 10.3 G6).
// Usage: bun run scripts/naming-lint.ts [repo root]. Exit 1 on any violation.
//
// Rule 1, whole repository: the banned product phrase (SPEC 14.2, 5.7(j)) is allowed only inside a quotation, that is
// wrapped in quotation marks directly, as in the verbatim rule at docs/SPEC.md:1626. Everywhere else it fails.
// Rule 2, public texts only (site/src, site/index.html, site/public and the root README.md): no "stock token" wording,
// "Robinhood" only as "Robinhood Chain" or "Robinhood Markets, Inc.", no "Hood Chain", no HOOD ticker.
// Rule 3, gate G6: the non-affiliation disclaimer (SPEC 14.2, 5.7(b)) is present in the root README.md and in the
// site's disclosure source, and FOOTER_DISCLOSURES, the list every page footer renders (components/Footer.tsx through
// DisclosureList), carries it: the text alone passes while the footer list lacks the item.
// On-chain strings are covered by test/spec/NamingLint.t.sol (string literals under src/), which runs in forge test.
// The patterns are written so that this file never contains the banned phrase itself.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Violation { file: string; line: number; col: number; rule: string; text: string }

const BANNED = /tokeni[sz]ed[\s-]+stock/gi;
const OPEN_QUOTE = /(?:["“'‘]|&quot;|&ldquo;)$/;
const CLOSE_QUOTE = /^[a-z]*[.,;:!?]?(?:["”'’]|&quot;|&rdquo;)/i;

const SITE_RULES: readonly { rule: string; re: RegExp }[] = [
  { rule: 'site: "stock token" wording (say "synthetic", "reference price", "market")', re: /stock[\s-]+tokens?/gi },
  { rule: 'site: "Robinhood" only as "Robinhood Chain" or "Robinhood Markets, Inc."', re: /\bRobinhood\b(?!(?: Chain| Markets, Inc\.))/g },
  { rule: 'site: never "Hood Chain"', re: /\bHood Chain\b/gi },
  { rule: 'site: no HOOD ticker', re: /\$?\bHOOD\b/g },
];

const SKIP_DIRS = new Set(['.git', 'lib', 'node_modules', 'dist', 'dist-local', 'broadcast', 'test-results', 'playwright-report', 'keeper-state']);
const SKIP_PREFIX = ['out', 'cache'];
const EXTS = new Set(['.md', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.sol', '.html', '.css', '.txt', '.sh', '.toml', '.yml', '.yaml', '.svg']);
/** SPEC 14.2, 5.7(b): the required disclaimer wording, and the files that must carry it (gate G6). */
export const DISCLAIMER = 'not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc.';
export const DISCLAIMER_FILES: readonly string[] = ['README.md', 'site/src/content/disclosures.ts'];

/** Generated from forge artifacts; the naming lint of the contracts covers their strings (test/spec/NamingLint.t.sol). */
const SKIP_FILES = new Set(['site/src/abi', 'docs/research']); // docs/research holds notes on third-party sites, not product text

function isQuoted(text: string, start: number, end: number): boolean {
  return OPEN_QUOTE.test(text.slice(Math.max(0, start - 8), start)) && CLOSE_QUOTE.test(text.slice(end, end + 12));
}

function position(text: string, index: number): { line: number; col: number; lineText: string } {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = text.indexOf('\n', index);
  return { line, col: index - lineStart + 1, lineText: text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim() };
}

export function lintText(text: string, file: string, site: boolean): Violation[] {
  const out: Violation[] = [];
  for (const m of text.matchAll(BANNED)) {
    const start = m.index;
    if (isQuoted(text, start, start + m[0].length)) continue;
    const p = position(text, start);
    out.push({ file, line: p.line, col: p.col, rule: 'banned product phrase outside a quotation (SPEC 14.2, 5.7(j))', text: p.lineText.slice(0, 160) });
  }
  if (site) {
    for (const { rule, re } of SITE_RULES) {
      for (const m of text.matchAll(re)) {
        const p = position(text, m.index);
        out.push({ file, line: p.line, col: p.col, rule, text: p.lineText.slice(0, 160) });
      }
    }
  }
  return out;
}

function* walk(dir: string, root: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(root, full);
    if (SKIP_FILES.has(rel)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name) || SKIP_PREFIX.some((p) => name === p || name.startsWith(`${p}-`))) continue;
      yield* walk(full, root);
    } else if (EXTS.has(extname(name)) && st.size < 4_000_000) {
      yield full;
    }
  }
}

export function isSiteSource(rel: string): boolean {
  return rel.startsWith('site/src/') || rel === 'site/index.html' || rel.startsWith('site/public/');
}

/** Public texts get the site rules: the site sources and the root README.md (gate G6: "README and site"). */
export function isPublicText(rel: string): boolean {
  return isSiteSource(rel) || rel === 'README.md';
}

/** Rule 3: one violation per required file that is missing or lacks the disclaimer (whitespace-insensitive). */
export function checkDisclaimer(read: (rel: string) => string | undefined): Violation[] {
  const want = DISCLAIMER.replace(/\s+/g, ' ');
  const out: Violation[] = [];
  for (const file of DISCLAIMER_FILES) {
    const text = read(file);
    if (text !== undefined && text.replace(/\s+/g, ' ').includes(want)) continue;
    out.push({ file, line: 0, col: 0, rule: 'non-affiliation disclaimer missing (SPEC 14.2, 5.7(b); gate G6)', text: text === undefined ? 'file not found' : DISCLAIMER });
  }
  return out;
}

/** The module whose FOOTER_DISCLOSURES every page footer renders (SPEC.md:1653). */
export const FOOTER_SOURCE = 'site/src/content/disclosures.ts';

/** Rule 3, the footer: one violation when the footer list could not be loaded or no item of it carries the disclaimer. */
export function checkFooterDisclaimer(items: readonly { text: string }[] | undefined): Violation[] {
  const want = DISCLAIMER.replace(/\s+/g, ' ');
  if (items !== undefined && items.some((d) => d.text.replace(/\s+/g, ' ').includes(want))) return [];
  return [{ file: FOOTER_SOURCE, line: 0, col: 0, rule: 'non-affiliation disclaimer missing from FOOTER_DISCLOSURES, the page footer (SPEC 14.2, 5.7(b); SPEC.md:1653; gate G6)', text: items === undefined ? 'FOOTER_DISCLOSURES not loadable' : DISCLAIMER }];
}

/** FOOTER_DISCLOSURES of the disclosure source under `root`, or undefined when it cannot be loaded. */
async function loadFooter(root: string): Promise<readonly { text: string }[] | undefined> {
  try {
    const m = (await import(pathToFileURL(join(root, FOOTER_SOURCE)).href)) as { FOOTER_DISCLOSURES?: unknown };
    return Array.isArray(m.FOOTER_DISCLOSURES) ? (m.FOOTER_DISCLOSURES as { text: string }[]) : undefined;
  } catch {
    return undefined;
  }
}

export async function lintRepo(root: string): Promise<{ files: number; violations: Violation[] }> {
  let files = 0;
  const violations: Violation[] = [];
  for (const f of walk(root, root)) {
    files++;
    const rel = relative(root, f);
    violations.push(...lintText(readFileSync(f, 'utf8'), rel, isPublicText(rel)));
  }
  violations.push(...checkDisclaimer((rel) => {
    try { return readFileSync(join(root, rel), 'utf8'); } catch { return undefined; }
  }));
  violations.push(...checkFooterDisclaimer(await loadFooter(root)));
  return { files, violations };
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..', '..'));
  const { files, violations } = await lintRepo(root);
  for (const v of violations) console.error(`${v.file}:${v.line}:${v.col} ${v.rule}\n    ${v.text}`);
  console.log(`naming lint: ${files} files under ${root}, ${violations.length} violation(s)`);
  process.exit(violations.length ? 1 : 0);
}
