import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { DocumentBlock, IrDocument, SourceBlock, SourcePage } from '../../src/core/ir.ts';
import {
  validateBook,
  validateIr,
  validateLanguage,
  validatePackFile,
  validateProbe,
  type PackFileKind,
} from '../../src/core/schema.ts';

const hash = 'a'.repeat(64);

const provenance = { engine: 'synthetic', version: '1.0.0', config_hash: hash, confidence: 0.9 };

function sourceBlock(overrides: Partial<SourceBlock> = {}): SourceBlock {
  return {
    id: 'p0012-3f9a1c',
    content_hash: hash,
    role: 'paragraph',
    spans: [{ page: 12, bbox: [72, 72, 300, 120] }],
    text: 'Synthetic text.',
    raw: 'Synthetic text.',
    lang: 'en',
    writing_mode: 'horizontal-tb',
    provenance,
    ...overrides,
  };
}

function documentBlock(overrides: Partial<DocumentBlock> = {}): DocumentBlock {
  return { ...sourceBlock(), flow: 'main', ...overrides } as DocumentBlock;
}

function sourcePage(overrides: Partial<SourcePage> = {}): SourcePage {
  return {
    schema: 'tome-ir/1',
    layer: 'source',
    pdf_sha256: hash,
    page: 12,
    blocks: [sourceBlock()],
    ...overrides,
  };
}

function document(overrides: Partial<IrDocument> = {}): IrDocument {
  return {
    schema: 'tome-ir/1',
    layer: 'document',
    pdf_sha256: hash,
    page_map: [{ page: 12, label: 'iv' }],
    sections: [
      { title: 'Chapter', block_id: 'p0012-3f9a1c', children: [{ title: 'Part', children: [] }] },
    ],
    blocks: [documentBlock()],
    ...overrides,
  };
}

function expectInvalid(data: unknown): void {
  expect(validateIr(data).ok).toBe(false);
}

describe('tome-ir/1', () => {
  it('accepts a source page and a document', () => {
    expect(validateIr(sourcePage())).toMatchObject({ ok: true });
    expect(validateIr(document())).toMatchObject({ ok: true });
  });

  it('accepts every field of the block table in white paper 5.2', () => {
    const block = documentBlock({
      id: 'p0123-3f9a1c-2',
      role: 'generic:stat_block',
      flow: 'aside',
      group: 'sidebar-1',
      section: ['Chapter', 'Part'],
      spans: [
        { page: 123, bbox: [0, 0, 10, 10] },
        { page: 124, bbox: [0, 0, 10, 10] },
      ],
      runs: [
        { start: 0, end: 4, marks: ['bold', 'small_caps'] },
        { start: 5, end: 6, ruby: 'かな' },
        { start: 7, end: 8, link: { page: 3 } },
      ],
      lang: 'ja-JP',
      writing_mode: 'vertical-rl',
    });
    expect(validateIr(document({ blocks: [block] }))).toMatchObject({ ok: true });
  });

  it('accepts a table with spans and headers', () => {
    const table = {
      rows: 2,
      cols: 2,
      cells: [
        { row: 0, col: 0, col_span: 2, header: true, text: 'Roll' },
        { row: 1, col: 0, text: '1' },
        { row: 1, col: 1, text: '2' },
      ],
    };
    expect(validateIr(document({ blocks: [documentBlock({ role: 'table', table })] }))).toMatchObject(
      { ok: true },
    );
  });

  it('refuses a table block with no table', () => {
    expectInvalid(document({ blocks: [documentBlock({ role: 'table' })] }));
  });

  it('refuses pack roles from an engine, which fills core roles only', () => {
    const block = { ...sourceBlock(), role: 'generic:stat_block' };
    expectInvalid(sourcePage({ blocks: [block as SourceBlock] }));
  });

  it('refuses an unknown core role and a role without a namespace', () => {
    expectInvalid(document({ blocks: [documentBlock({ role: 'stat_block' as 'title' })] }));
  });

  it('requires flow in the document layer but not from an engine', () => {
    const { flow: _flow, ...noFlow } = documentBlock();
    expectInvalid(document({ blocks: [noFlow as DocumentBlock] }));
  });

  it.each([
    ['a sequence number as id', 'p0012'],
    ['an uppercase hash', 'p0012-3F9A1C'],
    ['a short page', 'p12-3f9a1c'],
    ['a space', 'p0012 3f9a1c'],
  ])('refuses %s', (_name, id) => {
    expectInvalid(document({ blocks: [documentBlock({ id })] }));
  });

  it('refuses an unknown field, at the top and in a block', () => {
    expectInvalid({ ...document(), extra: 1 });
    expectInvalid(document({ blocks: [{ ...documentBlock(), extra: 1 } as DocumentBlock] }));
  });

  it('refuses another schema version or layer', () => {
    expectInvalid({ ...document(), schema: 'tome-ir/2' });
    expectInvalid({ ...document(), layer: 'overrides' });
    expectInvalid(null);
    expectInvalid([]);
  });

  it('refuses a block id used twice', () => {
    const result = validateIr(document({ blocks: [documentBlock(), documentBlock()] }));
    expect(result).toEqual({
      ok: false,
      issues: [{ path: '/blocks/1/id', message: 'duplicate block id' }],
    });
  });

  it('keeps book text out of its error messages', () => {
    const secret = 'A sentence from a book that must not reach a log.';
    const result = validateIr(document({ blocks: [{ ...documentBlock({ text: secret }), lang: 7 } as never] }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('accepts any well-formed block id and pack role', () => {
    const blockId = fc
      .tuple(
        fc.integer({ min: 0, max: 99_999 }),
        fc.stringMatching(/^[0-9a-f]{6}$/),
        fc.option(fc.integer({ min: 1, max: 99 })),
      )
      .map(([page, hex, serial]) => {
        const base = `p${String(page).padStart(4, '0')}-${hex}`;
        return serial === null ? base : `${base}-${serial}`;
      });
    const packRole = fc
      .tuple(fc.stringMatching(/^[a-z0-9]{1,8}$/), fc.stringMatching(/^[a-z0-9]{1,8}(_[a-z0-9]{1,8})?$/))
      .map(([pack, role]) => `${pack}:${role}` as const);
    fc.assert(
      fc.property(blockId, packRole, (id, role) => {
        expect(validateIr(document({ blocks: [documentBlock({ id, role })] }))).toMatchObject({
          ok: true,
        });
      }),
    );
  });
});

describe('tome-pack/1', () => {
  const pack = {
    schema: 'tome-pack/1',
    id: 'd100-orc',
    version: '0.1.0',
    extends: 'generic',
    license: 'ORC',
    source_langs: ['en'],
  };

  const files: readonly [PackFileKind, unknown][] = [
    ['pack', pack],
    [
      'roles',
      {
        roles: {
          stat_block: {
            detect: ['stat_line'],
            style: 'terse',
            review: false,
            fields: ['str', 'con'],
          },
        },
      },
    ],
    ['entities', { classes: { deity: { default_pronoun: '祂', review_weight: 3 } } }],
    [
      'glossary',
      {
        terms: [
          {
            source: { en: 'Dodge', ja: '回避' },
            target: '閃避',
            class: 'skill',
            keep_source: false,
            match: { case_sensitive: true, whole_word: true, roles: ['paragraph'] },
          },
        ],
      },
    ],
    ['syntaxPatterns', { patterns: [{ id: 'dice', use: 'mask', kind: 'dice', regex: '\\d+D\\d+' }] }],
  ];

  it.each(files)('accepts a valid %s file', (kind, data) => {
    expect(validatePackFile(kind, data).ok).toBe(true);
  });

  it('lets extends stay out, since generic is the implicit root', () => {
    const { extends: _extends, ...root } = pack;
    expect(validatePackFile('pack', root).ok).toBe(true);
  });

  it.each(['schema', 'id', 'version', 'license', 'source_langs'])('requires %s', (key) => {
    const { [key as keyof typeof pack]: _removed, ...rest } = pack;
    expect(validatePackFile('pack', rest).ok).toBe(false);
  });

  it.each([
    ['an id with uppercase', { id: 'D100' }],
    ['a version that is not semver', { version: '1.0' }],
    ['an empty language list', { source_langs: [] }],
    ['a repeated language', { source_langs: ['en', 'en'] }],
    ['another schema', { schema: 'tome-pack/2' }],
  ])('refuses %s', (_name, change) => {
    expect(validatePackFile('pack', { ...pack, ...change }).ok).toBe(false);
  });

  // ADR-0044：規則包不能指定連線端點，也不能碰金鑰。
  it.each(files)('cannot name an endpoint or a key in %s', (kind, data) => {
    for (const key of ['endpoint', 'base_url', 'api_key', 'command']) {
      expect(validatePackFile(kind, { ...(data as object), [key]: 'x' }).ok).toBe(false);
    }
  });

  it('cannot hide an endpoint inside a role', () => {
    const data = { roles: { stat_block: { endpoint: 'https://example.com' } } };
    expect(validatePackFile('roles', data).ok).toBe(false);
  });

  it('refuses a pattern with an unknown use', () => {
    const data = { patterns: [{ id: 'dice', use: 'run', regex: 'x' }] };
    expect(validatePackFile('syntaxPatterns', data).ok).toBe(false);
  });
});

describe('tome-book/1', () => {
  const book = { schema: 'tome-book/1', pdf: { path: 'book.pdf', sha256: hash }, source_lang: 'en' };

  it('accepts a book, with or without a rule pack', () => {
    expect(validateBook(book).ok).toBe(true);
    expect(validateBook({ ...book, system: 'd100-orc' }).ok).toBe(true);
  });

  it.each([
    ['an unknown key', { ...book, api_key: 'x' }],
    ['a bad hash', { ...book, pdf: { path: 'p', sha256: 'abc' } }],
    ['a bad language', { ...book, source_lang: 'not a tag' }],
    ['a bad pack id', { ...book, system: 'Bad Id' }],
    ['another schema', { ...book, schema: 'other/1' }],
  ])('refuses %s', (_name, value) => {
    expect(validateBook(value).ok).toBe(false);
  });
});

describe('tome-probe/1', () => {
  const page = {
    page: 0,
    kind: 'native',
    width: 612,
    height: 792,
    chars: 10,
    bad_chars: 0,
    image_coverage: 0,
  };
  const probe = {
    schema: 'tome-probe/1',
    pdf_sha256: hash,
    page_count: 1,
    tagged: false,
    spread: false,
    outline: [{ title: 'Part', page: null, children: [{ title: 'One', page: 0, children: [] }] }],
    page_labels: [{ page: 0, label: 'i' }],
    links: [{ page: 0, bbox: [0, 0, 1, 1], uri: 'https://example.com/' }],
    pages: [page],
  };

  it('accepts a probe', () => {
    expect(validateProbe(probe).ok).toBe(true);
  });

  it.each([
    ['an unknown page kind', { ...probe, pages: [{ ...page, kind: 'other' }] }],
    ['an unknown key', { ...probe, extra: 1 }],
    ['a coverage above one', { ...probe, pages: [{ ...page, image_coverage: 2 }] }],
  ])('refuses %s', (_name, value) => {
    expect(validateProbe(value).ok).toBe(false);
  });
});

describe('tome-pack/1 tests', () => {
  it('accepts a case with expected matches and a role', () => {
    const value = { cases: [{ id: 'one', text: 'x', matches: { dice: ['1D6'] }, role: 'stat_block' }] };
    expect(validatePackFile('packTest', value).ok).toBe(true);
    expect(validatePackFile('packTest', { cases: [{ id: 'two', text: 'x', role: null }] }).ok).toBe(true);
  });

  it('refuses an unknown key', () => {
    expect(validatePackFile('packTest', { cases: [{ id: 'one', text: 'x', extra: 1 }] }).ok).toBe(false);
  });

  it('takes only the flags a pack may add', () => {
    const pattern = (flags: string): unknown => ({
      patterns: [{ id: 'one', use: 'mask', regex: 'a', flags }],
    });
    expect(validatePackFile('syntaxPatterns', pattern('im')).ok).toBe(true);
    expect(validatePackFile('syntaxPatterns', pattern('y')).ok).toBe(false);
  });
});

describe('tome-lang/1', () => {
  it('refuses a profile of neither kind', () => {
    expect(validateLanguage({ schema: 'tome-lang/1', kind: 'other' }).ok).toBe(false);
  });

  it('refuses an incomplete profile', () => {
    expect(validateLanguage({ schema: 'tome-lang/1', kind: 'source', lang: 'en' }).ok).toBe(false);
    expect(validateLanguage({ schema: 'tome-lang/1', kind: 'target', lang: 'en' }).ok).toBe(false);
  });
});
