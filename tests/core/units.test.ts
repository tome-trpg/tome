import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { EntityCard } from '../../src/core/entities.ts';
import type { DocumentBlock, IrDocument } from '../../src/core/ir.ts';
import { maskText, restoreSegments } from '../../src/core/mask.ts';
import { findPack, resolvePack, termsFor, type ResolvedPack } from '../../src/core/pack.ts';
import { bookTerms } from '../../src/core/verify.ts';
import { openBookStore, type Store } from '../../src/core/store.ts';
import { parseUnits, unitTag } from '../../src/core/tags.ts';
import { buildUnits, syncUnits, type TranslationUnit } from '../../src/core/units.ts';
import { tempDir } from '../helpers.ts';

// 文字都是這裡編的。

function block(overrides: Partial<DocumentBlock> & { id: string }): DocumentBlock {
  return {
    content_hash: 'a'.repeat(64),
    role: 'paragraph',
    flow: 'main',
    spans: [{ page: 0, bbox: [0, 0, 1, 1] }],
    text: 'Some text.',
    raw: 'Some text.',
    lang: 'en',
    writing_mode: 'horizontal-tb',
    provenance: { engine: 'fake', version: '1', config_hash: 'b'.repeat(64) },
    ...overrides,
  };
}

function documentOf(blocks: readonly DocumentBlock[]): IrDocument {
  return {
    schema: 'tome-ir/1',
    layer: 'document',
    pdf_sha256: 'c'.repeat(64),
    pages: [{ page: 0, status: 'ok' }],
    page_map: [],
    sections: [],
    blocks,
  };
}

function generic(): ResolvedPack {
  const home = tempDir();
  const location = findPack(home, 'generic');
  if (location === null) throw new Error('generic is missing');
  const { pack } = resolvePack(home, location);
  if (pack === null) throw new Error('generic did not load');
  return pack;
}

/** 在工作區放一個繼承 generic 的規則包。 */
function childPack(files: Readonly<Record<string, string>>): ResolvedPack {
  const home = tempDir();
  const dir = join(home, 'systems', 'child');
  const all = {
    'pack.yaml': 'schema: tome-pack/1\nid: child\nversion: 0.1.0\nlicense: UNLICENSED\nsource_langs: [en]\n',
    ...files,
  };
  for (const [file, text] of Object.entries(all)) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  const { pack } = resolvePack(home, { dir, source: 'workspace' });
  if (pack === null) throw new Error('the child did not load');
  return pack;
}

describe('which blocks become units (ADR-0100)', () => {
  it.each(['title', 'heading', 'paragraph', 'list_item', 'sidebar', 'caption', 'footnote', 'generic:stat_block'])(
    'translates %s',
    async (role) => {
      const { units } = await buildUnits(documentOf([block({ id: 'p0000-aaaaaa', role: role as 'title' })]), generic(), 'en');
      expect(units.map(({ unit_id, role: kept }) => [unit_id, kept])).toEqual([['p0000-aaaaaa', role]]);
    },
  );

  it.each(['furniture', 'toc', 'index', 'credits', 'figure'])('leaves %s alone', async (role) => {
    const { units } = await buildUnits(documentOf([block({ id: 'p0000-aaaaaa', role: role as 'toc' })]), generic(), 'en');
    expect(units).toEqual([]);
  });

  it('skips a block with no text', async () => {
    const { units } = await buildUnits(documentOf([block({ id: 'p0000-aaaaaa', text: '  ' })]), generic(), 'en');
    expect(units).toEqual([]);
  });

  it('keeps the reading order of the document', async () => {
    const blocks = ['p0002-cccccc', 'p0000-aaaaaa', 'p0001-bbbbbb'].map((id) => block({ id }));
    const { units } = await buildUnits(documentOf(blocks), generic(), 'en');
    expect(units.map(({ unit_id }) => unit_id)).toEqual(['p0002-cccccc', 'p0000-aaaaaa', 'p0001-bbbbbb']);
  });

  it('keeps the section and the group of the block', async () => {
    const blocks = [block({ id: 'p0000-aaaaaa', role: 'sidebar', group: 'g1', section: ['One', 'Two'] })];
    const [unit] = (await buildUnits(documentOf(blocks), generic(), 'en')).units;
    expect(unit).toMatchObject({ block_id: 'p0000-aaaaaa', group: 'g1', section: ['One', 'Two'] });
  });
});

describe('tables', () => {
  const table = block({
    id: 'p0123-3f9a1c',
    role: 'table',
    text: 'ignored',
    table: {
      rows: 2,
      cols: 2,
      cells: [
        { row: 0, col: 0, header: true, text: 'Roll' },
        { row: 0, col: 1, header: true, text: 'Result' },
        { row: 1, col: 0, text: '1D6' },
        { row: 1, col: 1, text: '' },
      ],
    },
  });

  it('makes one unit for each cell that has text', async () => {
    const { units } = await buildUnits(documentOf([table]), generic(), 'en');
    expect(units.map(({ unit_id, source }) => [unit_id, source])).toEqual([
      ['p0123-3f9a1c-r0c0', 'Roll'],
      ['p0123-3f9a1c-r0c1', 'Result'],
      ['p0123-3f9a1c-r1c0', '1D6'],
    ]);
  });

  it('groups the cells of a table by its block, so they travel together', async () => {
    const { units } = await buildUnits(documentOf([table]), generic(), 'en');
    expect(new Set(units.map(({ group, block_id }) => [group, block_id].join()))).toEqual(
      new Set(['p0123-3f9a1c,p0123-3f9a1c']),
    );
  });

  it('does not send a cell that is only dice', async () => {
    const { units } = await buildUnits(documentOf([table]), generic(), 'en');
    expect(units.map(({ needs_llm }) => needs_llm)).toEqual([true, true, false]);
  });

  it('leaves a table marked as furniture alone', async () => {
    const { units } = await buildUnits(documentOf([{ ...table, role: 'furniture' }]), generic(), 'en');
    expect(units).toEqual([]);
  });
});

describe('inline styles (ADR-0116)', () => {
  it('wraps the styled words of a paragraph in <pc>, apart from the placeholders', async () => {
    const styled = block({
      id: 'p0001-aaaaaa',
      text: 'Roll 1D6 for Fire Bolt.',
      runs: [{ start: 13, end: 22, marks: ['bold'] }],
    });
    const [unit] = (await buildUnits(documentOf([styled]), generic(), 'en')).units;
    expect(unit?.masked).toBe('Roll <ph id="1" kind="dice"/> for <pc id="1">Fire Bolt</pc>.');
    expect(unit?.formats).toEqual({ paired: [{ id: 1, start: 13, end: 22, marks: ['bold'] }] });
    expect(unit).not.toHaveProperty('runs');
  });

  it('has no formats for a block without runs', async () => {
    const [unit] = (await buildUnits(documentOf([block({ id: 'p0001-aaaaaa' })]), generic(), 'en')).units;
    expect(unit?.formats).toBeNull();
  });
});

describe('masking through a pack', () => {
  it('hides what the patterns of the pack find, with their kind', async () => {
    const text = 'Roll 1D100, see p.42.';
    const [unit] = (await buildUnits(documentOf([block({ id: 'p0000-aaaaaa', text })]), generic(), 'en')).units;
    expect(unit?.masked).toBe('Roll <ph id="1" kind="dice"/>, see <ph id="2" kind="page_ref"/>.');
    expect(unit?.placeholders).toEqual([
      { id: 1, kind: 'dice', text: '1D100' },
      { id: 2, kind: 'page_ref', text: 'p.42' },
    ]);
  });

  it('does not run the patterns that only detect', async () => {
    const pack = childPack({
      'syntax_patterns.yaml': "patterns:\n  - id: word\n    use: detect\n    regex: 'Some'\n",
    });
    const [unit] = (await buildUnits(documentOf([block({ id: 'p0000-aaaaaa' })]), pack, 'en')).units;
    expect(unit?.placeholders).toEqual([]);
  });

  it('uses the pattern id when a pattern names no kind', async () => {
    const pack = childPack({
      'syntax_patterns.yaml': "patterns:\n  - id: rune\n    use: mask\n    regex: 'Some'\n",
    });
    const [unit] = (await buildUnits(documentOf([block({ id: 'p0000-aaaaaa' })]), pack, 'en')).units;
    expect(unit?.placeholders[0]?.kind).toBe('rune');
  });

  it('lets a child replace a pattern of the same id', async () => {
    const pack = childPack({
      'syntax_patterns.yaml': "patterns:\n  - id: dice\n    use: mask\n    kind: dice\n    regex: 'Some'\n",
    });
    const text = 'Some 1D6.';
    const [unit] = (await buildUnits(documentOf([block({ id: 'p0000-aaaaaa', text })]), pack, 'en')).units;
    expect(unit?.placeholders.map(({ text: hidden }) => hidden)).toEqual(['Some']);
  });

  it('says which pattern ran away, and gives no units', { timeout: 30_000 }, async () => {
    const pack = childPack({
      'syntax_patterns.yaml': "patterns:\n  - id: runaway\n    use: mask\n    regex: '(a+)+$'\n",
    });
    const text = `${'a'.repeat(4096)}!`;
    const { units, findings } = await buildUnits(documentOf([block({ id: 'p0000-aaaaaa', text })]), pack, 'en');
    expect(units).toEqual([]);
    expect(findings).toEqual([expect.objectContaining({ code: 'pack.slow_regex', params: { pattern: 'runaway' } })]);
  });
});

describe('keep_source terms (ADR-0100)', () => {
  const glossary = [
    'terms:',
    '  - source: { en: Sigil of Reeds }',
    '    target: 蘆葦印記',
    '    keep_source: true',
    '  - source: { en: Lantern }',
    '    target: 提燈',
  ].join('\n');

  it('hides the term, and leaves the terms that are translated', async () => {
    const pack = childPack({ 'glossary.yaml': glossary });
    const text = 'The Sigil of Reeds and the Lantern.';
    const [unit] = (await buildUnits(documentOf([block({ id: 'p0000-aaaaaa', text })]), pack, 'en')).units;
    expect(unit?.masked).toBe('The <ph id="1" kind="keep_source"/> and the Lantern.');
    expect(unit?.placeholders[0]?.text).toBe('Sigil of Reeds');
  });

  it('follows the match settings of the term', async () => {
    const pack = childPack({
      'glossary.yaml': [
        'terms:',
        '  - source: { en: glyph }',
        '    target: 字',
        '    keep_source: true',
        '    match: { case_sensitive: false, roles: [heading] }',
      ].join('\n'),
    });
    const blocks = [
      block({ id: 'p0000-aaaaaa', role: 'heading', text: 'The GLYPH' }),
      block({ id: 'p0000-bbbbbb', text: 'The GLYPH' }),
    ];
    const { units } = await buildUnits(documentOf(blocks), pack, 'en');
    expect(units.map(({ placeholders }) => placeholders.length)).toEqual([1, 0]);
  });

  it('uses the term of the source language, and the primary language for a regional tag', async () => {
    const pack = childPack({ 'glossary.yaml': glossary });
    const blocks = [block({ id: 'p0000-aaaaaa', text: 'Sigil of Reeds' })];
    expect((await buildUnits(documentOf(blocks), pack, 'en-GB')).units[0]?.placeholders).toHaveLength(1);
    expect((await buildUnits(documentOf(blocks), pack, 'ja')).units[0]?.placeholders).toEqual([]);
  });

  it('lets a child pack say a term of its parent is translated after all', async () => {
    const home = tempDir();
    const write = (id: string, extra: string, terms: string): void => {
      const dir = join(home, 'systems', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'pack.yaml'),
        `schema: tome-pack/1\nid: ${id}\nversion: 0.1.0\nlicense: UNLICENSED\nsource_langs: [en]\n${extra}`,
      );
      writeFileSync(join(dir, 'glossary.yaml'), terms);
    };
    write('parent', '', 'terms:\n  - source: { en: Glyph }\n    target: 字\n    keep_source: true\n');
    write('kid', 'extends: parent\n', 'terms:\n  - source: { en: Glyph }\n    target: 符文\n');
    const { pack } = resolvePack(home, { dir: join(home, 'systems', 'kid'), source: 'workspace' });
    const blocks = [block({ id: 'p0000-aaaaaa', text: 'The Glyph' })];
    const { units } = await buildUnits(documentOf(blocks), pack as ResolvedPack, 'en');
    expect(units[0]?.placeholders).toEqual([]);
  });

  it('hides a keep_source entity card it is given, and a card that says translate wins over the pack (ADR-0120)', async () => {
    const pack = childPack({ 'glossary.yaml': glossary });
    const card = (source: string, keep: boolean): EntityCard => ({
      id: 1,
      source,
      target: source,
      class: null,
      gender: null,
      pronoun: null,
      register: null,
      keep_source: keep,
      match: null,
      status: 'locked',
    });
    const terms = bookTerms(termsFor(pack, 'en'), [card('Old Tongue', true), card('Sigil of Reeds', false)]);
    const text = 'The Sigil of Reeds speaks Old Tongue.';
    const [unit] = (await buildUnits(documentOf([block({ id: 'p0000-aaaaaa', text })]), pack, 'en', terms)).units;
    expect(unit?.masked).toBe('The Sigil of Reeds speaks <ph id="1" kind="keep_source"/>.');
  });
});

describe('syncUnits (ADR-0102)', () => {
  interface Row {
    unit_id: string;
    seq: number;
    state: string;
    attempts: number;
    translation: string | null;
    group_id: string | null;
    section: string | null;
    placeholders: string;
  }

  function store(): Store {
    return openBookStore(join(tempDir(), 'home'), 'book');
  }

  function unit(unit_id: string, source = 'Some text.', extra: Partial<TranslationUnit> = {}): TranslationUnit {
    return { unit_id, block_id: unit_id, role: 'paragraph', source, ...maskText(source, []), ...extra };
  }

  function rows(database: Store): Row[] {
    return database.all<Row>('SELECT * FROM unit ORDER BY seq');
  }

  it('starts units at PENDING, in reading order', () => {
    const database = store();
    syncUnits(database, [unit('b'), unit('a')]);
    expect(rows(database).map(({ unit_id, seq, state }) => [unit_id, seq, state])).toEqual([
      ['b', 0, 'PENDING'],
      ['a', 1, 'PENDING'],
    ]);
    database.close();
  });

  it('marks a unit that needs no LLM as done, and keeps its text', () => {
    const database = store();
    syncUnits(database, [unit('a', '12')]);
    expect(rows(database)[0]).toMatchObject({ state: 'DONE', translation: '12' });
    database.close();
  });

  describe('stat blocks translated on this machine (ADR-0121)', () => {
    const fielded = (translation: string, paired: { id: number; start: number; end: number }[] = []) =>
      unit('a', 'Grit 12', { needs_llm: false, fielded: { translation, paired } });
    const local = (database: Store) =>
      database.get<{ state: string; translation: string | null; translation_pc: string | null; fielded: number; attempts: number }>(
        "SELECT state, translation, translation_pc, fielded, attempts FROM unit WHERE unit_id = 'a'",
      );

    it('stores the local translation as done, and marks the unit', () => {
      const database = store();
      syncUnits(database, [fielded('韌性12', [{ id: 1, start: 0, end: 2 }])]);
      expect(local(database)).toEqual({ state: 'DONE', translation: '韌性12', translation_pc: '[{"id":1,"start":0,"end":2}]', fielded: 1, attempts: 0 });
      database.close();
    });

    it('writes the newest local translation every time, since a label translation can change', () => {
      const database = store();
      syncUnits(database, [fielded('韌性12')]);
      syncUnits(database, [fielded('堅毅12')]);
      expect(local(database)).toMatchObject({ state: 'DONE', translation: '堅毅12', fielded: 1 });
      database.close();
    });

    it('takes over a unit the model translated, keeping its attempts and replies', () => {
      const database = store();
      syncUnits(database, [unit('a', 'Grit 12')]);
      database.run("UPDATE unit SET state = 'DONE', attempts = 1, translation = '模型的譯文'");
      syncUnits(database, [fielded('韌性12')]);
      expect(local(database)).toMatchObject({ state: 'DONE', translation: '韌性12', fielded: 1, attempts: 1 });
      database.close();
    });

    it('sends a unit to the model again once it no longer matches', () => {
      const database = store();
      syncUnits(database, [fielded('韌性12')]);
      syncUnits(database, [unit('a', 'Grit 12')]);
      expect(local(database)).toMatchObject({ state: 'PENDING', translation: null, fielded: 0 });
      database.close();
    });

    it('leaves a unit still in a batch alone this time, offsets included', () => {
      const database = store();
      const formats = { paired: [{ id: 1, start: 0, end: 4, marks: ['bold' as const] }] };
      syncUnits(database, [unit('a', 'Grit 12', { formats })]);
      database.run("UPDATE unit SET state = 'IN_FLIGHT'");
      syncUnits(database, [{ ...fielded('韌性12'), formats }]);
      expect(local(database)).toMatchObject({ state: 'IN_FLIGHT', translation: null, translation_pc: null, fielded: 0 });
      database.close();
    });

    it('keeps the offsets the model gave a unit it translated', () => {
      const database = store();
      const formats = { paired: [{ id: 1, start: 0, end: 4, marks: ['bold' as const] }] };
      syncUnits(database, [unit('a', 'Grit 12', { formats })]);
      database.run(`UPDATE unit SET state = 'DONE', translation = '韌性 12', translation_pc = '[{"id":1,"start":0,"end":2}]'`);
      syncUnits(database, [unit('a', 'Grit 12', { formats })]);
      expect(local(database)).toMatchObject({ state: 'DONE', translation_pc: '[{"id":1,"start":0,"end":2}]' });
      database.close();
    });

    it('keeps the offsets of a unit kept as it is, not those of a local translation', () => {
      const database = store();
      const kept = unit('a', '12', { formats: { paired: [{ id: 1, start: 0, end: 2, marks: ['bold'] }] } });
      syncUnits(database, [kept]);
      database.run("UPDATE unit SET translation_pc = NULL");
      syncUnits(database, [kept]);
      expect(local(database)).toMatchObject({ translation: '12', translation_pc: '[{"id":1,"start":0,"end":2}]', fielded: 0 });
      database.close();
    });
  });

  it('stores the group, the section and the placeholders', () => {
    const database = store();
    const hidden = { ...maskText('Roll 1D6 now.', [{ start: 5, end: 8, kind: 'dice' }]) };
    syncUnits(database, [unit('a', 'Roll 1D6 now.', { ...hidden, group: 'g', section: ['One'] })]);
    const [row] = rows(database);
    expect(row).toMatchObject({ group_id: 'g', section: '["One"]' });
    expect(JSON.parse(row?.placeholders ?? '')).toEqual([{ id: 1, kind: 'dice', text: '1D6' }]);
    database.close();
  });

  it('keeps the state of a unit whose masked text did not change', () => {
    const database = store();
    syncUnits(database, [unit('a')]);
    database.run("UPDATE unit SET state = 'DONE', attempts = 2, translation = '譯文'");
    syncUnits(database, [unit('new'), unit('a')]);
    expect(rows(database).find(({ unit_id }) => unit_id === 'a')).toMatchObject({
      seq: 1,
      state: 'DONE',
      attempts: 2,
      translation: '譯文',
    });
    database.close();
  });

  it('starts over when the masked text changed', () => {
    const database = store();
    syncUnits(database, [unit('a')]);
    database.run("UPDATE unit SET state = 'DONE', attempts = 2, translation = '譯文'");
    syncUnits(database, [unit('a', 'Other text.')]);
    expect(rows(database)[0]).toMatchObject({ state: 'PENDING', attempts: 0, translation: null });
    database.close();
  });

  it('keeps the state when only the styles changed, and writes the new styles (ADR-0116)', () => {
    const database = store();
    syncUnits(database, [unit('a')]);
    database.run("UPDATE unit SET state = 'DONE', attempts = 1, translation = '譯文'");
    const heading = { whole: { marks: ['bold' as const] }, paired: [] };
    syncUnits(database, [unit('a', 'Some text.', { formats: heading })]);
    const [row] = database.all<Row & { formats: string | null }>('SELECT * FROM unit');
    expect(row).toMatchObject({ state: 'DONE', translation: '譯文' });
    expect(JSON.parse(row?.formats ?? 'null')).toEqual(heading);
    database.close();
  });

  it('gives a unit that needs no LLM the <pc> offsets of its source (ADR-0116)', () => {
    const database = store();
    const styled = maskText('12 34', [], [{ start: 3, end: 5, marks: ['bold'] }]);
    syncUnits(database, [unit('a', '12 34', styled)]);
    const [row] = database.all<Row & { translation_pc: string | null }>('SELECT * FROM unit');
    expect(row).toMatchObject({ state: 'DONE', translation: '12 34', translation_pc: '[{"id":1,"start":3,"end":5}]' });
    syncUnits(database, [unit('a', '12 34', { ...styled, formats: null })]);
    expect(database.get('SELECT translation_pc, formats FROM unit')).toEqual({ translation_pc: null, formats: null });
    database.close();
  });

  it('deletes units the document no longer has, and keeps their responses', () => {
    const database = store();
    syncUnits(database, [unit('a'), unit('b')]);
    database.run(
      "INSERT INTO response (unit_id, attempt, text, model, created_at) VALUES ('b', 1, 'x', 'm', 't')",
    );
    syncUnits(database, [unit('a')]);
    expect(rows(database).map(({ unit_id }) => unit_id)).toEqual(['a']);
    expect(database.all('SELECT id FROM response')).toHaveLength(1);
    database.close();
  });
});

describe('the whole way there and back', () => {
  it('restores any paragraph after masking with the real pack', async () => {
    const pack = generic();
    const piece = fc.oneof(
      fc.constantFrom('1D100', '2d6+1', 'p.42', '<s>', '</s>', '&amp;', '<ph id="1"/>', ' ', 'Roll'),
      fc.string({ maxLength: 6 }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(piece, { minLength: 1, maxLength: 8 }), async (pieces) => {
        const text = pieces.join(' ');
        fc.pre(text.trim() !== '');
        const [unit] = (await buildUnits(documentOf([block({ id: 'p0000-aaaaaa', text })]), pack, 'en')).units;
        const { units, issues } = parseUnits(unitTag('1', 'paragraph', unit?.masked ?? ''));
        expect(issues).toEqual([]);
        expect(restoreSegments(units[0]?.segments ?? [], unit?.placeholders ?? []).text).toBe(text);
      }),
      { numRuns: 40 },
    );
  });
});
