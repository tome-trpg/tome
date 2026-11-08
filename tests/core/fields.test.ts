import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fieldFragment, fieldLabels, fieldUnits, fieldWords, type FieldWord } from '../../src/core/fields.ts';
import { loadTargetLanguage } from '../../src/core/language.ts';
import { maskText } from '../../src/core/mask.ts';
import { resolvePack, termsFor, type LocalizedTerm, type ResolvedPack } from '../../src/core/pack.ts';
import type { EntityCard } from '../../src/core/entities.ts';
import type { TranslationUnit } from '../../src/core/units.ts';
import { bookTerms } from '../../src/core/verify.ts';
import { tempDir } from '../helpers.ts';

// 文字都是合成的：虛構的遊戲系統（tests/fixtures/packs/stat-fixture，ADR-0121）。

const ROLE = 'stat-fixture:stat_block';
const { profile: language } = loadTargetLanguage('zh-TW');

function fixture(): ResolvedPack {
  const { pack } = resolvePack(tempDir(), { dir: resolve('tests/fixtures/packs/stat-fixture'), source: 'path' });
  if (pack === null) throw new Error('stat-fixture did not load');
  return pack;
}

const word = (text: string, target: string, match?: FieldWord['match']): FieldWord => ({
  text,
  target,
  ...(match === undefined ? {} : { match }),
});
const term = (text: string, target: string, extra: Partial<LocalizedTerm['term']> = {}): LocalizedTerm => ({
  text,
  term: { source: { en: text }, target, ...extra },
});
const GRIT = word('Grit', '韌性');
const WITS = word('Wits', '機智');

describe('fieldLabels', () => {
  it('reads the labels of a role in the source language, and the primary language for a regional tag', () => {
    expect(fieldLabels(fixture(), ROLE, 'en')).toEqual(['Grit', 'Wits', 'Reach', 'Ward', 'Stride', 'Knack']);
    expect(fieldLabels(fixture(), ROLE, 'en-GB')).toEqual(['Grit', 'Wits', 'Reach', 'Ward', 'Stride', 'Knack']);
  });

  it('has nothing for a role without fields, an unknown role or a language with no labels', () => {
    expect(fieldLabels(fixture(), 'generic:read_aloud', 'en')).toEqual([]);
    expect(fieldLabels(fixture(), 'paragraph', 'en')).toEqual([]);
    expect(fieldLabels(fixture(), ROLE, 'ja')).toEqual([]);
  });

  it('prefers the exact language over the primary one', () => {
    const pack = fixture();
    const roles = pack.roles.map((role) =>
      role.name === 'stat_block' ? { ...role, fields: [{ en: 'Grit', 'en-GB': 'Grittiness' }] } : role,
    );
    expect(fieldLabels({ ...pack, roles }, ROLE, 'en-GB')).toEqual(['Grittiness']);
  });
});

describe('fieldWords', () => {
  it('keeps the labels that have a translation, then adds the locked names', () => {
    const terms = [term('Grit', '韌性'), term('Lantern', '提燈')];
    const names = [term('Tide Warden', '潮汐守衛')];
    expect(fieldWords(['Grit', 'Knack'], terms, names)).toStrictEqual([word('Grit', '韌性'), word('Tide Warden', '潮汐守衛')]);
  });

  it('carries the match settings, and leaves out keep_source terms and names, which are hidden', () => {
    const terms = [term('Grit', '韌性', { match: { case_sensitive: false } }), term('Ward', 'Ward', { keep_source: true })];
    const names = [term('Old Tongue', 'Old Tongue', { keep_source: true })];
    expect(fieldWords(['Grit', 'Ward'], terms, names)).toEqual([word('Grit', '韌性', { case_sensitive: false })]);
  });

  it('lists a name once when it is also a label', () => {
    expect(fieldWords(['Grit'], [term('Grit', '韌性')], [term('Grit', '堅毅')])).toEqual([word('Grit', '韌性')]);
  });
});

describe('fieldFragment', () => {
  const fragment = (source: string, words: readonly FieldWord[] = [GRIT, WITS], role = ROLE): string | null =>
    fieldFragment(maskText(source, []).masked, role, words);

  it('swaps the labels and keeps the numbers', () => {
    expect(fragment('Grit 12 Wits 9')).toBe('<s id="1">韌性 12　機智 9</s>');
  });

  it('turns the space between two fields into one full-width space, and drops the space around punctuation', () => {
    expect(fragment('Grit 12, Wits 9')).toBe('<s id="1">韌性 12,機智 9</s>');
    expect(fragment('Grit 12 ( Wits : 9 )')).toBe('<s id="1">韌性 12(機智:9)</s>');
    expect(fragment('Grit 12\nWits 9')).toBe('<s id="1">韌性 12\n機智 9</s>');
  });

  it('keeps the spaces of a comma or a period between two digits, so 2, 4 does not read as one number', () => {
    expect(fragment('Grit 2, 4')).toBe('<s id="1">韌性 2, 4</s>');
    expect(fragment('Grit 1 . 5')).toBe('<s id="1">韌性 1 . 5</s>');
    expect(fragment('Grit 2,4 Wits 1')).toBe('<s id="1">韌性 2,4　機智 1</s>');
    expect(fragment('Grit 2 ; 4')).toBe('<s id="1">韌性 2;4</s>');
  });

  it('leaves the spaces before the first word alone', () => {
    expect(fragment('3 Grit 12')).toBe('<s id="1">3 韌性 12</s>');
  });

  it('gives nothing when a letter is left over, before, between or after the fields', () => {
    expect(fragment('So Grit 12 Wits 9')).toBeNull();
    expect(fragment('Grit 12 and Wits 9')).toBeNull();
    expect(fragment('Grit 12 Wits 9 total')).toBeNull();
  });

  it('gives nothing without a word to swap, or without words', () => {
    expect(fragment('12 9')).toBeNull();
    expect(fragment('Grit 12', [])).toBeNull();
  });

  it('follows the match settings: whole words, case and roles', () => {
    expect(fragment('Gritty 12')).toBeNull();
    expect(fragment('grit 12')).toBeNull();
    expect(fragment('grit 12', [word('Grit', '韌性', { case_sensitive: false })])).toBe('<s id="1">韌性 12</s>');
    expect(fragment('Grit 12', [word('Grit', '韌性', { roles: ['heading'] })])).toBeNull();
    expect(fragment('Grit 12', [word('Grit', '韌性', { roles: [ROLE] })])).toBe('<s id="1">韌性 12</s>');
  });

  it('takes the longer word where two start together, and does not reuse overlapping text', () => {
    const words = [word('Grit', '韌性'), word('Grit Check', '韌性檢定')];
    expect(fragment('Grit Check 3', words)).toBe('<s id="1">韌性檢定 3</s>');
    expect(fragment('Tide Warden Grit 12', [word('Tide Warden', '潮汐守衛'), GRIT])).toBe('<s id="1">潮汐守衛　韌性 12</s>');
  });

  it('keeps placeholders by id, and styled text in its <pc>', () => {
    const dice = maskText('Grit 1D6+1', [{ start: 5, end: 10, kind: 'dice' }]);
    expect(fieldFragment(dice.masked, ROLE, [GRIT])).toBe('<s id="1">韌性 <ph id="1"/></s>');
    const bold = maskText('Grit 12 Wits 9', [], [{ start: 0, end: 4, marks: ['bold'] }]);
    expect(fieldFragment(bold.masked, ROLE, [GRIT, WITS])).toBe('<s id="1"><pc id="1">韌性</pc> 12　機智 9</s>');
    const styledWord = maskText('Grit 12 Wits word', [], [{ start: 0, end: 4, marks: ['bold'] }]);
    expect(fieldFragment(styledWord.masked, ROLE, [GRIT, WITS])).toBeNull();
  });

  it('sees the space before a styled label as the space between two fields', () => {
    const styled = maskText('Grit 12 Wits 9', [], [{ start: 8, end: 12, marks: ['bold'] }]);
    expect(fieldFragment(styled.masked, ROLE, [GRIT, WITS])).toBe('<s id="1">韌性 12　<pc id="1">機智</pc> 9</s>');
    const both = maskText('Grit 12 Wits 9', [], [
      { start: 0, end: 4, marks: ['bold'] },
      { start: 8, end: 12, marks: ['bold'] },
    ]);
    expect(fieldFragment(both.masked, ROLE, [GRIT, WITS])).toBe('<s id="1"><pc id="1">韌性</pc> 12　<pc id="2">機智</pc> 9</s>');
    const first = maskText('Grit 12', [], [{ start: 0, end: 4, marks: ['bold'] }]);
    expect(fieldFragment(first.masked, ROLE, [GRIT])).toBe('<s id="1"><pc id="1">韌性</pc> 12</s>');
  });

  it('keeps the space before styled text that does not start with a word, or that comes before any word', () => {
    const number = maskText('Grit 12 Wits 9', [], [{ start: 5, end: 12, marks: ['bold'] }]);
    expect(fieldFragment(number.masked, ROLE, [GRIT, WITS])).toBe('<s id="1">韌性 <pc id="1">12　機智</pc> 9</s>');
    const leading = maskText(' Grit 12', [], [{ start: 1, end: 5, marks: ['bold'] }]);
    expect(fieldFragment(leading.masked, ROLE, [GRIT])).toBe('<s id="1"> <pc id="1">韌性</pc> 12</s>');
  });

  it('does not count styled text that starts with a placeholder as starting with a word', () => {
    const spaced = maskText('Grit 1D6 Wits 9', [{ start: 5, end: 8, kind: 'dice' }], [{ start: 5, end: 13, marks: ['bold'] }]);
    expect(fieldFragment(spaced.masked, ROLE, [GRIT, WITS])).toBe('<s id="1">韌性 <pc id="1"><ph id="1"/>　機智</pc> 9</s>');
    const joined = maskText('Grit 1D6Wits 9', [{ start: 5, end: 8, kind: 'dice' }], [{ start: 5, end: 12, marks: ['bold'] }]);
    expect(fieldFragment(joined.masked, ROLE, [GRIT, WITS])).toBe('<s id="1">韌性 <pc id="1"><ph id="1"/>機智</pc> 9</s>');
  });

  it('escapes what it writes, and reads the book text unescaped', () => {
    expect(fragment('Grit 1 & Wits 2', [word('Grit', '韌<性'), WITS])).toBe('<s id="1">韌&lt;性 1 &amp;　機智 2</s>');
  });
});

describe('fieldUnits', () => {
  function unit(source: string, extra: Partial<TranslationUnit> = {}): TranslationUnit {
    return { unit_id: 'u1', block_id: 'b1', role: ROLE, source, ...maskText(source, []), ...extra };
  }
  const options = (extra: { terms?: readonly LocalizedTerm[]; names?: readonly LocalizedTerm[] } = {}) => {
    const pack = fixture();
    return { pack, sourceLang: 'en', terms: extra.terms ?? termsFor(pack, 'en'), names: extra.names ?? [], language };
  };

  it('translates a whole stat block on this machine, formatted like a reply from the model', () => {
    const found = fieldUnits([unit('Grit 12, Wits 9, Stride 10%')], options());
    expect(found.get('u1')).toEqual({ translation: '韌性12，機智9，步幅10%', paired: [] });
  });

  it('skips units that need no model, roles without fields, and blocks that do not match', () => {
    const units = [
      unit('12 9', { needs_llm: false }),
      unit('Grit 12', { unit_id: 'u2', role: 'paragraph' }),
      unit('Grit 12 Knack 4', { unit_id: 'u3' }),
      unit('Tide Warden 12', { unit_id: 'u4', role: 'paragraph' }),
    ];
    expect(fieldUnits(units, options({ names: [term('Tide Warden', '潮汐守衛')] })).size).toBe(0);
  });

  it('takes a locked name, and the translation of a label from the book over the pack', () => {
    const pack = fixture();
    const card = (source: string, target: string): EntityCard => ({
      id: 1,
      source,
      target,
      class: null,
      gender: null,
      pronoun: null,
      register: null,
      keep_source: false,
      match: null,
      status: 'locked',
    });
    const terms = bookTerms(termsFor(pack, 'en'), [card('Grit', '堅毅')]);
    const names = bookTerms([], [card('Tide Warden', '潮汐守衛')]);
    const found = fieldUnits([unit('Tide Warden Grit 12 Wits 9')], options({ terms, names }));
    expect(found.get('u1')?.translation).toBe('潮汐守衛　堅毅12　機智9');
  });

  it('sends the block to the model when the swapped text does not pass verification', () => {
    const simplified = String.fromCodePoint(0x95e8);
    const terms = [term('Grit', simplified), ...termsFor(fixture(), 'en')];
    expect(fieldUnits([unit('Grit 12 Wits 9')], options({ terms })).size).toBe(0);
  });

  it('says where a <pc> landed in the translation', () => {
    const styled = unit('Grit 12 Wits 9', maskText('Grit 12 Wits 9', [], [{ start: 0, end: 4, marks: ['bold'] }]));
    expect(fieldUnits([styled], options()).get('u1')).toEqual({ translation: '韌性12　機智9', paired: [{ id: 1, start: 0, end: 2 }] });
  });
});
