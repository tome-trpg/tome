import { createHash } from 'node:crypto';
import { checkConservation } from './conservation.ts';
import type {
  DocumentBlock,
  PageStatus,
  Section,
  SourceBlock,
  SourcePage,
  Span,
  Table,
  TableCell,
} from './ir.ts';
import { normalizeText, type SourceLanguage } from './language.ts';
import type { Bbox, OutlineNode, TextRun } from './pdf.ts';
import type { PageKind } from './probe.ts';

// 組裝：把 source 層的區塊變成 document 層（白皮書 §5.2）。這裡沒有輸入輸出，
// 相同的輸入一定得到相同的結果。語言規則都來自語言設定檔，遊戲概念由規則包另外判定。

/** 規則一改就要重新組裝，document 層的指紋含這個版本。 */
export const ASSEMBLY_VERSION = 1;

// 下面的比例都是提案，等 H-5 量過才定案（ADR-0092）。
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
    into.text = joinText(language, into.text, next.text);
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
  const furniture = blocks.filter((block) => block.role === 'furniture');
  const rest = blocks.filter((block) => block.role !== 'furniture');
  return [
    ...readingOrder(rest.filter((block) => block.flow === 'main')),
    ...rest.filter((block) => block.flow === 'aside'),
    ...furniture,
  ];
}

function statusOf(language: SourceLanguage, item: AssemblyPage): PageStatus {
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
  return passed
    ? { page, status: 'ok', missing, total }
    : { page, status: 'failed', reason: 'characters_missing', missing, total };
}

function finish(blocks: readonly Working[]): DocumentBlock[] {
  const seen = new Map<string, number>();
  return blocks.map((block) => {
    const { role, flow, group, spans, text, raw, table, lang, writing_mode, provenance } = block;
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
      ...(table === undefined ? {} : { table }),
      lang,
      writing_mode,
      provenance,
    };
  });
}

export function assembleBlocks({ language, pages }: AssembleInput): Assembled {
  const statuses = pages.map((item) => statusOf(language, item));
  const closed = new Set(statuses.filter(({ status }) => status !== 'ok').map(({ page }) => page));
  const open = pages.filter(({ page }) => !closed.has(page));
  const repeated = repeatedMargins(language, open);
  const blocks = open.flatMap(({ source, layout }) =>
    source === null || layout === null ? [] : pageBlocks(language, source, layout, repeated),
  );
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
