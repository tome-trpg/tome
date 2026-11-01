import { describe, expect, it } from 'vitest';
import { checkConservation, MISSING_MIN } from '../../src/core/conservation.ts';
import { loadSourceLanguage } from '../../src/core/language.ts';

const { profile: language } = loadSourceLanguage('en');
const LINE = 'the warden of salt marsh counts tide stones before each crossing';

describe('character conservation', () => {
  it('passes when every character landed in a block, in any order', () => {
    const result = checkConservation(language, [LINE], LINE.split(' ').reverse(), 0);
    expect(result).toMatchObject({ missing: 0, passed: true });
    expect(result.total).toBe(LINE.replaceAll(' ', '').length);
  });

  it('fails a page that lost a whole line', () => {
    const page = Array.from({ length: 20 }, () => LINE);
    const result = checkConservation(language, page, page.slice(1), 0);
    expect(result.missing).toBe(LINE.replaceAll(' ', '').length);
    expect(result.passed).toBe(false);
  });

  it('forgives a few characters on a short page, but not more', () => {
    const page = 'short heading of a page';
    expect(checkConservation(language, [page], [page.slice(MISSING_MIN)], 0).passed).toBe(true);
    expect(checkConservation(language, [page], [page.slice(MISSING_MIN + 2)], 0).passed).toBe(false);
  });

  it('ignores spaces, hyphens and ligatures', () => {
    const result = checkConservation(language, ['a ﬁne tra-', 'vellers ﬂoat'], ['a fine travellers float'], 0);
    expect(result).toMatchObject({ missing: 0, passed: true });
  });

  it('takes invisible text off what is missing', () => {
    const hidden = 'a line nobody can see on this page at all';
    const result = checkConservation(language, [LINE, hidden], [LINE], hidden.replaceAll(' ', '').length);
    expect(result).toMatchObject({ missing: 0, passed: true });
  });

  it('does not mind an engine that reads a character twice', () => {
    expect(checkConservation(language, [LINE], [LINE, LINE], 0)).toMatchObject({ missing: 0, passed: true });
  });

  it('passes an empty page', () => {
    expect(checkConservation(language, [], [], 0)).toEqual({ total: 0, missing: 0, passed: true });
  });
});
