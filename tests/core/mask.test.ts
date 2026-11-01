import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { findTerm, maskText, restoreSegments, type MaskRange } from '../../src/core/mask.ts';
import { parseUnits, unitTag } from '../../src/core/tags.ts';

// 文字都是這裡編的。

const DICE = (start: number, end: number): MaskRange => ({ start, end, kind: 'dice' });

function roundTrip(text: string, ranges: readonly MaskRange[]): string {
  const { masked, placeholders } = maskText(text, ranges);
  const { units, issues } = parseUnits(unitTag('1', 'paragraph', masked));
  expect(issues).toEqual([]);
  return restoreSegments(units[0]?.segments ?? [], placeholders);
}

describe('maskText', () => {
  it('turns a range into a placeholder and keeps what it hid', () => {
    expect(maskText('Roll 1D100 now.', [DICE(5, 10)])).toEqual({
      masked: 'Roll <ph id="1" kind="dice"/> now.',
      placeholders: [{ id: 1, kind: 'dice', text: '1D100' }],
      needs_llm: true,
    });
  });

  it('numbers placeholders by where they appear, not by which pattern found them', () => {
    const ranges = [
      { start: 8, end: 12, kind: 'page_ref' },
      { start: 0, end: 4, kind: 'dice' },
    ];
    const { masked, placeholders } = maskText('2d6 and p.42 ok', ranges);
    expect(masked).toContain('<ph id="1" kind="dice"/>');
    expect(masked).toContain('<ph id="2" kind="page_ref"/>');
    expect(placeholders.map(({ id }) => id)).toEqual([1, 2]);
  });

  it('gives the same result for the same text, so the memory key stays stable', () => {
    const forward = maskText('2d6 and p.42', [DICE(0, 3), { start: 8, end: 12, kind: 'page_ref' }]);
    const backward = maskText('2d6 and p.42', [{ start: 8, end: 12, kind: 'page_ref' }, DICE(0, 3)]);
    expect(forward).toEqual(backward);
  });

  it('prefers the earlier start when ranges overlap (ADR-0100)', () => {
    const { placeholders } = maskText('abcdefgh', [
      { start: 2, end: 6, kind: 'later' },
      { start: 0, end: 4, kind: 'earlier' },
    ]);
    expect(placeholders).toEqual([{ id: 1, kind: 'earlier', text: 'abcd' }]);
  });

  it('prefers the longer one at the same start', () => {
    const { placeholders } = maskText('abcdefgh', [
      { start: 0, end: 2, kind: 'short' },
      { start: 0, end: 5, kind: 'long' },
    ]);
    expect(placeholders).toEqual([{ id: 1, kind: 'long', text: 'abcde' }]);
  });

  it('prefers the one listed first when they are the same', () => {
    const { placeholders } = maskText('abcdefgh', [
      { start: 0, end: 3, kind: 'first' },
      { start: 0, end: 3, kind: 'second' },
    ]);
    expect(placeholders).toEqual([{ id: 1, kind: 'first', text: 'abc' }]);
  });

  it('keeps a range that starts where the last one ended', () => {
    expect(maskText('abcd', [DICE(0, 2), DICE(2, 4)]).placeholders).toHaveLength(2);
  });

  it('ignores an empty match', () => {
    expect(maskText('abc', [DICE(1, 1)]).masked).toBe('abc');
  });

  it('escapes the book text around the placeholders', () => {
    expect(maskText('a<b 1D6 c&d', [DICE(4, 7)]).masked).toBe('a&lt;b <ph id="1" kind="dice"/> c&amp;d');
  });

  it('keeps the kind safe when a pack writes something odd', () => {
    expect(maskText('ab', [{ start: 0, end: 1, kind: 'x"y' }]).masked).toBe('<ph id="1" kind="x&quot;y"/>b');
  });
});

describe('whether a unit needs the LLM (ADR-0100)', () => {
  it.each([
    ['1D100', [DICE(0, 5)], false],
    ['1D6 + 2', [DICE(0, 3)], false],
    ['42', [], false],
    ['— 12 / 13 —', [], false],
    ['', [], false],
    ['Roll', [], true],
    ['1D6 damage', [DICE(0, 3)], true],
    ['祂', [], true],
  ] as const)('%j', (text, ranges, expected) => {
    expect(maskText(text, ranges).needs_llm).toBe(expected);
  });

  it('is not fooled by the entities that escaping adds', () => {
    expect(maskText('1 & 2 < 3', []).needs_llm).toBe(false);
  });
});

describe('restoreSegments', () => {
  it('puts back what was hidden, wherever the translation moved it', () => {
    const { placeholders } = maskText('Roll 1D100 then p.42', [
      DICE(5, 10),
      { start: 16, end: 20, kind: 'page_ref' },
    ]);
    const { units } = parseUnits('<s id="1">先看 <ph id="2"/>，再擲 <ph id="1"/>。</s>');
    expect(restoreSegments(units[0]?.segments ?? [], placeholders)).toBe('先看 p.42，再擲 1D100。');
  });

  it('keeps the text inside the tags that only carry a note', () => {
    const { units } = parseUnits(
      '<s id="1"><pc id="1" kind="bold">甲</pc><new-term source="B">乙</new-term><flag reason="r">丙</flag></s>',
    );
    expect(restoreSegments(units[0]?.segments ?? [], [])).toBe('甲乙丙');
  });

  it('refuses to invent what a placeholder held', () => {
    const { units } = parseUnits('<s id="1"><ph id="9"/></s>');
    expect(() => restoreSegments(units[0]?.segments ?? [], [])).toThrow(RangeError);
  });

  it('gets the original back for any text and any ranges', () => {
    const scenario = fc.string({ unit: 'binary' }).chain((text) =>
      fc.record({
        text: fc.constant(text),
        ranges: fc.array(
          fc
            .tuple(fc.nat({ max: text.length }), fc.nat({ max: text.length }), fc.constantFrom('dice', 'page_ref'))
            .map(([a, b, kind]) => ({ start: Math.min(a, b), end: Math.max(a, b), kind })),
          { maxLength: 6 },
        ),
      }),
    );
    fc.assert(
      fc.property(scenario, ({ text, ranges }) => {
        expect(roundTrip(text, ranges)).toBe(text);
      }),
    );
  });

  it('gets the original back when the text is full of markup', () => {
    const markup = fc.stringMatching(/^(<\/?s[^]{0,4}|<ph id="1"\/>|&amp;|&lt;|[<>&"]|1D6| )+$/);
    fc.assert(
      fc.property(markup, (text) => {
        const start = text.indexOf('1D6');
        const ranges = start < 0 ? [] : [DICE(start, start + 3)];
        expect(roundTrip(text, ranges)).toBe(text);
      }),
    );
  });
});

describe('findTerm', () => {
  it('matches case and whole words by default, as the whitepaper says for Dodge', () => {
    expect(findTerm('Dodge the dodge.', 'Dodge')).toEqual([[0, 5]]);
    expect(findTerm('Dodgeball', 'Dodge')).toEqual([]);
    expect(findTerm('UnDodge', 'Dodge')).toEqual([]);
  });

  it('can ignore case', () => {
    expect(findTerm('Dodge the dodge.', 'DODGE', { case_sensitive: false })).toEqual([
      [0, 5],
      [10, 15],
    ]);
  });

  it('can match inside a word', () => {
    expect(findTerm('Dodgeball', 'Dodge', { whole_word: false })).toEqual([[0, 5]]);
  });

  it('finds every place, without overlapping', () => {
    expect(findTerm('aaaa', 'aa', { whole_word: false })).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it('counts digits as part of a word', () => {
    expect(findTerm('Salt2', 'Salt')).toEqual([]);
  });

  it('treats a term with spaces as one term', () => {
    expect(findTerm('At Salt Marsh, dawn.', 'Salt Marsh')).toEqual([[3, 13]]);
  });

  it('keeps the offsets right when folding case changes the length', () => {
    // İ 小寫後變成兩個碼元，直接比對小寫字串會讓後面的位置全部偏移。
    const text = 'İİ Dodge';
    const [range] = findTerm(text, 'dodge', { case_sensitive: false });
    expect(range).toEqual([3, 8]);
    expect(text.slice(...(range as [number, number]))).toBe('Dodge');
  });

  it('finds nothing for an empty term', () => {
    expect(findTerm('text', '')).toEqual([]);
  });
});
