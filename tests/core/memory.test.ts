import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTargetLanguage } from '../../src/core/language.ts';
import { maskText } from '../../src/core/mask.ts';
import { memoryKey, recall, remember, styleVersion, type KeyContext } from '../../src/core/memory.ts';
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
});
