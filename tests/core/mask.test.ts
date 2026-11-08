import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Run } from '../../src/core/ir.ts';
import {
  findTerm,
  maskText,
  needsLlm,
  pairedJson,
  restoreSegments,
  unitRuns,
  type MaskRange,
} from '../../src/core/mask.ts';
import { parseUnits, unitTag } from '../../src/core/tags.ts';

// 文字都是這裡編的。

const DICE = (start: number, end: number): MaskRange => ({ start, end, kind: 'dice' });

function roundTrip(text: string, ranges: readonly MaskRange[]): string {
  const { masked, placeholders } = maskText(text, ranges);
  const { units, issues } = parseUnits(unitTag('1', 'paragraph', masked));
  expect(issues).toEqual([]);
  return restoreSegments(units[0]?.segments ?? [], placeholders).text;
}

describe('maskText', () => {
  it('turns a range into a placeholder and keeps what it hid', () => {
    expect(maskText('Roll 1D100 now.', [DICE(5, 10)])).toEqual({
      masked: 'Roll <ph id="1" kind="dice"/> now.',
      placeholders: [{ id: 1, kind: 'dice', text: '1D100' }],
      needs_llm: true,
      formats: null,
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

describe('inline styles as <pc> (ADR-0116)', () => {
  const BOLD = (start: number, end: number): Run => ({ start, end, marks: ['bold'] });

  it('wraps only the styled stretch and numbers <pc> apart from <ph>', () => {
    expect(maskText('Roll 1D6 for Fire Bolt now.', [DICE(5, 8)], [BOLD(13, 22)])).toEqual({
      masked: 'Roll <ph id="1" kind="dice"/> for <pc id="1">Fire Bolt</pc> now.',
      placeholders: [{ id: 1, kind: 'dice', text: '1D6' }],
      needs_llm: true,
      formats: { paired: [{ id: 1, start: 13, end: 22, marks: ['bold'] }] },
    });
  });

  it('sends no <pc> when the whole unit has one style', () => {
    expect(maskText('Chapter One:', [], [BOLD(0, 11)])).toMatchObject({
      masked: 'Chapter One:',
      formats: { whole: { marks: ['bold'] }, paired: [] },
    });
  });

  it('takes out what every letter shares and sends only the difference', () => {
    const runs: Run[] = [
      { start: 0, end: 2, marks: ['italic'] },
      { start: 3, end: 5, marks: ['bold', 'italic'] },
      { start: 6, end: 8, marks: ['italic'], link: { page: 3 } },
    ];
    expect(maskText('aa bb cc', [], runs)).toMatchObject({
      masked: 'aa <pc id="1">bb</pc> <pc id="2">cc</pc>',
      formats: {
        whole: { marks: ['italic'] },
        paired: [
          { id: 1, start: 3, end: 5, marks: ['bold'] },
          { id: 2, start: 6, end: 8, link: { page: 3 } },
        ],
      },
    });
  });

  it('puts a whole placeholder inside the <pc>', () => {
    expect(maskText('Deal 2d6 fire now', [DICE(5, 8)], [BOLD(5, 13)]).masked).toBe(
      'Deal <pc id="1"><ph id="1" kind="dice"/> fire</pc> now',
    );
  });

  it('shrinks a <pc> off a placeholder it only partly covers, and drops one left empty', () => {
    expect(maskText('Deal 2d6 fire', [DICE(5, 8)], [BOLD(7, 13)]).masked).toBe(
      'Deal <ph id="1" kind="dice"/> <pc id="1">fire</pc>',
    );
    expect(maskText('Deal 2d6 fire now', [DICE(5, 8)], [BOLD(4, 7)])).toMatchObject({
      masked: 'Deal <ph id="1" kind="dice"/> fire now',
      formats: null,
    });
  });

  it('leaves the masked text as it was without styles, so memory keys do not change', () => {
    expect(maskText('Roll 1D6.', [DICE(5, 8)], [])).toEqual(maskText('Roll 1D6.', [DICE(5, 8)]));
  });

  it('records where each <pc> lands in the translation, without the spaces at its edges', () => {
    const { placeholders } = maskText('Roll 1D6 for Fire Bolt.', [DICE(5, 8)], [BOLD(13, 22)]);
    const { units } = parseUnits('<s id="1">施放<pc id="1"> 火焰箭 </pc>，擲 <ph id="1"/>。</s>');
    expect(restoreSegments(units[0]?.segments ?? [], placeholders)).toEqual({
      text: '施放 火焰箭 ，擲 1D6。',
      paired: [{ id: 1, start: 3, end: 6 }],
    });
  });

  it('styles the source and the translation from the same formats', () => {
    const { formats } = maskText('aa bb cc', [], [
      { start: 0, end: 2, marks: ['italic'] },
      { start: 3, end: 5, marks: ['bold', 'italic'] },
      { start: 6, end: 8, marks: ['italic'] },
    ]);
    expect(unitRuns('aa bb cc', formats, formats?.paired ?? [])).toEqual([
      { start: 0, end: 3, marks: ['italic'] },
      { start: 3, end: 5, marks: ['bold', 'italic'] },
      { start: 5, end: 8, marks: ['italic'] },
    ]);
    expect(unitRuns('甲乙丙丁', formats, [{ id: 1, start: 1, end: 2 }])).toEqual([
      { start: 0, end: 1, marks: ['italic'] },
      { start: 1, end: 2, marks: ['bold', 'italic'] },
      { start: 2, end: 4, marks: ['italic'] },
    ]);
    expect(unitRuns('abc', null, [])).toEqual([]);
  });

  it('stores no offsets as NULL', () => {
    expect(pairedJson([])).toBeNull();
    expect(pairedJson([{ id: 1, start: 0, end: 2 }])).toBe('[{"id":1,"start":0,"end":2}]');
  });

  it('gets the text and every <pc> back for any text, ranges and styles', () => {
    const scenario = fc.string({ unit: 'binary', maxLength: 40 }).chain((text) =>
      fc.record({
        text: fc.constant(text),
        ranges: fc.array(
          fc
            .tuple(fc.nat({ max: text.length }), fc.nat({ max: text.length }))
            .map(([a, b]) => DICE(Math.min(a, b), Math.max(a, b))),
          { maxLength: 3 },
        ),
        cuts: fc.uniqueArray(fc.nat({ max: text.length }), { maxLength: 6 }),
        marks: fc.array(fc.subarray(['bold', 'italic'] as const), { maxLength: 6 }),
      }),
    );
    fc.assert(
      fc.property(scenario, ({ text, ranges, cuts, marks }) => {
        const points = [...cuts].sort((a, b) => a - b);
        const runs: Run[] = [];
        for (let index = 0; index + 1 < points.length; index += 2) {
          runs.push({ start: points[index] ?? 0, end: points[index + 1] ?? 0, marks: [...(marks[index] ?? ['bold'])] });
        }
        const { masked, placeholders, formats } = maskText(text, ranges, runs);
        const { units, issues } = parseUnits(unitTag('1', 'paragraph', masked));
        expect(issues).toEqual([]);
        const restored = restoreSegments(units[0]?.segments ?? [], placeholders);
        expect(restored.text).toBe(text);
        expect(restored.paired).toEqual((formats?.paired ?? []).map(({ id, start, end }) => ({ id, start, end })));
      }),
    );
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

  it('gives the same answer from the source and the placeholders alone, as book.db keeps them (ADR-0111)', () => {
    expect(needsLlm('1D100', [{ text: '1D100' }])).toBe(false);
    expect(needsLlm('1D6 damage', [{ text: '1D6' }])).toBe(true);
    expect(needsLlm('d6 d6', [{ text: 'd6' }])).toBe(true);
    expect(needsLlm('d6 d6', [{ text: 'd6' }, { text: 'd6' }])).toBe(false);
    fc.assert(
      fc.property(fc.string(), fc.array(fc.tuple(fc.nat(), fc.nat())), (text, pairs) => {
        const ranges = pairs.map(([a, b]) => DICE(Math.min(a, b) % (text.length + 1), Math.max(a, b) % (text.length + 1)));
        const { placeholders, needs_llm } = maskText(text, ranges);
        expect(needsLlm(text, placeholders)).toBe(needs_llm);
        const visible = placeholders.reduce((rest, { text: hidden }) => rest.replace(hidden, ''), text);
        expect(needs_llm).toBe(/\p{L}/u.test(visible));
      }),
    );
  });
});

describe('restoreSegments', () => {
  it('puts back what was hidden, wherever the translation moved it', () => {
    const { placeholders } = maskText('Roll 1D100 then p.42', [
      DICE(5, 10),
      { start: 16, end: 20, kind: 'page_ref' },
    ]);
    const { units } = parseUnits('<s id="1">先看 <ph id="2"/>，再擲 <ph id="1"/>。</s>');
    expect(restoreSegments(units[0]?.segments ?? [], placeholders).text).toBe('先看 p.42，再擲 1D100。');
  });

  it('keeps the text inside the tags that only carry a note', () => {
    const { units } = parseUnits(
      '<s id="1"><pc id="1" kind="bold">甲</pc><new-term source="B">乙</new-term><flag reason="r">丙</flag></s>',
    );
    expect(restoreSegments(units[0]?.segments ?? [], [])).toEqual({ text: '甲乙丙', paired: [{ id: 1, start: 0, end: 1 }] });
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
