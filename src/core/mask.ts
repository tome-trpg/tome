import type { Run } from './ir.ts';
import type { MatchRange } from './patterns.ts';
import { isPlain, layerRuns, mergeRuns, styleOf, type Style } from './runs.ts';
import { escapeText, PAIRED_END, pairedTag, placeholderTag, type Segment } from './tags.ts';

// 遮蔽與還原（白皮書 §5.6）。遮蔽的規則都來自規則包（ADR-0026），這裡只處理範圍。
// 行內樣式用 `<pc>` 包起來送出，還原時記下它在譯文裡的位置（ADR-0116）。

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

/** 一個 `<pc>` 在文字裡的位置，UTF-16 位置。 */
export interface PairedOffset {
  readonly id: number;
  readonly start: number;
  readonly end: number;
}

/** 一個 `<pc>` 的樣式與它在原文的位置。 */
export interface PairedFormat extends PairedOffset, Style {}

/** 一個單位的行內樣式（ADR-0116）。存進 `book.db` 的 `unit.formats`。 */
export interface UnitFormats {
  /** 單位裡每個字母數字都有的樣式，不送 `<pc>`，譯文整段套用。 */
  readonly whole?: Style;
  /** 其他樣式，每個是一個 `<pc>`，只帶 `whole` 以外的部分。編號從 1 起算，跟 `<ph>` 分開。 */
  readonly paired: readonly PairedFormat[];
}

export interface MaskedText {
  /** 已經跳脫，佔位符也寫好了，可以直接放進 `<s>`。 */
  readonly masked: string;
  readonly placeholders: readonly Placeholder[];
  readonly needs_llm: boolean;
  /** 沒有樣式時是 null。 */
  readonly formats: UnitFormats | null;
}

export interface Restored {
  readonly text: string;
  /** 每個 `<pc>` 在譯文裡的位置，依編號排，兩端的空白不算。 */
  readonly paired: readonly PairedOffset[];
}

export interface TermMatch {
  readonly case_sensitive?: boolean;
  readonly whole_word?: boolean;
  readonly roles?: readonly string[];
}

const LETTERS = /\p{L}/gu;
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

function letters(text: string): number {
  return text.match(LETTERS)?.length ?? 0;
}

/**
 * 佔位符以外還有字母才要送 LLM（ADR-0100）。用跳脫前的文字判斷：`&amp;` 裡的字母不是書的內容。
 * 佔位符是原文裡不重疊的片段，所以比字母數就夠，`tome status` 從 `book.db` 也算得出來（ADR-0111）。
 */
export function needsLlm(text: string, placeholders: readonly Pick<Placeholder, 'text'>[]): boolean {
  return letters(text) > placeholders.reduce((total, hidden) => total + letters(hidden.text), 0);
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;
const SPACE = /\s/u;

function lettersIn(text: string, start = 0, end = text.length): number {
  return text.slice(start, end).match(LETTER_OR_DIGIT)?.length ?? 0;
}

function sameLink(left: Style['link'], right: Style['link']): boolean {
  return left?.page === right?.page && left?.uri === right?.uri;
}

/** 每個字母數字都有的樣式。`runs` 不重疊，蓋到的字數加起來等於全部才算蓋滿（ADR-0116）。 */
function sharedStyle(text: string, runs: readonly Run[]): Style {
  const [first, ...rest] = runs;
  const total = lettersIn(text);
  const covered = runs.reduce((sum, run) => sum + lettersIn(text, run.start, run.end), 0);
  if (first === undefined || total === 0 || covered < total) return {};
  const marks = (first.marks ?? []).filter((mark) => rest.every((run) => run.marks?.includes(mark) === true));
  const link = rest.every((run) => sameLink(run.link, first.link)) ? first.link : undefined;
  return styleOf({ marks, ...(link === undefined ? {} : { link }) });
}

/** 一段的樣式扣掉整個單位都有的部分。 */
function residual(run: Run, whole: Style): Style {
  const marks = (run.marks ?? []).filter((mark) => !(whole.marks ?? []).includes(mark));
  const link = whole.link === undefined ? run.link : undefined;
  return styleOf({ marks, ...(link === undefined ? {} : { link }) });
}

/** 只蓋到一部分的 `<ph>` 不包進來，`<pc>` 縮到不含它；整個在裡面的照樣包住（ADR-0116）。 */
function shrink(start: number, end: number, hidden: readonly MaskRange[]): readonly [number, number] {
  let from = start;
  let to = end;
  for (const range of hidden) {
    if (range.end <= from || range.start >= to) continue;
    if (range.start >= from && range.end <= to) continue;
    if (range.start <= from) from = range.end;
    if (range.end >= to) to = range.start;
  }
  return [from, to];
}

function trimmed(text: string, start: number, end: number): readonly [number, number] {
  let from = start;
  let to = end;
  while (from < to && SPACE.test(text[from] ?? '')) from += 1;
  while (to > from && SPACE.test(text[to - 1] ?? '')) to -= 1;
  return [from, to];
}

/**
 * 單位的行內樣式：整個單位都有的樣式提出來，其他的每段一個 `<pc>`，攤平不巢狀（ADR-0116）。
 * 沒有樣式時是 null，送出的內容跟沒有 `runs` 時一樣。
 */
function planFormats(text: string, runs: readonly Run[], hidden: readonly MaskRange[]): UnitFormats | null {
  if (runs.length === 0) return null;
  const whole = sharedStyle(text, runs);
  const spans = runs.flatMap((run): Run[] => {
    const style = residual(run, whole);
    if (isPlain(style)) return [];
    const [shrunkStart, shrunkEnd] = shrink(run.start, run.end, hidden);
    const [start, end] = trimmed(text, shrunkStart, shrunkEnd);
    return end > start && lettersIn(text, start, end) > 0 ? [{ start, end, ...style }] : [];
  });
  const paired = mergeRuns(text, spans).map((run, index) => ({
    id: index + 1,
    start: run.start,
    end: run.end,
    ...styleOf(run),
  }));
  if (isPlain(whole) && paired.length === 0) return null;
  return { ...(isPlain(whole) ? {} : { whole }), paired };
}

type Cut =
  | { readonly at: number; readonly order: number; readonly tag: string }
  | { readonly at: number; readonly order: number; readonly range: MaskRange };

/**
 * 佔位符編號在單位內從 1 起算，依出現順序，翻譯記憶的鍵才穩定。`<pc>` 另外從 1 起算（ADR-0116），
 * 沒有 `runs` 的單位遮蔽後的文字跟以前一樣。
 */
export function maskText(text: string, ranges: readonly MaskRange[], runs: readonly Run[] = []): MaskedText {
  const hidden = chooseRanges(ranges);
  const formats = planFormats(text, runs, hidden);
  // 同一個位置先關再開，`<ph>` 最後：從這裡開始的 `<ph>` 在新開的 `<pc>` 裡面。
  const cuts: Cut[] = [
    ...(formats?.paired ?? []).flatMap(({ id, start, end }) => [
      { at: start, order: 1, tag: pairedTag(id) },
      { at: end, order: 0, tag: PAIRED_END },
    ]),
    ...hidden.map((range) => ({ at: range.start, order: 2, range })),
  ].sort((left, right) => left.at - right.at || left.order - right.order);
  const placeholders: Placeholder[] = [];
  let masked = '';
  let cursor = 0;
  for (const cut of cuts) {
    masked += escapeText(text.slice(cursor, cut.at));
    cursor = Math.max(cursor, cut.at);
    if ('tag' in cut) {
      masked += cut.tag;
      continue;
    }
    const { start, end, kind } = cut.range;
    const id = placeholders.length + 1;
    placeholders.push({ id, kind, text: text.slice(start, end) });
    masked += placeholderTag(id, kind);
    cursor = end;
  }
  return {
    masked: masked + escapeText(text.slice(cursor)),
    placeholders,
    needs_llm: needsLlm(text, placeholders),
    formats,
  };
}

/**
 * 把解析出的片段還原成文字，記下每個 `<pc>` 在譯文裡的位置（ADR-0116）。佔位符對不上要先由驗證擋下，
 * 走到這裡是程式錯誤。
 */
export function restoreSegments(segments: readonly Segment[], placeholders: readonly Placeholder[]): Restored {
  const hidden = new Map(placeholders.map(({ id, text }) => [String(id), text]));
  const paired: PairedOffset[] = [];
  let text = '';
  const walk = (items: readonly Segment[]): void => {
    for (const item of items) {
      if (item.type === 'text') {
        text += item.text;
      } else if (item.type === 'ph') {
        const found = hidden.get(item.id);
        if (found === undefined) throw new RangeError('a placeholder has no text');
        text += found;
      } else if (item.type === 'pc') {
        const start = text.length;
        walk(item.children);
        paired.push({ id: Number(item.id), start, end: text.length });
      } else {
        walk(item.children);
      }
    }
  };
  walk(segments);
  const offsets = paired.map(({ id, start, end }) => {
    const [from, to] = trimmed(text, start, end);
    return { id, start: from, end: to };
  });
  return { text, paired: offsets.sort((left, right) => left.id - right.id) };
}

/** `<pc>` 的位置存進 `book.db` 的樣子，沒有時是 NULL（ADR-0116）。 */
export function pairedJson(offsets: readonly PairedOffset[]): string | null {
  return offsets.length === 0 ? null : JSON.stringify(offsets.map(({ id, start, end }) => ({ id, start, end })));
}

/**
 * 一段文字套上單位樣式之後的 `runs`（ADR-0116）。`offsets` 是每個 `<pc>` 在這段文字裡的位置：
 * 原文用 `formats.paired` 自己的位置，譯文用還原時記下的位置。
 */
export function unitRuns(text: string, formats: UnitFormats | null, offsets: readonly PairedOffset[]): Run[] {
  if (formats === null) return [];
  const styles = new Map(formats.paired.map((format) => [format.id, styleOf(format)]));
  const spans = offsets.flatMap(({ id, start, end }) => {
    const style = styles.get(id);
    return style === undefined ? [] : [{ ...style, start, end }];
  });
  return layerRuns(text, formats.whole, spans);
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
