import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashText } from '../../src/core/assemble.ts';
import { TomeError } from '../../src/core/errors.ts';
import { bookDir } from '../../src/core/book.ts';
import type { DocumentBlock } from '../../src/core/ir.ts';
import { loadSourceLanguage } from '../../src/core/language.ts';
import { applyOverrides, readOverrides, type Operation } from '../../src/core/overrides.ts';
import { tempDir } from '../helpers.ts';

const { profile: language } = loadSourceLanguage('en');

function block(id: string, text: string, extra: Partial<DocumentBlock> = {}): DocumentBlock {
  return {
    id,
    content_hash: hashText(text),
    role: 'paragraph',
    flow: 'main',
    spans: [{ page: 1, bbox: [0, 0, 10, 10] }],
    text,
    raw: text,
    lang: 'en',
    writing_mode: 'horizontal-tb',
    provenance: { engine: 'fake', version: '1', config_hash: 'b'.repeat(64) },
    ...extra,
  };
}

const A = 'p0001-aaaaaa';
const B = 'p0001-bbbbbb';
const C = 'p0002-cccccc';
const BLOCKS = [block(A, 'the warden counts'), block(B, 'tide stones wait.'), block(C, 'Licensed to Reader.')];

function apply(...operations: Operation[]): ReturnType<typeof applyOverrides> {
  return applyOverrides(language, BLOCKS, operations);
}

const ids = (blocks: readonly DocumentBlock[]): string[] => blocks.map(({ id }) => id);

describe('overrides', () => {
  it('changes a role, to a core role or a pack role', () => {
    const { blocks } = apply(
      { op: 'role', block: A, role: 'sidebar' },
      { op: 'role', block: B, role: 'forged-pack:stat_block' },
    );
    expect(blocks.map(({ role }) => role).slice(0, 2)).toEqual(['sidebar', 'forged-pack:stat_block']);
  });

  it('moves a block after another, or to the front', () => {
    expect(ids(apply({ op: 'move', block: A, after: C }).blocks)).toEqual([B, C, A]);
    expect(ids(apply({ op: 'move', block: C, after: null }).blocks)).toEqual([C, A, B]);
  });

  it('reports a block told to follow itself, and leaves it where it was', () => {
    const { blocks, findings } = apply({ op: 'move', block: B, after: B });
    expect(ids(blocks)).toEqual([A, B, C]);
    expect(findings.map(({ code }) => code)).toEqual(['overrides.no_block']);
  });

  it('merges blocks in the order given and keeps the first id', () => {
    const { blocks } = apply({ op: 'merge', blocks: [A, B] });
    expect(ids(blocks)).toEqual([A, C]);
    expect(blocks[0]).toMatchObject({ text: 'the warden counts tide stones wait.' });
    expect(blocks[0]?.content_hash).toBe(hashText(blocks[0]?.text ?? ''));
    expect(blocks[0]?.spans).toHaveLength(2);
  });

  it('splits a block before the text it is given', () => {
    const { blocks, findings } = apply({ op: 'split', block: A, before: 'counts' });
    expect(findings).toEqual([]);
    expect(blocks.map(({ text }) => text).slice(0, 2)).toEqual(['the warden', 'counts']);
    expect(blocks[0]?.id).toBe(A);
    expect(blocks[1]?.id).not.toBe(A);
    expect(blocks[1]?.content_hash).toBe(hashText('counts'));
  });

  it('skips a block', () => {
    expect(ids(apply({ op: 'skip', block: B }).blocks)).toEqual([A, C]);
  });

  it('redacts text in text and raw, and keeps the id', () => {
    const { blocks } = apply({ op: 'redact', block: C, text: 'Reader' });
    expect(blocks[2]).toMatchObject({ id: C, text: 'Licensed to [REDACTED].', raw: 'Licensed to [REDACTED].' });
    expect(blocks[2]?.content_hash).toBe(hashText('Licensed to [REDACTED].'));
  });

  it('redacts table cells too', () => {
    const table = { rows: 1, cols: 1, cells: [{ row: 0, col: 0, text: 'Reader Name', raw: 'Reader  Name' }] };
    const { blocks } = applyOverrides(
      language,
      [block(A, 'Reader Name', { role: 'table', table })],
      [{ op: 'redact', block: A, text: 'Reader' }],
    );
    expect(blocks[0]?.table?.cells[0]).toMatchObject({ text: '[REDACTED] Name', raw: '[REDACTED]  Name' });
  });

  it('applies operations in order, so a later one sees an earlier one', () => {
    const { blocks, findings } = apply(
      { op: 'merge', blocks: [A, B] },
      { op: 'split', block: A, before: 'tide' },
      { op: 'role', block: A, role: 'heading' },
    );
    expect(findings).toEqual([]);
    expect(blocks.map(({ text }) => text).slice(0, 2)).toEqual(['the warden counts', 'tide stones wait.']);
    expect(blocks[0]?.role).toBe('heading');
  });

  it('reports what it could not match and carries on, without the text', () => {
    const { blocks, findings } = apply(
      { op: 'skip', block: 'p0009-dddddd' },
      { op: 'split', block: A, before: 'nowhere in this block' },
      { op: 'redact', block: A, text: 'nowhere either' },
      { op: 'move', block: A, after: 'p0009-dddddd' },
      { op: 'merge', blocks: [A, 'p0009-dddddd'] },
      { op: 'skip', block: B },
    );
    expect(ids(blocks)).toEqual([A, C]);
    expect(findings.map(({ code, level }) => [code, level])).toEqual([
      ['overrides.no_block', 'warn'],
      ['overrides.no_text', 'warn'],
      ['overrides.no_text', 'warn'],
      ['overrides.no_block', 'warn'],
      ['overrides.no_block', 'warn'],
    ]);
    expect(findings[1]?.params).toEqual({ index: '2', block: A });
    expect(JSON.stringify(findings)).not.toContain('nowhere');
  });

  it('will not cut at the very start, which would leave an empty block', () => {
    expect(apply({ op: 'split', block: A, before: 'the warden' }).findings).toHaveLength(1);
  });

  it('will not merge or split a table', () => {
    const table = { rows: 1, cols: 1, cells: [{ row: 0, col: 0, text: 'Toll' }] };
    const blocks = [block(A, 'Toll', { role: 'table', table }), block(B, 'Toll note.')];
    expect(applyOverrides(language, blocks, [{ op: 'merge', blocks: [A, B] }]).findings).toHaveLength(1);
    expect(applyOverrides(language, blocks, [{ op: 'split', block: A, before: 'oll' }]).findings).toHaveLength(1);
  });
});

describe('reading overrides.yaml', () => {
  function bookWith(text?: string): string {
    const home = tempDir();
    mkdirSync(bookDir(home, 'book'), { recursive: true });
    if (text !== undefined) writeFileSync(join(bookDir(home, 'book'), 'overrides.yaml'), text);
    return home;
  }

  it('has nothing to do when the file is not there', () => {
    expect(readOverrides(bookWith(), 'book')).toEqual({ operations: [], hash: '' });
  });

  it('reads every operation', () => {
    const home = bookWith(`schema: tome-overrides/1
operations:
  - op: role
    block: ${A}
    role: sidebar
  - op: move
    block: ${A}
    after: null
  - op: merge
    blocks: [${A}, ${B}]
  - op: split
    block: ${A}
    before: "The warden"
  - op: skip
    block: ${B}
  - op: redact
    block: ${C}
    text: "Licensed to"
`);
    const { operations, hash } = readOverrides(home, 'book');
    expect(operations.map(({ op }) => op)).toEqual(['role', 'move', 'merge', 'split', 'skip', 'redact']);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('asks the person to fix a syntax error, because the file cannot be made again', () => {
    expect(() => readOverrides(bookWith('a: [unclosed'), 'book')).toThrow(
      expect.objectContaining({ code: 'config.invalid_yaml' }),
    );
  });

  it('refuses a file that is not the format', () => {
    expect(() => readOverrides(bookWith('schema: tome-overrides/1\noperations:\n  - op: burn\n'), 'book')).toThrow(TomeError);
    expect(() => readOverrides(bookWith(`schema: tome-overrides/1\noperations:\n  - op: role\n    block: ${A}\n    role: table\n`), 'book')).toThrow(TomeError);
  });
});
