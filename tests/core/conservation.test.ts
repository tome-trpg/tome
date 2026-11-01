import { describe, expect, it } from 'vitest';
import { checkConservation, MISSING_MIN } from '../../src/core/conservation.ts';
import { loadSourceLanguage } from '../../src/core/language.ts';
import { prose } from '../forge/index.ts';

const { profile: language } = loadSourceLanguage('en');
const LINE = 'the warden of salt marsh counts tide stones before each crossing';
const letters = (text: string): number => text.replace(/[^\p{L}\p{N}]/gu, '').length;

describe('character conservation', () => {
  it('passes when every character landed in a block, in any order', () => {
    const page = Array.from({ length: 6 }, (_, index) => prose(index, 12));
    const result = checkConservation(language, page, [...page].reverse(), 0);
    expect(result).toMatchObject({ missing: 0, passed: true });
    expect(result.total).toBe(page.reduce((sum, line) => sum + letters(line), 0));
  });

  it('fails a page that lost a whole line', () => {
    const page = Array.from({ length: 20 }, (_, index) => prose(index, 12));
    const result = checkConservation(language, page, page.slice(1), 0);
    expect(result.missing).toBeGreaterThan(0);
    expect(result.passed).toBe(false);
  });

  it('forgives a few characters on a short page, but not more', () => {
    const page = 'short heading of a page';
    expect(checkConservation(language, [page], [page.slice(MISSING_MIN)], 0).passed).toBe(true);
    expect(checkConservation(language, [page], [page.slice(MISSING_MIN + 3)], 0).passed).toBe(false);
  });

  it('ignores spaces, hyphens and ligatures', () => {
    const result = checkConservation(language, ['a ﬁne tra-', 'vellers ﬂoat'], ['a fine travellers float'], 0);
    expect(result).toMatchObject({ missing: 0, passed: true });
  });

  it('ignores punctuation an engine swapped for another', () => {
    const result = checkConservation(language, ['• the warden’s “salt” — marsh'], ['· the warden\'s "salt" - marsh'], 0);
    expect(result).toMatchObject({ missing: 0, passed: true });
  });

  it('does not count dot leaders in a table of contents', () => {
    const page = Array.from({ length: 30 }, (_, index) => `chapter ${index} ........................ ${index}`);
    const result = checkConservation(language, page, page.map((line) => line.replaceAll('.', '�')), 0);
    expect(result).toMatchObject({ missing: 0, passed: true });
  });

  it('is not fooled by text printed twice', () => {
    const page = Array.from({ length: 12 }, (_, index) => prose(index, 12));
    const result = checkConservation(language, [...page, ...page], page, 0);
    expect(result).toMatchObject({ missing: 0, passed: true });
  });

  it('cannot tell a lost copy of a repeated line, which is the price of ignoring overprint', () => {
    const page = Array.from({ length: 20 }, () => LINE);
    expect(checkConservation(language, page, [LINE], 0)).toMatchObject({ missing: 0, passed: true });
  });

  it('is not fooled by a line that runs across table cells', () => {
    const result = checkConservation(language, ['Ferry Marsh tolls', 'Reeds River tolls'], ['Ferry Reeds Marsh River tolls tolls'], 0);
    expect(result).toMatchObject({ missing: 0, passed: true });
  });

  it('ignores case, since an engine may read small capitals either way', () => {
    expect(checkConservation(language, ['THE WARDEN'], ['the warden'], 0)).toMatchObject({ missing: 0, passed: true });
  });

  it('takes invisible text off what is missing', () => {
    const hidden = 'a line nobody can see on this page at all';
    const result = checkConservation(language, [LINE, hidden], [LINE], letters(hidden));
    expect(result).toMatchObject({ missing: 0, passed: true });
  });

  it('does not mind an engine that reads a character twice', () => {
    expect(checkConservation(language, [LINE], [LINE, LINE], 0)).toMatchObject({ missing: 0, passed: true });
  });

  it('passes an empty page', () => {
    expect(checkConservation(language, [], [], 0)).toEqual({ total: 0, missing: 0, passed: true });
  });
});
