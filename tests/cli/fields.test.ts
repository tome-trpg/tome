import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { openBookStore, type Store } from '../../src/core/store.ts';
import { fakeHost, startFakeProvider, translated, type FakeProvider } from '../helpers/fake-provider.ts';
import { library, type Library } from '../helpers/library.ts';
import { capture, tempDir } from '../helpers.ts';

// 數值塊欄位化（ADR-0121）。規則包是合成的 stat-fixture，數值塊與名字都是這裡編的。

const PACK = resolve('tests/fixtures/packs/stat-fixture');
const ROLE = 'stat-fixture:stat_block';

function block(id: string, text: string, role = 'paragraph'): Record<string, unknown> {
  return {
    id,
    content_hash: createHash('sha256').update(text).digest('hex'),
    role,
    flow: 'main',
    spans: [{ page: 0, bbox: [0, 0, 10, 10] }],
    text,
    raw: text,
    lang: 'en',
    writing_mode: 'horizontal-tb',
    provenance: { engine: 'fake', version: '1', config_hash: 'b'.repeat(64) },
  };
}

const BLOCKS = [
  block('p0000-aaaaa1', 'The warden keeps the ford, and the ferry waits for her at dusk.'),
  block('p0000-aaaaa2', 'Tide Warden Grit 12, Wits 9, Reach 1D6+1', ROLE),
  block('p0000-aaaaa3', 'Grit 12, Wits 9. She guards the ford alone.', ROLE),
];

function withStore<T>(home: string, action: (store: Store) => T): T {
  const store = openBookStore(home, 'book');
  try {
    return action(store);
  } finally {
    store.close();
  }
}

/** 一本用 stat-fixture 的書，換成這裡的區塊，名字是鎖定的實體卡。 */
async function book(): Promise<Library> {
  const lib = await library();
  cpSync(PACK, join(lib.home, 'systems', 'stat-fixture'), { recursive: true });
  const bookYaml = join(lib.home, 'books', 'book', 'book.yaml');
  writeFileSync(bookYaml, `${readFileSync(bookYaml, 'utf8')}system: stat-fixture\n`);
  const path = join(lib.home, 'books', 'book', 'ir', 'document.json');
  const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...document, sections: [], blocks: BLOCKS }));
  withStore(lib.home, (store) =>
    store.run(
      `INSERT INTO entity (source, target, status, origin, sources, occurrences, created_at, updated_at)
       VALUES ('Tide Warden', '潮汐守衛', 'locked', 'pass0', '[]', 1, 't', 't')`,
    ),
  );
  return lib;
}

async function tome(lib: Library, provider: FakeProvider | null, ...args: string[]): Promise<{ exit: number; output: Envelope; text: string }> {
  const { io, stdout } = lib.session(provider === null ? {} : { llm: fakeHost(provider) });
  const exit = await run([...args, '--json'], io);
  return { exit, output: JSON.parse(stdout()) as Envelope, text: stdout() };
}

function units(home: string): { unit_id: string; state: string; translation: string | null; fielded: number }[] {
  return withStore(home, (store) => store.all('SELECT unit_id, state, translation, fielded FROM unit ORDER BY seq'));
}

function found(output: Envelope, code: string): Envelope['findings'][number] | undefined {
  return output.findings.find((item) => item.code === code);
}

describe('stat block fields (ADR-0121)', () => {
  it('translates a whole stat block on this machine with a locked name, and sends the rest', async () => {
    const lib = await book();
    const { output, text } = await tome(lib, null, 'estimate', 'book', '--realtime', '--budget', '100');
    expect(output.data).toMatchObject({ units: 2, kept: 0, fielded: 1 });
    expect(found(output, 'units.fielded')?.params).toEqual({ count: '1' });
    expect(units(lib.home)[1]).toMatchObject({ state: 'DONE', translation: '潮汐守衛　韌性12，機智9，觸及1D6+1', fielded: 1 });
    expect(text).not.toContain('潮汐守衛');
  });

  it('sends nothing of the stat block, and counts it apart from what is kept as it is', async () => {
    const lib = await book();
    // 第三塊有一句話，要送模型；假的譯文要用鎖定的譯名，驗證才會過。
    const provider = await startFakeProvider(({ user }) => ({
      text: translated(user).replaceAll('Grit', '韌性').replaceAll('Wits', '機智'),
    }));
    await tome(lib, null, 'estimate', 'book', '--realtime', '--budget', '100', '--confirm');
    const { exit, output } = await tome(lib, provider, 'translate', 'book', '--realtime');
    expect(exit).toBe(0);
    const sent = provider.requests.map(({ user }) => user).join('\n');
    expect(sent).toContain('She guards the ford alone.');
    expect(sent).not.toContain('Reach');
    expect(output.data).toMatchObject({ done: 3, kept: 0, fielded: 1, total: 3 });
    expect(found(output, 'units.fielded')?.params).toEqual({ count: '1' });
    const status = await tome(lib, null, 'status', 'book');
    expect(status.output.data).toMatchObject({ kept: 0, fielded: 1 });
    expect(found(status.output, 'units.fielded')?.params).toEqual({ count: '1' });
  });

  it('follows a new translation of a label at the next estimate', async () => {
    const lib = await book();
    await tome(lib, null, 'estimate', 'book', '--realtime', '--budget', '100');
    const csv = join(tempDir(), 'labels.csv');
    writeFileSync(csv, 'source,target\nGrit,堅毅\n');
    await tome(lib, null, 'glossary', 'import', 'book', csv);
    await tome(lib, null, 'estimate', 'book', '--realtime');
    expect(units(lib.home)[1]?.translation).toBe('潮汐守衛　堅毅12，機智9，觸及1D6+1');
  });

  it('sends a stat block again once the name is no longer locked', async () => {
    const lib = await book();
    await tome(lib, null, 'estimate', 'book', '--realtime', '--budget', '100');
    withStore(lib.home, (store) => store.run("UPDATE entity SET status = 'rejected'"));
    const { output } = await tome(lib, null, 'estimate', 'book', '--realtime');
    expect(output.data).toMatchObject({ units: 3, fielded: 0 });
    expect(found(output, 'units.fielded')).toBeUndefined();
    expect(units(lib.home)[1]).toMatchObject({ state: 'PENDING', translation: null, fielded: 0 });
  });
});

describe('tome system test and lint with fields (ADR-0121)', () => {
  it('checks the local translation of each case', async () => {
    const { io, stdout } = capture({ env: { TOME_HOME: tempDir() } });
    expect(await run(['system', 'test', PACK], io)).toBe(0);
    expect(stdout()).toContain('8 個測試案例全部通過');
  });

  it('fails a case whose local translation is not the one written, and a case that should not be local', async () => {
    const dir = join(mkdtempSync(join(tempDir(), 'pack-')), 'stat-fixture');
    cpSync(PACK, dir, { recursive: true });
    writeFileSync(
      join(dir, 'tests', 'basic.yaml'),
      [
        'cases:',
        '  - id: wrong\n    text: Grit 12 Wits 9\n    fielded: 堅毅12',
        '  - id: not_local\n    text: Grit 12 Wits 9\n    fielded: null',
        '  - id: kept\n    text: Grit 12 Wits word\n    fielded: null',
        '  - id: not_asked\n    text: Grit 12 Wits 9\n    role: stat_block',
        '',
      ].join('\n'),
    );
    const { io, stdout } = capture({ env: { TOME_HOME: tempDir() } });
    expect(await run(['system', 'test', dir, '--json'], io)).toBe(1);
    const output = JSON.parse(stdout()) as Envelope;
    expect(output.findings.filter(({ code }) => code === 'pack.test_fielded_failed').map(({ params }) => params['case'])).toEqual([
      'wrong',
      'not_local',
    ]);
  });

  it('reads the cases in the first source language of the pack', async () => {
    const dir = join(mkdtempSync(join(tempDir(), 'pack-')), 'mut-fixture');
    cpSync(PACK, dir, { recursive: true });
    const files: Record<string, string> = {
      'pack.yaml': 'schema: tome-pack/1\nid: mut-fixture\nversion: 0.1.0\nextends: generic\nlicense: Apache-2.0\nsource_langs: [de]\n',
      'roles.yaml': 'roles:\n  stat_block:\n    detect: [mut_line]\n    fields:\n      - { de: Mut }\n',
      'glossary.yaml': 'terms:\n  - source: { de: Mut }\n    target: 勇氣\n',
      'syntax_patterns.yaml': "patterns:\n  - id: mut_line\n    use: detect\n    regex: '\\bMut\\s+\\d+'\n",
      'tests/basic.yaml': 'cases:\n  - id: mut\n    text: Mut 3\n    role: stat_block\n    fielded: 勇氣3\n',
    };
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    const { io, stdout } = capture({ env: { TOME_HOME: tempDir() } });
    expect(await run(['system', 'test', dir], io)).toBe(0);
    expect(stdout()).toContain('1 個測試案例全部通過');
  });

  it('warns about a field label without a translation in any of its languages', async () => {
    const dir = join(mkdtempSync(join(tempDir(), 'pack-')), 'stat-fixture');
    cpSync(PACK, dir, { recursive: true });
    const roles = join(dir, 'roles.yaml');
    writeFileSync(roles, readFileSync(roles, 'utf8').replace('{ en: Grit }', '{ en: Grit, de: Mut }'));
    const { io, stdout } = capture({ env: { TOME_HOME: tempDir() } });
    await run(['system', 'lint', dir, '--json'], io);
    const output = JSON.parse(stdout()) as Envelope;
    expect(output.findings.filter(({ code }) => code === 'pack.field_untranslated').map(({ params }) => params['field'])).toEqual(['1', '6']);
  });

  it('warns about a field label without a translation, naming the role and the field number only', async () => {
    const { io, stdout } = capture({ env: { TOME_HOME: tempDir() } });
    expect(await run(['system', 'lint', PACK, '--json'], io)).toBe(0);
    const output = JSON.parse(stdout()) as Envelope;
    expect(output.findings.filter(({ code }) => code === 'pack.field_untranslated')).toEqual([
      expect.objectContaining({ level: 'warn', params: { role: 'stat_block', field: '6' } }),
    ]);
    expect(stdout()).not.toContain('Knack');
  });
});
