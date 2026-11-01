import { describe, expect, it } from 'vitest';
import { formatSegments } from '../../src/core/format.ts';
import { loadTargetLanguage, type TargetLanguage } from '../../src/core/language.ts';
import { restoreSegments, type Placeholder } from '../../src/core/mask.ts';
import { parseUnits } from '../../src/core/tags.ts';

// 文字都是這裡編的。

const { profile } = loadTargetLanguage('zh-TW');

function format(inner: string, placeholders: readonly Placeholder[] = [], language: TargetLanguage = profile): string {
  const { units, issues } = parseUnits(`<s id="1">${inner}</s>`);
  expect(issues).toEqual([]);
  return restoreSegments(formatSegments(units[0]?.segments ?? [], language), placeholders);
}

describe('punctuation (ADR-0102)', () => {
  it.each([
    ['你好,世界', '你好，世界'],
    ['真的?不會吧!', '真的？不會吧！'],
    ['如下:一;二', '如下：一；二'],
    ['甲(乙)丙', '甲（乙）丙'],
    ['等等...', '等等……'],
    ['(HP)', '（HP）'],
    ['生命值(HP)', '生命值（HP）'],
  ])('%j', (text, expected) => {
    expect(format(text)).toBe(expected);
  });

  it.each(['1,000 枚', '3:00 出發', 'f(x)', 'v1,2', 'a:b'])('leaves %j alone', (text) => {
    expect(format(text)).toBe(text.replace(/ (?=[枚出])/u, ''));
  });
});

describe('quotes (ADR-0102)', () => {
  it('turns curly quotes into the target forms', () => {
    expect(format('他說：“走吧。”')).toBe('他說：「走吧。」');
    expect(format('‘走吧’')).toBe('『走吧』');
  });

  it('turns paired straight quotes in order', () => {
    expect(format('"甲"與"乙"')).toBe('「甲」與「乙」');
  });

  it('counts the quotes of the whole unit, across placeholders', () => {
    expect(format('"擲 <ph id="1"/> 次"', [{ id: 1, kind: 'dice', text: '1D6' }])).toBe('「擲1D6次」');
  });

  it('leaves an odd count alone, since it cannot tell which is which', () => {
    expect(format('他說"走吧')).toBe('他說"走吧');
  });

  it('leaves the apostrophe alone', () => {
    expect(format("Warden's Lantern")).toBe("Warden's Lantern");
  });

  it.each([
    ['6" 長、8" 寬', '6" 長、8" 寬'],
    ['比例尺 1" = 5 feet', '比例尺1" = 5 feet'],
    ['長 6.5" 的劍', '長6.5" 的劍'],
    ['一把 12＂ 的劍"', '一把12＂ 的劍"'],
  ])('keeps an inch mark after a number: %j', (text, expected) => {
    expect(format(text)).toBe(expected);
  });

  it('does not count an inch mark when it pairs the quotes', () => {
    expect(format('他說"長 6" 的劍"')).toBe('他說「長6" 的劍」');
    expect(format('"6" 的劍')).toBe('"6" 的劍');
  });

  it('counts a quote after a placeholder, which is not a number', () => {
    const placeholders = [{ id: 1, kind: 'dice', text: '1D6' }];
    expect(format('"擲 <ph id="1"/>"', placeholders)).toBe('「擲1D6」');
  });
});

describe('web addresses (ADR-0102)', () => {
  it.each([
    ['請看 https://example.com。', '請看https://example.com。'],
    ['https://example.com/?q=1&amp;x=(2)', 'https://example.com/?q=1&x=(2)'],
    ['http://example.com:8080/a,b', 'http://example.com:8080/a,b'],
    ['見 https://example.com/a,然後', '見https://example.com/a，然後'],
    ['網址是(https://example.com/a)。', '網址是（https://example.com/a）。'],
  ])('%j', (text, expected) => {
    expect(format(text)).toBe(expected);
  });

  it('still changes punctuation after the address ends', () => {
    expect(format('https://example.com 然後,走吧')).toBe('https://example.com然後，走吧');
  });
});

describe('spacing around Latin text (ADR-0102)', () => {
  it.each([
    ['使用 HP 值', '使用HP值'],
    ['擲 3 次', '擲3次'],
    ['HP 是 12', 'HP是12'],
  ])('%j', (text, expected) => {
    expect(format(text)).toBe(expected);
  });

  it('keeps the spaces inside Latin text and between Chinese words', () => {
    expect(format('Spot Hidden 檢定')).toBe('Spot Hidden檢定');
    expect(format('甲 乙')).toBe('甲 乙');
  });

  it('treats a placeholder as Latin text', () => {
    const placeholders = [{ id: 1, kind: 'dice', text: '1D100' }];
    expect(format('擲 <ph id="1"/> 次', placeholders)).toBe('擲1D100次');
  });

  it('adds the space when the language asks for it', () => {
    const spaced = { ...profile, punctuation: { ...profile.punctuation, space_around_latin: true } };
    expect(format('使用HP值', [], spaced)).toBe('使用 HP 值');
    const placeholders = [{ id: 1, kind: 'dice', text: '1D100' }];
    expect(format('擲<ph id="1"/>次', placeholders, spaced)).toBe('擲 1D100 次');
  });
});

describe('a long translation', () => {
  const BUDGET_MS = 1_000;
  const LONG = 200_000;

  it.each([
    ['a long run of spaces', `甲${' '.repeat(LONG)}乙`],
    ['spaces that never reach Latin text', `甲${' '.repeat(LONG)}。`],
    ['many short runs', '甲 乙 '.repeat(LONG / 4)],
    ['many quotes', '"'.repeat(LONG)],
    ['many brackets', '('.repeat(LONG)],
    ['many address marks', '://'.repeat(LONG / 3)],
    ['a long address', `https://${'a'.repeat(LONG)}`],
    ['many inch marks', '6"'.repeat(LONG / 2)],
  ])('formats %s in linear time', (_name, text) => {
    const started = performance.now();
    format(text);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});

describe('what formatting must not touch', () => {
  it('never changes what a placeholder held', () => {
    const placeholders = [{ id: 1, kind: 'dice', text: '1,000 "x" (y)...' }];
    expect(format('得到 <ph id="1"/>。', placeholders)).toBe('得到1,000 "x" (y)...。');
  });

  it('formats inside the tags that only carry a note', () => {
    expect(format('<new-term source="X">鹽,沼</new-term><flag reason="r">謎,面</flag>')).toBe('鹽，沼謎，面');
    expect(format('<pc id="1" kind="bold">甲,乙</pc>')).toBe('甲，乙');
  });

  it('keeps the note attributes', () => {
    const { units } = parseUnits('<s id="1"><new-term source="a, b">鹽</new-term></s>');
    const formatted = formatSegments(units[0]?.segments ?? [], profile);
    expect(formatted[0]).toMatchObject({ type: 'new-term', source: 'a, b' });
  });
});
