import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import type { PageKind } from '../../src/core/probe.ts';
import { noisePng } from './png.ts';

// 合成 PDF 鍛造（ADR-0061、ADR-0084）。repo 不放 PDF，測試時才產生，驗證基準用生成時的標準答案。
// 文字全部是這裡編的，跟任何書都沒有關係。

type Doc = InstanceType<typeof PDFDocument>;

/** pdfkit 的低階介面，型別定義沒有列出來。 */
interface LowLevel {
  ref(data?: unknown): { end(data?: string): void };
  page: { fonts: Record<string, unknown> };
  _root: { data: Record<string, unknown> };
}

export interface ForgeTruth {
  readonly kinds: readonly PageKind[];
  readonly tagged?: boolean;
  readonly spread?: boolean;
  readonly labels?: readonly string[];
  readonly encrypted?: boolean;
  /** 每頁畫上去的文字。引擎不管怎麼分區塊，這些字都要在。 */
  readonly text?: readonly (readonly string[])[];
}

export interface Forged {
  readonly bytes: Buffer;
  readonly truth: ForgeTruth;
}

const FIXED_DATE = new Date(Date.UTC(2026, 0, 1));
const LETTER: [number, number] = [612, 792];

const WORDS = (
  'the warden of salt marsh counts tide stones before each crossing and marks a lantern ' +
  'beside old ferry where river meets grey reeds while travellers wait for morning bells'
).split(' ');

/** 決定性的假文字。同樣的種子一定得到同樣的句子。 */
export function prose(seed: number, words: number): string {
  const chosen = Array.from({ length: words }, (_, index) => {
    const position = (seed * 31 + index * index * 7 + index * 13) % WORDS.length;
    return WORDS[position] ?? 'the';
  });
  return `${chosen.join(' ')}.`;
}

function open(options: Record<string, unknown> = {}): Doc {
  return new PDFDocument({
    autoFirstPage: false,
    info: { Title: 'Forged test document', CreationDate: FIXED_DATE, ModDate: FIXED_DATE },
    ...options,
  });
}

function finish(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function textPage(doc: Doc, seed: number, size: [number, number] = LETTER): void {
  doc.addPage({ size });
  doc.font('Times-Roman').fontSize(11).fillColor('black');
  doc.text(prose(seed, 90), 72, 72, { width: size[0] - 144 });
}

function imagePage(doc: Doc, seed: number): void {
  doc.addPage({ size: LETTER });
  doc.image(noisePng(120, 160, seed), 0, 0, { width: LETTER[0], height: LETTER[1] });
}

function invisibleText(doc: Doc, text: string): void {
  doc.save();
  (doc as Doc & { addContent(data: string): void }).addContent('3 Tr');
  doc.font('Times-Roman').fontSize(11).fillColor('black').text(text, 72, 72, { width: 468 });
  doc.restore();
}

function escapePdfString(text: string): string {
  return text.replace(/[\\()]/g, (char) => `\\${char}`);
}

function hex(value: number, digits: number): string {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}

function toUnicodeCMap(map: (code: number) => number): string {
  const entries = Array.from({ length: 95 }, (_, index) => {
    const code = index + 32;
    return `<${hex(code, 2)}> <${hex(map(code), 4)}>`;
  });
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
    `${entries.length} beginbfchar`,
    ...entries,
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
    '',
  ].join('\n');
}

/** 字形照常畫，ToUnicode 卻指到別的字元。讀者看得懂，抽出來的文字是壞的。 */
function brokenToUnicodePage(doc: Doc, seed: number, map: (code: number) => number): void {
  doc.addPage({ size: LETTER });
  const low = doc as unknown as LowLevel;
  const cmap = low.ref();
  cmap.end(toUnicodeCMap(map));
  const font = low.ref({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
    ToUnicode: cmap,
  });
  font.end();
  low.page.fonts['FBroken'] = font;
  const lines = Array.from({ length: 12 }, (_, index) => {
    const text = escapePdfString(prose(seed + index, 12));
    return `1 0 0 1 72 ${720 - index * 16} Tm (${text}) Tj`;
  });
  (doc as Doc & { addContent(data: string): void }).addContent(
    `BT /FBroken 11 Tf ${lines.join(' ')} ET`,
  );
}

function plain(): Doc {
  const doc = open();
  for (let page = 0; page < 3; page += 1) textPage(doc, page);
  return doc;
}

function structure(): Doc {
  const doc = open({ tagged: true });
  const low = doc as unknown as LowLevel;
  textPage(doc, 10);
  const part = doc.outline.addItem('Forged Part One');
  textPage(doc, 11);
  doc.link(72, 72, 120, 14, 'https://example.com/forged');
  doc.goTo(72, 100, 120, 14, 'forged-target');
  textPage(doc, 12);
  doc.addNamedDestination('forged-target');
  part.addItem('Forged Chapter Two');
  textPage(doc, 13);
  textPage(doc, 14);
  doc.outline.addItem('Forged Appendix');
  const labels = low.ref({ Nums: [0, { S: 'r' }, 2, { S: 'D', St: 1 }] });
  labels.end();
  low._root.data['PageLabels'] = labels;
  return doc;
}

function scan(): Doc {
  const doc = open();
  imagePage(doc, 1);
  imagePage(doc, 2);
  doc.font('Helvetica').fontSize(8).fillColor('black');
  doc.text('Licensed to Forged Reader', 72, 760, { lineBreak: false });
  imagePage(doc, 3);
  invisibleText(doc, prose(3, 90));
  imagePage(doc, 4);
  doc.font('Times-Roman').fontSize(11).fillColor('black');
  doc.text(prose(4, 90), 72, 72, { width: 468 });
  return doc;
}

function images(): Doc {
  const doc = open();
  imagePage(doc, 6);
  imagePage(doc, 7);
  return doc;
}

function artwork(): Doc {
  const doc = open();
  doc.addPage({ size: LETTER });
  doc.image(noisePng(60, 40, 5), 72, 300, { width: 300, height: 200 });
  doc.addPage({ size: LETTER });
  for (let index = 0; index < 60; index += 1) {
    doc.rect(72 + index * 7, 200 + (index % 9) * 30, 5, 20).fill('#886644');
  }
  doc.addPage({ size: LETTER });
  doc.addPage({ size: LETTER });
  invisibleText(doc, prose(6, 40));
  return doc;
}

function broken(): Doc {
  const doc = open();
  brokenToUnicodePage(doc, 1, (code) => 0xe000 + code);
  brokenToUnicodePage(doc, 2, () => 0xfffd);
  brokenToUnicodePage(doc, 3, (code) => (code % 2 === 0 ? 0xe000 + code : code));
  // 對應錯但字元合法：字元類別抓不到，靠語言訊號（H-10）。
  brokenToUnicodePage(doc, 4, (code) => (code >= 0x61 && code <= 0x7a ? 0x61 + ((code - 0x61 + 13) % 26) : code));
  textPage(doc, 5);
  return doc;
}

function spread(): Doc {
  const doc = open();
  for (let page = 0; page < 4; page += 1) textPage(doc, page + 20, [1224, 792]);
  return doc;
}

function hidden(): Doc {
  const doc = open();
  textPage(doc, 30);
  invisibleText(doc, 'a short line that nobody can see');
  return doc;
}

function encrypted(options: Record<string, unknown>): Doc {
  const doc = open({ pdfVersion: '1.7', ...options });
  textPage(doc, 40);
  return doc;
}

const TOLLS = [
  ['Crossing', 'Toll', 'Bells', 'Warden'],
  ['Ferry', '3', '2', 'Marsh'],
  ['Reeds', '5', '1', 'River'],
  ['Stones', '8', '4', 'Tide'],
];

function ruledTable(doc: Doc, left: number, top: number): void {
  const cellWidth = 110;
  const cellHeight = 24;
  TOLLS.forEach((row, rowIndex) => {
    row.forEach((cell, colIndex) => {
      const x = left + colIndex * cellWidth;
      const y = top + rowIndex * cellHeight;
      doc.rect(x, y, cellWidth, cellHeight).stroke();
      doc.font(rowIndex === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
      doc.text(cell, x + 6, y + 7, { lineBreak: false });
    });
  });
}

const BLOCK_PAGES = 2;

function blockText(page: number): Record<'title' | 'first' | 'second' | 'caption' | 'footer', string> {
  return {
    title: page === 0 ? 'The Salt Marsh Ledger' : 'Tolls of the Old Ferry',
    first: prose(page, 70),
    second: prose(page + 2, 60),
    caption: `Figure ${page + 1}. Grey reeds beside the ferry.`,
    footer: `Forged ledger, page ${page + 1}`,
  };
}

/** 引擎測試用：標題、段落、有框線的表格、圖與圖說、頁尾各有一個。 */
function blocks(): Doc {
  const doc = open();
  const figure = noisePng(120, 80, 4);
  for (let page = 0; page < BLOCK_PAGES; page += 1) {
    const text = blockText(page);
    doc.addPage({ size: LETTER });
    doc.font('Helvetica-Bold').fontSize(20).fillColor('black');
    doc.text(text.title, 72, 72);
    doc.font('Times-Roman').fontSize(11);
    doc.text(text.first, 72, 110, { width: 468 });
    ruledTable(doc, 72, 220);
    doc.font('Times-Roman').fontSize(11);
    doc.text(text.second, 72, 340, { width: 468 });
    doc.image(figure, 72, 450, { width: 240 });
    doc.font('Times-Italic').fontSize(9);
    doc.text(text.caption, 72, 620);
    doc.font('Helvetica').fontSize(8);
    doc.text(text.footer, 72, 740, { lineBreak: false });
  }
  return doc;
}

function wrapped(doc: Doc, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (doc.widthOfString(next) > width && line !== '') {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  return line === '' ? lines : [...lines, line];
}

function drawLines(doc: Doc, lines: readonly string[], x: number, top: number, leading = 13): number {
  lines.forEach((line, index) => doc.text(line, x, top + index * leading, { lineBreak: false }));
  return top + lines.length * leading;
}

/** 每頁都有的購買者資訊與頁碼。 */
function purchaserFooter(doc: Doc, page: number): void {
  doc.font('Helvetica').fontSize(7).fillColor('#666666');
  doc.text('Licensed to Forged Reader, order 1234567', LEFT_COLUMN, 760, { lineBreak: false });
  doc.text(String(page + 1), 540, 760, { lineBreak: false });
  doc.fillColor('black');
}

function ruledRows(doc: Doc, rows: readonly (readonly string[])[], top: number): void {
  const cellWidth = 126;
  const cellHeight = 22;
  rows.forEach((row, rowIndex) => {
    row.forEach((cell, colIndex) => {
      const x = LEFT_COLUMN + colIndex * cellWidth;
      const y = top + rowIndex * cellHeight;
      doc.rect(x, y, cellWidth, cellHeight).lineWidth(0.5).stroke('#000000');
      doc.font(rowIndex === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('black');
      doc.text(cell, x + 6, y + 7, { lineBreak: false });
    });
  });
}

/** 連字：字形是 fi、fl，文字層也是連字的碼位，要靠語言設定檔還原。 */
function ligatureLine(doc: Doc, x: number, y: number): void {
  const low = doc as unknown as LowLevel;
  const encoding = low.ref({
    Type: 'Encoding',
    BaseEncoding: 'WinAnsiEncoding',
    Differences: [174, 'fi', 175, 'fl'],
  });
  encoding.end();
  const font = low.ref({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman', Encoding: encoding });
  font.end();
  low.page.fonts['FLigature'] = font;
  const text = LAYOUT_LIGATURE.replaceAll('fi', '\\256').replaceAll('fl', '\\257');
  // pdfkit 的座標原點在左上，所以字要再翻一次才是正的。
  (doc as Doc & { addContent(data: string): void }).addContent(
    `BT /FLigature 10 Tf 1 0 0 -1 ${x} ${y} Tm (${text}) Tj ET`,
  );
}

const LEFT_COLUMN = 54;
const RIGHT_COLUMN = 318;
const COLUMN_WIDTH = 240;
const LAYOUT_HEADER = ['Crossing', 'Toll', 'Bells', 'Warden'];
const LAYOUT_ROWS = [
  ['Ferry', '3', '2', 'Marsh'],
  ['Reeds', '5', '1', 'River'],
  ['Stones', '8', '4', 'Tide'],
];
const LAYOUT_MORE_ROWS = [
  ['Lantern', '2', '7', 'Salt'],
  ['Morning', '1', '6', 'Grey'],
];
const LAYOUT_LIGATURE = 'a fine field of reeds beside the floating ferry';

/** 這個案例的標準答案：字在文件裡要照這個順序出現。 */
export const LAYOUT_TRUTH = {
  heading: 'Chapter One: Salt Marsh',
  flow: ['Alpha opening', 'travellers', 'second column opens', 'third stretch opens', 'closing words of the flow.'],
  sidebar: ['Sidebar: Reading the Tide', 'Sidebar body'],
  columnBox: 'Column box',
  dropCap: 'The dropped capital',
  rightColumn: 'Right column text',
  furniture: 'Licensed to Forged Reader, order 1234567',
  tableRows: 1 + LAYOUT_ROWS.length + LAYOUT_MORE_ROWS.length,
  ligature: LAYOUT_LIGATURE,
  plainHeading: 'Plain Heading',
  afterOutline: 'Paragraph after the outlined heading',
};

/** §8.5 的版面案例都在這份：雙欄、跨欄邊欄、跨頁表格、首字放大、標題轉外框、背景紋理、購買者浮水印、連字、斷字。 */
function layout(): Doc {
  const doc = open();
  doc.addPage({ size: LETTER });
  doc.font('Helvetica-Bold').fontSize(18).fillColor('black');
  doc.text(LAYOUT_TRUTH.heading, LEFT_COLUMN, 40, { lineBreak: false });
  doc.font('Times-Roman').fontSize(10);
  const leftTop = wrapped(doc, `Alpha opening ${prose(1, 40).slice(0, -1)}`, COLUMN_WIDTH);
  const leftBottom = wrapped(doc, `vellers ${prose(2, 40).slice(0, -1)}`, COLUMN_WIDTH);
  const rightTop = wrapped(doc, `second column opens ${prose(3, 40).slice(0, -1)}`, COLUMN_WIDTH);
  const rightBottom = wrapped(doc, `third stretch opens ${prose(4, 40).slice(0, -1)}`, COLUMN_WIDTH);
  // 斷字剛好落在邊欄上下：tra- 在方框上面，vellers 在下面。
  drawLines(doc, [...leftTop.slice(0, -1), `${leftTop.at(-1) ?? ''} tra-`], LEFT_COLUMN, 72);
  drawLines(doc, rightTop, RIGHT_COLUMN, 72);
  doc.save().rect(LEFT_COLUMN, 190, 504, 96).fill('#e8e0d0').restore();
  doc.rect(LEFT_COLUMN, 190, 504, 96).lineWidth(1).stroke('#000000');
  doc.font('Helvetica-Bold').fontSize(11).fillColor('black');
  doc.text(LAYOUT_TRUTH.sidebar[0] ?? '', 66, 200, { lineBreak: false });
  doc.font('Helvetica').fontSize(9);
  drawLines(doc, wrapped(doc, `Sidebar body ${prose(5, 45)}`, 480), 66, 218, 12);
  doc.font('Times-Roman').fontSize(10);
  drawLines(doc, leftBottom, LEFT_COLUMN, 300);
  drawLines(doc, rightBottom, RIGHT_COLUMN, 300);
  purchaserFooter(doc, 0);

  doc.addPage({ size: LETTER });
  doc.font('Times-Roman').fontSize(10).fillColor('black');
  const end = drawLines(doc, wrapped(doc, `and runs on to ${LAYOUT_TRUTH.flow[4] ?? ''}`, COLUMN_WIDTH), LEFT_COLUMN, 54);
  doc.font('Times-Bold').fontSize(40);
  doc.text('T', LEFT_COLUMN, end + 10, { lineBreak: false });
  doc.font('Times-Roman').fontSize(10);
  const drop = wrapped(doc, `he dropped capital opens this paragraph and ${prose(9, 26)}`, COLUMN_WIDTH - 34);
  drawLines(doc, drop.slice(0, 3), LEFT_COLUMN + 34, end + 14);
  drawLines(doc, wrapped(doc, drop.slice(3).join(' '), COLUMN_WIDTH), LEFT_COLUMN, end + 53);
  doc.rect(RIGHT_COLUMN, 54, COLUMN_WIDTH, 84).lineWidth(1).stroke('#000000');
  doc.font('Helvetica').fontSize(9);
  drawLines(doc, wrapped(doc, `${LAYOUT_TRUTH.columnBox} ${prose(11, 26)}`, COLUMN_WIDTH - 20), RIGHT_COLUMN + 10, 64, 12);
  doc.font('Times-Roman').fontSize(10);
  drawLines(doc, wrapped(doc, `${LAYOUT_TRUTH.rightColumn} ${prose(12, 40)}`, COLUMN_WIDTH), RIGHT_COLUMN, 150);
  ruledRows(doc, [LAYOUT_HEADER, ...LAYOUT_ROWS], 620);
  purchaserFooter(doc, 1);

  doc.addPage({ size: LETTER });
  ruledRows(doc, [LAYOUT_HEADER, ...LAYOUT_MORE_ROWS], 54);
  doc.font('Helvetica-Bold').fontSize(14).fillColor('black');
  doc.text(LAYOUT_TRUTH.plainHeading, LEFT_COLUMN, 150, { lineBreak: false });
  ligatureLine(doc, LEFT_COLUMN, 182);
  // 標題轉外框：看起來是字，文字層沒有東西。
  for (let index = 0; index < 14; index += 1) doc.rect(LEFT_COLUMN + index * 18, 214, 12, 18).fill('#000000');
  // 背景紋理：一張圖鋪在文字後面。
  doc.image(noisePng(60, 30, 7), LEFT_COLUMN, 240, { width: 504, height: 80 });
  doc.font('Times-Roman').fontSize(10).fillColor('black');
  drawLines(doc, wrapped(doc, `${LAYOUT_TRUTH.afterOutline} ${prose(15, 40)}`, 492), LEFT_COLUMN + 6, 250);
  purchaserFooter(doc, 2);
  return doc;
}

/** 效能預算用：雙欄滿版文字，每 10 頁一張小圖。 */
export function large(pages: number): Promise<Buffer> {
  const doc = open();
  const figure = noisePng(200, 150, 9);
  for (let page = 0; page < pages; page += 1) {
    doc.addPage({ size: LETTER });
    doc.font('Times-Roman').fontSize(10).fillColor('black');
    doc.text(prose(page, 320), 54, 54, { width: 240 });
    doc.text(prose(page + 1, 320), 318, 54, { width: 240 });
    if (page % 10 === 0) doc.image(figure, 54, 600, { width: 240 });
  }
  return finish(doc);
}

const repeat = (kind: PageKind, count: number): PageKind[] => Array<PageKind>(count).fill(kind);

const CASES = {
  plain: {
    build: plain,
    truth: { kinds: repeat('native', 3), text: [0, 1, 2].map((page) => [prose(page, 90)]) },
  },
  layout: { build: layout, truth: { kinds: repeat('native', 3) } },
  blocks: {
    build: blocks,
    truth: {
      kinds: repeat('native', BLOCK_PAGES),
      text: Array.from({ length: BLOCK_PAGES }, (_, page) => [
        ...Object.values(blockText(page)),
        ...TOLLS.flat(),
      ]),
    },
  },
  structure: {
    build: structure,
    truth: { kinds: repeat('native', 5), tagged: true, labels: ['i', 'ii', '1', '2', '3'] },
  },
  scan: {
    build: scan,
    truth: { kinds: ['scan', 'scan', 'scan', 'native'], text: [[], [], [], [prose(4, 90)]] },
  },
  images: { build: images, truth: { kinds: repeat('scan', 2) } },
  artwork: { build: artwork, truth: { kinds: ['image_only', 'image_only', 'native', 'image_only'] } },
  broken: {
    build: broken,
    truth: { kinds: ['broken_text', 'broken_text', 'broken_text', 'broken_text', 'native'] },
  },
  spread: { build: spread, truth: { kinds: repeat('native', 4), spread: true } },
  hidden: { build: hidden, truth: { kinds: ['native'] } },
  'encrypted-owner': {
    build: () => encrypted({ ownerPassword: 'forged', permissions: { copying: false } }),
    truth: { kinds: [], encrypted: true },
  },
  'encrypted-user': {
    build: () => encrypted({ userPassword: 'forged', ownerPassword: 'forged' }),
    truth: { kinds: [], encrypted: true },
  },
} satisfies Record<string, { build(): Doc; truth: ForgeTruth }>;

export type ForgeCase = keyof typeof CASES;

export const FORGE_CASES = Object.keys(CASES) as ForgeCase[];

export async function forge(name: ForgeCase): Promise<Forged> {
  const { build, truth } = CASES[name];
  return { bytes: await finish(build()), truth };
}

/** 寫成檔案，回傳路徑。目錄由呼叫端負責，要在任何 repo 之外。 */
export async function forgeFile(name: ForgeCase, directory: string): Promise<string> {
  const path = join(directory, `${name}.pdf`);
  await writeFile(path, (await forge(name)).bytes);
  return path;
}
