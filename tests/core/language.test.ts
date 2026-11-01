import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TomeError } from '../../src/core/errors.ts';
import { loadSourceLanguage, loadTargetLanguage } from '../../src/core/language.ts';
import { validateLanguage } from '../../src/core/schema.ts';
import { parse } from 'yaml';

describe('the language profiles', () => {
  it.each(['languages/source/en.yaml', 'languages/target/zh-TW.yaml'])('%s is valid', (path) => {
    expect(validateLanguage(parse(readFileSync(path, 'utf8'))).ok).toBe(true);
  });

  it('loads the source profile', () => {
    const { profile, hash } = loadSourceLanguage('en');
    expect(profile.kind).toBe('source');
    expect(profile.writing_mode).toBe('horizontal-tb');
    expect(profile.normalize.replace['ﬁ']).toBe('fi');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses the primary language when a region has no profile of its own', () => {
    expect(loadSourceLanguage('en-GB').profile.lang).toBe('en');
  });

  it('loads the target profile with the five pronouns', () => {
    const { profile } = loadTargetLanguage('zh-TW');
    expect(profile.pronouns).toEqual(['他', '她', '牠', '它', '祂']);
    expect(profile.punctuation.quotes.open).toBe('「');
  });

  it('leaves pronouns to the entity cards, not to a game concept', () => {
    const { profile } = loadTargetLanguage('zh-TW');
    expect(profile.style_guide).toContain('代名詞依實體卡。');
    expect(profile.style_guide.join('')).not.toMatch(/神祇|超自然/);
  });

  it.each([
    ['source', () => loadSourceLanguage('xx')],
    ['target', () => loadTargetLanguage('xx')],
    ['a target used as a source', () => loadSourceLanguage('zh-TW')],
  ])('reports an unknown language: %s', (_name, load) => {
    expect(load).toThrow(TomeError);
    try {
      load();
    } catch (error) {
      expect((error as TomeError).code).toBe('language.unknown');
    }
  });
});
