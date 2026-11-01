import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { packTemplate, workspaceTemplate } from '../../src/cli/messages.ts';
import {
  addBook,
  bookDir,
  hashFile,
  scanBooks,
  probeBook,
  readBook,
  readProbe,
  slugFromPath,
} from '../../src/core/book.ts';
import { TomeError } from '../../src/core/errors.ts';
import { createPack } from '../../src/core/pack.ts';
import { assertSafeId, openBookStore } from '../../src/core/store.ts';
import { initWorkspace } from '../../src/core/workspace.ts';
import { forgeFile } from '../forge/index.ts';
import { tempDir } from '../helpers.ts';

function workspace(): string {
  const home = join(tempDir(), 'home');
  initWorkspace({ home, env: {}, template: workspaceTemplate });
  return home;
}

function codes(result: { findings: readonly { code: string }[] }): string[] {
  return result.findings.map((item) => item.code);
}

async function failure(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof TomeError) return error.code;
    throw error;
  }
  return 'no error';
}

describe('slugFromPath', () => {
  it.each([
    ['rules.pdf', 'rules'],
    ['My Core Rules (2nd).pdf', 'My-Core-Rules-2nd'],
    ['守密人手冊.pdf', '守密人手冊'],
    ['...pdf', 'book'],
    ['   .pdf', 'book'],
    ['con.pdf', 'book-con'],
    ['LPT1.pdf', 'book-LPT1'],
  ])('turns %j into %j', (input, expected) => {
    expect(slugFromPath(input)).toBe(expected);
  });

  it('caps the length', () => {
    expect(slugFromPath(`${'a'.repeat(300)}.pdf`)).toHaveLength(64);
  });

  it('always gives a name the store accepts', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (name) => {
        expect(() => assertSafeId(slugFromPath(`${name}.pdf`))).not.toThrow();
      }),
    );
  });
});

describe('addBook', () => {
  it('records the path and hash and leaves the PDF where it is', async () => {
    const home = workspace();
    const pdf = await forgeFile('plain', tempDir());
    const result = await addBook({ home, pdf });
    expect(result.book).toBe('plain');
    expect(codes(result)).toEqual(['book.added']);
    const book = readBook(home, 'plain');
    expect(book.config).toEqual({
      schema: 'tome-book/1',
      pdf: { path: pdf, sha256: await hashFile(pdf) },
      source_lang: 'en',
    });
    const files = readdirSync(bookDir(home, 'plain'), { recursive: true }).map(String);
    expect(files.some((file) => file.toLowerCase().endsWith('.pdf'))).toBe(false);
    expect(readProbe(home, 'plain')?.page_count).toBe(3);
  });

  it('keeps --system and --source-lang in book.yaml', async () => {
    const home = workspace();
    createPack(home, 'my-pack', packTemplate('my-pack'));
    const pdf = await forgeFile('plain', tempDir());
    await addBook({ home, pdf, system: 'my-pack', sourceLang: 'en-GB' });
    expect(readBook(home, 'plain').config).toMatchObject({ system: 'my-pack', source_lang: 'en-GB' });
  });

  it('refuses a language or a rule pack that does not exist', async () => {
    const home = workspace();
    const pdf = await forgeFile('plain', tempDir());
    expect(await failure(() => addBook({ home, pdf, sourceLang: 'xx' }))).toBe('language.unknown');
    expect(await failure(() => addBook({ home, pdf, system: 'no-such-pack' }))).toBe('pack.not_found');
    expect(scanBooks(home).books).toEqual([]);
  });

  it.each(['encrypted-owner', 'encrypted-user'] as const)(
    'refuses %s and leaves nothing behind',
    async (name) => {
      const home = workspace();
      const result = await addBook({ home, pdf: await forgeFile(name, tempDir()) });
      expect(codes(result)).toEqual(['pdf.encrypted']);
      expect(result.findings[0]?.level).toBe('fail');
      expect(scanBooks(home).books).toEqual([]);
      expect(existsSync(bookDir(home, name))).toBe(false);
    },
  );

  it('asks for --as when the name is taken', async () => {
    const home = workspace();
    const first = tempDir();
    const second = tempDir();
    await addBook({ home, pdf: await forgeFile('plain', first) });
    const other = join(second, 'plain.pdf');
    copyFileSync(await forgeFile('hidden', second), other);
    const refused = await addBook({ home, pdf: other });
    expect(codes(refused)).toEqual(['book.name_taken']);
    expect(refused.findings[0]?.level).toBe('fail');
    const accepted = await addBook({ home, pdf: other, name: 'second' });
    expect(accepted.book).toBe('second');
    expect(scanBooks(home).books.map((book) => book.slug).sort()).toEqual(['plain', 'second']);
  });

  it('only updates the path when the same file moved', async () => {
    const home = workspace();
    const pdf = await forgeFile('plain', tempDir());
    await addBook({ home, pdf });
    const moved = join(tempDir(), 'renamed.pdf');
    renameSync(pdf, moved);
    const result = await addBook({ home, pdf: moved });
    expect(codes(result)).toEqual(['book.updated']);
    expect(result.book).toBe('plain');
    expect(readBook(home, 'plain').config.pdf.path).toBe(moved);
    expect(scanBooks(home).books).toHaveLength(1);
  });

  it('changes nothing when the same file is added again', async () => {
    const home = workspace();
    const pdf = await forgeFile('plain', tempDir());
    await addBook({ home, pdf });
    const before = readFileSync(join(bookDir(home, 'plain'), 'book.yaml'), 'utf8');
    expect(codes(await addBook({ home, pdf }))).toEqual(['book.already_added']);
    expect(readFileSync(join(bookDir(home, 'plain'), 'book.yaml'), 'utf8')).toBe(before);
  });

  it('needs a workspace', async () => {
    const home = join(tempDir(), 'none');
    const result = await addBook({ home, pdf: await forgeFile('plain', tempDir()) });
    expect(codes(result)).toEqual(['workspace.missing']);
  });

  it('reports a missing file and a file that is not a PDF', async () => {
    const home = workspace();
    const directory = tempDir();
    expect(await failure(() => addBook({ home, pdf: join(directory, 'nope.pdf') }))).toBe('pdf.not_found');
    expect(await failure(() => addBook({ home, pdf: directory }))).toBe('pdf.not_found');
    const fake = join(directory, 'fake.pdf');
    writeFileSync(fake, 'this is not a pdf');
    expect(await failure(() => addBook({ home, pdf: fake }))).toBe('pdf.unreadable');
    expect(scanBooks(home).books).toEqual([]);
  });

  it('refuses a name the store cannot hold', async () => {
    const home = workspace();
    const pdf = await forgeFile('plain', tempDir());
    expect(await failure(() => addBook({ home, pdf, name: '../escape' }))).toBe('store.bad_id');
  });

  it.each(['con', 'CON', 'nul', 'Com1', 'lpt9'])('refuses the reserved name %s', async (name) => {
    const home = workspace();
    const pdf = await forgeFile('plain', tempDir());
    expect(await failure(() => addBook({ home, pdf, name }))).toBe('store.bad_id');
    expect(scanBooks(home).books).toEqual([]);
  });

  it('is not stopped by another book that is broken', async () => {
    const home = workspace();
    mkdirSync(bookDir(home, 'broken'), { recursive: true });
    writeFileSync(join(bookDir(home, 'broken'), 'book.yaml'), 'a: [');
    mkdirSync(bookDir(home, 'stray'), { recursive: true });
    mkdirSync(join(home, 'books', 'not a name!'), { recursive: true });
    writeFileSync(join(home, 'books', 'not a name!', 'book.yaml'), 'schema: tome-book/1\n');
    const result = await addBook({ home, pdf: await forgeFile('plain', tempDir()) });
    expect(result.book).toBe('plain');
    expect(result.findings.filter((item) => item.code === 'book.unreadable')).toEqual([
      { code: 'book.unreadable', level: 'warn', params: { name: 'broken' } },
      { code: 'book.unreadable', level: 'warn', params: { name: 'not a name!' } },
    ]);
    expect(codes(result)).toContain('book.added');
    expect(scanBooks(home).unreadable).toEqual(['broken', 'not a name!']);
  });

  it('still warns about a broken book when nothing else changes', async () => {
    const home = workspace();
    const pdf = await forgeFile('plain', tempDir());
    await addBook({ home, pdf });
    mkdirSync(bookDir(home, 'broken'), { recursive: true });
    writeFileSync(join(bookDir(home, 'broken'), 'book.yaml'), 'schema: other/1\n');
    expect(codes(await addBook({ home, pdf }))).toEqual(['book.unreadable', 'book.already_added']);
  });
});

describe('probeBook', () => {
  it('reuses the result while the PDF is the same', async () => {
    const home = workspace();
    await addBook({ home, pdf: await forgeFile('plain', tempDir()) });
    const outcome = await probeBook(home, 'plain');
    expect(outcome.reused).toBe(true);
    expect(outcome.summary.pages).toBe(3);
  });

  it('records the stage with its fingerprint', async () => {
    const home = workspace();
    await addBook({ home, pdf: await forgeFile('plain', tempDir()) });
    const store = openBookStore(home, 'plain');
    const row = store.get<{ fingerprint: string; status: string }>(
      "SELECT fingerprint, status FROM stage WHERE name = 'probe'",
    );
    store.close();
    expect(row?.status).toBe('done');
    expect(row?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('runs again when the stored result is gone', async () => {
    const home = workspace();
    await addBook({ home, pdf: await forgeFile('plain', tempDir()) });
    renameSync(join(bookDir(home, 'plain'), 'ir', 'probe.json'), join(bookDir(home, 'plain'), 'old.json'));
    expect((await probeBook(home, 'plain')).reused).toBe(false);
  });

  it('reports a stored result that is corrupt as a damaged file', async () => {
    const home = workspace();
    await addBook({ home, pdf: await forgeFile('plain', tempDir()) });
    const path = join(bookDir(home, 'plain'), 'ir', 'probe.json');
    writeFileSync(path, '{ not json');
    expect(await failure(() => probeBook(home, 'plain'))).toBe('file.corrupt');
    writeFileSync(path, '{"schema":"other/1"}');
    expect(await failure(() => probeBook(home, 'plain'))).toBe('config.bad_schema');
  });

  describe('suggesting a pack (ADR-0100)', () => {
    /** 合成書的假文字每頁都有這些字。 */
    const KEYWORDS = '[the, of, and, warden, salt]';

    function hintedPack(home: string, id = 'hinted'): void {
      createPack(home, id, packTemplate(id));
      const path = join(home, 'systems', id, 'pack.yaml');
      writeFileSync(path, `${readFileSync(path, 'utf8')}suggest:\n  keywords: ${KEYWORDS}\n`);
    }

    it('keeps only the pack and the page counts in probe.json', async () => {
      const home = workspace();
      hintedPack(home);
      const { probe } = await addBook({ home, pdf: await forgeFile('plain', tempDir()) });
      expect(probe?.suggestion).toEqual({ id: 'hinted', keyword_pages: 3, pattern_pages: 0 });
      const stored = JSON.parse(readFileSync(join(bookDir(home, 'plain'), 'ir', 'probe.json'), 'utf8')) as {
        suggested_pack: unknown;
      };
      expect(stored.suggested_pack).toEqual({ id: 'hinted', keyword_pages: 3, pattern_pages: 0 });
    });

    it('suggests nothing with no pack that says what to look for', async () => {
      const home = workspace();
      const { probe } = await addBook({ home, pdf: await forgeFile('plain', tempDir()) });
      expect(probe?.suggestion).toBeNull();
    });

    it('stays quiet for a book that already has a pack, and only then', async () => {
      const home = workspace();
      hintedPack(home);
      createPack(home, 'chosen', packTemplate('chosen'));
      const { probe } = await addBook({ home, pdf: await forgeFile('plain', tempDir()), system: 'chosen' });
      expect(probe?.suggestion).toBeNull();
      expect(probe?.probe.suggested_pack?.id).toBe('hinted');
    });

    it('still gives the suggestion when it reuses the result', async () => {
      const home = workspace();
      hintedPack(home);
      await addBook({ home, pdf: await forgeFile('plain', tempDir()) });
      const outcome = await probeBook(home, 'plain');
      expect(outcome.reused).toBe(true);
      expect(outcome.suggestion?.id).toBe('hinted');
    });

    it('runs again when a pack that suggests is added', async () => {
      const home = workspace();
      await addBook({ home, pdf: await forgeFile('plain', tempDir()) });
      hintedPack(home);
      const outcome = await probeBook(home, 'plain');
      expect(outcome.reused).toBe(false);
      expect(outcome.suggestion?.id).toBe('hinted');
    });

    it('does not run again for a pack with nothing to suggest', async () => {
      const home = workspace();
      await addBook({ home, pdf: await forgeFile('plain', tempDir()) });
      createPack(home, 'plain-pack', packTemplate('plain-pack'));
      expect((await probeBook(home, 'plain')).reused).toBe(true);
    });
  });

  it('runs again when the language profile changes the fingerprint', async () => {
    const home = workspace();
    await addBook({ home, pdf: await forgeFile('plain', tempDir()) });
    const store = openBookStore(home, 'plain');
    store.run("UPDATE stage SET fingerprint = 'old' WHERE name = 'probe'");
    store.close();
    expect((await probeBook(home, 'plain')).reused).toBe(false);
  });

  it('refuses a PDF that changed instead of probing it quietly', async () => {
    const home = workspace();
    const directory = tempDir();
    const pdf = await forgeFile('plain', directory);
    await addBook({ home, pdf });
    writeFileSync(pdf, readFileSync(await forgeFile('hidden', directory)));
    expect(await failure(() => probeBook(home, 'plain'))).toBe('book.pdf_changed');
  });

  it('reports a PDF that moved away', async () => {
    const home = workspace();
    const pdf = await forgeFile('plain', tempDir());
    await addBook({ home, pdf });
    renameSync(pdf, `${pdf}.moved`);
    expect(await failure(() => probeBook(home, 'plain'))).toBe('book.pdf_missing');
  });

  it('reports a book that does not exist, and a broken book.yaml', async () => {
    const home = workspace();
    expect(await failure(() => probeBook(home, 'nope'))).toBe('book.not_found');
    mkdirSync(bookDir(home, 'bad'), { recursive: true });
    writeFileSync(join(bookDir(home, 'bad'), 'book.yaml'), 'schema: other/1\n');
    expect(await failure(() => probeBook(home, 'bad'))).toBe('config.bad_schema');
    writeFileSync(join(bookDir(home, 'bad'), 'book.yaml'), 'a: [');
    expect(await failure(() => probeBook(home, 'bad'))).toBe('config.invalid_yaml');
  });
});
