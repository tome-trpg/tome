import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { TomeError } from './errors.ts';

// 資料存取層。`node:sqlite` 還是 Release candidate，只有這個檔案碰它，需要時能換（ADR-0052）。

export type StoreKind = 'book' | 'series';

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

function metaTable(kind: StoreKind): string {
  return `
    CREATE TABLE tome_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO tome_meta (key, value) VALUES ('kind', '${kind}');
  `;
}

// 只能往後加，不能改已發佈的遷移，也沒有降版。
export const MIGRATIONS: Readonly<Record<StoreKind, readonly Migration[]>> = {
  book: [{ version: 1, sql: metaTable('book') }],
  series: [{ version: 1, sql: metaTable('series') }],
};

export interface Store {
  readonly kind: StoreKind;
  readonly path: string;
  schemaVersion(): number;
  run(sql: string, ...params: SQLInputValue[]): void;
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined;
  all<T>(sql: string, ...params: SQLInputValue[]): T[];
  transaction<T>(action: () => T): T;
  close(): void;
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

function storedKind(db: DatabaseSync): string | null {
  const table = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'tome_meta'")
    .get();
  if (table === undefined) return null;
  const row = db.prepare("SELECT value FROM tome_meta WHERE key = 'kind'").get() as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function inTransaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrate(
  db: DatabaseSync,
  path: string,
  kind: StoreKind,
  migrations: readonly Migration[],
): void {
  const latest = migrations.at(-1)?.version ?? 0;
  inTransaction(db, () => {
    const current = userVersion(db);
    if (current > latest) {
      throw new TomeError('store.too_new', {
        path,
        found: String(current),
        supported: String(latest),
      });
    }
    if (current > 0 && storedKind(db) !== kind) {
      throw new TomeError('store.wrong_kind', { path, expected: kind });
    }
    if (current === 0) {
      const tables = db.prepare('SELECT 1 AS found FROM sqlite_master LIMIT 1').get();
      if (tables !== undefined) throw new TomeError('store.wrong_kind', { path, expected: kind });
    }
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
  });
}

function connect(path: string): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  } catch {
    db?.close();
    throw new TomeError('store.corrupt', { path });
  }
}

export function openStore(
  path: string,
  kind: StoreKind,
  migrations: readonly Migration[] = MIGRATIONS[kind],
): Store {
  mkdirSync(dirname(path), { recursive: true });
  const db = connect(path);
  try {
    migrate(db, path, kind, migrations);
  } catch (error) {
    db.close();
    if (error instanceof TomeError) throw error;
    throw new TomeError('store.corrupt', { path });
  }
  return {
    kind,
    path,
    schemaVersion: () => userVersion(db),
    run: (sql, ...params) => void db.prepare(sql).run(...params),
    get: <T>(sql: string, ...params: SQLInputValue[]) =>
      db.prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as T[],
    transaction: (action) => inTransaction(db, action),
    close: () => db.close(),
  };
}

function assertSafeId(id: string): void {
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(id)) throw new TomeError('store.bad_id', { id });
}

export function openBookStore(home: string, slug: string): Store {
  assertSafeId(slug);
  return openStore(join(home, 'books', slug, 'book.db'), 'book');
}

export function openSeriesStore(home: string, id: string): Store {
  assertSafeId(id);
  return openStore(join(home, 'series', id, 'series.db'), 'series');
}

export function sqliteVersion(): string {
  const db = new DatabaseSync(':memory:');
  try {
    const row = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    return row.version;
  } finally {
    db.close();
  }
}
