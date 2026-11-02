import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { openBookStore } from '../../src/core/store.ts';
import { library, type Library } from '../helpers/library.ts';

// 文字都是合成 PDF 的假文字（ADR-0104 第 22、23 項）。

interface UnitRow {
  readonly unit_id: string;
  readonly block_id: string;
  readonly source: string;
}

/** 估價會把單位寫進 `book.db`。 */
async function withUnits(): Promise<Library> {
  const lib = await library();
  await run(['estimate', 'book'], lib.session().io);
  return lib;
}

function units(home: string): UnitRow[] {
  const store = openBookStore(home, 'book');
  try {
    return store.all<UnitRow>('SELECT unit_id, block_id, source FROM unit ORDER BY seq');
  } finally {
    store.close();
  }
}

function update(home: string, sql: string, ...params: string[]): void {
  const store = openBookStore(home, 'book');
  try {
    store.run(sql, ...params);
  } finally {
    store.close();
  }
}

async function preview(lib: Library): Promise<{ exit: number; output: Envelope; text: string }> {
  const { io, stdout } = lib.session();
  const exit = await run(['preview', 'book', '--json'], io);
  return { exit, output: JSON.parse(stdout()) as Envelope, text: stdout() };
}

function reviewDir(home: string): string {
  return join(home, 'books', 'book', 'review');
}

function review(home: string, file: string): string {
  return readFileSync(join(reviewDir(home), file), 'utf8');
}

function setChapters(home: string, starts: readonly number[]): void {
  const path = join(home, 'books', 'book', 'ir', 'document.json');
  const document = JSON.parse(readFileSync(path, 'utf8')) as { blocks: { id: string }[]; sections: unknown[] };
  document.sections = starts.map((start, index) => ({
    title: `Chapter ${index + 1}`,
    block_id: document.blocks[start]?.id,
    children: [],
  }));
  writeFileSync(path, JSON.stringify(document));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tome preview (ADR-0104)', () => {
  it('writes one file for a book without chapters, and sends nothing', async () => {
    const lib = await withUnits();
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const { exit, output } = await preview(lib);
    expect(exit).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(readdirSync(reviewDir(lib.home))).toEqual(['01.md']);
    expect(output.data).toMatchObject({ book: 'book', files: 1 });
    expect(output.findings.find((item) => item.code === 'preview.done')?.params['files']).toBe('1');
  });

  it('writes the source and the quoted translation, under the block id', async () => {
    const lib = await withUnits();
    const [first] = units(lib.home);
    update(lib.home, "UPDATE unit SET state = 'DONE', translation = ? WHERE unit_id = ?", '第一行\n第二行', first?.unit_id ?? '');
    await preview(lib);
    expect(review(lib.home, '01.md')).toContain(`<!-- ${first?.block_id} -->\n${first?.source}\n\n> 第一行\n> 第二行\n`);
  });

  it('keeps the order of the book', async () => {
    const lib = await withUnits();
    await preview(lib);
    const text = review(lib.home, '01.md');
    const positions = units(lib.home).map(({ block_id }) => text.indexOf(`<!-- ${block_id} -->`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.every((position) => position >= 0)).toBe(true);
  });

  it('gives each chapter a file, and what comes before the first one 00.md', async () => {
    const lib = await withUnits();
    setChapters(lib.home, [1, 2]);
    await preview(lib);
    expect(readdirSync(reviewDir(lib.home)).sort()).toEqual(['00.md', '01.md', '02.md']);
    const [first, second, third] = units(lib.home);
    expect(review(lib.home, '00.md')).toContain(first?.block_id);
    expect(review(lib.home, '01.md')).toContain(second?.block_id);
    expect(review(lib.home, '02.md')).toContain(third?.block_id);
  });

  it.each(['PENDING', 'QUEUED', 'FAILED_QA', 'REFUSED'])('shows the source and says %s', async (state) => {
    const lib = await withUnits();
    update(lib.home, 'UPDATE unit SET state = ?', state);
    await preview(lib);
    const [first] = units(lib.home);
    expect(review(lib.home, '01.md')).toContain(`${first?.source}\n\n> [!untranslated] ${state}\n`);
  });

  it('leaves the source of a blocked unit out, or the personal data would be in the file', async () => {
    const lib = await withUnits();
    update(lib.home, "UPDATE unit SET state = 'BLOCKED'");
    await preview(lib);
    const text = review(lib.home, '01.md');
    const [first] = units(lib.home);
    expect(text).toContain(`<!-- ${first?.block_id} -->\n> [!untranslated] BLOCKED\n`);
    expect(text).not.toContain(first?.source);
    expect(text).not.toContain('warden');
  });

  it('does not show an old translation of a unit that is no longer done', async () => {
    const lib = await withUnits();
    update(lib.home, "UPDATE unit SET state = 'FAILED_QA', translation = '舊譯文'");
    await preview(lib);
    expect(review(lib.home, '01.md')).not.toContain('舊譯文');
  });

  it('puts only counts and the path in what it reports', async () => {
    const lib = await withUnits();
    const { text } = await preview(lib);
    expect(text).not.toContain('warden');
    expect(text).toContain('review');
  });

  it('starts over, so that a chapter that went away leaves no file', async () => {
    const lib = await withUnits();
    setChapters(lib.home, [0, 2]);
    await preview(lib);
    expect(existsSync(join(reviewDir(lib.home), '02.md'))).toBe(true);
    setChapters(lib.home, [0]);
    await preview(lib);
    expect(readdirSync(reviewDir(lib.home))).toEqual(['01.md']);
  });

  it('removes only its own files, one level down at most (ADR-0104 item 48)', async () => {
    const lib = await withUnits();
    const dir = reviewDir(lib.home);
    mkdirSync(join(dir, 'notes'), { recursive: true });
    mkdirSync(join(dir, '07.md'), { recursive: true });
    const kept = ['notes.md', 'todo.txt', '1.md', '02.txt', 'a02.md', join('notes', '01.md'), join('07.md', 'inside.md')];
    for (const file of kept) writeFileSync(join(dir, file), '人工筆記');
    writeFileSync(join(dir, '09.md'), '舊的對照');
    writeFileSync(join(dir, '100.md'), '舊的對照');
    await preview(lib);
    expect(existsSync(join(dir, '09.md'))).toBe(false);
    expect(existsSync(join(dir, '100.md'))).toBe(false);
    expect(existsSync(join(dir, '01.md'))).toBe(true);
    for (const file of kept) expect(readFileSync(join(dir, file), 'utf8')).toBe('人工筆記');
  });

  it('writes nothing for a book with no units yet', async () => {
    const lib = await library();
    const { exit, output } = await preview(lib);
    expect(exit).toBe(0);
    expect(output.data).toMatchObject({ files: 0 });
  });

  it('asks to run tome extract first', async () => {
    const lib = await library({ extract: false });
    const { io, stderr } = lib.session();
    expect(await run(['preview', 'book'], io)).toBe(2);
    expect(stderr()).toContain('tome extract book');
  });

  it('exits 2 for a book it does not know', async () => {
    const lib = await library();
    expect(await run(['preview', 'nope'], lib.session().io)).toBe(2);
    expect(await run(['preview'], lib.session().io)).toBe(2);
  });
});
