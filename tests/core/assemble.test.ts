import { describe, expect, it } from 'vitest';
import {
  assembleBlocks,
  joinText,
  withSections,
  type AssemblyPage,
  type PageLayout,
} from '../../src/core/assemble.ts';
import type { DocumentBlock, SourceBlock, SourcePage, Table } from '../../src/core/ir.ts';
import { loadSourceLanguage } from '../../src/core/language.ts';
import type { Bbox, TextRun } from '../../src/core/pdf.ts';
import { validateIr } from '../../src/core/schema.ts';

const { profile: language } = loadSourceLanguage('en');
const SHA = 'a'.repeat(64);
const PROVENANCE = { engine: 'fake', version: '1', config_hash: 'b'.repeat(64) };
const WIDTH = 612;
const HEIGHT = 792;

function block(text: string, bbox: Bbox, role: SourceBlock['role'] = 'paragraph', extra: object = {}): SourceBlock {
  return {
    id: 'p0000-000000',
    content_hash: 'c'.repeat(64),
    role,
    spans: [{ page: 0, bbox }],
    text,
    raw: text,
    lang: 'en',
    writing_mode: 'horizontal-tb',
    provenance: PROVENANCE,
    ...extra,
  };
}

function run(text: string, bbox: Bbox): TextRun {
  return { text, bbox, font: 'g_d0_f1' };
}

interface PageSpec {
  readonly blocks: readonly SourceBlock[];
  readonly boxes?: readonly Bbox[];
  readonly runs?: readonly TextRun[];
}

/** 文字層預設就是區塊的文字，所以字元守恆會過。 */
function page(index: number, { blocks, boxes = [], runs }: PageSpec): AssemblyPage {
  const located = blocks.map((item) => ({
    ...item,
    spans: item.spans.map((span) => ({ ...span, page: index })),
  }));
  const source: SourcePage = {
    schema: 'tome-ir/1',
    layer: 'source',
    pdf_sha256: SHA,
    page: index,
    blocks: located,
  };
  const layout: PageLayout = {
    width: WIDTH,
    height: HEIGHT,
    runs: runs ?? blocks.map((item) => run(item.raw, item.spans[0]?.bbox ?? [0, 0, 0, 0])),
    boxes,
    invisibleGlyphs: 0,
  };
  return { page: index, kind: 'native', source, layout };
}

function assemble(...pages: readonly PageSpec[]): readonly DocumentBlock[] {
  return assembleBlocks({ language, pages: pages.map((spec, index) => page(index, spec)) }).blocks;
}

function texts(blocks: readonly DocumentBlock[]): string[] {
  return blocks.map(({ text }) => text);
}

const LEFT_TOP: Bbox = [54, 500, 291, 700];
const LEFT_BOTTOM: Bbox = [54, 100, 291, 300];
const RIGHT_TOP: Bbox = [318, 500, 551, 700];
const RIGHT_BOTTOM: Bbox = [318, 100, 551, 300];
const SIDEBAR: Bbox = [54, 340, 558, 460];

describe('reading order', () => {
  it('reads a whole column before moving to the next', () => {
    const blocks = assemble({
      blocks: [
        block('Left top.', LEFT_TOP),
        block('Right top.', RIGHT_TOP),
        block('Left bottom.', LEFT_BOTTOM),
        block('Right bottom.', RIGHT_BOTTOM),
      ],
    });
    expect(texts(blocks)).toEqual(['Left top.', 'Left bottom.', 'Right top.', 'Right bottom.']);
  });

  it('lets a full width heading cut the columns', () => {
    const blocks = assemble({
      blocks: [
        block('Right top.', RIGHT_TOP),
        block('Left top.', LEFT_TOP),
        block('Mid heading', [54, 400, 558, 420], 'heading'),
        block('Left bottom.', LEFT_BOTTOM),
        block('Right bottom.', RIGHT_BOTTOM),
      ],
    });
    expect(texts(blocks)).toEqual(['Left top.', 'Right top.', 'Mid heading', 'Left bottom.', 'Right bottom.']);
  });

  it('keeps one column in top to bottom order', () => {
    const blocks = assemble({
      blocks: [block('Second one.', [72, 300, 540, 400]), block('First one.', [72, 500, 540, 600])],
    });
    expect(texts(blocks)).toEqual(['First one.', 'Second one.']);
  });
});

describe('sidebars', () => {
  const page0: PageSpec = {
    boxes: [SIDEBAR],
    blocks: [
      block('Left top.', LEFT_TOP),
      block('Box title', [66, 430, 300, 450], 'heading'),
      block('Box body.', [66, 360, 540, 420]),
      block('Left bottom.', LEFT_BOTTOM),
    ],
  };

  it('takes what is inside a box out of the main flow', () => {
    const blocks = assemble(page0);
    expect(blocks.map(({ text, flow }) => [text, flow])).toEqual([
      ['Left top.', 'main'],
      ['Left bottom.', 'main'],
      ['Box title', 'aside'],
      ['Box body.', 'aside'],
    ]);
  });

  it('calls the body a sidebar and keeps the heading a heading, in one group', () => {
    const [, , title, body] = assemble(page0);
    expect([title?.role, body?.role]).toEqual(['heading', 'sidebar']);
    expect(title?.group).toBeDefined();
    expect(title?.group).toBe(body?.group);
  });

  it('joins a paragraph across a sidebar', () => {
    const blocks = assemble({
      boxes: [SIDEBAR],
      blocks: [
        block('the warden counts tide', LEFT_TOP),
        block('Box body.', [66, 360, 540, 420]),
        block('stones before dawn.', LEFT_BOTTOM),
      ],
    });
    expect(texts(blocks)).toEqual(['the warden counts tide stones before dawn.', 'Box body.']);
    expect(blocks[0]?.spans).toHaveLength(2);
  });

  it('ignores a band behind a heading, which has no body text', () => {
    const blocks = assemble({
      boxes: [[54, 690, 558, 730]],
      blocks: [block('Chapter', [66, 700, 300, 720], 'heading'), block('Body.', [72, 300, 540, 600])],
    });
    expect(blocks.map(({ flow }) => flow)).toEqual(['main', 'main']);
  });

  it('ignores a frame around the whole page', () => {
    const blocks = assemble({ boxes: [[20, 20, 592, 772]], blocks: [block('Body.', [72, 300, 540, 600])] });
    expect(blocks[0]).toMatchObject({ role: 'paragraph', flow: 'main' });
  });

  it('leaves a ruled table in the main flow', () => {
    const table: Table = { rows: 1, cols: 1, cells: [{ row: 0, col: 0, text: 'Toll' }] };
    const blocks = assemble({
      boxes: [[60, 200, 300, 300]],
      blocks: [block('Toll', [70, 220, 280, 280], 'table', { table })],
    });
    expect(blocks[0]).toMatchObject({ role: 'table', flow: 'main' });
  });
});

describe('joining paragraphs', () => {
  it('joins across a page, and past the furniture between them', () => {
    const blocks = assemble(
      {
        blocks: [
          block('the warden counts', [72, 100, 540, 700]),
          block('Forged footer', [72, 20, 300, 30], 'furniture'),
        ],
      },
      { blocks: [block('tide stones.', [72, 600, 540, 700])] },
    );
    expect(texts(blocks)).toEqual(['the warden counts tide stones.', 'Forged footer']);
    expect(blocks[0]?.spans.map(({ page: index }) => index)).toEqual([0, 1]);
  });

  it('keeps the place of the first piece', () => {
    const [first] = assemble(
      { blocks: [block('the warden counts', [72, 100, 540, 700])] },
      { blocks: [block('tide stones.', [72, 600, 540, 700])] },
    );
    expect(first?.id.startsWith('p0000-')).toBe(true);
  });

  it('does not join after the end of a sentence', () => {
    const blocks = assemble({
      blocks: [block('The warden sleeps.', [72, 500, 540, 700]), block('tide stones wait.', [72, 300, 540, 400])],
    });
    expect(blocks).toHaveLength(2);
  });

  it('does not join a new sentence', () => {
    const blocks = assemble({
      blocks: [block('The warden sleeps', [72, 500, 540, 700]), block('Tide stones wait.', [72, 300, 540, 400])],
    });
    expect(blocks).toHaveLength(2);
  });

  it('does not join across a heading', () => {
    const blocks = assemble({
      blocks: [
        block('the warden counts', [72, 500, 540, 700]),
        block('Heading', [72, 450, 540, 470], 'heading'),
        block('tide stones.', [72, 300, 540, 400]),
      ],
    });
    expect(blocks).toHaveLength(3);
  });

  it('takes the hyphen off a word broken over the join', () => {
    expect(joinText(language, 'the tra-', 'vellers wait')).toBe('the travellers wait');
    expect(joinText(language, 'well-', 'Known')).toBe('well- Known');
    expect(joinText(language, 'the end', 'of it')).toBe('the end of it');
  });

  it('does not join across a page that failed', () => {
    const lost = page(1, { blocks: [block('kept text here.', [72, 100, 540, 700])], runs: [] });
    const { blocks, pages } = assembleBlocks({
      language,
      pages: [
        page(0, { blocks: [block('the warden counts', [72, 100, 540, 700])] }),
        { ...lost, source: null, failure: 'conversion_failed' },
        page(2, { blocks: [block('tide stones.', [72, 600, 540, 700])] }),
      ],
    });
    expect(texts(blocks)).toEqual(['the warden counts', 'tide stones.']);
    expect(pages[1]).toEqual({ page: 1, status: 'failed', reason: 'conversion_failed' });
  });
});

describe('tables across pages', () => {
  const head = [
    { row: 0, col: 0, text: 'Crossing', header: true },
    { row: 0, col: 1, text: 'Toll', header: true },
  ];
  const first: Table = {
    rows: 2,
    cols: 2,
    cells: [...head, { row: 1, col: 0, text: 'Ferry' }, { row: 1, col: 1, text: '3' }],
  };
  const second: Table = {
    rows: 2,
    cols: 2,
    cells: [...head, { row: 1, col: 0, text: 'Reeds' }, { row: 1, col: 1, text: '5' }],
  };
  const tableBlock = (table: Table): SourceBlock =>
    block(table.cells.map(({ text }) => text).join('\n'), [54, 60, 558, 170], 'table', { table });

  it('joins two tables with the same columns and drops the repeated header', () => {
    const blocks = assemble({ blocks: [tableBlock(first)] }, { blocks: [tableBlock(second)] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.table).toMatchObject({ rows: 3, cols: 2 });
    expect(blocks[0]?.table?.cells.at(-2)).toMatchObject({ row: 2, col: 0, text: 'Reeds' });
    expect(blocks[0]?.spans).toHaveLength(2);
  });

  it('keeps every row when the next page does not repeat the header', () => {
    const rest: Table = { rows: 1, cols: 2, cells: second.cells.slice(2).map((cell) => ({ ...cell, row: 0 })) };
    const blocks = assemble({ blocks: [tableBlock(first)] }, { blocks: [tableBlock(rest)] });
    expect(blocks[0]?.table).toMatchObject({ rows: 3 });
  });

  it('leaves tables with different columns apart', () => {
    const other: Table = { rows: 1, cols: 1, cells: [{ row: 0, col: 0, text: 'Note' }] };
    expect(assemble({ blocks: [tableBlock(first)] }, { blocks: [tableBlock(other)] })).toHaveLength(2);
  });
});

describe('page furniture', () => {
  const footer = (index: number): SourceBlock => block(`Licensed to Reader ${index + 1}`, [54, 26, 188, 32]);
  const body = (index: number): SourceBlock => block(`Body of page ${index}.`, [72, 300, 540, 600]);

  it('finds a footer that repeats on three pages, whatever its number', () => {
    const blocks = assemble(...[0, 1, 2].map((index) => ({ blocks: [body(index), footer(index)] })));
    expect(blocks.filter(({ role }) => role === 'furniture')).toHaveLength(3);
  });

  it('needs three pages', () => {
    const blocks = assemble(...[0, 1].map((index) => ({ blocks: [body(index), footer(index)] })));
    expect(blocks.filter(({ role }) => role === 'furniture')).toHaveLength(0);
  });

  it('leaves repeated text in the middle of the page alone', () => {
    const middle = (index: number): SourceBlock => block(`Refrain ${index}`, [72, 300, 540, 320]);
    const blocks = assemble(...[0, 1, 2].map((index) => ({ blocks: [middle(index)] })));
    expect(blocks.filter(({ role }) => role === 'furniture')).toHaveLength(0);
  });
});

describe('drop caps', () => {
  const bbox: Bbox = [54, 500, 291, 600];
  const runs = [
    run('T', [54, 560, 80, 600]),
    run('he warden counts', [88, 580, 291, 590]),
    run('tide stones', [54, 540, 291, 550]),
    run('before dawn', [54, 520, 291, 530]),
  ];

  it('closes the gap after a large first letter', () => {
    const blocks = assemble({ blocks: [block('T he warden counts tide stones before dawn.', bbox)], runs });
    expect(texts(blocks)).toEqual(['The warden counts tide stones before dawn.']);
  });

  it('leaves a real one letter word alone', () => {
    const flat = [run('A', [54, 580, 64, 590]), ...runs.slice(1)];
    const blocks = assemble({ blocks: [block('A warden counts tide stones before dawn.', bbox)], runs: flat });
    expect(texts(blocks)).toEqual(['A warden counts tide stones before dawn.']);
  });
});

describe('text and ids', () => {
  it('normalizes the text and keeps what the engine wrote in raw', () => {
    const [first] = assemble({ blocks: [block('a ﬁne\nline   here.', [72, 300, 540, 600])] });
    expect(first).toMatchObject({ text: 'a fine line here.', raw: 'a ﬁne\nline   here.' });
  });

  it('drops what an engine could not read, and keeps it in raw', () => {
    const [first] = assemble({ blocks: [block('Chapter ���\b 12.', [72, 300, 540, 600])] });
    expect(first).toMatchObject({ text: 'Chapter 12.', raw: 'Chapter ���\b 12.' });
  });

  it('cleans table cells the same way', () => {
    const table: Table = { rows: 1, cols: 1, cells: [{ row: 0, col: 0, text: 'Toll�' }] };
    const [first] = assemble({ blocks: [block('Toll�', [72, 300, 540, 600], 'table', { table })] });
    expect(first?.table?.cells[0]).toMatchObject({ text: 'Toll', raw: 'Toll�' });
  });

  it('gives repeated text its own id', () => {
    const blocks = assemble({
      blocks: [block('Same text.', [72, 500, 540, 600]), block('Same text.', [72, 300, 540, 400])],
    });
    expect(blocks[1]?.id).toBe(`${blocks[0]?.id}-1`);
  });

  it('builds the same document from the same input', () => {
    const spec = { blocks: [block('The warden sleeps.', [72, 500, 540, 700])] };
    expect(assemble(spec)).toEqual(assemble(spec));
  });

  it('drops empty text blocks but keeps figures', () => {
    const blocks = assemble({
      blocks: [block('', [72, 500, 540, 600]), block('', [72, 300, 540, 400], 'figure')],
    });
    expect(blocks.map(({ role }) => role)).toEqual(['figure']);
  });
});

describe('page statuses', () => {
  it('skips pages that are not native, and says what they are', () => {
    const { pages } = assembleBlocks({
      language,
      pages: [{ page: 0, kind: 'scan', source: null, layout: null }, page(1, { blocks: [block('Body.', [72, 300, 540, 600])] })],
    });
    expect(pages[0]).toEqual({ page: 0, status: 'skipped', reason: 'scan' });
    expect(pages[1]).toMatchObject({ page: 1, status: 'ok' });
  });

  it('fails a page that lost characters and keeps its blocks out', () => {
    const text = 'the warden of salt marsh counts tide stones before each crossing';
    const { blocks, pages } = assembleBlocks({
      language,
      pages: [
        page(0, { blocks: [block('Kept.', [72, 300, 540, 600])], runs: [run(text, [72, 300, 540, 600])] }),
        page(1, { blocks: [block('Other page.', [72, 300, 540, 600])] }),
      ],
    });
    expect(pages[0]).toMatchObject({ status: 'failed', reason: 'characters_missing' });
    expect(pages[0]?.missing).toBeGreaterThan(5);
    expect(texts(blocks)).toEqual(['Other page.']);
  });
});

describe('sections', () => {
  const blocks = assemble({
    blocks: [
      block('Chapter One', [72, 700, 540, 720], 'title'),
      block('First paragraph.', [72, 600, 540, 680]),
      block('Part Two', [72, 560, 540, 580], 'heading'),
      block('Second paragraph.', [72, 400, 540, 540]),
    ],
  });

  it('builds one level from headings when the book has no bookmarks', () => {
    const { sections, blocks: placed } = withSections(blocks, []);
    expect(sections.map(({ title }) => title)).toEqual(['Chapter One', 'Part Two']);
    expect(placed.map(({ section }) => section)).toEqual([
      ['Chapter One'],
      ['Chapter One'],
      ['Part Two'],
      ['Part Two'],
    ]);
  });

  it('prefers bookmarks and keeps their depth', () => {
    const outline = [
      {
        title: 'Chapter One',
        page: 0,
        children: [{ title: 'part two', page: 0, children: [] }],
      },
    ];
    const { sections, blocks: placed } = withSections(blocks, outline);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.children[0]?.block_id).toBe(blocks[2]?.id);
    expect(placed[3]?.section).toEqual(['Chapter One', 'part two']);
  });

  it('keeps a bookmark on a page with no blocks, with no block id', () => {
    const { sections } = withSections(blocks, [{ title: 'Elsewhere', page: 9, children: [] }]);
    expect(sections).toEqual([{ title: 'Elsewhere', children: [] }]);
  });

  it('passes tome-ir/1', () => {
    const { sections, blocks: placed } = withSections(blocks, []);
    const checked = validateIr({
      schema: 'tome-ir/1',
      layer: 'document',
      pdf_sha256: SHA,
      pages: [{ page: 0, status: 'ok' }],
      page_map: [],
      sections,
      blocks: placed,
    });
    expect(checked.ok).toBe(true);
  });
});
