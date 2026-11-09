import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { backupStamp } from '../../src/core/backup.ts';
import { openBookStore, openSeriesStore, type Store } from '../../src/core/store.ts';
import { tempDir } from '../helpers.ts';
import { library, MODEL, type Library } from '../helpers/library.ts';

// tome backup（ADR-0128）。只在暫存的合成工作區跑，文字都是合成 PDF 的假文字與這裡編的字。

interface Ran {
  readonly exit: number;
  readonly output: Envelope;
  readonly text: string;
}

interface Manifest {
  readonly format: string;
  readonly book: string;
  readonly created_at: string;
  readonly tome_version: string;
  readonly user_version: { readonly book: number; readonly series: number | null };
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
}

async function tome(lib: Library, ...args: string[]): Promise<Ran> {
  const env = { ...lib.env, TOME_ANTHROPIC_API_KEY: undefined };
  const { io, stdout } = lib.session({ env });
  const exit = await run([...args, '--json'], io);
  return { exit, output: JSON.parse(stdout()) as Envelope, text: stdout() };
}

function codes(output: Envelope): string[] {
  return output.findings.map(({ code }) => code);
}

function closing<T>(store: Store, action: (store: Store) => T): T {
  try {
    return action(store);
  } finally {
    store.close();
  }
}

/** 唯讀打開，不改到備份。 */
function countIn(path: string, table: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  } finally {
    db.close();
  }
}

/** 資料夾底下所有的檔，分隔字元是 `/`。 */
function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 有系列記憶的書：翻譯記憶一筆，另有合成的 `overrides.yaml`。 */
async function bookWithSeries(): Promise<Library> {
  const lib = await library();
  closing(openSeriesStore(lib.home, 'book'), (series) =>
    series.run(
      'INSERT INTO memory (key, fragment, model, prompt_hash, pack_hash, sdk_version, book, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      'key-1',
      '合成的片段',
      MODEL,
      'd'.repeat(64),
      'e'.repeat(64),
      '0.0.0',
      'book',
      new Date().toISOString(),
    ),
  );
  writeFileSync(join(lib.home, 'books', 'book', 'overrides.yaml'), 'entities: []\n');
  return lib;
}

const LAYOUT = [
  'books/book/book.db',
  'series/book/series.db',
  'books/book/book.yaml',
  'books/book/overrides.yaml',
  'books/book/ir/document.json',
  'books/book/ir/probe.json',
];

describe('tome backup (ADR-0128)', () => {
  it('lays out consistent copies of both databases, the settings and the document layer, with a manifest', async () => {
    const lib = await bookWithSeries();
    const { home } = lib;
    const bookPath = join(home, 'books', 'book');
    // 不進備份的：source 層與 review/。
    expect(existsSync(join(bookPath, 'ir', 'source'))).toBe(true);
    mkdirSync(join(bookPath, 'review'), { recursive: true });
    writeFileSync(join(bookPath, 'review', 'chapter.md'), '合成的對照\n');
    const units = closing(openBookStore(home, 'book'), (store) => store.get<{ count: number }>('SELECT COUNT(*) AS count FROM unit')?.count ?? 0);
    const document = JSON.parse(readFileSync(join(bookPath, 'ir', 'document.json'), 'utf8')) as { blocks: { text: string }[] };
    const longest = document.blocks.map(({ text }) => text).sort((a, b) => b.length - a.length)[0] ?? '';
    expect(longest.length).toBeGreaterThan(10);

    const ran = await tome(lib, 'backup', 'book');
    expect(ran.exit).toBe(0);
    expect(codes(ran.output)).toEqual(['backup.done', 'backup.private']);
    const target = ran.output.findings[0]?.params['path'] ?? '';
    expect(target.slice(join(home, 'backups').length)).toMatch(/^[\\/]book-\d{8}T\d{6}Z$/);
    expect(ran.output.findings[0]).toMatchObject({ level: 'info', params: { book: 'book', path: target, files: '6' } });
    expect(ran.output.findings[0]?.message).toContain('manifest.json');
    expect(ran.output.findings[1]?.level).toBe('warn');

    const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')) as Manifest;
    expect(ran.output.data).toEqual({ book: 'book', path: target, files: 6, manifest });
    expect(manifest).toMatchObject({
      format: 'tome-backup/1',
      book: 'book',
      tome_version: packageJson.version,
      user_version: { book: 14, series: 3 },
    });
    expect(target.endsWith(backupStamp(new Date(manifest.created_at)))).toBe(true);
    expect(manifest.files.map(({ path }) => path)).toEqual(LAYOUT);
    // 只有這些檔：沒有 source 層、review/、鎖檔、PDF、tome.yaml。
    expect(filesUnder(target)).toEqual([...LAYOUT, 'manifest.json'].sort());
    for (const { path, bytes, sha256: hash } of manifest.files) {
      expect(statSync(join(target, path)).size).toBe(bytes);
      expect(sha256(join(target, path))).toBe(hash);
    }
    // 設定與 document 層原樣複製；資料庫是打得開的複本。
    for (const path of LAYOUT.slice(2)) expect(sha256(join(target, path))).toBe(sha256(join(home, path)));
    expect(countIn(join(target, 'books/book/book.db'), 'unit')).toBe(units);
    expect(countIn(join(target, 'series/book/series.db'), 'memory')).toBe(1);
    // 訊息與 --json 只有路徑、數量與雜湊（ADR-0059）。
    expect(ran.text).not.toContain(longest);
    // 備份不刪也不改工作區。
    expect(existsSync(join(bookPath, 'review', 'chapter.md'))).toBe(true);
  });

  it('leaves out what the book does not have yet, and writes where --out says', async () => {
    const lib = await library();
    const target = join(tempDir(), 'kept', 'copy');
    const ran = await tome(lib, 'backup', 'book', '--out', target);
    expect(ran.exit).toBe(0);
    expect(ran.output.findings[0]).toMatchObject({ params: { path: target, files: '4' } });
    const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')) as Manifest;
    expect(manifest.user_version).toEqual({ book: 14, series: null });
    expect(manifest.files.map(({ path }) => path)).toEqual([
      'books/book/book.db',
      'books/book/book.yaml',
      'books/book/ir/document.json',
      'books/book/ir/probe.json',
    ]);
    expect(existsSync(join(target, 'series'))).toBe(false);
    expect(existsSync(join(lib.home, 'series', 'book'))).toBe(false);
  });

  it('does not overwrite a destination that already exists', async () => {
    const lib = await library();
    const target = join(tempDir(), 'taken');
    mkdirSync(target);
    writeFileSync(join(target, 'mine.txt'), 'kept\n');
    const ran = await tome(lib, 'backup', 'book', '--out', target);
    expect(ran.exit).toBe(2);
    expect(ran.output.findings[0]).toMatchObject({ code: 'backup.exists', params: { path: target } });
    expect(readdirSync(target)).toEqual(['mine.txt']);
  });

  it('refuses a destination inside a git repository and warns about a sync folder', async () => {
    const lib = await library();
    const repo = join(tempDir(), 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const inside = join(repo, 'backups', 'book');
    const refused = await tome(lib, 'backup', 'book', '--out', inside);
    expect(refused.exit).toBe(1);
    expect(codes(refused.output)).toEqual(['backup.in_git_repo']);
    expect(refused.output.findings[0]).toMatchObject({ level: 'fail', params: { path: inside } });
    expect(refused.output.data).toEqual({ book: 'book', path: inside });
    expect(existsSync(join(repo, 'backups'))).toBe(false);

    const synced = join(tempDir(), 'Dropbox', 'book');
    const warned = await tome(lib, 'backup', 'book', '--out', synced);
    expect(warned.exit).toBe(0);
    expect(codes(warned.output)).toEqual(['backup.done', 'backup.private', 'backup.sync_folder']);
    expect(warned.output.findings[2]).toMatchObject({ level: 'warn', params: { path: synced, provider: 'Dropbox' } });
    expect(existsSync(join(synced, 'manifest.json'))).toBe(true);
  });

  it('removes the half-written destination when copying fails', async () => {
    const lib = await library();
    const probe = join(lib.home, 'books', 'book', 'ir', 'probe.json');
    rmSync(probe);
    mkdirSync(probe);
    const target = join(tempDir(), 'broken');
    const ran = await tome(lib, 'backup', 'book', '--out', target);
    expect(ran.exit).toBe(2);
    expect(ran.output.findings[0]?.code).toBe('cli.internal');
    expect(existsSync(target)).toBe(false);
  });

  it('says the destination exists only when it does, not when it cannot be made', async () => {
    const lib = await library();
    // 名稱太長，建不了資料夾：Windows 回 EINVAL，Linux 回 ENAMETOOLONG，都不是「已經存在」。
    const target = join(tempDir(), 'x'.repeat(300));
    const ran = await tome(lib, 'backup', 'book', '--out', target);
    expect(ran.exit).toBe(2);
    expect(ran.output.findings[0]?.code).toBe('cli.internal');
    expect(existsSync(target)).toBe(false);
  });
});

describe('tome backup and tome purge without a book', () => {
  it('asks for the name of the book', async () => {
    const lib = await library({ extract: false });
    for (const command of ['backup', 'purge']) {
      const ran = await tome(lib, command);
      expect(ran.exit).toBe(2);
      expect(ran.output.findings[0]).toMatchObject({ code: 'cli.missing_argument', params: { argument: '<名稱>' } });
    }
  });
});

describe('the backup folder name', () => {
  it('is the UTC time without separators, so it sorts in time order', () => {
    expect(backupStamp(new Date('2026-11-09T12:00:00.000Z'))).toBe('20261109T120000Z');
    expect(backupStamp(new Date('2026-01-02T03:04:05.678Z'))).toBe('20260102T030405Z');
  });
});
