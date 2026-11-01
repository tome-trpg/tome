import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TomeError } from '../../src/core/errors.ts';
import { loadSourceLanguage, loadTargetLanguage, scriptViolations } from '../../src/core/language.ts';
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

  describe('finding another script (ADR-0102)', () => {
    // 樣本用碼位寫，受版控的文字檔才不用開例外（ADR-0086）。
    const SHARED = String.fromCodePoint(0x7136, 0x540e);
    const check = loadTargetLanguage('zh-TW').profile.script_check;

    it('goes by the data alone', () => {
      expect(scriptViolations(check, SHARED)).toHaveLength(1);
      expect(scriptViolations({ ...check, shared_forms: '' }, SHARED)).toEqual([]);
      expect(scriptViolations({ ...check, allowed_words: [SHARED] }, SHARED)).toEqual([]);
      expect(scriptViolations({ ...check, misused_words: ['渡口'] }, '渡口')).toEqual(['渡口']);
    });

    describe('where an allowed word could hide a misused one', () => {
      const SHARED_FORM = String.fromCodePoint(0x540e);

      it.each(['三天', '十天', '幾天', '半天', '當天', '昨天', '拆封', '解封'])(
        'finds %s followed by the wrong form',
        (start) => {
          expect(scriptViolations(check, `${start}${SHARED_FORM}再說`)).toEqual([`${start}${SHARED_FORM}`]);
        },
      );

      it.each(['天后', '這位天后', '歌壇天后登臺', '封后', '她封后了', '皇后', '后土'])('leaves %s alone', (text) => {
        expect(scriptViolations(check, text)).toEqual([]);
      });
    });

    it('lets an allowed word hold a character the encoding does not have', () => {
      const rare = String.fromCodePoint(0x3402);
      expect(scriptViolations(check, rare)).toEqual([rare]);
      expect(scriptViolations({ ...check, allowed_words: [`甲${rare}`] }, `甲${rare}`)).toEqual([]);
    });

    it('counts a repeated finding once', () => {
      expect(scriptViolations(check, `${SHARED}${SHARED}`)).toHaveLength(1);
    });
  });

  it('leaves pronouns to the entity cards, not to a game concept', () => {
    const { profile } = loadTargetLanguage('zh-TW');
    expect(profile.style_guide).toContain('代名詞依實體卡，沒有實體卡時依上下文判斷。');
    expect(profile.style_guide.join('')).not.toMatch(/神祇|超自然/);
  });

  it.each([
    ['source', 'language.unknown', () => loadSourceLanguage('xx')],
    ['target', 'language.unknown_target', () => loadTargetLanguage('xx')],
    ['a target used as a source', 'language.unknown', () => loadSourceLanguage('zh-TW')],
  ])('reports an unknown language: %s', (_name, code, load) => {
    expect(load).toThrow(TomeError);
    try {
      load();
    } catch (error) {
      expect((error as TomeError).code).toBe(code);
    }
  });
});
