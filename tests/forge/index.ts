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

/** 引擎測試用：標題、段落、有框線的表格、圖與圖說、頁尾各有一個。 */
function blocks(): Doc {
  const doc = open();
  const figure = noisePng(120, 80, 4);
  for (let page = 0; page < 2; page += 1) {
    doc.addPage({ size: LETTER });
    doc.font('Helvetica-Bold').fontSize(20).fillColor('black');
    doc.text(page === 0 ? 'The Salt Marsh Ledger' : 'Tolls of the Old Ferry', 72, 72);
    doc.font('Times-Roman').fontSize(11);
    doc.text(prose(page, 70), 72, 110, { width: 468 });
    ruledTable(doc, 72, 220);
    doc.font('Times-Roman').fontSize(11);
    doc.text(prose(page + 2, 60), 72, 340, { width: 468 });
    doc.image(figure, 72, 450, { width: 240 });
    doc.font('Times-Italic').fontSize(9);
    doc.text(`Figure ${page + 1}. Grey reeds beside the ferry.`, 72, 620);
    doc.font('Helvetica').fontSize(8);
    doc.text(`Forged ledger, page ${page + 1}`, 72, 740, { lineBreak: false });
  }
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
  plain: { build: plain, truth: { kinds: repeat('native', 3) } },
  blocks: { build: blocks, truth: { kinds: repeat('native', 2) } },
  structure: {
    build: structure,
    truth: { kinds: repeat('native', 5), tagged: true, labels: ['i', 'ii', '1', '2', '3'] },
  },
  scan: { build: scan, truth: { kinds: ['scan', 'scan', 'scan', 'native'] } },
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
