import { readFile } from 'node:fs/promises';
import { getResolvedPDFJS } from 'unpdf';
import { TomeError } from './errors.ts';

// 只有這個檔案碰 pdf.js（ADR-0084）。unpdf 內含 pdf.js，沒有原生模組。
// 這裡回傳的文字是書的內容，MUST NOT 進訊息或紀錄（ADR-0059）。

type PdfJs = Awaited<ReturnType<typeof getResolvedPDFJS>>;
type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;
type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export type Bbox = readonly [number, number, number, number];

export interface OutlineNode {
  readonly title: string;
  /** 實體頁索引，從 0 起算。目的地解析不到時是 null。 */
  readonly page: number | null;
  readonly children: readonly OutlineNode[];
}

export interface PdfLink {
  readonly page: number;
  readonly bbox: Bbox;
  readonly target_page?: number;
  readonly uri?: string;
}

export interface TextRun {
  readonly text: string;
  readonly bbox: Bbox;
  readonly font: string;
}

export interface PageFacts {
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly runs: readonly TextRun[];
  /** 依文字繪製模式分開算，掃描頁的 OCR 文字層是看不見的（模式 3）。 */
  readonly visibleGlyphs: number;
  readonly invisibleGlyphs: number;
  /** 最大的單張圖片占頁面的比例。 */
  readonly imageLargest: number;
  /** 所有圖片加總占頁面的比例，上限 1。 */
  readonly imageTotal: number;
  readonly vectorPaths: number;
  /** 畫出來的向量形狀的外框，已經換算成頁面座標。邊欄靠它判定（ADR-0092）。 */
  readonly boxes: readonly Bbox[];
  readonly links: readonly PdfLink[];
}

export interface PdfHandle {
  readonly pageCount: number;
  readonly tagged: boolean;
  outline(): Promise<readonly OutlineNode[]>;
  /** 長度等於頁數，沒有標籤的頁是空字串。整份都沒有時是 null。 */
  pageLabels(): Promise<readonly string[] | null>;
  page(index: number): Promise<PageFacts>;
  close(): Promise<void>;
}

export type PdfOpen =
  | { readonly status: 'encrypted' }
  | { readonly status: 'ok'; readonly pdf: PdfHandle };

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 圖片是單位正方形經 CTM 映射。回傳它落在頁面內的面積比例。 */
function imageShare(ctm: Matrix, view: Bbox): number {
  const corners = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const width = Math.min(Math.max(...xs), view[2]) - Math.max(Math.min(...xs), view[0]);
  const height = Math.min(Math.max(...ys), view[3]) - Math.max(Math.min(...ys), view[1]);
  if (width <= 0 || height <= 0) return 0;
  return (width * height) / ((view[2] - view[0]) * (view[3] - view[1]));
}

function asMatrix(args: unknown): Matrix | null {
  const list = Array.isArray(args) && args.length === 1 ? args[0] : args;
  const values = Array.from((list ?? []) as Iterable<number>);
  return values.length === 6 ? (values as unknown as Matrix) : null;
}

function isGlyph(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !(value as { isSpace?: boolean }).isSpace;
}

interface OperatorSummary {
  readonly visibleGlyphs: number;
  readonly invisibleGlyphs: number;
  readonly imageLargest: number;
  readonly imageTotal: number;
  readonly vectorPaths: number;
  readonly boxes: readonly Bbox[];
}

/** 比這小的形狀是線條或表格的格子，不會是邊欄。單位是 PDF 點。 */
const BOX_MIN_WIDTH = 36;
const BOX_MIN_HEIGHT = 18;

/** `constructPath` 的參數帶著路徑的外框。沒有填色也沒有描邊的路徑看不見，不算。 */
function pathBox(ops: PdfJs['OPS'], args: readonly unknown[] | null, ctm: Matrix): Bbox | null {
  const paints = new Set<number>([
    ops.fill,
    ops.eoFill,
    ops.stroke,
    ops.closeStroke,
    ops.fillStroke,
    ops.eoFillStroke,
    ops.closeFillStroke,
    ops.closeEOFillStroke,
  ]);
  const extent = args?.[2] as ArrayLike<number> | null | undefined;
  if (!paints.has(Number(args?.[0])) || extent === null || extent === undefined || extent.length !== 4) return null;
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = Array.from(extent);
  const corners = [apply(ctm, x0, y0), apply(ctm, x1, y1)];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const box: Bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return box[2] - box[0] >= BOX_MIN_WIDTH && box[3] - box[1] >= BOX_MIN_HEIGHT ? box : null;
}

function summarizeOperators(
  ops: PdfJs['OPS'],
  fnArray: readonly number[],
  argsArray: readonly unknown[],
  view: Bbox,
): OperatorSummary {
  const imageOps = new Set<number>([
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintImageMaskXObject,
    ops.paintImageXObjectRepeat,
    ops.paintImageMaskXObjectRepeat,
    ops.paintInlineImageXObjectGroup,
    ops.paintImageMaskXObjectGroup,
  ]);
  const stack: { ctm: Matrix; invisible: boolean }[] = [];
  let state = { ctm: IDENTITY, invisible: false };
  let visibleGlyphs = 0;
  let invisibleGlyphs = 0;
  let imageLargest = 0;
  let imageTotal = 0;
  let vectorPaths = 0;
  const boxes: Bbox[] = [];

  fnArray.forEach((fn, index) => {
    const args = argsArray[index] as unknown[] | null;
    if (fn === ops.save || fn === ops.paintFormXObjectBegin) stack.push(state);
    if (fn === ops.restore || fn === ops.paintFormXObjectEnd) state = stack.pop() ?? state;
    if (fn === ops.transform || fn === ops.paintFormXObjectBegin) {
      const matrix = asMatrix(fn === ops.transform ? args : args?.[0]);
      if (matrix !== null) state = { ...state, ctm: multiply(state.ctm, matrix) };
    } else if (fn === ops.setTextRenderingMode) {
      const mode = Number(args?.[0] ?? 0);
      state = { ...state, invisible: mode === 3 || mode === 7 };
    } else if (fn === ops.showText || fn === ops.showSpacedText) {
      const count = ((args?.[0] ?? []) as unknown[]).filter(isGlyph).length;
      if (state.invisible) invisibleGlyphs += count;
      else visibleGlyphs += count;
    } else if (imageOps.has(fn)) {
      const share = imageShare(state.ctm, view);
      imageLargest = Math.max(imageLargest, share);
      imageTotal = Math.min(1, imageTotal + share);
    } else if (fn === ops.constructPath) {
      vectorPaths += 1;
      const box = pathBox(ops, args, state.ctm);
      if (box !== null) boxes.push(box);
    }
  });
  return { visibleGlyphs, invisibleGlyphs, imageLargest, imageTotal, vectorPaths, boxes };
}

async function destinationPage(doc: PdfDocument, dest: unknown): Promise<number | null> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    const target = (explicit as unknown[] | null | undefined)?.[0];
    if (typeof target === 'number') return target;
    if (target === undefined || target === null) return null;
    return await doc.getPageIndex(target as Parameters<PdfDocument['getPageIndex']>[0]);
  } catch {
    return null;
  }
}

interface RawOutline {
  readonly title: string;
  readonly dest: unknown;
  readonly items: readonly RawOutline[];
}

async function outlineNodes(
  doc: PdfDocument,
  items: readonly RawOutline[],
): Promise<OutlineNode[]> {
  return Promise.all(
    items.map(async (item) => ({
      title: item.title,
      page: await destinationPage(doc, item.dest),
      children: await outlineNodes(doc, item.items),
    })),
  );
}

async function pageLinks(
  doc: PdfDocument,
  page: Awaited<ReturnType<PdfDocument['getPage']>>,
  index: number,
): Promise<PdfLink[]> {
  const annotations = (await page.getAnnotations()) as {
    subtype?: string;
    rect?: readonly number[];
    url?: string;
    dest?: unknown;
  }[];
  const links: PdfLink[] = [];
  for (const annotation of annotations) {
    if (annotation.subtype !== 'Link') continue;
    const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = annotation.rect ?? [];
    const target = annotation.dest === undefined ? null : await destinationPage(doc, annotation.dest);
    links.push({
      page: index,
      bbox: [x0, y0, x1, y1],
      ...(target === null ? {} : { target_page: target }),
      ...(annotation.url === undefined ? {} : { uri: annotation.url }),
    });
  }
  return links;
}

function textRuns(items: readonly unknown[]): TextRun[] {
  const runs: TextRun[] = [];
  for (const item of items as { str?: string; transform?: number[]; width?: number; height?: number; fontName?: string }[]) {
    if (typeof item.str !== 'string' || item.str.length === 0) continue;
    const [, , , , x = 0, y = 0] = item.transform ?? [];
    runs.push({
      text: item.str,
      bbox: [x, y, x + (item.width ?? 0), y + (item.height ?? 0)],
      font: item.fontName ?? '',
    });
  }
  return runs;
}

function wrap(
  doc: PdfDocument,
  ops: PdfJs['OPS'],
  tagged: boolean,
  destroy: () => Promise<void>,
): PdfHandle {
  return {
    pageCount: doc.numPages,
    tagged,
    outline: async () => {
      const raw = (await doc.getOutline()) as unknown as RawOutline[] | null | undefined;
      return outlineNodes(doc, raw ?? []);
    },
    pageLabels: () => doc.getPageLabels(),
    page: async (index) => {
      const page = await doc.getPage(index + 1);
      const viewport = page.getViewport({ scale: 1 });
      // 正規化留給組裝步驟，這裡要原始文字才能做字元守恆（白皮書 §5.2）。
      const content = await page.getTextContent({ disableNormalization: true });
      const operators = await page.getOperatorList({ annotationMode: 0 });
      const summary = summarizeOperators(
        ops,
        operators.fnArray,
        operators.argsArray,
        page.view as unknown as Bbox,
      );
      const links = await pageLinks(doc, page, index);
      page.cleanup();
      return {
        page: index,
        width: viewport.width,
        height: viewport.height,
        runs: textRuns(content.items),
        links,
        ...summary,
      };
    },
    close: destroy,
  };
}

function isPasswordError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'PasswordException';
}

/** 加密的 PDF 不算錯誤，是要拒絕的輸入（PC-3）。打不開才丟 `pdf.unreadable`。 */
export async function openPdf(path: string): Promise<PdfOpen> {
  let data: Uint8Array;
  try {
    data = new Uint8Array(await readFile(path));
  } catch {
    throw new TomeError('pdf.not_found', { path });
  }
  const pdfjs = await getResolvedPDFJS();
  const task = pdfjs.getDocument({
    data,
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
  });
  let doc: PdfDocument;
  try {
    doc = await task.promise;
  } catch (error) {
    await task.destroy();
    if (isPasswordError(error)) return { status: 'encrypted' };
    throw new TomeError('pdf.unreadable', { path });
  }
  const { info } = (await doc.getMetadata()) as { info: { EncryptFilterName?: string | null } };
  if (info.EncryptFilterName !== null && info.EncryptFilterName !== undefined) {
    await task.destroy();
    return { status: 'encrypted' };
  }
  const mark = (await doc.getMarkInfo()) as ReadonlyMap<string, unknown> | { Marked?: unknown } | null;
  const marked = mark instanceof Map ? mark.get('Marked') : (mark as { Marked?: unknown } | null)?.Marked;
  return { status: 'ok', pdf: wrap(doc, pdfjs.OPS, marked === true, () => task.destroy()) };
}
