import { describe, expect, test } from 'bun:test';
import { checkDisclaimer, checkFooterDisclaimer, DISCLAIMER, isPublicText, lintRepo, lintText } from './naming-lint';
import { FOOTER_DISCLOSURES, NON_AFFILIATION } from '../src/content/disclosures';
import { join } from 'node:path';

// Built by concatenation so this file never contains the phrase.
const P = 'tokenized' + ' stock';

describe('naming lint', () => {
  test('bare phrase fails anywhere', () => {
    expect(lintText(`We list ${P}s here.`, 'docs/x.md', false)).toHaveLength(1);
  });
  test('British spelling and hyphen fail too', () => {
    expect(lintText('tokenised' + '-stock', 'docs/x.md', false)).toHaveLength(1);
  });
  test('quoted phrase in a verbatim rule passes', () => {
    const rule = `- 5.7(j): "You must not describe ... as "${P}s," "tokenized equities," or similar"`;
    expect(lintText(rule, 'docs/SPEC.md', false)).toHaveLength(0);
  });
  test('site rules: stock token wording, bare Robinhood, HOOD', () => {
    expect(lintText('Buy Stock' + ' Tokens', 'site/src/a.tsx', true)).toHaveLength(1);
    expect(lintText('Robin' + 'hood app', 'site/src/a.tsx', true)).toHaveLength(1);
    expect(lintText('$' + 'HOOD', 'site/src/a.tsx', true)).toHaveLength(1);
    expect(lintText('Built on Robinhood Chain; not affiliated with Robinhood Markets, Inc.', 'site/src/a.tsx', true)).toHaveLength(0);
  });
  test('site rules do not apply outside the site', () => {
    expect(lintText('Stock' + ' Tokens', 'docs/SPEC.md', false)).toHaveLength(0);
  });
  test('the root README gets the public text rules, docs do not', () => {
    expect(isPublicText('README.md')).toBe(true);
    expect(isPublicText('site/src/a.tsx')).toBe(true);
    expect(isPublicText('docs/SPEC.md')).toBe(false);
    expect(isPublicText('keeper/README.md')).toBe(false);
  });
  test('disclaimer: present in both files passes, missing text or file fails', () => {
    const ok = `x\nThis project is ${DISCLAIMER} It is built on Robinhood Chain.`;
    expect(checkDisclaimer(() => ok)).toHaveLength(0);
    const wrapped = ok.replace('endorsed by,', 'endorsed by,\n   ');
    expect(checkDisclaimer(() => wrapped)).toHaveLength(0);
    expect(checkDisclaimer((f) => (f === 'README.md' ? 'no disclaimer' : ok))).toHaveLength(1);
    expect(checkDisclaimer(() => undefined)).toHaveLength(2);
  });
  // With the item removed from FOOTER_DISCLOSURES and the NON_AFFILIATION constant kept, the text check
  // passed while no page footer showed the disclaimer.
  test('disclaimer: the footer list must carry it, not only the source text', () => {
    expect(checkFooterDisclaimer(FOOTER_DISCLOSURES)).toEqual([]);
    const without = FOOTER_DISCLOSURES.filter((d) => d.text !== NON_AFFILIATION);
    expect(without.length).toBe(FOOTER_DISCLOSURES.length - 1);
    expect(checkDisclaimer(() => `const NON_AFFILIATION = '${NON_AFFILIATION}';`)).toHaveLength(0);
    expect(checkFooterDisclaimer(without)).toHaveLength(1);
    expect(checkFooterDisclaimer(undefined)).toHaveLength(1);
  });
  test('the repository passes (gate G6)', async () => {
    const { files, violations } = await lintRepo(join(import.meta.dir, '..', '..'));
    expect(files).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
