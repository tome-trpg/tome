import type { MatchRange } from './patterns.ts';
import { escapeText, placeholderTag, type Segment } from './tags.ts';

// 遮蔽與還原（白皮書 §5.6）。遮蔽的規則都來自規則包（ADR-0026），這裡只處理範圍。

export interface Placeholder {
  readonly id: number;
  readonly kind: string;
  /** 被遮蔽的原文，還原時放回去。 */
  readonly text: string;
}

export interface MaskRange {
  readonly start: number;
  readonly end: number;
  readonly kind: string;
}

export interface MaskedText {
  /** 已經跳脫，佔位符也寫好了，可以直接放進 `<s>`。 */
  readonly masked: string;
  readonly placeholders: readonly Placeholder[];
  readonly needs_llm: boolean;
}

export interface TermMatch {
  readonly case_sensitive?: boolean;
  readonly whole_word?: boolean;
  readonly roles?: readonly string[];
}

const LETTER = /\p{L}/u;
const WORD_START = /^[\p{L}\p{N}]/u;
const WORD_END = /[\p{L}\p{N}]$/u;

/** 起點較前的優先，同起點取較長的，再相同時取列在前面的（ADR-0100）。 */
function chooseRanges(ranges: readonly MaskRange[]): MaskRange[] {
  // 陣列排序是穩定的，所以長度也相同時，列在前面的還是在前面。
  const ordered = ranges
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const chosen: MaskRange[] = [];
  let cursor = 0;
  for (const range of ordered) {
    if (range.start < cursor) continue;
    chosen.push(range);
    cursor = range.end;
  }
  return chosen;
}

/** 佔位符編號在單位內從 1 起算，依出現順序，翻譯記憶的鍵才穩定。 */
export function maskText(text: string, ranges: readonly MaskRange[]): MaskedText {
  const placeholders: Placeholder[] = [];
  let masked = '';
  let visible = '';
  let cursor = 0;
  for (const { start, end, kind } of chooseRanges(ranges)) {
    const before = text.slice(cursor, start);
    const id = placeholders.length + 1;
    placeholders.push({ id, kind, text: text.slice(start, end) });
    masked += escapeText(before) + placeholderTag(id, kind);
    visible += before;
    cursor = end;
  }
  const rest = text.slice(cursor);
  // 用跳脫前的文字判斷：`&amp;` 裡的字母不是書的內容。
  return { masked: masked + escapeText(rest), placeholders, needs_llm: LETTER.test(visible + rest) };
}

/** 把解析出的片段還原成文字。佔位符對不上要先由驗證擋下，走到這裡是程式錯誤。 */
export function restoreSegments(
  segments: readonly Segment[],
  placeholders: readonly Placeholder[],
): string {
  const hidden = new Map(placeholders.map(({ id, text }) => [String(id), text]));
  const walk = (items: readonly Segment[]): string =>
    items
      .map((item) => {
        if (item.type === 'text') return item.text;
        if (item.type !== 'ph') return walk(item.children);
        const text = hidden.get(item.id);
        if (text === undefined) throw new RangeError('a placeholder has no text');
        return text;
      })
      .join('');
  return walk(segments);
}

/** 一個字元轉小寫後變長時留原樣，位置才對得回原文。 */
export function foldCase(text: string): string {
  return Array.from(text, (char) => {
    const lower = char.toLowerCase();
    return lower.length === char.length ? lower : char;
  }).join('');
}

function isWholeWord(text: string, start: number, end: number): boolean {
  return !WORD_END.test(text.slice(Math.max(0, start - 2), start)) && !WORD_START.test(text.slice(end, end + 2));
}

/**
 * 找出詞條的位置。預設區分大小寫、全字（ADR-0100）。
 * 比對條件是規則包的資料，所以用字串搜尋，不編成正規表示式（ADR-0049）。
 */
export function findTerm(text: string, term: string, match: TermMatch = {}): MatchRange[] {
  if (term === '') return [];
  const { case_sensitive = true, whole_word = true } = match;
  const haystack = case_sensitive ? text : foldCase(text);
  const needle = case_sensitive ? term : foldCase(term);
  const ranges: MatchRange[] = [];
  let start = haystack.indexOf(needle);
  while (start >= 0) {
    const end = start + needle.length;
    const found = !whole_word || isWholeWord(text, start, end);
    if (found) ranges.push([start, end]);
    start = haystack.indexOf(needle, found ? end : start + 1);
  }
  return ranges;
}
