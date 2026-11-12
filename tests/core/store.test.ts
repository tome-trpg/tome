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

  // M2 的帳本已經有列，升級之後要留著，新的兩欄是 NULL（ADR-0114）。
  it('adds the stop reason and max_tokens to a ledger that already has rows', () => {
    const path = join(tempDir(), 'book.db');
    openStore(path, 'book', MIGRATIONS.book.slice(0, 6)).close();
    const old = new DatabaseSync(path);
    old
      .prepare(
        `INSERT INTO ledger (request_id, unit_id, model, mode, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, cost_usd, created_at)
         VALUES ('r1', 'a', 'm', 'batch', 1, 2, 0, 0, 0.5, '2026-11-08T00:00:00.000Z')`,
      )
      .run();
    old.close();
    const store = openStore(path, 'book');
    const rows = store.all('SELECT request_id, output_tokens, stop_reason, max_tokens FROM ledger');
    store.close();
    expect(pragma(path, 'user_version')).toBe(LATEST_BOOK);
    expect(rows).toEqual([{ request_id: 'r1', output_tokens: 2, stop_reason: null, max_tokens: null }]);
  });

  it('adds the inline formats to units that are already there, with no styles (ADR-0116)', () => {
    const path = join(tempDir(), 'book.db');
    openStore(path, 'book', MIGRATIONS.book.slice(0, 7)).close();
    const old = new DatabaseSync(path);
    old
      .prepare(
        `INSERT INTO unit (unit_id, block_id, role, seq, source, masked, placeholders, state, translation)
         VALUES ('a', 'b', 'paragraph', 0, 'x', 'x', '[]', 'DONE', 'y')`,
      )
      .run();
    old.close();
    const store = openStore(path, 'book');
    const rows = store.all('SELECT unit_id, state, translation, formats, translation_pc FROM unit');
    store.close();
    expect(pragma(path, 'user_version')).toBe(LATEST_BOOK);
    expect(rows).toEqual([{ unit_id: 'a', state: 'DONE', translation: 'y', formats: null, translation_pc: null }]);
  });

  it('adds the entity cards and the summary, and counts old batches as translation (ADR-0118)', () => {
    const path = join(tempDir(), 'book.db');
    openStore(path, 'book', MIGRATIONS.book.slice(0, 8)).close();
    const old = new DatabaseSync(path);
    old
      .prepare(
        `INSERT INTO batch (nonce, state, requests, high_usd, created_at)
         VALUES ('n', 'submitted', 1, 0.1, '2026-11-08T00:00:00.000Z')`,
      )
      .run();
    old.close();
    const store = openStore(path, 'book');
    const batches = store.all('SELECT nonce, stage FROM batch');
    store.run(
      `INSERT INTO entity (source, status, origin, sources, occurrences, created_at, updated_at)
       VALUES ('Salt Marsh', 'candidate', 'pass0', '["caps"]', 2, 't', 't')`,
    );
    const entities = store.all('SELECT source, target, keep_source, attempts FROM entity');
    store.close();
    expect(pragma(path, 'user_version')).toBe(LATEST_BOOK);
    expect(batches).toEqual([{ nonce: 'n', stage: 'translate' }]);
    expect(entities).toEqual([{ source: 'Salt Marsh', target: null, keep_source: 0, attempts: 0 }]);
  });

  it('adds who decided an entity card and when, and its previous translation (ADR-0119)', () => {
    const path = join(tempDir(), 'book.db');
    openStore(path, 'book', MIGRATIONS.book.slice(0, 9)).close();
    const old = new DatabaseSync(path);
    old
      .prepare(
        `INSERT INTO entity (source, target, status, origin, sources, occurrences, created_at, updated_at)
         VALUES ('Salt Marsh', '鹽沼', 'proposed', 'pass0', '["caps"]', 2, 't', 't')`,
      )
      .run();
    old.close();
    const store = openStore(path, 'book');
    const rows = store.all('SELECT source, target, decided_by, decided_at, previous_target, review_written FROM entity');
    store.close();
    expect(pragma(path, 'user_version')).toBe(LATEST_BOOK);
    expect(rows).toEqual([
      { source: 'Salt Marsh', target: '鹽沼', decided_by: null, decided_at: null, previous_target: null, review_written: null },
    ]);
  });

  it('marks the units translated on this machine from stat block fields, none at first (ADR-0121)', () => {
    const path = join(tempDir(), 'book.db');
    openStore(path, 'book', MIGRATIONS.book.slice(0, 10)).close();
    const old = new DatabaseSync(path);
    old
      .prepare(
        `INSERT INTO unit (unit_id, block_id, role, seq, source, masked, placeholders, state, attempts)
         VALUES ('p0000-aaaaaa', 'p0000-aaaaaa', 'paragraph', 0, 'Grit 3', 'Grit 3', '[]', 'DONE', 1)`,
      )
      .run();
    old.close();
    const store = openStore(path, 'book');
    const rows = store.all('SELECT unit_id, fielded FROM unit');
    store.close();
    expect(pragma(path, 'user_version')).toBe(LATEST_BOOK);
    expect(rows).toEqual([{ unit_id: 'p0000-aaaaaa', fielded: 0 }]);
  });

  it('adds the render tables for what the vault last held, empty at first (ADR-0122)', () => {
    const path = join(tempDir(), 'book.db');
    openStore(path, 'book', MIGRATIONS.book.slice(0, 11)).close();
    const store = openStore(path, 'book');
    store.run("INSERT INTO render (block_id, path, markdown, rendered_at) VALUES ('p0000-aaaaaa', '01.md', '譯文', 't')");
    store.run("INSERT INTO render_file (path, sha256, rendered_at) VALUES ('01.md', 'h', 't')");
    const rows = [store.all('SELECT * FROM render'), store.all('SELECT * FROM render_file')];
    store.close();
    expect(pragma(path, 'user_version')).toBe(LATEST_BOOK);
    expect(rows).toEqual([
      [{ block_id: 'p0000-aaaaaa', path: '01.md', markdown: '譯文', rendered_at: 't' }],
      [{ path: '01.md', sha256: 'h', rendered_at: 't' }],
    ]);
  });

  it('adds the confirmed estimates and the memory key of a batched unit, which old rows leave empty (ADR-0123)', () => {
    const path = join(tempDir(), 'book.db');
    const old = openStore(path, 'book', MIGRATIONS.book.slice(0, 12));
    old.run("INSERT INTO batch_unit (batch_id, custom_id, position, unit_id, model) VALUES (1, 'c', 0, 'p0000-aaaaaa', 'm')");
    old.close();
    const store = openStore(path, 'book');
    store.run(
      "INSERT INTO estimate (stage, mode, model, requests, low_usd, high_usd, created_at) VALUES ('translate', 'batch', 'm', 2, 0.1, 0.3, 't')",
    );
    const rows = [store.all('SELECT stage, requests, low_usd, high_usd FROM estimate'), store.all('SELECT memory_key FROM batch_unit')];
    store.close();
    expect(pragma(path, 'user_version')).toBe(LATEST_BOOK);
    expect(rows).toEqual([[{ stage: 'translate', requests: 2, low_usd: 0.1, high_usd: 0.3 }], [{ memory_key: null }]]);
  });

  it('marks no unit as a human translation at first, and adds the changes tome sync cannot recover with their files (ADR-0125)', () => {
    const path = join(tempDir(), 'book.db');
    const old = openStore(path, 'book', MIGRATIONS.book.slice(0, 13));
    old.run(
      `INSERT INTO unit (unit_id, block_id, role, seq, source, masked, placeholders, state)
       VALUES ('p0000-aaaaaa', 'p0000-aaaaaa', 'paragraph', 0, 'x', 'x', '[]', 'DONE')`,
    );
    old.close();
    const store = openStore(path, 'book');
    store.run("INSERT INTO sync_change (path, kind, before_block, after_block, created_at) VALUES ('01.md', 'merged', 'a', NULL, 't')");
    store.run("INSERT INTO sync_file (path, sha256) VALUES ('01.md', 'h')");
    expect(() => store.run("INSERT INTO sync_file (path, sha256) VALUES ('01.md', 'h2')")).toThrow();
    const rows = [
      store.all('SELECT unit_id, human FROM unit'),
      store.all('SELECT path, kind, before_block, after_block FROM sync_change'),
      store.all('SELECT path, sha256 FROM sync_file'),
    ];
    store.close();
    expect(pragma(path, 'user_version')).toBe(LATEST_BOOK);
    expect(rows).toEqual([
      [{ unit_id: 'p0000-aaaaaa', human: 0 }],
      [{ path: '01.md', kind: 'merged', before_block: 'a', after_block: null }],
      [{ path: '01.md', sha256: 'h' }],
    ]);
  });

  // 試翻（ADR-0135）：舊的帳本列不是試翻，舊的估價沒有中間值、沒有校準，不算 Q-6。
  it('adds the calibration and the trial, and leaves old ledger rows and estimates out of both (ADR-0135)', () => {
    const path = join(tempDir(), 'book.db');
    const old = openStore(path, 'book', MIGRATIONS.book.slice(0, 14));
    old.run(
      `INSERT INTO ledger (request_id, unit_id, model, mode, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at)
       VALUES ('r', 'u', 'm', 'batch', 1, 1, 0, 0, 0.1, 't')`,
    );
    old.run("INSERT INTO estimate (stage, mode, model, requests, low_usd, high_usd, created_at) VALUES ('translate', 'batch', 'm', 1, 0.1, 0.3, 't')");
    old.close();
    const store = openStore(path, 'book');
    store.run(
      `INSERT INTO calibration (model, mode, input_factor, output_factor, requests, resend_ratio, cache_ttl, cache_hit_rate, created_at)
       VALUES ('m', 'batch', 1.1, 0.9, 5, 0.2, '1h', 0.8, 't')`,
    );
    store.run("INSERT INTO trial_unit (unit_id, model, mode) VALUES ('u', 'm', 'batch')");
    const twice = (): void => store.run("INSERT INTO calibration (model, mode, input_factor, output_factor, requests, resend_ratio, created_at) VALUES ('m', 'batch', 1, 1, 1, 0, 't')");
    const rows = [
      store.all('SELECT request_id, trial FROM ledger'),
      store.all('SELECT stage, middle_usd, calibrated FROM estimate'),
      store.all('SELECT model, mode, cache_ttl FROM calibration'),
      store.all('SELECT unit_id FROM trial_unit'),
    ];
    expect(twice).toThrow();
    store.close();
    expect(pragma(path, 'user_version')).toBe(15);
    expect(rows).toEqual([
      [{ request_id: 'r', trial: 0 }],
      [{ stage: 'translate', middle_usd: null, calibrated: 0 }],
      [{ model: 'm', mode: 'batch', cache_ttl: '1h' }],
      [{ unit_id: 'u' }],
    ]);
  });

  it('adds the human translations to series.db, one per unit of a book (ADR-0125)', () => {
    const path = join(tempDir(), 'series.db');
    openStore(path, 'series', MIGRATIONS.series.slice(0, 2)).close();
    const series = openStore(path, 'series');
    const insert = "INSERT INTO human (book, unit_id, source_sha256, text, created_at) VALUES ('b', 'u', 'h', ?, 't')";
    series.run(insert, '人工');
    const repeated = (() => {
      try {
        series.run(insert, '又一次');
        return false;
      } catch {
        return true;
      }
    })();
    const rows = series.all('SELECT book, unit_id, text FROM human');
    series.close();
    expect(pragma(path, 'user_version')).toBe(3);
    expect(repeated).toBe(true);
    expect(rows).toEqual([{ book: 'b', unit_id: 'u', text: '人工' }]);
  });
});

describe('sqliteVersion', () => {
  it('reads the bundled version', () => {
    expect(sqliteVersion()).toMatch(/^3\.\d+\.\d+$/);
  });
});
