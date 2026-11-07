import { describe, expect, it } from 'vitest';
import {
  chapterCount,
  chapterLevels,
  chapterMap,
  chapterSections,
  checkedLevel,
  levelCounts,
  levelFindings,
} from '../../src/core/chapters.ts';
import type { DocumentBlock, IrDocument } from '../../src/core/ir.ts';

// 書籤的標題都是這裡編的（ADR-0115）。

function block(id: string): DocumentBlock {
  return {
    id,
    content_hash: 'a'.repeat(64),
    role: 'paragraph',
    flow: 'main',
    spans: [{ page: 0, bbox: [0, 0, 1, 1] }],
    text: 'Some text.',
    raw: 'Some text.',
    lang: 'en',
    writing_mode: 'horizontal-tb',
    provenance: { engine: 'fake', version: '1', config_hash: 'b'.repeat(64) },
  };
}

function document(sections: IrDocument['sections'], ...blockIds: string[]): IrDocument {
  return {
    schema: 'tome-ir/1',
    layer: 'document',
    pdf_sha256: 'c'.repeat(64),
    pages: [],
    page_map: [],
    sections,
    blocks: blockIds.map(block),
  };
}

/** 跟公有領域那本一樣：一個書名底下三章，書名之後、第一章之前還有一段。 */
const NESTED: IrDocument['sections'] = [
  {
    title: 'Book',
    block_id: 'title',
    children: [
      { title: 'One', block_id: 'one', children: [] },
      { title: 'Two', block_id: 'two', children: [{ title: 'Two A', block_id: 'two-a', children: [] }] },
      { title: 'Three', block_id: 'three', children: [] },
    ],
  },
];
const BLOCKS = ['title', 'epigraph', 'one', 'one-body', 'two', 'two-a', 'three', 'end'];

describe('chapters by level (ADR-0115)', () => {
  it('counts the bookmarks of each level', () => {
    expect(levelCounts(NESTED)).toEqual([1, 3, 1]);
    expect(levelCounts([])).toEqual([]);
    expect(chapterLevels(document(NESTED))).toBe(3);
    expect(chapterLevels(document([]))).toBe(1);
  });

  it('flattens every bookmark down to the level, in reading order', () => {
    expect(chapterSections(NESTED, 1).map(({ title }) => title)).toEqual(['Book']);
    expect(chapterSections(NESTED, 2).map(({ title }) => title)).toEqual(['Book', 'One', 'Two', 'Three']);
    expect(chapterSections(NESTED, 3).map(({ title }) => title)).toEqual(['Book', 'One', 'Two', 'Two A', 'Three']);
  });

  it('keeps the whole book as one chapter at level 1, as before', () => {
    const map = chapterMap(document(NESTED, ...BLOCKS));
    expect([...map.values()]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(chapterCount(document(NESTED))).toBe(1);
  });

  it('gives the text before the first chapter a chapter of its own at level 2', () => {
    const map = chapterMap(document(NESTED, ...BLOCKS), 2);
    expect(Object.fromEntries(map)).toEqual({
      title: 1,
      epigraph: 1,
      one: 2,
      'one-body': 2,
      two: 3,
      'two-a': 3,
      three: 4,
      end: 4,
    });
    expect(chapterCount(document(NESTED), 2)).toBe(4);
  });

  it('goes one level deeper at level 3', () => {
    const map = chapterMap(document(NESTED, ...BLOCKS), 3);
    expect(map.get('two')).toBe(3);
    expect(map.get('two-a')).toBe(4);
    expect(map.get('three')).toBe(5);
  });

  it('refuses a level the book does not have', () => {
    expect(checkedLevel(document(NESTED), 3)).toBe(3);
    for (const level of [0, 4, 1.5]) {
      expect(() => checkedLevel(document(NESTED), level)).toThrow(
        expect.objectContaining({ code: 'chapter_level.invalid', params: { value: String(level), levels: '3' } }),
      );
    }
    expect(() => checkedLevel(document([]), 2)).toThrow(expect.objectContaining({ code: 'chapter_level.invalid' }));
  });

  it('says the counts of each level only when there is more than one, with numbers alone', () => {
    expect(levelFindings('book', document([{ title: 'Only', block_id: 'a', children: [] }]), 1)).toEqual([]);
    const [found] = levelFindings('book', document(NESTED), 2);
    expect(found).toMatchObject({
      code: 'chapters.levels',
      level: 'info',
      params: { book: 'book', levels: '3', counts: '1／3／1', level: '2', chapters: '4' },
    });
    expect(JSON.stringify(found)).not.toContain('Two A');
  });
});
