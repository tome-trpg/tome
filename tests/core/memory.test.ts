import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTargetLanguage } from '../../src/core/language.ts';
import { maskText } from '../../src/core/mask.ts';
import { memoryKey, recall, remember, replaceTarget, styleVersion, type KeyContext } from '../../src/core/memory.ts';
import type { LocalizedTerm } from '../../src/core/pack.ts';
import { openSeriesStore } from '../../src/core/store.ts';
import type { VerifyContext } from '../../src/core/verify.ts';
import { tempDir } from '../helpers.ts';

// 文字都是這裡編的。

const { profile } = loadTargetLanguage('zh-TW');
const LONG = 'The warden counts the tide stones before each crossing and marks a lantern for the ferry.';

function unit(source: string, role = 'paragraph') {
  return { source, role, ...maskText(source, []) };
}

function term(text: string, target: string): LocalizedTerm {
  return { text, term: { source: { en: text }, target } };
}

function keyContext(overrides: Partial<KeyContext> = {}): KeyContext {
  return { terms: [], targetLang: 'zh-TW', style: undefined, ...overrides };
}

function verifyContext(overrides: Partial<VerifyContext> = {}): VerifyContext {
  return { language: profile, terms: [], phraseCheck: () => [], ...overrides };
}

const ENTRY = {
  fragment: '<s id="1">守望者在每次渡河前清點潮石，並在提燈上做記號，等待晨鐘響起再出發。</s>',
  model: 'model-a',
  prompt_hash: 'p'.repeat(64),
  pack_hash: 'q'.repeat(64),
  sdk_version: '0.0.0',
  book: 'book',
};

describe('the memory key (ADR-0102)', () => {
  const key = (source: string, previous: string | null = null, context = keyContext()): string =>
    memoryKey(unit(source), previous, context);

  it('is stable', () => {
    expect(key(LONG)).toBe(key(LONG));
    expect(key(LONG)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with the text, the target language and the style', () => {
    expect(key(`${LONG}!`)).not.toBe(key(LONG));
    expect(key(LONG, null, keyContext({ targetLang: 'ja' }))).not.toBe(key(LONG));
    expect(key(LONG, null, keyContext({ style: 'Plain.' }))).not.toBe(key(LONG));
  });

  it('treats dice with different values the same, since they are hidden', () => {
    const roll = (dice: string) => {
      const source = `Roll ${dice} for the crossing tonight at the old ferry by the marsh.`;
      return { source, role: 'paragraph', ...maskText(source, [{ start: 5, end: 5 + dice.length, kind: 'dice' }]) };
    };
    expect(memoryKey(roll('1D6'), null, keyContext())).toBe(memoryKey(roll('1D100'), null, keyContext()));
  });

  it('changes with the locked target of a term the text hits', () => {
    const terms = [term('warden', '守望者')];
    const other = [term('warden', '看守人')];
    expect(key(LONG, null, keyContext({ terms }))).not.toBe(key(LONG, null, keyContext({ terms: other })));
  });

  it('ignores a term the text does not hit', () => {
    expect(key(LONG, null, keyContext({ terms: [term('Marsh', '鹽沼')] }))).toBe(key(LONG));
  });

  it('does not care in which order the terms are listed', () => {
    const terms = [term('warden', '守望者'), term('lantern', '提燈')];
    const reversed = [...terms].reverse();
    expect(key(LONG, null, keyContext({ terms }))).toBe(key(LONG, null, keyContext({ terms: reversed })));
  });

  it('reads the paragraph before a short one, so It moves. picks the right pronoun', () => {
    expect(key('It moves.', 'The god wakes.')).not.toBe(key('It moves.', 'The dog wakes.'));
    expect(key('It moves.', null)).not.toBe(key('It moves.', 'The god wakes.'));
  });

  it('does not read the paragraph before a long one', () => {
    expect(key(LONG, 'The god wakes.')).toBe(key(LONG, 'The dog wakes.'));
  });

  it('puts the limit at 40 characters of visible text', () => {
    const at = 'a'.repeat(40);
    const over = 'a'.repeat(41);
    expect(key(at, 'one')).not.toBe(key(at, 'two'));
    expect(key(over, 'one')).toBe(key(over, 'two'));
  });

  it('does not depend on the model', () => {
    expect(key(LONG)).toBe(key(LONG));
    expect(Object.keys(keyContext())).not.toContain('model');
  });
});

describe('the memory key with entity cards (ADR-0120)', () => {
  const key = (terms: readonly LocalizedTerm[]): string => memoryKey(unit(LONG), null, keyContext({ terms }));
  const card = (attributes: LocalizedTerm['attributes']): LocalizedTerm => ({
    ...term('warden', '守望者'),
    ...(attributes === undefined ? {} : { attributes }),
  });

  it('is the same as before 037 when only pack terms hit, so stored translations still match', () => {
    // 照 037 之前的算法在測試外算好的值：命中詞條的摘要只有 [原文, 譯名]。
    expect(key([term('warden', '守望者')])).toBe('f810fdfd7754fb47e6384b8c305008756867a5eb920549331b72cb37ebfc32b3');
  });

  it('treats a card without attributes like a pack term', () => {
    expect(key([card(undefined)])).toBe(key([term('warden', '守望者')]));
  });

  it.each([
    ['gender', { gender: 'female' }, { gender: 'male' }],
    ['pronoun', { pronoun: '她' }, { pronoun: '祂' }],
    ['register', { register: 'formal' }, { register: 'archaic' }],
  ] as const)('changes with the %s of a card the text hits', (_name, one, other) => {
    expect(key([card(one)])).not.toBe(key([card(other)]));
    expect(key([card(one)])).not.toBe(key([term('warden', '守望者')]));
  });

  it('keeps each attribute in its own place, so a pronoun is not read as a gender', () => {
    expect(key([card({ gender: '她' })])).not.toBe(key([card({ pronoun: '她' })]));
    expect(key([card({ pronoun: 'formal' })])).not.toBe(key([card({ register: 'formal' })]));
  });

  it('ignores the attributes of a card the text does not hit', () => {
    const marsh = { ...term('Marsh', '鹽沼'), attributes: { pronoun: '它' } };
    expect(key([marsh])).toBe(key([]));
  });

  it('does not care in which order cards with attributes are listed', () => {
    const terms = [card({ pronoun: '她' }), { ...term('lantern', '提燈'), attributes: { register: 'plain' } }];
    expect(key(terms)).toBe(key([...terms].reverse()));
  });
});

describe('replaceTarget (S-16, ADR-0120)', () => {
  it('replaces every whole occurrence and counts them', () => {
    expect(replaceTarget('<s id="1">鹽沼的風吹過鹽沼。</s>', '鹽沼', '鹽澤', [])).toEqual({
      fragment: '<s id="1">鹽澤的風吹過鹽澤。</s>',
      count: 2,
    });
  });

  it('replaces occurrences that touch each other', () => {
    expect(replaceTarget('<s id="1">鹽沼鹽沼</s>', '鹽沼', '鹽澤', [])).toEqual({ fragment: '<s id="1">鹽澤鹽澤</s>', count: 2 });
  });

  it('leaves the old name alone inside a longer locked name, and changes it outside', () => {
    expect(replaceTarget('<s id="1">鹽沼守衛巡過鹽沼。</s>', '鹽沼', '鹽澤', ['鹽沼守衛'])).toEqual({
      fragment: '<s id="1">鹽沼守衛巡過鹽澤。</s>',
      count: 1,
    });
    expect(replaceTarget('<s id="1">鹽沼。鹽沼守衛</s>', '鹽沼', '鹽澤', ['鹽沼守衛']).fragment).toBe('<s id="1">鹽澤。鹽沼守衛</s>');
  });

  it('protects a longer name that ends with the old one', () => {
    expect(replaceTarget('<s id="1">大鹽沼與鹽沼</s>', '鹽沼', '鹽澤', ['大鹽沼'])).toEqual({
      fragment: '<s id="1">大鹽沼與鹽澤</s>',
      count: 1,
    });
  });

  it('works on text without tags, with the old name or a longer name at the very start', () => {
    expect(replaceTarget('鹽沼與潮石', '鹽沼', '鹽澤', [])).toEqual({ fragment: '鹽澤與潮石', count: 1 });
    expect(replaceTarget('鹽沼守衛與鹽沼', '鹽沼', '鹽澤', ['鹽沼守衛'])).toEqual({ fragment: '鹽沼守衛與鹽澤', count: 1 });
  });

  it('protects only the longer names that contain the old one', () => {
    expect(replaceTarget('<s id="1">鹽沼</s>', '鹽沼', '鹽澤', ['鹽沼', '守衛', '沼']).fragment).toBe('<s id="1">鹽澤</s>');
  });

  it('stops after one pass when the new name contains the old one, and keeps the new one already there', () => {
    expect(replaceTarget('<s id="1">鹽沼與鹽沼地</s>', '鹽沼', '鹽沼地', ['鹽沼地'])).toEqual({
      fragment: '<s id="1">鹽沼地與鹽沼地</s>',
      count: 1,
    });
  });

  it('does not touch tag attributes, only the text', () => {
    const fragment = '<s id="1"><new-term source="鹽沼">鹽沼</new-term></s>';
    expect(replaceTarget(fragment, '鹽沼', '鹽澤', [])).toEqual({
      fragment: '<s id="1"><new-term source="鹽沼">鹽澤</new-term></s>',
      count: 1,
    });
  });

  it('finds and writes names with characters that are escaped in the fragment', () => {
    expect(replaceTarget('<s id="1">甲&amp;乙，甲&amp;乙</s>', '甲&乙', '丙<丁', [])).toEqual({
      fragment: '<s id="1">丙&lt;丁，丙&lt;丁</s>',
      count: 2,
    });
  });

  it('changes nothing when the old name is empty or not there', () => {
    expect(replaceTarget('<s id="1">鹽沼</s>', '', '鹽澤', [])).toEqual({ fragment: '<s id="1">鹽沼</s>', count: 0 });
    expect(replaceTarget('<s id="1">潮石</s>', '鹽沼', '鹽澤', [])).toEqual({ fragment: '<s id="1">潮石</s>', count: 0 });
  });
});

describe('the style version (ADR-0050)', () => {
  it('hashes the text, and an empty string when a role has none', () => {
    expect(styleVersion('Plain.')).toMatch(/^[0-9a-f]{64}$/);
    expect(styleVersion('Plain.')).not.toBe(styleVersion(undefined));
    expect(styleVersion(undefined)).toBe(styleVersion(''));
  });
});

describe('remember and recall', () => {
  function store() {
    return openSeriesStore(join(tempDir(), 'home'), 'book');
  }

  it('gives back what passes verification', () => {
    const series = store();
    expect(remember(series, 'key', ENTRY, unit(LONG), verifyContext())).toBe(true);
    const found = recall(series, 'key', unit(LONG), verifyContext());
    series.close();
    expect(found?.entry).toMatchObject({ model: 'model-a', book: 'book' });
    expect(found?.translation).toBe('守望者在每次渡河前清點潮石，並在提燈上做記號，等待晨鐘響起再出發。');
  });

  it('has nothing for a key it never saw', () => {
    const series = store();
    expect(recall(series, 'other', unit(LONG), verifyContext())).toBeNull();
    series.close();
  });

  it('treats a stored translation that no longer passes as a miss (ADR-0102)', () => {
    const series = store();
    remember(series, 'key', ENTRY, unit(LONG), verifyContext());
    const terms = [term('warden', '看守人')];
    expect(recall(series, 'key', unit(LONG), verifyContext({ terms }))).toBeNull();
    series.close();
  });

  it('refuses a translation that does not pass, so it never comes back (ADR-0102)', () => {
    const series = store();
    const bad = { ...ENTRY, fragment: '<s id="1">摘要。</s>' };
    expect(remember(series, 'key', bad, unit(LONG), verifyContext())).toBe(false);
    expect(series.all('SELECT key FROM memory')).toEqual([]);
    series.close();
  });

  it('keeps the first translation of a key, the same text does not change', () => {
    const series = store();
    remember(series, 'key', ENTRY, unit(LONG), verifyContext());
    remember(series, 'key', { ...ENTRY, model: 'model-b' }, unit(LONG), verifyContext());
    expect(recall(series, 'key', unit(LONG), verifyContext())?.entry.model).toBe('model-a');
    series.close();
  });

  it('restores the dice of this unit, not of the unit it was stored from', () => {
    const series = store();
    const roll = (dice: string) => {
      const source = `Roll ${dice} for the crossing tonight at the old ferry by the marsh.`;
      return { source, role: 'paragraph', ...maskText(source, [{ start: 5, end: 5 + dice.length, kind: 'dice' }]) };
    };
    const fragment = '<s id="1">今晚渡河前，在沼澤旁的老渡口擲<ph id="1"/>，看看運氣如何。</s>';
    expect(remember(series, 'key', { ...ENTRY, fragment }, roll('1D6'), verifyContext())).toBe(true);
    expect(recall(series, 'key', roll('1D100'), verifyContext())?.translation).toContain('擲1D100');
    series.close();
  });

  it('says where each <pc> landed, and keeps no style in the memory (ADR-0116)', () => {
    const series = store();
    const styled = (marks: ('bold' | 'italic')[]) => ({
      source: LONG,
      role: 'paragraph',
      ...maskText(LONG, [], [{ start: 4, end: 10, marks }]),
    });
    const fragment = '<s id="1"><pc id="1">守望者</pc>在每次渡河前清點潮石，並在提燈上做記號，等待晨鐘響起再出發。</s>';
    expect(remember(series, 'key', { ...ENTRY, fragment }, styled(['bold']), verifyContext())).toBe(true);
    const found = recall(series, 'key', styled(['italic']), verifyContext());
    series.close();
    expect(found?.paired).toEqual([{ id: 1, start: 0, end: 3 }]);
    expect(found?.entry.fragment).not.toContain('bold');
  });
});
