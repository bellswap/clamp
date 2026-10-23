import { describe, expect, test } from 'bun:test';
import { neverRules, separation, textLines, wordRules } from './copy-rules';

describe('copy rules (port of launch-copy check_copy.py)', () => {
  test('banned words, negation-only words, channel bans', () => {
    expect(wordRules(['The price will moon soon.'], ['site']).map((v) => v.match)).toEqual(['moon', 'soon']);
    expect(wordRules(['It will be listed.'], ['site']).map((v) => v.match)).toEqual(['will be']);
    expect(wordRules(['It is designed to equal the reference.'], ['site']).length).toBe(1);
    expect(wordRules(['It is not designed or promised to equal the reference.'], ['site'])).toEqual([]);
    expect(wordRules(['buy it'], ['reference']).map((v) => v.match)).toEqual(['buy']);
    expect(wordRules(['Built on Robinhood Chain.'], ['site'])).toEqual([]);
    expect(wordRules(['Robinhood Markets, Inc.'], ['site']).length).toBe(1);
  });
  test('neverRules: banned and channel words only, no negation-only words and no Robinhood rule', () => {
    expect(neverRules(['The price will moon soon.'], ['site']).map((v) => v.match)).toEqual(['moon', 'soon']);
    expect(neverRules(['It is designed to equal the reference.'], ['site'])).toEqual([]);
    expect(neverRules(['Robinhood Markets, Inc.'], ['site'])).toEqual([]);
    expect(neverRules(['It may trade at a discount, up to 44x.'], ['site']).map((v) => v.match)).toEqual(['44x', 'discount']);
  });
  test('text lines split at tags and decode entities', () => {
    expect(textLines('<p>a<!-- -->b</p><p>it&#x27;s</p>')).toEqual(['ab', "it's"]);
  });
  test('separation: different sections, separator between', () => {
    const ok = '<section id="a"><p id="ref-price">1</p></section><div class="tk-wall">w</div><section id="b"><p id="meme-price">2</p></section>';
    expect(separation(ok)).toEqual([]);
    const same = '<section id="a"><p id="ref-price">1</p><div class="tk-wall">w</div><p id="meme-price">2</p></section>';
    expect(separation(same).length).toBe(1);
    const noWall = '<section id="a"><p id="ref-price">1</p></section><section id="b"><p id="meme-price">2</p></section>';
    expect(separation(noWall)).toEqual(['separator is not between the reference and the pool price']);
  });
});
