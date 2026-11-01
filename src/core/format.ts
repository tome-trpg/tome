import type { TargetLanguage } from './language.ts';
import type { Segment } from './tags.ts';

// 譯後自動排版（白皮書 §5.6、ADR-0081、ADR-0102）。不花 token，在還原之前執行，
// 所以只碰得到文字片段，佔位符不受影響。規則都來自目標語言設定檔。

const ASCII_WORD = /^[A-Za-z0-9]$/;
const HAN = /^\p{Script=Han}$/u;
const STRAIGHT_QUOTE = '"';
/** 佔位符當成拉丁文字。 */
const PLACEHOLDER_STAND_IN = 'x';

function mapText(segments: readonly Segment[], change: (text: string) => string): Segment[] {
  return segments.map((item) => {
    if (item.type === 'text') return { ...item, text: change(item.text) };
    return item.type === 'ph' ? item : { ...item, children: mapText(item.children, change) };
  });
}

function countQuotes(segments: readonly Segment[]): number {
  let count = 0;
  mapText(segments, (text) => {
    count += text.split(STRAIGHT_QUOTE).length - 1;
    return text;
  });
  return count;
}

/** 成對的 `"` 依序換，算的是整個單位，中間隔著佔位符也一樣。單數個分不出開合，不動。 */
function formatQuotes(segments: readonly Segment[], language: TargetLanguage): Segment[] {
  const { open, close, inner_open, inner_close } = language.punctuation.quotes;
  const paired = countQuotes(segments) % 2 === 0;
  let opening = true;
  return mapText(segments, (text) => {
    const curly = text
      .replaceAll('“', open)
      .replaceAll('”', close)
      .replaceAll('‘', inner_open)
      .replaceAll('’', inner_close);
    if (!paired) return curly;
    return curly.replaceAll(STRAIGHT_QUOTE, () => {
      const quote = opening ? open : close;
      opening = !opening;
      return quote;
    });
  });
}

function isAsciiWord(character: string): boolean {
  return ASCII_WORD.test(character);
}

/** 兩側都是半形英文字母或數字時不換，`1,000`、`3:00` 才不會壞。括號跟著開括號的決定走。 */
function replacePunctuation(
  text: string,
  before: string,
  after: string,
  language: TargetLanguage,
): string {
  const rules = Object.entries(language.punctuation.replace).sort(([a], [b]) => b.length - a.length);
  const open: boolean[] = [];
  let result = '';
  let index = 0;
  while (index < text.length) {
    const rule = rules.find(([from]) => text.startsWith(from, index));
    if (rule === undefined) {
      result += text[index] ?? '';
      index += 1;
      continue;
    }
    const [from, to] = rule;
    const end = index + from.length;
    let kept = isAsciiWord(text[index - 1] ?? before) && isAsciiWord(text[end] ?? after);
    if (from === '(') open.push(kept);
    if (from === ')') kept = open.pop() ?? kept;
    result += kept ? from : to;
    index = end;
  }
  return result;
}

function isBlank(character: string | undefined): boolean {
  return character === ' ' || character === '\t';
}

/** 一格一格掃，耗時跟長度成正比：譯文來自 LLM，不用會回溯的正規表示式。 */
function removeSpacing(text: string): string {
  const characters = [...text];
  let result = '';
  let index = 0;
  while (index < characters.length) {
    const character = characters[index] ?? '';
    if (!isBlank(character)) {
      result += character;
      index += 1;
      continue;
    }
    let end = index;
    while (isBlank(characters[end])) end += 1;
    const before = characters[index - 1] ?? '';
    const after = characters[end] ?? '';
    const between = (HAN.test(before) && isAsciiWord(after)) || (isAsciiWord(before) && HAN.test(after));
    if (!between) result += characters.slice(index, end).join('');
    index = end;
  }
  return result;
}

function formatSpacing(text: string, language: TargetLanguage): string {
  if (!language.punctuation.space_around_latin) return removeSpacing(text);
  return text
    .replace(/(\p{Script=Han})(?=[A-Za-z0-9])/gu, '$1 ')
    .replace(/([A-Za-z0-9])(?=\p{Script=Han})/gu, '$1 ');
}

function neighbor(item: Segment | undefined, end: 'first' | 'last'): string {
  if (item?.type === 'ph') return PLACEHOLDER_STAND_IN;
  if (item?.type !== 'text') return '';
  const characters = [...item.text];
  return (end === 'first' ? characters[0] : characters.at(-1)) ?? '';
}

function formatList(segments: readonly Segment[], language: TargetLanguage): Segment[] {
  return segments.map((item, index) => {
    if (item.type === 'ph') return item;
    if (item.type !== 'text') return { ...item, children: formatList(item.children, language) };
    const before = neighbor(segments[index - 1], 'last');
    const after = neighbor(segments[index + 1], 'first');
    const punctuated = replacePunctuation(item.text, before, after, language);
    // 前後接上鄰居再處理，邊界的空白才看得到另一邊是什麼。
    const spaced = formatSpacing(`${before}${punctuated}${after}`, language);
    return { ...item, text: spaced.slice(before.length, spaced.length - after.length) };
  });
}

export function formatSegments(segments: readonly Segment[], language: TargetLanguage): Segment[] {
  return formatList(formatQuotes(segments, language), language);
}
