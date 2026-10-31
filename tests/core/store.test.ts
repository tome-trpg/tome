import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { TomeError } from '../../src/core/errors.ts';
import {
  MIGRATIONS,
  openBookStore,
  openSeriesStore,
  openStore,
  sqliteVersion,
  type Migration,
} from '../../src/core/store.ts';
import { tempDir } from '../helpers.ts';

const LATEST_BOOK = MIGRATIONS.book.at(-1)?.version ?? 0;

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof TomeError) return error.code;
    throw error;
  }
  return 'no error';
}

function pragma(path: string, name: string): unknown {
  const db = new DatabaseSync(path);
  try {
    return Object.values(db.prepare(`PRAGMA ${name}`).get() as object)[0];
  } finally {
    db.close();
  }
}

describe('openStore', () => {
  it('creates book.db and series.db under the layout of the white paper', () => {
    const home = tempDir();
    const book = openBookStore(home, 'my-book');
    const series = openSeriesStore(home, 'my-series');
    expect(book.path).toBe(join(home, 'books', 'my-book', 'book.db'));
    expect(series.path).toBe(join(home, 'series', 'my-series', 'series.db'));
    expect(book.get('SELECT value FROM tome_meta WHERE key = ?', 'kind')).toEqual({ value: 'book' });
    expect(series.get('SELECT value FROM tome_meta WHERE key = ?', 'kind')).toEqual({
      value: 'series',
    });
    book.close();
    series.close();
  });

  it('turns on WAL and records the schema version', () => {
    const path = join(tempDir(), 'book.db');
    const store = openStore(path, 'book');
    expect(store.schemaVersion()).toBe(LATEST_BOOK);
    store.close();
    expect(pragma(path, 'journal_mode')).toBe('wal');
    expect(pragma(path, 'user_version')).toBe(LATEST_BOOK);
  });

  it('enforces foreign keys on each connection', () => {
    const store = openStore(join(tempDir(), 'book.db'), 'book', [
      ...MIGRATIONS.book,
      {
        version: 2,
        sql: `CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;
              CREATE TABLE child (id INTEGER REFERENCES parent(id)) STRICT;`,
      },
    ]);
    expect(() => store.run('INSERT INTO child (id) VALUES (1)')).toThrow(/FOREIGN KEY/);
    store.close();
  });

  it('applies new migrations once, and keeps data', () => {
    const path = join(tempDir(), 'book.db');
    const first = openStore(path, 'book');
    first.run("INSERT INTO tome_meta (key, value) VALUES ('note', 'kept')");
    first.close();

    const later: Migration[] = [
      ...MIGRATIONS.book,
      { version: LATEST_BOOK + 1, sql: 'CREATE TABLE later (name TEXT PRIMARY KEY) STRICT' },
    ];
    const second = openStore(path, 'book', later);
    expect(second.schemaVersion()).toBe(LATEST_BOOK + 1);
    second.close();
    const third = openStore(path, 'book', later);
    expect(third.schemaVersion()).toBe(LATEST_BOOK + 1);
    expect(third.get("SELECT value FROM tome_meta WHERE key = 'note'")).toEqual({ value: 'kept' });
    third.close();
  });

  it('rolls back a failing migration whole, and leaves the version alone', () => {
    const path = join(tempDir(), 'book.db');
    openStore(path, 'book').close();
    const broken: Migration[] = [
      ...MIGRATIONS.book,
      { version: LATEST_BOOK + 1, sql: 'CREATE TABLE half (id INTEGER) STRICT' },
      { version: LATEST_BOOK + 2, sql: 'THIS IS NOT SQL' },
    ];
    expect(codeOf(() => openStore(path, 'book', broken))).toBe('store.corrupt');
    const store = openStore(path, 'book');
    expect(store.schemaVersion()).toBe(LATEST_BOOK);
    expect(store.all("SELECT name FROM sqlite_master WHERE name = 'half'")).toEqual([]);
    store.close();
  });

  it('refuses a database newer than the program', () => {
    const path = join(tempDir(), 'book.db');
    openStore(path, 'book', [...MIGRATIONS.book, { version: LATEST_BOOK + 1, sql: 'SELECT 1' }]).close();
    expect(codeOf(() => openStore(path, 'book'))).toBe('store.too_new');
  });

  it('refuses to open one kind of database as the other', () => {
    const path = join(tempDir(), 'book.db');
    openStore(path, 'book').close();
    expect(codeOf(() => openStore(path, 'series'))).toBe('store.wrong_kind');
  });

  it('refuses a SQLite file that is not one of ours', () => {
    const path = join(tempDir(), 'other.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE theirs (id INTEGER)');
    db.close();
    expect(codeOf(() => openStore(path, 'book'))).toBe('store.wrong_kind');
  });

  it('refuses a file that is not a database', () => {
    const path = join(tempDir(), 'book.db');
    writeFileSync(path, 'this is not a database, and it is long enough to read a header from.');
    expect(codeOf(() => openStore(path, 'book'))).toBe('store.corrupt');
  });

  it('waits for another process on the first open, instead of failing at once', async () => {
    const path = join(tempDir(), 'book.db');
    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN EXCLUSIVE');
      process.stdout.write('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 500);
    `;
    const holder = spawn(process.execPath, ['-e', script, path], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = once(holder, 'exit');
    await once(holder.stdout, 'data');
    const store = openStore(path, 'book');
    expect(store.schemaVersion()).toBe(LATEST_BOOK);
    store.close();
    await exited;
  });

  it('commits a transaction, and undoes one that throws', () => {
    const store = openStore(join(tempDir(), 'book.db'), 'book');
    store.transaction(() => store.run("INSERT INTO tome_meta VALUES ('a', '1')"));
    expect(() =>
      store.transaction(() => {
        store.run("INSERT INTO tome_meta VALUES ('b', '2')");
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(store.all<{ key: string }>('SELECT key FROM tome_meta ORDER BY key')).toEqual([
      { key: 'a' },
      { key: 'kind' },
    ]);
    store.close();
  });

  it('lets a second connection read what the first committed', () => {
    const path = join(tempDir(), 'book.db');
    const writer = openStore(path, 'book');
    writer.run("INSERT INTO tome_meta VALUES ('a', '1')");
    const reader = openStore(path, 'book');
    expect(reader.get("SELECT value FROM tome_meta WHERE key = 'a'")).toEqual({ value: '1' });
    reader.close();
    writer.close();
  });

  it.each(['../escape', 'a/b', 'a\\b', '', '.'])('refuses %j as an id', (id) => {
    expect(codeOf(() => openBookStore(tempDir(), id))).toBe('store.bad_id');
    expect(codeOf(() => openSeriesStore(tempDir(), id))).toBe('store.bad_id');
  });

  it('accepts a slug in any script', () => {
    const store = openBookStore(tempDir(), '克蘇魯-2');
    store.close();
  });
});

describe('a lock that outlasts the wait', () => {
  const shortWait = 20;

  it('is store.busy on a first open, and the next open works', () => {
    const path = join(tempDir(), 'book.db');
    const holder = new DatabaseSync(path);
    holder.exec('BEGIN EXCLUSIVE');
    try {
      expect(codeOf(() => openStore(path, 'book', MIGRATIONS.book, shortWait))).toBe('store.busy');
    } finally {
      holder.exec('COMMIT');
      holder.close();
    }
    const store = openStore(path, 'book', MIGRATIONS.book, shortWait);
    expect(store.schemaVersion()).toBe(LATEST_BOOK);
    store.close();
  });

  it('is store.busy while migrating a database already in WAL', () => {
    const path = join(tempDir(), 'book.db');
    const holder = openStore(path, 'book');
    const code = holder.transaction(() =>
      codeOf(() => openStore(path, 'book', MIGRATIONS.book, shortWait)),
    );
    expect(code).toBe('store.busy');
    holder.close();
  });

  it('is store.busy on a write and a transaction once open', () => {
    const path = join(tempDir(), 'book.db');
    const holder = openStore(path, 'book');
    const other = openStore(path, 'book', MIGRATIONS.book, shortWait);
    holder.transaction(() => {
      expect(codeOf(() => other.run("INSERT INTO tome_meta VALUES ('a', '1')"))).toBe('store.busy');
      expect(codeOf(() => other.transaction(() => undefined))).toBe('store.busy');
    });
    other.close();
    holder.close();
  });

  it('leaves other failures alone', () => {
    const store = openStore(join(tempDir(), 'book.db'), 'book');
    expect(() => store.run('THIS IS NOT SQL')).toThrow(/syntax error/);
    expect(codeOf(() => openStore(store.path, 'series'))).toBe('store.wrong_kind');
    store.close();
  });
});

describe('migrations', () => {
  it.each(['book', 'series'] as const)('%s versions run 1, 2, 3 with no gap', (kind) => {
    expect(MIGRATIONS[kind].map((item) => item.version)).toEqual(
      MIGRATIONS[kind].map((_item, index) => index + 1),
    );
  });
});

describe('sqliteVersion', () => {
  it('reads the bundled version', () => {
    expect(sqliteVersion()).toMatch(/^3\.\d+\.\d+$/);
  });
});
