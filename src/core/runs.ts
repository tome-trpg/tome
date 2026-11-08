import type { Run } from './ir.ts';
import { normalizeText, type SourceLanguage } from './language.ts';
import type { Bbox, PdfLink, TextRun } from './pdf.ts';

// 行內樣式（ADR-0116）。粗體、斜體來自 pdf.js 的字型名稱，連結來自 PDF 的連結方框，
// 組裝時把 pdf.js 的字對到區塊的文字，產生 IR 的 `runs`。`runs` 的位置是區塊文字的 UTF-16 位置。

/** 區塊裡對上的字母數字少於這個比例就不給樣式，寧可沒有樣式也不要錯的樣式。是提案（ADR-0116）。 */
export const RUNS_MIN_SHARE = 0.95;
/** 對不上時往前找多遠、要連續幾個字相同才算接回去。 */
const RESYNC_WINDOW = 24;
const RESYNC_ANCHOR = 3;
/** pdf.js 文字段的中心落在區塊方框外這麼多還算在裡面。單位是 PDF 點。 */
const BOX_SLACK = 1;

/** IR 的標記。035 只產生 `bold`、`italic`（ADR-0116）。 */
export type Mark = NonNullable<Run['marks']>[number];
export type Link = NonNullable<Run['link']>;

export interface Style {
  readonly marks?: readonly Mark[];
  readonly link?: Link;
}

const LETTER = /[\p{L}\p{N}]/u;

/** 樣式相同就相同。標記的順序不算。 */
export function styleKey(style: Style): string {
  const marks = [...(style.marks ?? [])].sort();
  return JSON.stringify([marks, style.link?.page ?? null, style.link?.uri ?? null]);
}

/** 沒有標記也沒有連結。 */
export function isPlain(style: Style): boolean {
  return (style.marks ?? []).length === 0 && style.link === undefined;
}

/** 只留樣式欄位，空的不寫。 */
export function styleOf(style: Style): Style {
  const marks = [...new Set(style.marks ?? [])].sort();
  return { ...(marks.length === 0 ? {} : { marks }), ...(style.link === undefined ? {} : { link: style.link }) };
}

function runOf(start: number, end: number, style: Style): Run {
  return { start, end, ...styleOf(style) };
}

/**
 * 一個字比對用的樣子：照語言設定檔正規化、拆掉附加符號、轉小寫，只留字母與數字。
 * 跟字元守恆一樣只比字母數字（ADR-0092），引擎換掉的標點與引號不影響。
 */
function foldChar(language: SourceLanguage, char: string): string[] {
  return [...normalizeText(language, char).normalize('NFD').toLowerCase()].filter((item) => LETTER.test(item));
}

interface Letter {
  readonly char: string;
  readonly start: number;
  readonly end: number;
}

function lettersOf(language: SourceLanguage, text: string): Letter[] {
  const letters: Letter[] = [];
  let offset = 0;
  for (const char of text) {
    for (const folded of foldChar(language, char)) letters.push({ char: folded, start: offset, end: offset + char.length });
    offset += char.length;
  }
  return letters;
}

export interface Glyph {
  readonly char: string;
  readonly style: Style;
}

function normalized(box: Bbox): Bbox {
  return [Math.min(box[0], box[2]), Math.min(box[1], box[3]), Math.max(box[0], box[2]), Math.max(box[1], box[3])];
}

function contains(box: Bbox, x: number, y: number, slack = 0): boolean {
  const [x0, y0, x1, y1] = normalized(box);
  return x >= x0 - slack && x <= x1 + slack && y >= y0 - slack && y <= y1 + slack;
}

function linkOf({ target_page: page, uri }: PdfLink): Link | undefined {
  if (page !== undefined) return { page };
  return uri === undefined ? undefined : { uri };
}

/**
 * pdf.js 的文字段拆成一個一個字。pdf.js 只給整段的方框，段內每個字的位置用寬度平均分，
 * 字的中心落在連結方框裡就掛上連結（ADR-0116）。
 */
export function glyphsOf(language: SourceLanguage, runs: readonly TextRun[], links: readonly PdfLink[]): Glyph[] {
  return runs.flatMap((run) => {
    const chars = Array.from(run.text);
    const [x0, y0, x1, y1] = run.bbox;
    const y = (y0 + y1) / 2;
    const marks: Mark[] = [...(run.bold === true ? ['bold' as const] : []), ...(run.italic === true ? ['italic' as const] : [])];
    return chars.flatMap((char, index) => {
      const x = x0 + ((x1 - x0) * (index + 0.5)) / chars.length;
      const found = links.find((link) => contains(link.bbox, x, y));
      const link = found === undefined ? undefined : linkOf(found);
      const style = styleOf({ marks, ...(link === undefined ? {} : { link }) });
      return foldChar(language, char).map((folded) => ({ char: folded, style }));
    });
  });
}

/** 中心落在任一個方框裡的文字段，依內容串流的順序。 */
export function runsInside(runs: readonly TextRun[], boxes: readonly Bbox[]): TextRun[] {
  return runs.filter(({ bbox }) => {
    const x = (bbox[0] + bbox[2]) / 2;
    const y = (bbox[1] + bbox[3]) / 2;
    return boxes.some((box) => contains(box, x, y, BOX_SLACK));
  });
}

function sameStretch(left: readonly string[], i: number, right: readonly string[], j: number): boolean {
  const wanted = Math.min(RESYNC_ANCHOR, left.length - i);
  if (wanted <= 0 || right.length - j < wanted) return false;
  for (let k = 0; k < wanted; k += 1) if (left[i + k] !== right[j + k]) return false;
  return true;
}

/** 對不上時兩邊各要跳幾個字。找不到接得回去的位置就各跳一個。 */
function resync(left: readonly string[], i: number, right: readonly string[], j: number): readonly [number, number] {
  for (let skip = 1; skip <= RESYNC_WINDOW; skip += 1) {
    if (sameStretch(left, i, right, j + skip)) return [0, skip];
    if (sameStretch(left, i + skip, right, j)) return [skip, 0];
  }
  return [1, 1];
}

/** `left` 每個字對到 `right` 的第幾個字，沒對上是 -1。從頭往後掃一次，耗時跟字數成正比。 */
export function matchLetters(left: readonly string[], right: readonly string[]): Int32Array {
  const match = new Int32Array(left.length).fill(-1);
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      match[i] = j;
      i += 1;
      j += 1;
      continue;
    }
    const [skipLeft, skipRight] = resync(left, i, right, j);
    i += skipLeft;
    j += skipRight;
  }
  return match;
}

export interface Alignment {
  /** 對上的字母數字占區塊的比例。區塊沒有字母數字時是 1。 */
  readonly share: number;
  /** 比例不到 `RUNS_MIN_SHARE` 時是空的。 */
  readonly runs: readonly Run[];
}

/** 沒對上的字：前後對上的字樣式相同就跟著用，不同就沒有樣式。 */
function fillGaps(styles: readonly (Style | null | undefined)[]): (Style | null)[] {
  const after: (Style | null)[] = new Array<Style | null>(styles.length).fill(null);
  let next: Style | null = null;
  for (let index = styles.length - 1; index >= 0; index -= 1) {
    after[index] = next;
    const style = styles[index];
    if (style !== undefined) next = style;
  }
  let before: Style | null = null;
  return styles.map((style, index) => {
    if (style !== undefined) {
      before = style;
      return style;
    }
    const following = after[index] ?? null;
    return before !== null && following !== null && styleKey(before) === styleKey(following) ? before : null;
  });
}

const segmenters = new Map<string, Intl.Segmenter>();

/** 詞的位置。用平台的斷詞，依語言設定檔的 `lang` 切，核心不放語言規則（ADR-0116）。 */
function wordsOf(lang: string, text: string): { readonly start: number; readonly end: number }[] {
  let segmenter = segmenters.get(lang);
  if (segmenter === undefined) {
    segmenter = new Intl.Segmenter(lang, { granularity: 'word' });
    segmenters.set(lang, segmenter);
  }
  return [...segmenter.segment(text)]
    .filter(({ isWordLike }) => isWordLike === true)
    .map(({ index, segment }) => ({ start: index, end: index + segment.length }));
}

/**
 * 一段樣式縮到它完整蓋住的詞，一個都沒蓋滿就不要（ADR-0116）。首字放大的字母常用別的字型，
 * 只蓋到詞的一個字母，送成 `<pc>` 模型也放不回譯文。
 */
export function wholeWords(lang: string, text: string, runs: readonly Run[]): Run[] {
  if (runs.length === 0) return [];
  const words = wordsOf(lang, text);
  return runs.flatMap((run) => {
    const inside = words.filter(({ start, end }) => start >= run.start && end <= run.end);
    const first = inside[0];
    const last = inside.at(-1);
    return first === undefined || last === undefined ? [] : [{ ...run, start: first.start, end: last.end }];
  });
}

/**
 * 把 pdf.js 的字對到區塊的文字，產生 `runs`（ADR-0116）。同樣式、中間只隔空白或標點的字併成一段，
 * 只放在完整的詞上。
 */
export function alignRuns(language: SourceLanguage, text: string, glyphs: readonly Glyph[]): Alignment {
  const letters = lettersOf(language, text);
  if (letters.length === 0) return { share: 1, runs: [] };
  const match = matchLetters(
    letters.map(({ char }) => char),
    glyphs.map(({ char }) => char),
  );
  const matched = match.filter((index) => index >= 0).length;
  const share = matched / letters.length;
  if (share < RUNS_MIN_SHARE) return { share, runs: [] };
  const styles = fillGaps(Array.from(match, (index) => (index < 0 ? undefined : (glyphs[index]?.style ?? null))));
  const runs: Run[] = [];
  let open: { start: number; end: number; key: string; style: Style } | null = null;
  for (const [index, letter] of letters.entries()) {
    const style = styles[index] ?? null;
    const key = style === null || isPlain(style) ? null : styleKey(style);
    if (open !== null && key === open.key) {
      open.end = letter.end;
      continue;
    }
    if (open !== null) runs.push(runOf(open.start, open.end, open.style));
    open = key === null || style === null ? null : { start: letter.start, end: letter.end, key, style };
  }
  if (open !== null) runs.push(runOf(open.start, open.end, open.style));
  return { share, runs: wholeWords(language.lang, text, runs) };
}

/** 相鄰、樣式相同、中間沒有字母數字的段併起來。 */
export function mergeRuns(text: string, runs: readonly Run[]): Run[] {
  const sorted = [...runs].filter(({ start, end }) => end > start).sort((left, right) => left.start - right.start);
  const merged: Run[] = [];
  for (const run of sorted) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      previous.end <= run.start &&
      styleKey(previous) === styleKey(run) &&
      !LETTER.test(text.slice(previous.end, run.start))
    ) {
      merged[merged.length - 1] = { ...previous, end: run.end };
    } else {
      merged.push(run);
    }
  }
  return merged;
}

/** `[start, end)` 裡的段，位置改成從 `start` 起算，超出的部分切掉。 */
export function sliceRuns(runs: readonly Run[], start: number, end: number): Run[] {
  return runs.flatMap((run) => {
    const from = Math.max(run.start, start);
    const to = Math.min(run.end, end);
    return to > from ? [{ ...run, start: from - start, end: to - start }] : [];
  });
}

export function shiftRuns(runs: readonly Run[], by: number): Run[] {
  return runs.map((run) => ({ ...run, start: run.start + by, end: run.end + by }));
}

/**
 * 兩段文字接起來之後的 `runs`。`joinText` 的結果一定以右邊的文字結尾，左邊可能少了行尾的連字號，
 * 所以右邊從 `joined.length - rightLength` 開始，左邊切到那裡為止。
 */
export function joinRuns(joined: string, left: readonly Run[], right: readonly Run[], rightLength: number): Run[] {
  const offset = joined.length - rightLength;
  return mergeRuns(joined, [...sliceRuns(left, 0, offset), ...shiftRuns(right, offset)]);
}

export interface StyledSpan extends Style {
  readonly start: number;
  readonly end: number;
}

/**
 * 整段的樣式疊上各段的樣式，攤平成不重疊的 `runs`（ADR-0116）。整段的樣式從第一個字母數字到最後一個，
 * 連結以段的為準。
 */
export function layerRuns(text: string, whole: Style | undefined, spans: readonly StyledSpan[]): Run[] {
  const letters = [...text.matchAll(/[\p{L}\p{N}]/gu)];
  const first = letters[0];
  const last = letters.at(-1);
  const range =
    whole === undefined || isPlain(whole) || first === undefined || last === undefined
      ? null
      : ([first.index, last.index + last[0].length] as const);
  const valid = spans.filter(({ start, end }) => end > start);
  const cuts = [...new Set([...(range ?? []), ...valid.flatMap(({ start, end }) => [start, end])])].sort(
    (left, right) => left - right,
  );
  const runs: Run[] = [];
  for (let index = 0; index + 1 < cuts.length; index += 1) {
    const from = cuts[index] ?? 0;
    const to = cuts[index + 1] ?? 0;
    const inWhole = range !== null && from >= range[0] && to <= range[1];
    const over = valid.filter(({ start, end }) => start <= from && end >= to);
    const marks = [...(inWhole ? (whole?.marks ?? []) : []), ...over.flatMap((span) => span.marks ?? [])];
    const link = over.find((span) => span.link !== undefined)?.link ?? (inWhole ? whole?.link : undefined);
    const style = styleOf({ marks, ...(link === undefined ? {} : { link }) });
    if (!isPlain(style)) runs.push({ start: from, end: to, ...style });
  }
  return mergeRuns(text, runs);
}

/** `text` 裡每個 `needle` 換成 `replacement` 之後的 `runs`。被換掉的地方沒有樣式（ADR-0116）。 */
export function replaceRuns(text: string, needle: string, replacement: string, runs: readonly Run[]): Run[] {
  if (needle === '' || runs.length === 0) return [...runs];
  const kept: Run[] = [];
  let from = 0;
  let shift = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    kept.push(...shiftRuns(sliceRuns(runs, from, at), from + shift));
    shift += replacement.length - needle.length;
    from = at + needle.length;
  }
  kept.push(...shiftRuns(sliceRuns(runs, from, text.length), from + shift));
  return kept;
}
