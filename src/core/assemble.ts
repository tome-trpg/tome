import { createHash } from 'node:crypto';
import { checkConservation } from './conservation.ts';
import type {
  DocumentBlock,
  PageStatus,
  Run,
  Section,
  SourceBlock,
  SourcePage,
  Span,
  Table,
  TableCell,
} from './ir.ts';
import { normalizeText, type SourceLanguage } from './language.ts';
import type { Bbox, OutlineNode, PdfLink, TextRun } from './pdf.ts';
import type { PageKind } from './probe.ts';
import { alignRuns, glyphsOf, joinRuns, runsInside } from './runs.ts';

// 組裝：把 source 層的區塊變成 document 層（白皮書 §5.2）。這裡沒有輸入輸出，
// 相同的輸入一定得到相同的結果。語言規則都來自語言設定檔，遊戲概念由規則包另外判定。

/**
 * 規則一改就要重新組裝，document 層的指紋含這個版本。2 加了 `index`、`credits` 的判定（ADR-0115），
 * 3 加了行內樣式 `runs`（ADR-0116）。
 */
export const ASSEMBLY_VERSION = 3;

// 書末索引與版權頁（ADR-0115）。數字都是提案，只用維護者的七本書量過，只寫數字（ADR-0092 第 7 項）。
/** 判錯成 `index` 的內容不會翻譯、使用者也不會發現，漏判只是多花錢，所以只判書末，寧可少判。 */
const INDEX_FROM_SHARE = 0.9;
const INDEX_MIN_LINES = 10;
const INDEX_LINE_SHARE = 0.5;
const INDEX_ROLES = new Set<string>(['paragraph', 'list_item', 'toc', 'table']);
const CREDITS_FIRST_PAGES = 6;
const CREDITS_LAST_PAGES = 2;
const CREDITS_ROLES = new Set<string>(['paragraph', 'list_item', 'sidebar']);
/** 不分語言的版權記號。語言相關的字詞在來源語言設定檔的 `credits_phrases`。 */
const CREDIT_MARK = /©|\(c\)\s*(?:19|20)\d\d|\bisbn\b/iu;

// 下面的比例已定案（ADR-0098）。
const MARGIN_SHARE = 0.08;
const REPEATED_PAGES = 3;
const BOX_MAX_PAGE_SHARE = 0.6;
const BOX_INSIDE_SHARE = 0.8;
const WIDE_SHARE = 0.6;
const DROP_CAP_RATIO = 2;

/** 接段時跳過的角色：它們是浮動的，不打斷正文。 */
const FLOATING = new Set<string>(['furniture', 'figure', 'caption']);

export interface PageLayout {
  readonly width: number;
  readonly height: number;
  readonly runs: readonly TextRun[];
  readonly boxes: readonly Bbox[];
  readonly invisibleGlyphs: number;
  /** 這一頁的連結方框，行內樣式的 `link` 從這裡來（ADR-0116）。 */
  readonly links?: readonly PdfLink[];
}

export interface AssemblyPage {
  readonly page: number;
  readonly kind: PageKind;
  /** 引擎的輸出。解析失敗或不是原生頁時是 null。 */
  readonly source: SourcePage | null;
  /** 引擎回報的失敗原因。 */
  readonly failure?: string;
  readonly layout: PageLayout | null;
}

export interface AssembleInput {
  readonly language: SourceLanguage;
  readonly pages: readonly AssemblyPage[];
  /** `overrides` 放行的頁，頁面索引從 0 起算（ADR-0115）。 */
  readonly accepted?: ReadonlySet<number>;
}

export interface Assembled {
  readonly blocks: readonly DocumentBlock[];
  readonly pages: readonly PageStatus[];
}

interface Working {
  role: DocumentBlock['role'];
  flow: DocumentBlock['flow'];
  group?: string;
  spans: readonly Span[];
  text: string;
  raw: string;
  /** `text` 上的行內樣式，表格沒有（ADR-0116）。 */
  runs: readonly Run[];
  table?: Table;
  readonly lang: string;
  readonly writing_mode: DocumentBlock['writing_mode'];
  readonly provenance: DocumentBlock['provenance'];
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function startsAs(text: string, rule: 'lower' | 'any'): boolean {
  return rule === 'any' || /^\p{Ll}/u.test(text);
}

/** 接兩段文字。行尾斷字的連字號拿掉，其他情況補一個空白。 */
export function joinText(language: SourceLanguage, left: string, right: string): string {
  const { hyphens, next_starts: nextStarts } = language.dehyphenate;
  const hyphen = hyphens.find((mark) => left.endsWith(mark));
  if (hyphen !== undefined && startsAs(right, nextStarts)) {
    const stem = left.slice(0, -hyphen.length);
    if (/\p{L}$/u.test(stem)) return `${stem}${right}`;
  }
  return `${left} ${right}`;
}

function cleanText(language: SourceLanguage, text: string): string {
  // 引擎把讀不出來的字變成 U+FFFD 與控制字元，例如目錄的點線。這些不能進翻譯，raw 留原樣。
  const lines = normalizeText(language, text)
    .split(/\r?\n/u)
    .map((line) => line.replace(/(?!\s)[\p{Cc}�]/gu, '').replace(/\s+/gu, ' ').trim())
    .filter((line) => line.length > 0);
  return lines.reduce((joined, line) => (joined === '' ? line : joinText(language, joined, line)), '');
}

function cleanTable(language: SourceLanguage, table: Table): Table {
  const cells = table.cells.map((cell): TableCell => {
    const text = cleanText(language, cell.text);
    return text === cell.text ? cell : { ...cell, text, raw: cell.raw ?? cell.text };
  });
  return { ...table, cells };
}

function tableText(table: Table): string {
  return table.cells.map((cell) => cell.text).join('\n');
}

function toWorking(language: SourceLanguage, block: SourceBlock): Working {
  const table = block.table === undefined ? undefined : cleanTable(language, block.table);
  return {
    role: block.role,
    flow: block.flow ?? 'main',
    spans: block.spans,
    text: table === undefined ? cleanText(language, block.text) : tableText(table),
    raw: block.raw,
    // 引擎給的 `runs` 是對引擎的文字算的，清理過的文字對不上，樣式由組裝自己產生（ADR-0116）。
    runs: [],
    ...(table === undefined ? {} : { table }),
    lang: block.lang,
    writing_mode: block.writing_mode,
    provenance: block.provenance,
  };
}

function boxOf(block: { readonly spans: readonly Span[] }): Bbox {
  return block.spans[0]?.bbox ?? [0, 0, 0, 0];
}

const widthOf = (box: Bbox): number => box[2] - box[0];
const areaOf = (box: Bbox): number => Math.max(0, widthOf(box)) * Math.max(0, box[3] - box[1]);

function inMargin(block: SourceBlock, height: number): boolean {
  const [, bottom, , top] = boxOf(block);
  return bottom >= height * (1 - MARGIN_SHARE) || top <= height * MARGIN_SHARE;
}

function repeatKey(language: SourceLanguage, text: string): string {
  return cleanText(language, text).replace(/\p{N}+/gu, '').trim().toLowerCase();
}

/** 每頁都有的頁首頁尾與購買者資訊。引擎沒標到時，靠它們重複出現認出來。 */
function repeatedMargins(language: SourceLanguage, pages: readonly AssemblyPage[]): Set<string> {
  const seen = new Map<string, Set<number>>();
  for (const { page, source, layout } of pages) {
    if (source === null || layout === null) continue;
    for (const block of source.blocks) {
      if (block.text === '' || block.table !== undefined || !inMargin(block, layout.height)) continue;
      const key = repeatKey(language, block.text);
      seen.set(key, (seen.get(key) ?? new Set()).add(page));
    }
  }
  return new Set([...seen].filter(([, found]) => found.size >= REPEATED_PAGES).map(([key]) => key));
}

function overlapShare(block: Bbox, box: Bbox): number {
  const width = Math.min(block[2], box[2]) - Math.max(block[0], box[0]);
  const height = Math.min(block[3], box[3]) - Math.max(block[1], box[1]);
  const area = areaOf(block);
  return width <= 0 || height <= 0 || area === 0 ? 0 : (width * height) / area;
}

/** 文字落在方框內算邊欄，走 aside，不打斷正文。方框裡要有內文，標題的底色帶不算。 */
function markSidebars(blocks: readonly Working[], layout: PageLayout, page: number): void {
  const pageArea = layout.width * layout.height;
  const unique = new Map(layout.boxes.map((box) => [box.join(','), box]));
  const boxes = [...unique.values()]
    .filter((box) => areaOf(box) <= pageArea * BOX_MAX_PAGE_SHARE)
    .sort((left, right) => areaOf(left) - areaOf(right));
  let found = 0;
  for (const box of boxes) {
    const members = blocks.filter(
      (block) =>
        block.flow === 'main' &&
        block.role !== 'furniture' &&
        overlapShare(boxOf(block), box) >= BOX_INSIDE_SHARE,
    );
    if (!members.some((block) => block.role === 'paragraph')) continue;
    found += 1;
    for (const block of members) {
      block.flow = 'aside';
      block.group = `p${String(page).padStart(4, '0')}-box${found}`;
      if (block.role === 'paragraph') block.role = 'sidebar';
    }
  }
}

function intoColumns(blocks: readonly Working[]): Working[] {
  const columns: { right: number; members: Working[] }[] = [];
  for (const block of [...blocks].sort((left, right) => boxOf(left)[0] - boxOf(right)[0])) {
    const [x0, , x1] = boxOf(block);
    const column = columns.find(({ right }) => x0 < right);
    if (column === undefined) {
      columns.push({ right: x1, members: [block] });
    } else {
      column.right = Math.max(column.right, x1);
      column.members.push(block);
    }
  }
  return columns.flatMap(({ members }) => members.sort((left, right) => boxOf(right)[3] - boxOf(left)[3]));
}

/** 全寬的區塊把頁面切成幾段，每段裡整欄讀完再換欄。邊欄已經拿掉，不會把欄切開。 */
function readingOrder(blocks: readonly Working[]): Working[] {
  if (blocks.length < 2) return [...blocks];
  const left = Math.min(...blocks.map((block) => boxOf(block)[0]));
  const right = Math.max(...blocks.map((block) => boxOf(block)[2]));
  const wide = (right - left) * WIDE_SHARE;
  const ordered: Working[] = [];
  let band: Working[] = [];
  for (const block of [...blocks].sort((a, b) => boxOf(b)[3] - boxOf(a)[3])) {
    if (widthOf(boxOf(block)) > wide) {
      ordered.push(...intoColumns(band), block);
      band = [];
    } else {
      band.push(block);
    }
  }
  return [...ordered, ...intoColumns(band)];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const runHeight = (run: TextRun): number => run.bbox[3] - run.bbox[1];

/** 引擎把放大的首字跟後面隔開，讀成「T he」。 */
function fixDropCaps(blocks: readonly Working[], layout: PageLayout): void {
  const usual = median(layout.runs.map(runHeight));
  for (const block of blocks) {
    const match = /^(\p{Lu})\s+(?=\p{Ll})/u.exec(block.text);
    if (match === null || block.table !== undefined) continue;
    const [x0, bottom, x1, top] = boxOf(block);
    const found = layout.runs.some(
      (run) =>
        run.text.trim() === match[1] &&
        runHeight(run) >= usual * DROP_CAP_RATIO &&
        run.bbox[0] >= x0 - 1 &&
        run.bbox[0] <= x1 &&
        run.bbox[3] >= bottom &&
        run.bbox[1] <= top,
    );
    if (found) block.text = `${match[1] ?? ''}${block.text.slice(match[0].length)}`;
  }
}

/**
 * 段落類的區塊對上 pdf.js 的字，產生 `runs`。表格的儲存格沒有座標，不做；對上的字母數字不到 95%
 * 的區塊不給樣式（ADR-0116）。首字放大要先修好，區塊的文字才是最後的樣子。
 */
function addRuns(language: SourceLanguage, blocks: readonly Working[], layout: PageLayout): void {
  const links = layout.links ?? [];
  for (const block of blocks) {
    if (block.table !== undefined || block.text === '') continue;
    const inside = runsInside(
      layout.runs,
      block.spans.map(({ bbox }) => bbox),
    );
    block.runs = alignRuns(language, block.text, glyphsOf(language, inside, links)).runs;
  }
}

function firstPage(block: Working): number {
  return block.spans[0]?.page ?? 0;
}

function lastPage(block: Working): number {
  return block.spans.at(-1)?.page ?? 0;
}

function canReach(previous: Working, next: Working, closed: ReadonlySet<number>): boolean {
  for (let page = lastPage(previous) + 1; page < firstPage(next); page += 1) {
    if (closed.has(page)) return false;
  }
  return !closed.has(firstPage(next));
}

function continuesParagraph(language: SourceLanguage, previous: Working, next: Working): boolean {
  if (previous.role !== 'paragraph' || next.role !== 'paragraph') return false;
  const { sentence_end: ends, next_starts: nextStarts } = language.join;
  return !ends.some((mark) => previous.text.endsWith(mark)) && startsAs(next.text, nextStarts);
}

function continuesTable(previous: Working, next: Working): boolean {
  return (
    previous.table !== undefined &&
    next.table !== undefined &&
    previous.table.cols === next.table.cols &&
    firstPage(next) === lastPage(previous) + 1
  );
}

function rowTexts(table: Table, row: number): string[] {
  return table.cells.filter((cell) => cell.row === row).map((cell) => cell.text);
}

/** 跨頁表格。下一頁重印的表頭不算資料列。 */
function appendTable(first: Table, second: Table): Table {
  const repeated = rowTexts(first, 0).join('\n') === rowTexts(second, 0).join('\n');
  const skipped = repeated ? 1 : 0;
  const moved = second.cells
    .filter((cell) => cell.row >= skipped)
    .map((cell) => ({ ...cell, row: cell.row - skipped + first.rows }));
  return { ...first, rows: first.rows + second.rows - skipped, cells: [...first.cells, ...moved] };
}

function absorb(language: SourceLanguage, into: Working, next: Working): void {
  into.spans = [...into.spans, ...next.spans];
  into.raw = `${into.raw}\n${next.raw}`;
  if (into.table !== undefined && next.table !== undefined) {
    into.table = appendTable(into.table, next.table);
    into.text = tableText(into.table);
  } else {
    const text = joinText(language, into.text, next.text);
    // 後一塊的樣式跟著位移，跨頁的粗體句子接成一段（ADR-0116）。
    into.runs = joinRuns(text, into.runs, next.runs, next.text.length);
    into.text = text;
  }
}

/** 接起跨欄、跨邊欄、跨頁的段落與表格。接過的區塊留在第一塊的位置。 */
function stitch(
  language: SourceLanguage,
  blocks: readonly Working[],
  closed: ReadonlySet<number>,
): Working[] {
  const result: Working[] = [];
  let previous: Working | null = null;
  for (const block of blocks) {
    if (block.flow === 'aside' || FLOATING.has(block.role)) {
      result.push(block);
      continue;
    }
    if (
      previous !== null &&
      canReach(previous, block, closed) &&
      (continuesTable(previous, block) || continuesParagraph(language, previous, block))
    ) {
      absorb(language, previous, block);
      continue;
    }
    result.push(block);
    previous = block;
  }
  return result;
}

function pageBlocks(
  language: SourceLanguage,
  source: SourcePage,
  layout: PageLayout,
  repeated: ReadonlySet<string>,
): Working[] {
  const blocks = source.blocks
    .map((block) => {
      const working = toWorking(language, block);
      const margin = inMargin(block, layout.height) && repeated.has(repeatKey(language, block.text));
      if (margin && block.table === undefined) working.role = 'furniture';
      return working;
    })
    .filter((block) => block.text !== '' || block.role === 'figure');
  markSidebars(blocks, layout, source.page);
  fixDropCaps(blocks, layout);
  addRuns(language, blocks, layout);
  const furniture = blocks.filter((block) => block.role === 'furniture');
  const rest = blocks.filter((block) => block.role !== 'furniture');
  return [
    ...readingOrder(rest.filter((block) => block.flow === 'main')),
    ...rest.filter((block) => block.flow === 'aside'),
    ...furniture,
  ];
}

/** 放行的頁在 `pages` 的原因代碼（ADR-0115）。 */
export const ACCEPTED = 'accepted';

/**
 * 未通過字元守恆的頁預設失敗，`overrides` 放行時照樣收，狀態是 `ok`、原因是 `accepted`，缺字數照留
 * （ADR-0099 第 11 項、ADR-0115）。引擎沒有輸出的頁沒有區塊可收，放行也沒用。
 */
function statusOf(language: SourceLanguage, item: AssemblyPage, accepted: ReadonlySet<number>): PageStatus {
  const { page, kind, source, failure, layout } = item;
  if (kind !== 'native') return { page, status: 'skipped', reason: kind };
  if (source === null || layout === null) {
    return { page, status: 'failed', reason: failure ?? 'no_output' };
  }
  const { total, missing, passed } = checkConservation(
    language,
    layout.runs.map((run) => run.text),
    source.blocks.map((block) => block.raw),
    layout.invisibleGlyphs,
  );
  if (passed) return { page, status: 'ok', missing, total };
  if (accepted.has(page)) return { page, status: 'ok', reason: ACCEPTED, missing, total };
  return { page, status: 'failed', reason: 'characters_missing', missing, total };
}

function finish(blocks: readonly Working[]): DocumentBlock[] {
  const seen = new Map<string, number>();
  return blocks.map((block) => {
    const { role, flow, group, spans, text, raw, runs, table, lang, writing_mode, provenance } = block;
    const hash = hashText(text);
    const base = `p${String(spans[0]?.page ?? 0).padStart(4, '0')}-${hash.slice(0, 6)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return {
      id: count === 0 ? base : `${base}-${count}`,
      content_hash: hash,
      role,
      flow,
      ...(group === undefined ? {} : { group }),
      spans,
      text,
      raw,
      ...(runs.length === 0 ? {} : { runs }),
      ...(table === undefined ? {} : { table }),
      lang,
      writing_mode,
      provenance,
    };
  });
}

const isSpace = (char: string | undefined): boolean => char !== undefined && /\s/u.test(char);
const isDigit = (char: string | undefined): boolean => char !== undefined && char >= '0' && char <= '9';

function skipSpaces(line: string, end: number): number {
  let at = end;
  while (at > 0 && isSpace(line[at - 1])) at -= 1;
  return at;
}

/** `end` 之前的 1 到 4 位數字從哪裡開始，不是就回 -1。 */
function digitsBefore(line: string, end: number): number {
  let at = end;
  while (at > 0 && isDigit(line[at - 1])) at -= 1;
  const count = end - at;
  return count >= 1 && count <= 4 ? at : -1;
}

/** `end` 之前的一個頁碼或範圍（`12`、`12–14`）從哪裡開始，不是就回 -1。 */
function pageRefBefore(line: string, end: number): number {
  const last = digitsBefore(line, end);
  if (last < 0) return -1;
  const dash = skipSpaces(line, last);
  if (line[dash - 1] === '-' || line[dash - 1] === '–') {
    const first = digitsBefore(line, skipSpaces(line, dash - 1));
    if (first >= 0) return first;
  }
  return last;
}

/**
 * 一行的結尾是不是頁碼清單（`Armor, 12`、`Combat 12–14, 30`）：前面要有字母，清單前要有空白、逗號或句點。
 * 從行尾往前掃一次，不用正規表示式，長行也不會回溯（ADR-0115）。
 */
export function endsWithPageNumbers(line: string): boolean {
  return pageListStart(line) >= 0;
}

/** 行尾頁碼清單從哪裡開始，不是頁碼清單就回 -1。Pass 0 從索引取前面的詞用（ADR-0118）。 */
export function pageListStart(line: string): number {
  let start = pageRefBefore(line, skipSpaces(line, line.length));
  if (start < 0) return -1;
  for (;;) {
    const comma = skipSpaces(line, start);
    if (line[comma - 1] !== ',') break;
    const previous = pageRefBefore(line, skipSpaces(line, comma - 1));
    if (previous < 0) break;
    start = previous;
  }
  const before = line[start - 1];
  if (!(isSpace(before) || before === ',' || before === '.')) return -1;
  return /\p{L}/u.test(line.slice(0, start)) ? start : -1;
}

/** 一個區塊的每一行：表格是每一格，其他用引擎給的原文分行，接段之前的樣子。讀不出來的字當空白。 */
function linesOf(block: Working): string[] {
  const lines = block.table === undefined ? block.raw.split(/\r?\n/u) : block.table.cells.map(({ text }) => text);
  return lines.map((line) => line.replace(/[\p{Cc}�]/gu, ' ').trim()).filter((line) => line !== '');
}

interface PageWork {
  readonly page: number;
  readonly blocks: readonly Working[];
}

function looksLikeIndex(blocks: readonly Working[]): boolean {
  const lines = blocks.filter(({ role }) => role !== 'furniture' && role !== 'figure').flatMap(linesOf);
  const hits = lines.filter(endsWithPageNumbers).length;
  return lines.length >= INDEX_MIN_LINES && hits / lines.length >= INDEX_LINE_SHARE;
}

/**
 * 全書 90% 之後、一半以上的行結尾是頁碼的頁是書末索引，夾在兩頁索引之間的一頁也算。
 * 目錄長得一樣，但都在書的開頭（ADR-0115）。標題、圖、邊欄與頁首頁尾不動。
 */
function markIndex(pages: readonly PageWork[], total: number): void {
  const tail = pages.filter(({ page }) => (page + 1) / total >= INDEX_FROM_SHARE);
  const hits = new Set(tail.filter(({ blocks }) => looksLikeIndex(blocks)).map(({ page }) => page));
  for (const { page, blocks } of tail) {
    if (!hits.has(page) && !(hits.has(page - 1) && hits.has(page + 1))) continue;
    for (const block of blocks) if (INDEX_ROLES.has(block.role)) block.role = 'index';
  }
}

/** 開頭 6 頁與最後 2 頁裡，帶版權記號或語言設定檔字詞的區塊。只改有記號的區塊，不整頁改（ADR-0115）。 */
function markCredits(language: SourceLanguage, pages: readonly PageWork[], total: number): void {
  const phrases = (language.credits_phrases ?? []).map((phrase) => phrase.toLowerCase());
  for (const { page, blocks } of pages) {
    if (page >= CREDITS_FIRST_PAGES && page < total - CREDITS_LAST_PAGES) continue;
    for (const block of blocks) {
      if (!CREDITS_ROLES.has(block.role)) continue;
      const text = block.text.toLowerCase();
      if (CREDIT_MARK.test(block.text) || phrases.some((phrase) => text.includes(phrase))) block.role = 'credits';
    }
  }
}

export function assembleBlocks({ language, pages, accepted = new Set() }: AssembleInput): Assembled {
  const statuses = pages.map((item) => statusOf(language, item, accepted));
  const closed = new Set(statuses.filter(({ status }) => status !== 'ok').map(({ page }) => page));
  const open = pages.filter(({ page }) => !closed.has(page));
  const repeated = repeatedMargins(language, open);
  const work = open.map(({ page, source, layout }) => ({
    page,
    blocks: source === null || layout === null ? [] : pageBlocks(language, source, layout, repeated),
  }));
  // 在接段之前判定：索引的條目常以小寫開頭，先判成 `index` 才不會被接成一長段（ADR-0115）。
  markIndex(work, pages.length);
  markCredits(language, work, pages.length);
  const blocks = work.flatMap(({ blocks: list }) => list);
  return { blocks: finish(stitch(language, blocks, closed)), pages: statuses };
}

function fold(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

interface Located {
  readonly section: Section;
  readonly path: readonly string[];
}

function locate(
  nodes: readonly OutlineNode[],
  blocks: readonly DocumentBlock[],
  path: readonly string[],
  found: Located[],
): Section[] {
  return nodes.flatMap((node) => {
    const title = node.title.trim();
    if (title === '') return [];
    const onPage = blocks.filter(
      (block) => block.role !== 'furniture' && block.spans.some(({ page }) => page === node.page),
    );
    const target = onPage.find((block) => fold(block.text) === fold(title)) ?? onPage[0];
    const trail = [...path, title];
    const position = found.length;
    const children = locate(node.children, blocks, trail, found);
    const section: Section = {
      title,
      ...(target === undefined ? {} : { block_id: target.id }),
      children,
    };
    found.splice(position, 0, { section, path: trail });
    return [section];
  });
}

function outlineSections(
  blocks: readonly DocumentBlock[],
  outline: readonly OutlineNode[],
): { sections: readonly Section[]; located: readonly Located[] } {
  const located: Located[] = [];
  return { sections: locate(outline, blocks, [], located), located };
}

function headingSections(blocks: readonly DocumentBlock[]): {
  sections: readonly Section[];
  located: readonly Located[];
} {
  const located = blocks
    .filter(({ flow, role }) => flow === 'main' && (role === 'title' || role === 'heading'))
    .filter(({ text }) => text !== '')
    .map(({ id, text }) => ({
      section: { title: text, block_id: id, children: [] },
      path: [text],
    }));
  return { sections: located.map(({ section }) => section), located };
}

/** 書籤優先。沒有書籤就用標題區塊建一層（ADR-0092）。 */
export function withSections(
  blocks: readonly DocumentBlock[],
  outline: readonly OutlineNode[],
): { readonly blocks: readonly DocumentBlock[]; readonly sections: readonly Section[] } {
  const { sections, located } = outline.length > 0 ? outlineSections(blocks, outline) : headingSections(blocks);
  const starts = new Map<string, readonly string[]>();
  for (const { section, path } of located) {
    if (section.block_id !== undefined) starts.set(section.block_id, path);
  }
  let current: readonly string[] | undefined;
  const placed = blocks.map((block) => {
    current = starts.get(block.id) ?? current;
    return current === undefined || block.role === 'furniture' ? block : { ...block, section: current };
  });
  return { blocks: placed, sections };
}
