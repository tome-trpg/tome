import { describe, expect, it } from 'vitest';
import { loadSourceLanguage } from '../../src/core/language.ts';
import type { TextRun } from '../../src/core/pdf.ts';
import {
  alignRuns,
  glyphsOf,
  joinRuns,
  layerRuns,
  matchLetters,
  mergeRuns,
  replaceRuns,
  RUNS_MIN_SHARE,
  runsInside,
  sliceRuns,
  wholeWords,
  type Glyph,
} from '../../src/core/runs.ts';

// 文字都是這裡編的（ADR-0116）。

const { profile: en } = loadSourceLanguage('en');

function textRun(text: string, x: number, style: { bold?: boolean; italic?: boolean } = {}, y = 700): TextRun {
  return { text, bbox: [x, y, x + text.length * 6, y + 10], font: 'f', ...style };
}

/** 一段文字，每個字母數字都是同一種樣式。 */
function glyphs(text: string, style: Glyph['style'] = {}): Glyph[] {
  return [...text.toLowerCase()].filter((char) => /[\p{L}\p{N}]/u.test(char)).map((char) => ({ char, style }));
}

describe('glyphsOf', () => {
  it('takes bold and italic from the text runs and keeps only letters and digits', () => {
    const found = glyphsOf(en, [textRun('Ab, 1', 0, { bold: true }), textRun('c', 40, { bold: true, italic: true })], []);
    expect(found).toEqual([
      { char: 'a', style: { marks: ['bold'] } },
      { char: 'b', style: { marks: ['bold'] } },
      { char: '1', style: { marks: ['bold'] } },
      { char: 'c', style: { marks: ['bold', 'italic'] } },
    ]);
  });

  it('splits a ligature the way the block text has it', () => {
    expect(glyphsOf(en, [textRun('ﬁre', 0)], []).map(({ char }) => char)).toEqual(['f', 'i', 'r', 'e']);
  });

  it('links only the letters whose share of the run falls inside the link box', () => {
    // `see 12`：六個字平均分 36 點寬，後兩個字在 24 點之後。
    const found = glyphsOf(en, [textRun('see 12', 0)], [{ page: 0, bbox: [24, 695, 40, 715], target_page: 11 }]);
    expect(found.map(({ style }) => style.link?.page ?? null)).toEqual([null, null, null, 11, 11]);
  });

  it('turns a web link into a uri, and a box drawn upside down still counts', () => {
    const found = glyphsOf(en, [textRun('go', 0)], [{ page: 0, bbox: [20, 715, 0, 695], uri: 'https://example.com/x' }]);
    expect(found.map(({ style }) => style)).toEqual([
      { link: { uri: 'https://example.com/x' } },
      { link: { uri: 'https://example.com/x' } },
    ]);
  });
});

describe('runsInside', () => {
  it('keeps the runs whose centre is inside a box', () => {
    const runs = [textRun('in', 10), textRun('out', 10, {}, 500)];
    expect(runsInside(runs, [[0, 690, 100, 720]]).map(({ text }) => text)).toEqual(['in']);
  });
});

describe('matchLetters', () => {
  it('skips what only one side has and picks up again', () => {
    expect(Array.from(matchLetters([...'abcxyzdef'], [...'abcdef']))).toEqual([0, 1, 2, -1, -1, -1, 3, 4, 5]);
    expect(Array.from(matchLetters([...'abcdef'], [...'abcqqdef']))).toEqual([0, 1, 2, 5, 6, 7]);
  });

  it('steps over a letter the two sides read differently', () => {
    expect(Array.from(matchLetters([...'abcxdef'], [...'abcydef']))).toEqual([0, 1, 2, -1, 4, 5, 6]);
  });

  it('takes time in proportion to the length, not its square', () => {
    const left = Array.from({ length: 200_000 }, (_, index) => String.fromCharCode(97 + (index % 26)));
    const right = Array.from({ length: 200_000 }, (_, index) => String.fromCharCode(97 + ((index * 7) % 26)));
    const started = performance.now();
    matchLetters(left, right);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('alignRuns', () => {
  it('puts a run over each styled stretch, from its first letter to its last', () => {
    const text = 'Use “Fire Bolt” now.';
    const found = [...glyphs('Use'), ...glyphs('Fire Bolt', { marks: ['bold'] }), ...glyphs('now')];
    expect(alignRuns(en, text, found)).toEqual({ share: 1, runs: [{ start: 5, end: 14, marks: ['bold'] }] });
  });

  it('gives a whole heading one run', () => {
    expect(alignRuns(en, 'Chapter 3: Rain', glyphs('Chapter 3 Rain', { marks: ['bold'] })).runs).toEqual([
      { start: 0, end: 15, marks: ['bold'] },
    ]);
  });

  it('gives nothing when too few letters line up, rather than the wrong style', () => {
    const text = 'abcdefghijklmnopqrst';
    const found = glyphs('abcdefghijklmnopqrzz', { marks: ['italic'] });
    const { share, runs } = alignRuns(en, text, found);
    expect(share).toBeLessThan(RUNS_MIN_SHARE);
    expect(runs).toEqual([]);
  });

  it('lets a letter that did not line up follow its neighbours when they agree', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz0123456789ab';
    const found = glyphs('abcdefghijklmnopqrstuvwxyz0123456789ab', { marks: ['bold'] });
    found[10] = { char: '!', style: {} };
    expect(alignRuns(en, text, found).runs).toEqual([{ start: 0, end: 38, marks: ['bold'] }]);
  });

  it('has no runs for plain text and treats a block with no letters as lined up', () => {
    expect(alignRuns(en, 'plain words', glyphs('plain words'))).toEqual({ share: 1, runs: [] });
    expect(alignRuns(en, '— · —', [])).toEqual({ share: 1, runs: [] });
  });

  it('keeps a style only on whole words, so a drop cap in a bold face gets none', () => {
    expect(alignRuns(en, 'The dropped capital', [...glyphs('T', { marks: ['bold'] }), ...glyphs('he dropped capital')]).runs).toEqual([]);
    const found = [...glyphs('Fi'), ...glyphs('re Bolt', { marks: ['italic'] }), ...glyphs('now')];
    expect(alignRuns(en, 'Fire Bolt now', found).runs).toEqual([{ start: 5, end: 9, marks: ['italic'] }]);
  });

  it('keeps a link and its target', () => {
    const found = [...glyphs('see page'), ...glyphs('12', { link: { page: 11 } })];
    expect(alignRuns(en, 'see page 12', found).runs).toEqual([{ start: 9, end: 11, link: { page: 11 } }]);
  });
});

describe('wholeWords', () => {
  it('cuts a run back to the words it covers whole, by the words of the language', () => {
    expect(wholeWords('en', 'Fire-Bolt, 2d6 now', [{ start: 0, end: 14, marks: ['bold'] }])).toEqual([
      { start: 0, end: 14, marks: ['bold'] },
    ]);
    expect(wholeWords('en', 'Fire-Bolt, 2d6 now', [{ start: 2, end: 16, marks: ['bold'] }])).toEqual([
      { start: 5, end: 14, marks: ['bold'] },
    ]);
    expect(wholeWords('en', 'Fire', [{ start: 1, end: 3, marks: ['bold'] }])).toEqual([]);
  });
});

describe('run edits', () => {
  it('merges runs of the same style with only spaces or punctuation between', () => {
    const runs = [
      { start: 0, end: 3, marks: ['bold' as const] },
      { start: 5, end: 8, marks: ['bold' as const] },
      { start: 10, end: 12, marks: ['bold' as const] },
    ];
    expect(mergeRuns('abc, def x gh', runs)).toEqual([
      { start: 0, end: 8, marks: ['bold'] },
      { start: 10, end: 12, marks: ['bold'] },
    ]);
  });

  it('cuts runs at the edges of a slice', () => {
    expect(sliceRuns([{ start: 2, end: 8, marks: ['italic'] }], 5, 20)).toEqual([{ start: 0, end: 3, marks: ['italic'] }]);
    expect(sliceRuns([{ start: 2, end: 4 }], 5, 20)).toEqual([]);
  });

  it('shifts the right side of a join, whether a space was added or a hyphen taken away', () => {
    const left = [{ start: 0, end: 4, marks: ['bold' as const] }];
    const right = [{ start: 0, end: 4, marks: ['bold' as const] }];
    expect(joinRuns('word next', left, right, 4)).toEqual([{ start: 0, end: 9, marks: ['bold'] }]);
    expect(joinRuns('travellers', [{ start: 0, end: 6, marks: ['italic'] }], [{ start: 0, end: 4 }], 4)).toEqual([
      { start: 0, end: 6, marks: ['italic'] },
      { start: 6, end: 10 },
    ]);
  });

  it('drops the style of what was replaced and shifts the rest', () => {
    const runs = [
      { start: 0, end: 4, marks: ['bold' as const] },
      { start: 5, end: 8, marks: ['bold' as const] },
      { start: 13, end: 16, marks: ['italic' as const] },
    ];
    expect(replaceRuns('Call Bob at 555 now', 'Bob', '[REDACTED]', runs)).toEqual([
      { start: 0, end: 4, marks: ['bold'] },
      { start: 20, end: 23, marks: ['italic'] },
    ]);
  });
});

describe('layerRuns', () => {
  it('lays the paired styles over the whole one without overlapping runs', () => {
    expect(layerRuns('ab cd ef', { marks: ['italic'] }, [{ start: 3, end: 5, marks: ['bold'] }])).toEqual([
      { start: 0, end: 3, marks: ['italic'] },
      { start: 3, end: 5, marks: ['bold', 'italic'] },
      { start: 5, end: 8, marks: ['italic'] },
    ]);
  });

  it('runs the whole style from the first letter to the last', () => {
    expect(layerRuns(' 火球術。', { marks: ['bold'] }, [])).toEqual([{ start: 1, end: 4, marks: ['bold'] }]);
  });

  it('has nothing for plain text', () => {
    expect(layerRuns('abc', undefined, [])).toEqual([]);
    expect(layerRuns('abc', {}, [{ start: 0, end: 0, marks: ['bold'] }])).toEqual([]);
  });
});
