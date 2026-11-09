import { describe, expect, it } from 'vitest';
import { vaultTexts } from '../../src/cli/messages.ts';
import type { EntityCard } from '../../src/core/entities.ts';
import type { DocumentBlock, IrDocument, Section } from '../../src/core/ir.ts';
import type { BookReport } from '../../src/core/report.ts';
import { escapeLines, renderVault, safeName, type RenderInput, type UnitRow, type VaultTexts } from '../../src/core/vault.ts';

// 文字都是這裡編的（ADR-0122）。

const TEXTS: VaultTexts = {
  keys: { book: '書', chapter: '章', title: '標題', pages: '原書頁碼' },
  front: '卷首',
  info: { file: '00-書目與來源', title: '書名', author: '作者', hash: '雜湊', unknown: '不明', notice: '不得散布。', credits: '版權頁' },
  figure: '原書 p.{page} 的圖',
  entity: { source: '原文', target: '譯名', class: '類別', gender: '性別', pronoun: '代名詞', register: '語域' },
  map: { file: '00-區塊對應表', block: '區塊', chapter: '章節檔' },
  // 交付報告的固定文字用訊息檔的，報告本身的測試在 tests/core/report.test.ts。
  report: vaultTexts.report,
};

function block(id: string, role: string, text: string, page = 0, extra: Partial<DocumentBlock> = {}): DocumentBlock {
  return {
    id,
    content_hash: 'c'.repeat(64),
    role: role as DocumentBlock['role'],
    flow: 'main',
    spans: [{ page, bbox: [0, 0, 10, 10] }],
    text,
    raw: text,
    lang: 'en',
    writing_mode: 'horizontal-tb',
    provenance: { engine: 'fake', version: '1', config_hash: 'b'.repeat(64) },
    ...extra,
  };
}

function documentOf(blocks: readonly DocumentBlock[], sections: readonly Section[] = []): IrDocument {
  return {
    schema: 'tome-ir/1',
    layer: 'document',
    pdf_sha256: 'a'.repeat(64),
    pages: [],
    page_map: [
      { page: 0, label: '1' },
      { page: 1, label: '2' },
      { page: 2, label: '3' },
    ],
    sections,
    blocks,
  };
}

function unit(block_id: string, source: string, translation: string | null, extra: Partial<UnitRow> = {}): UnitRow {
  return {
    unit_id: block_id,
    block_id,
    source,
    state: translation === null ? 'PENDING' : 'DONE',
    translation,
    formats: null,
    translation_pc: null,
    placeholders: '[]',
    ...extra,
  };
}

function render(input: Partial<RenderInput> & Pick<RenderInput, 'document' | 'units'>): ReturnType<typeof renderVault> {
  return renderVault({ slug: 'book', chapterLevel: 1, cards: [], pdf: {}, texts: TEXTS, ...input });
}

const SECTIONS: Section[] = [
  { title: 'The Ford', block_id: 'h1', children: [{ title: 'The Tide', block_id: 'h2', children: [] }] },
  { title: 'The Marsh', block_id: 'h3', children: [] },
];

const BOOK = documentOf(
  [
    block('t0', 'title', 'A Book of Tides'),
    block('h1', 'heading', 'The Ford'),
    block('p1', 'paragraph', 'The warden waits.'),
    block('h2', 'heading', 'The Tide'),
    block('l1', 'list_item', 'Count the stones.'),
    block('s1', 'sidebar', 'A note on tides.'),
    block('k1', 'stat-fixture:stat_block', 'Grit 12'),
    block('f1', 'figure', '', 1),
    block('x1', 'furniture', 'Page 2', 1),
    block('h3', 'heading', 'The Marsh', 2),
    block('p3', 'paragraph', 'Rain falls.', 2),
    block('c1', 'credits', 'Copyright 2026 Nobody.', 2),
  ],
  SECTIONS,
);

const BOOK_UNITS = [
  unit('t0', 'A Book of Tides', '潮汐之書'),
  unit('h1', 'The Ford', '渡口'),
  unit('p1', 'The warden waits.', '守望者在等待。'),
  unit('h2', 'The Tide', '潮汐'),
  unit('l1', 'Count the stones.', '清點石頭。'),
  unit('s1', 'A note on tides.', '關於潮汐的說明。'),
  unit('k1', 'Grit 12', '韌性12'),
  unit('h3', 'The Marsh', '沼澤'),
  unit('p3', 'Rain falls.', '雨落下。'),
];

describe('renderVault: chapter files (ADR-0122)', () => {
  const vault = render({ document: BOOK, units: BOOK_UNITS });

  it('writes one file per chapter, named by number and translated chapter title, and a front file for what comes first', () => {
    expect([...vault.files.keys()].filter((path) => !path.includes('/')).sort()).toEqual([
      '00-卷首.md',
      '00-書目與來源.md',
      '01-渡口.md',
      '02-沼澤.md',
    ]);
  });

  it('starts each chapter with flat frontmatter', () => {
    expect(vault.files.get('01-渡口.md')).toMatch(/^---\n書: "book"\n章: 1\n標題: "渡口"\n原書頁碼: "1-2"\n---\n/u);
    expect(vault.files.get('00-卷首.md')).toContain('標題: "卷首"');
    expect(vault.files.get('02-沼澤.md')).toContain('原書頁碼: "3"\n');
  });

  it('gives the title the top level and a heading outside the section tree the second', () => {
    expect(vault.files.get('00-卷首.md')).toContain('\n# 潮汐之書\n');
    const loose = documentOf([block('h1', 'heading', 'Loose')]);
    expect(render({ document: loose, units: [unit('h1', 'Loose', '散落')] }).files.get('01-散落.md')).toContain('\n## 散落\n');
  });

  it('writes a callout and a figure without a block anchor when nothing links to them', () => {
    const markdown = (id: string) => vault.blocks.find(({ block_id: blockId }) => blockId === id)?.markdown;
    expect(markdown('f1')).toBe('> [!figure] 原書 p.2 的圖');
    expect(markdown('s1')).toBe('> [!sidebar]\n> 關於潮汐的說明。');
  });

  it('writes each role its own way, and leaves out page furniture, the table of contents and the credits', () => {
    const chapter = vault.files.get('01-渡口.md') ?? '';
    expect(chapter).toContain('\n# 渡口\n');
    expect(chapter).toContain('\n## 潮汐\n');
    expect(chapter).toContain('\n守望者在等待。\n');
    expect(chapter).toContain('\n- 清點石頭。\n');
    expect(chapter).toContain('> [!sidebar]\n> 關於潮汐的說明。');
    expect(chapter).toContain('> [!stat-block]\n> 韌性12');
    expect(chapter).toContain('> [!figure] 原書 p.2 的圖');
    expect(chapter).not.toContain('Page 2');
    expect(vault.files.get('02-沼澤.md')).not.toContain('Copyright');
  });

  it('marks where each page of the book begins, by its printed label', () => {
    const chapter = vault.files.get('01-渡口.md') ?? '';
    expect(chapter.indexOf('<!-- page: 1 -->')).toBeLessThan(chapter.indexOf('# 渡口'));
    expect(chapter.indexOf('<!-- page: 2 -->')).toBeLessThan(chapter.indexOf('[!figure]'));
    expect(chapter.match(/<!-- page:/gu)).toHaveLength(2);
    expect(vault.files.get('02-沼澤.md')).toContain('<!-- page: 3 -->');
  });

  it('counts the units and finds the same headings and tables it expected', () => {
    expect(vault.units).toBe(9);
    expect(vault.untranslated).toBe(0);
    expect(vault.structure.actual).toEqual(vault.structure.expected);
    expect(vault.structure.expected).toEqual({ headings: 4, tables: 0 });
  });

  it('keeps each block’s Markdown and file for tome sync', () => {
    expect(vault.blocks.find(({ block_id: id }) => id === 'p1')).toEqual({ block_id: 'p1', path: '01-渡口.md', markdown: '守望者在等待。' });
    expect(vault.blocks.map(({ block_id: id }) => id)).not.toContain('x1');
  });
});

describe('renderVault: what is not translated', () => {
  it('keeps the original in an untranslated callout, and never the original of a blocked unit', () => {
    const document = documentOf([block('p1', 'paragraph', 'Failed text.'), block('p2', 'paragraph', 'Private text.')]);
    const units = [
      unit('p1', 'Failed text.', null, { state: 'FAILED_QA' }),
      unit('p2', 'Private text.', null, { state: 'BLOCKED' }),
    ];
    const vault = render({ document, units });
    const chapter = vault.files.get('01.md') ?? '';
    expect(chapter).toContain('> [!untranslated] FAILED_QA\n> Failed text.');
    expect(chapter).toContain('> [!untranslated] BLOCKED');
    expect(chapter).not.toContain('Private text.');
    expect(vault.untranslated).toBe(2);
    expect(vault.blocks.map(({ markdown }) => markdown)).toEqual(['> [!untranslated] FAILED_QA\n> Failed text.', '> [!untranslated] BLOCKED']);
  });

  it('quotes every line of a longer original, and never shows a translation that did not pass', () => {
    const document = documentOf([block('p1', 'paragraph', 'First line.\n\nSecond line.')]);
    const units = [unit('p1', 'First line.\n\nSecond line.', '沒過的譯文', { state: 'FAILED_QA' })];
    const chapter = render({ document, units }).files.get('01.md') ?? '';
    expect(chapter).toContain('> [!untranslated] FAILED_QA\n> First line.\n>\n> Second line.\n');
    expect(chapter).not.toContain('沒過的譯文');
  });

  it('never shows a blocked heading, not in a file name, a heading or a link', () => {
    const document = documentOf(
      [block('h1', 'heading', 'Secret Name'), block('p1', 'paragraph', 'See p.1.')],
      [{ title: 'Secret Name', block_id: 'h1', children: [] }],
    );
    const units = [
      unit('h1', 'Secret Name', null, { state: 'BLOCKED' }),
      unit('p1', 'See p.1.', '見 p.1。', { placeholders: JSON.stringify([{ id: 1, kind: 'page_ref', text: 'p.1' }]) }),
    ];
    const vault = render({ document, units });
    expect([...vault.files.keys()].filter((path) => !path.includes('/')).sort()).toEqual(['00-書目與來源.md', '01.md']);
    expect([...vault.files.values()].join('\n')).not.toContain('Secret');
    expect(vault.files.get('01.md')).toContain('> [!untranslated] BLOCKED\n^h1');
    expect(vault.files.get('01.md')).toContain('見 [[#^h1|p.1]]。');
    expect(vault.structure.actual).toEqual(vault.structure.expected);
  });

  it('writes Markdown styles of a translation', () => {
    const document = documentOf([block('p1', 'paragraph', 'Bold.')]);
    const formats = JSON.stringify({ whole: { marks: ['bold'] }, paired: [] });
    expect(render({ document, units: [unit('p1', 'Bold.', '粗體。', { formats })] }).files.get('01.md')).toContain('\n**粗體**。\n');
  });

  it('writes a human translation as it was written, without the styles of the source (ADR-0125)', () => {
    const document = documentOf([block('p1', 'paragraph', 'Bold.')]);
    const formats = JSON.stringify({ whole: { marks: ['bold'] }, paired: [] });
    const vault = render({ document, units: [unit('p1', 'Bold.', '只有*這裡*斜體。', { formats, human: 1 })] });
    expect(vault.files.get('01.md')).toContain('\n只有*這裡*斜體。\n');
    expect(vault.files.get('review/01.md')).toContain('> 只有*這裡*斜體。');
  });

  it('leaves out the table of contents, the index, page furniture and the credits even when they have units', () => {
    const document = documentOf([
      block('p1', 'paragraph', 'One.'),
      block('c1', 'toc', 'Contents'),
      block('i1', 'index', 'Index'),
      block('x1', 'furniture', 'Page 1'),
      block('r1', 'credits', 'Copyright'),
    ]);
    const units = [unit('p1', 'One.', '一。'), unit('c1', 'Contents', '目錄'), unit('i1', 'Index', '索引'), unit('x1', 'Page 1', '第 1 頁'), unit('r1', 'Copyright', '版權')];
    const vault = render({ document, units });
    expect(vault.blocks.map(({ block_id: id }) => id)).toEqual(['p1']);
    expect(vault.files.get('01.md')).not.toMatch(/目錄|索引|第 1 頁|版權/u);
  });

  it('leaves out blocks with nothing to write, without a page marker for them', () => {
    const document = documentOf([
      block('p1', 'paragraph', 'One.'),
      block('p2', 'paragraph', 'No unit.', 1),
      block('t1', 'table', '', 1),
      block('p3', 'paragraph', 'Three.', 2),
    ]);
    const vault = render({ document, units: [unit('p1', 'One.', '一。'), unit('p3', 'Three.', '三。')] });
    expect(vault.blocks.map(({ block_id: id }) => id)).toEqual(['p1', 'p3']);
    expect(vault.files.get('01.md')).not.toContain('<!-- page: 2 -->');
    expect(vault.structure.expected).toEqual({ headings: 0, tables: 0 });
    expect(vault.structure.actual).toEqual(vault.structure.expected);
  });

  it('names a chapter by number when its heading has nothing to show', () => {
    const document = documentOf([block('h1', 'heading', 'Ford'), block('p1', 'paragraph', 'Text.')], [{ title: 'Ford', block_id: 'h1', children: [] }]);
    const vault = render({ document, units: [unit('p1', 'Text.', '內文。')] });
    expect(vault.files.has('01.md')).toBe(true);
    expect(vault.files.get('01.md')).toContain('標題: "01"');
  });

  it('writes the original of an untranslated heading on one line', () => {
    const document = documentOf([block('h1', 'heading', ' The\nFord ')], [{ title: 'The Ford', block_id: 'h1', children: [] }]);
    const vault = render({ document, units: [unit('h1', ' The\nFord ', null, { state: 'REFUSED' })] });
    expect(vault.blocks[0]?.markdown).toBe('# The Ford\n> [!untranslated] REFUSED');
  });

  it('keeps an untranslated heading a heading, in the original, with a note under it', () => {
    const document = documentOf([block('h1', 'heading', 'The Ford')], [{ title: 'The Ford', block_id: 'h1', children: [] }]);
    const vault = render({ document, units: [unit('h1', 'The Ford', null, { state: 'REFUSED' })] });
    expect(vault.files.get('01-The Ford.md')).toContain('# The Ford\n> [!untranslated] REFUSED');
    expect(vault.structure.actual).toEqual(vault.structure.expected);
  });
});

describe('renderVault: tables', () => {
  const table = { rows: 2, cols: 2, cells: [] };
  const document = documentOf([block('t1', 'table', '', 0, { table })]);
  const cell = (row: number, col: number, source: string, translation: string | null, extra: Partial<UnitRow> = {}) =>
    unit('t1', source, translation, { unit_id: `t1-r${row}c${col}`, ...extra });

  it('writes a Markdown table with the first row as its header, one line per cell', () => {
    const units = [cell(0, 0, 'Name', '名稱'), cell(0, 1, 'Grit', '韌性'), cell(1, 0, 'A|B', 'A|B\n二'), cell(1, 1, 'Text', null, { state: 'FAILED_QA' })];
    const vault = render({ document, units });
    expect(vault.files.get('01.md')).toContain('| 名稱 | 韌性 |\n| --- | --- |\n| A\\|B<br>二 | Text |');
    expect(vault.blocks[0]?.markdown).toBe('| 名稱 | 韌性 |\n| --- | --- |\n| A\\|B<br>二 | Text |');
    expect(vault.structure.expected.tables).toBe(1);
    expect(vault.structure.actual.tables).toBe(1);
  });

  it('shows only the state of a blocked cell, and leaves a missing cell empty', () => {
    const units = [cell(0, 0, 'Name', '名稱'), cell(1, 1, 'Private', null, { state: 'BLOCKED' })];
    const text = render({ document, units }).files.get('01.md') ?? '';
    expect(text).toContain('| 名稱 |  |');
    expect(text).toContain('|  | BLOCKED |');
    expect(text).not.toContain('Private');
  });

  it('counts a table once even when its cells hold dashes', () => {
    const units = [cell(0, 0, '---', '---'), cell(0, 1, 'Grit', '韌性'), cell(1, 0, '---', '---'), cell(1, 1, '---', '---')];
    const vault = render({ document, units });
    expect(vault.blocks[0]?.markdown).toBe('| --- | 韌性 |\n| --- | --- |\n| --- | --- |');
    expect(vault.structure.actual.tables).toBe(1);
  });

  it('notices a table it could not write', () => {
    const broken = documentOf([block('t1', 'table', '', 0, { table: { rows: 1, cols: 0, cells: [] } })]);
    const vault = render({ document: broken, units: [unit('t1', 'x', 'y', { unit_id: 't1-r0c0' })] });
    expect(vault.structure.expected.tables).toBe(1);
    expect(vault.structure.actual.tables).toBe(0);
  });
});

describe('renderVault: page references (ADR-0022)', () => {
  const ref = (text: string) => JSON.stringify([{ id: 1, kind: 'page_ref', text }]);

  it('links to the heading before the page, in another chapter or the same one, showing the text of the translation', () => {
    const units = [...BOOK_UNITS.filter(({ block_id: id }) => id !== 'p1' && id !== 'p3'),
      unit('p1', 'See p.3.', '見 p.3。', { placeholders: ref('p.3') }),
      unit('p3', 'See p.3 again.', '再見 p.3。', { placeholders: ref('p.3') })];
    const vault = render({ document: BOOK, units });
    expect(vault.files.get('01-渡口.md')).toContain('見 [[02-沼澤#沼澤|p.3]]。');
    expect(vault.files.get('02-沼澤.md')).toContain('再見 [[#沼澤|p.3]]。');
  });

  it('links to a block when there is no usable heading, and marks that block', () => {
    const document = documentOf([block('p1', 'paragraph', 'See p.2.'), block('p2', 'paragraph', 'Target.', 1)]);
    const units = [unit('p1', 'See p.2.', '見 p.2。', { placeholders: ref('p.2') }), unit('p2', 'Target.', '目標。')];
    const text = render({ document, units }).files.get('01.md') ?? '';
    expect(text).toContain('見 [[#^p2|p.2]]。');
    expect(text).toContain('目標。 ^p2');
  });

  it('links to a block when the heading would break the link', () => {
    const document = documentOf(
      [block('h1', 'heading', 'A'), block('p1', 'paragraph', 'See p.1.')],
      [{ title: 'A', block_id: 'h1', children: [] }],
    );
    const units = [unit('h1', 'A', '甲:乙'), unit('p1', 'See p.1.', '見 p.1。', { placeholders: ref('p.1') })];
    const text = render({ document, units }).files.get('01-甲 乙.md') ?? '';
    expect(text).toContain('[[#^h1|p.1]]');
    expect(text).toContain('# 甲:乙 ^h1');
  });

  it('leaves a reference it cannot resolve as plain text', () => {
    const document = documentOf([block('p1', 'paragraph', 'See p.99.')]);
    const text = render({ document, units: [unit('p1', 'See p.99.', '見 p.99。', { placeholders: ref('p.99') })] }).files.get('01.md') ?? '';
    expect(text).toContain('見 p.99。');
    expect(text).not.toContain('[[');
  });

  it('links to the heading before the first block written on that page, past page furniture', () => {
    const units = [...BOOK_UNITS.filter(({ block_id: id }) => id !== 'p1'), unit('p1', 'See p.2.', '見 p.2。', { placeholders: ref('p.2') })];
    expect(render({ document: BOOK, units }).files.get('01-渡口.md')).toContain('見 [[#潮汐|p.2]]。');
  });

  it('finds the page by its printed label, or else by its place in the PDF', () => {
    const document: IrDocument = {
      ...documentOf(
        [
          block('h1', 'heading', 'Ford'),
          block('p1', 'paragraph', 'See p.11 and p.5.'),
          block('p2', 'paragraph', 'On eleven.', 1),
          block('p3', 'paragraph', 'On five.', 4),
        ],
        [{ title: 'Ford', block_id: 'h1', children: [] }],
      ),
      page_map: [
        { page: 0, label: '10' },
        { page: 1, label: '11' },
      ],
    };
    const placeholders = JSON.stringify([
      { id: 1, kind: 'page_ref', text: 'p.11' },
      { id: 2, kind: 'page_ref', text: 'p.5' },
    ]);
    const units = [unit('h1', 'Ford', '渡口'), unit('p1', 'See p.11 and p.5.', '見 p.11 與 p.5。', { placeholders }), unit('p2', 'On eleven.', '十一。'), unit('p3', 'On five.', '五。')];
    const text = render({ document, units }).files.get('01-渡口.md') ?? '';
    expect(text).toContain('見 [[#渡口|p.11]] 與 [[#渡口|p.5]]。');
    expect(text.match(/<!-- page: \d+ -->/gu)).toEqual(['<!-- page: 10 -->', '<!-- page: 11 -->', '<!-- page: 5 -->']);
    expect(text).toContain('原書頁碼: "10-5"');
  });

  it('links each reference once, in order, even when one text holds another', () => {
    const document = documentOf([block('p1', 'paragraph', 'x'), block('p2', 'paragraph', 'Two.', 1), block('p9', 'paragraph', 'Nine.', 8)]);
    const placeholders = JSON.stringify([
      { id: 1, kind: 'page_ref', text: 'p.99' },
      { id: 2, kind: 'page_ref', text: 'p.9' },
      { id: 3, kind: 'page_ref', text: 'p.2' },
      { id: 4, kind: 'page_ref', text: 'p.2' },
    ]);
    const units = [unit('p1', 'x', 'p.99 與 p.9，p.2 與 p.2。', { placeholders }), unit('p2', 'Two.', '二。'), unit('p9', 'Nine.', '九。')];
    expect(render({ document, units }).files.get('01.md')).toContain('p.99 與 [[#^p9|p.9]]，[[#^p2|p.2]] 與 [[#^p2|p.2]]。');
  });

  it('leaves other placeholders and a reference missing from the translation alone', () => {
    const document = documentOf([block('p1', 'paragraph', 'x'), block('p2', 'paragraph', 'Two.', 1)]);
    const placeholders = JSON.stringify([
      { id: 1, kind: 'dice', text: '2d6' },
      { id: 2, kind: 'page_ref', text: 'p.2' },
    ]);
    const vault = render({ document, units: [unit('p1', 'x', '擲 2d6，見下頁。', { placeholders }), unit('p2', 'Two.', '二。')] });
    expect(vault.files.get('01.md')).toContain('擲 2d6，見下頁。');
    expect(vault.files.get('01.md')).not.toContain('[[');
    expect(vault.files.get('01.md')).not.toContain('^p2');
  });

  it('does not mark a block for a reference in a translation that did not pass', () => {
    const document = documentOf([block('p1', 'paragraph', 'x'), block('p2', 'paragraph', 'Two.', 1)]);
    const units = [unit('p1', 'x', '見 p.2。', { state: 'FAILED_QA', placeholders: ref('p.2') }), unit('p2', 'Two.', '二。')];
    expect(render({ document, units }).files.get('01.md')).not.toContain('^p2');
  });

  it('marks each kind of block it links to in the right place', () => {
    const document = documentOf([
      block('p0', 'paragraph', 'x'),
      block('f1', 'figure', '', 1),
      block('t1', 'table', '', 2, { table: { rows: 1, cols: 1, cells: [] } }),
      block('s1', 'sidebar', 'Side.', 3),
      block('u1', 'paragraph', 'Failed.', 4),
      block('h9', 'heading', 'Raw: Head ', 5),
      block('l1', 'list_item', 'Item.', 6),
    ]);
    const placeholders = JSON.stringify(['p.2', 'p.3', 'p.4', 'p.5', 'p.6', 'p.7'].map((text, id) => ({ id, kind: 'page_ref', text })));
    const units = [
      unit('p0', 'x', 'p.2 p.3 p.4 p.5 p.6 p.7', { placeholders }),
      unit('t1', 'Name', '名', { unit_id: 't1-r0c0' }),
      unit('s1', 'Side.', '邊欄。'),
      unit('u1', 'Failed.', null, { state: 'FAILED_QA' }),
      unit('h9', 'Raw: Head ', null, { state: 'REFUSED' }),
      unit('l1', 'Item.', '項目。'),
    ];
    const vault = render({ document, units });
    const markdown = (id: string) => vault.blocks.find(({ block_id: blockId }) => blockId === id)?.markdown;
    expect(markdown('p0')).toBe('[[#^f1|p.2]] [[#^t1|p.3]] [[#^s1|p.4]] [[#^u1|p.5]] [[#^h9|p.6]] [[#^l1|p.7]]');
    expect(markdown('f1')).toBe('> [!figure] 原書 p.2 的圖\n^f1');
    expect(markdown('t1')).toBe('| 名 |\n| --- |\n\n^t1');
    expect(markdown('s1')).toBe('> [!sidebar]\n> 邊欄。\n^s1');
    expect(markdown('u1')).toBe('> [!untranslated] FAILED_QA\n> Failed.\n^u1');
    expect(markdown('h9')).toBe('## Raw: Head ^h9\n> [!untranslated] REFUSED');
    expect(markdown('l1')).toBe('- 項目。 ^l1');
  });

  it('links to a block for a styled or empty heading, and matches a heading by its written spaces', () => {
    const document = documentOf(
      [block('h1', 'heading', 'A'), block('p1', 'paragraph', 'See p.1.'), block('h2', 'heading', 'B', 1), block('p2', 'paragraph', 'See p.2.', 1)],
      [
        { title: 'A', block_id: 'h1', children: [] },
        { title: 'B', block_id: 'h2', children: [] },
      ],
    );
    const formats = JSON.stringify({ whole: { marks: ['bold'] }, paired: [] });
    const units = [
      unit('h1', 'A', '甲', { formats }),
      unit('p1', 'See p.1.', '見 p.1。', { placeholders: ref('p.1') }),
      unit('h2', 'B', ' 乙  丙 '),
      unit('p2', 'See p.2.', '見 p.2。', { placeholders: ref('p.2') }),
    ];
    const vault = render({ document, units });
    expect(vault.files.get('01-甲.md')).toContain('見 [[#^h1|p.1]]。');
    expect(vault.files.get('01-甲.md')).toContain('# **甲** ^h1');
    expect(vault.files.get('02-乙 丙.md')).toContain('\n# 乙 丙\n');
    expect(vault.files.get('02-乙 丙.md')).toContain('見 [[#乙 丙|p.2]]。');
    const empty = render({ document, units: units.map((row) => (row.block_id === 'h1' ? { ...row, formats: null, translation: ' ' } : row)) });
    expect(empty.files.get('01.md')).toContain('見 [[#^h1|p.1]]。');
  });

  it('does not carry a heading into the next chapter when that chapter starts without one', () => {
    const document = documentOf(
      [block('h1', 'heading', 'A'), block('p1', 'paragraph', 'See p.2.'), block('p2', 'paragraph', 'Two.', 1)],
      [
        { title: 'A', block_id: 'h1', children: [] },
        { title: 'B', block_id: 'p2', children: [] },
      ],
    );
    const units = [unit('h1', 'A', '甲-乙'), unit('p1', 'See p.2.', '見 p.2。', { placeholders: ref('p.2') }), unit('p2', 'Two.', '二。')];
    const vault = render({ document, units });
    expect([...vault.files.keys()].filter((path) => !path.includes('/')).sort()).toEqual(['00-書目與來源.md', '01-甲-乙.md', '02.md']);
    expect(vault.files.get('01-甲-乙.md')).toContain('見 [[02#^p2|p.2]]。');
    expect(vault.files.get('01-甲-乙.md')).toContain('標題: "甲-乙"');
    expect(vault.files.get('02.md')).toContain('標題: "02"');
    expect(vault.files.get('02.md')).toContain('二。 ^p2');
  });
});

describe('renderVault: the other files', () => {
  it('writes the book information with the PDF title and author, the hash, the notice and the credits', () => {
    const vault = render({ document: BOOK, units: BOOK_UNITS, pdf: { title: 'Tides', author: 'Nobody' } });
    expect(vault.files.get('00-書目與來源.md')).toBe(
      `# Tides\n\n- 書名: Tides\n- 作者: Nobody\n- 雜湊: \`${'a'.repeat(64)}\`\n\n> 不得散布。\n\n## 版權頁\n\n> Copyright 2026 Nobody.\n`,
    );
    const bare = documentOf([block('p1', 'paragraph', 'Text.'), block('c1', 'credits', '  \n ')]);
    expect(render({ document: bare, units: [unit('p1', 'Text.', '內文。')] }).files.get('00-書目與來源.md')).toBe(
      `# book\n\n- 書名: book\n- 作者: 不明\n- 雜湊: \`${'a'.repeat(64)}\`\n\n> 不得散布。\n`,
    );
  });

  it('writes one file per locked entity card, with a safe and unique name', () => {
    const card = (id: number, target: string | null, status = 'locked'): EntityCard => ({
      id,
      source: `Name ${id}`,
      target,
      class: 'person',
      gender: null,
      pronoun: '她',
      register: null,
      keep_source: false,
      match: null,
      status,
    });
    const vault = render({ document: BOOK, units: BOOK_UNITS, cards: [card(1, '守/望者'), card(2, '守 望者'), card(3, '提案', 'proposed'), card(4, null)] });
    const entities = [...vault.files.keys()].filter((path) => path.startsWith('entities/')).sort();
    expect(entities).toEqual(['entities/守 望者 2.md', 'entities/守 望者.md']);
    expect(vault.files.get('entities/守 望者.md')).toBe('# 守/望者\n\n- 原文: Name 1\n- 譯名: 守/望者\n- 類別: person\n- 代名詞: 她\n');
  });

  // Manager 審 PR 71 時找到的兩項（ADR-0122 第 5 項）。
  const lockedCard = (id: number, target: string): EntityCard => ({
    id,
    source: `Name ${id}`,
    target,
    class: 'person',
    gender: null,
    pronoun: null,
    register: null,
    keep_source: true,
    match: null,
    status: 'locked',
  });
  const entityFiles = (cards: EntityCard[]) =>
    [...render({ document: BOOK, units: BOOK_UNITS, cards }).files.keys()].filter((path) => path.startsWith('entities/')).sort();

  it('tells entity names apart the way a case-insensitive file system does', () => {
    const files = entityFiles([lockedCard(1, 'Ward'), lockedCard(2, 'WARD'), lockedCard(3, 'ward 2'), lockedCard(4, 'Café'), lockedCard(5, 'Café')]);
    expect(files).toEqual(['entities/Café 5.md', 'entities/Café.md', 'entities/WARD 2.md', 'entities/Ward.md', 'entities/ward 2 3.md']);
    expect(new Set(files.map((path) => path.normalize('NFC').toLowerCase())).size).toBe(files.length);
  });

  it('adds the card id to a name Windows reserves for a device', () => {
    const files = entityFiles([lockedCard(1, 'Con'), lockedCard(2, 'nul.txt'), lockedCard(3, 'COM1'), lockedCard(4, 'lpt9'), lockedCard(5, 'Console'), lockedCard(6, 'COM10')]);
    expect(files).toEqual(['entities/COM1 3.md', 'entities/COM10.md', 'entities/Con 1.md', 'entities/Console.md', 'entities/lpt9 4.md', 'entities/nul.txt 2.md']);
  });

  it('writes the side-by-side files and the block map in review/', () => {
    const vault = render({ document: BOOK, units: BOOK_UNITS });
    expect(vault.files.get('review/01-渡口.md')).toContain('<!-- p1 -->\nThe warden waits.\n\n> 守望者在等待。');
    expect(vault.files.get('review/01-渡口.md')).toContain('> 渡口\n\n<!-- p1 -->');
    expect(vault.files.get('review/00-區塊對應表.md')).toMatch(/^\| 區塊 \| 章節檔 \|\n\| --- \| --- \|\n\| t0 \| \[\[00-卷首\]\] \|\n/u);
    expect(vault.files.get('review/00-區塊對應表.md')?.endsWith('| p3 | [[02-沼澤]] |\n')).toBe(true);
  });

  it('writes no side-by-side file for a chapter without units', () => {
    const document = documentOf(
      [block('h1', 'heading', 'A'), block('f2', 'figure', '', 1)],
      [
        { title: 'A', block_id: 'h1', children: [] },
        { title: 'B', block_id: 'f2', children: [] },
      ],
    );
    const vault = render({ document, units: [unit('h1', 'A', '甲')] });
    expect(vault.files.has('02.md')).toBe(true);
    expect([...vault.files.keys()].filter((path) => path.startsWith('review/')).sort()).toEqual(['review/00-區塊對應表.md', 'review/01-甲.md']);
  });
});

describe('renderVault: the delivery report (ADR-0123)', () => {
  const report = (blocks: readonly string[]): BookReport => ({
    coverage: { total: 9, kept: 0, fielded: 0, done: 9, in_flight: 0, blocked: 0, failed: 0, refused: 0, left: 0 },
    spent: { translate: 0, scan: 0, budget: null },
    estimates: [],
    pending_cards: 0,
    untranslated: [],
    pages: [],
    figures: [],
    flags: [],
    checks: blocks.map((id) => ({ block_id: id, code: 'too_long', detail: {} })),
    variants: [],
    unused: [],
    sync: [],
  });

  it('writes the report, links each item to its block by file and printed page, and marks the block', () => {
    const vault = render({ document: BOOK, units: BOOK_UNITS, report: report(['p1', 'p3']) });
    const text = vault.files.get('00-交付報告.md') ?? '';
    expect(text).toContain('- [[01-渡口#^p1|01-渡口 p.1]]：譯文比原文長很多');
    expect(text).toContain('- [[02-沼澤#^p3|02-沼澤 p.3]]：譯文比原文長很多');
    expect(vault.files.get('01-渡口.md')).toContain('\n守望者在等待。 ^p1\n');
    expect(vault.files.get('02-沼澤.md')).toContain('\n雨落下。 ^p3\n');
    expect(vault.files.get('01-渡口.md')).not.toContain('^l1');
  });

  it('writes only the ID of a block that is not in a chapter file', () => {
    const vault = render({ document: BOOK, units: BOOK_UNITS, report: report(['x1', 'gone']) });
    expect(vault.files.get('00-交付報告.md')).toContain('- x1：譯文比原文長很多\n- gone：譯文比原文長很多');
    // 在章節裡、但沒有東西可寫的區塊也一樣。
    const document = documentOf([block('p1', 'paragraph', 'One.'), block('p2', 'paragraph', 'No unit.')]);
    const empty = render({ document, units: [unit('p1', 'One.', '一。')], report: report(['p2']) });
    expect(empty.files.get('00-交付報告.md')).toContain('- p2：譯文比原文長很多');
  });

  it('writes no report without its data', () => {
    expect(render({ document: BOOK, units: BOOK_UNITS }).files.has('00-交付報告.md')).toBe(false);
  });
});

describe('the helpers', () => {
  it('makes a name safe for a file and a link', () => {
    expect(safeName('A: B/C [D] #E | F^G %H')).toBe('A B C D E F G H');
    expect(safeName('Name. ')).toBe('Name');
    expect(safeName('x'.repeat(80))).toHaveLength(60);
    expect(safeName(` ${'x'.repeat(80)}`)).toHaveLength(60);
    expect(safeName(`${'x'.repeat(59)} yz`)).toBe('x'.repeat(59));
  });

  it('escapes book text that would start a heading, a quote or a table', () => {
    expect(escapeLines('# one\n  > two\n| three\nfour # five')).toBe('\\# one\n  \\> two\n\\| three\nfour # five');
  });
});
