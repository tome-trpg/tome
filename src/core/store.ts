import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { TomeError } from './errors.ts';

// 資料存取層。`node:sqlite` 還是 Release candidate，只有這個檔案碰它，需要時能換（ADR-0052）。

const BUSY_TIMEOUT_MS = 5000;
const SQLITE_BUSY = 5;
// Windows 不能建立這些名稱的檔案或目錄，放進路徑會變成看不懂的系統錯誤。
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

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
  book: [
    { version: 1, sql: metaTable('book') },
    {
      // 各階段的內容指紋，以及還沒有單位的階段狀態（ADR-0056、ADR-0081）。
      version: 2,
      sql: `
        CREATE TABLE stage (
          name TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          status TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
      `,
    },
  ],
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
    // 先看種類：book 與 series 的版本各算各的，開錯庫時版本比較沒有意義。
    if (current > 0 && storedKind(db) !== kind) {
      throw new TomeError('store.wrong_kind', { path, expected: kind });
    }
    if (current > latest) {
      throw new TomeError('store.too_new', {
        path,
        found: String(current),
        supported: String(latest),
      });
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

/** 鎖等滿了還拿不到。延伸代碼的低八位是主代碼，SQLITE_BUSY_SNAPSHOT 這類也算。 */
function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && (code & 0xff) === SQLITE_BUSY;
}

function openFailure(error: unknown, path: string): TomeError {
  if (error instanceof TomeError) return error;
  return new TomeError(isBusy(error) ? 'store.busy' : 'store.corrupt', { path });
}

function connect(path: string, busyTimeoutMs: number): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    // 等待時間要先設：切到 WAL 要拿鎖，第一次開檔撞到別的行程時才會等，不會立刻失敗。
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  } catch (error) {
    db?.close();
    throw openFailure(error, path);
  }
}

export function openStore(
  path: string,
  kind: StoreKind,
  migrations: readonly Migration[] = MIGRATIONS[kind],
  busyTimeoutMs: number = BUSY_TIMEOUT_MS,
): Store {
  mkdirSync(dirname(path), { recursive: true });
  const db = connect(path, busyTimeoutMs);
  try {
    migrate(db, path, kind, migrations);
  } catch (error) {
    db.close();
    throw openFailure(error, path);
  }
  const guarded = <T>(action: () => T): T => {
    try {
      return action();
    } catch (error) {
      throw isBusy(error) ? new TomeError('store.busy', { path }) : error;
    }
  };
  return {
    kind,
    path,
    schemaVersion: () => userVersion(db),
    run: (sql, ...params) => guarded(() => void db.prepare(sql).run(...params)),
    get: <T>(sql: string, ...params: SQLInputValue[]) =>
      guarded(() => db.prepare(sql).get(...params) as T | undefined),
    all: <T>(sql: string, ...params: SQLInputValue[]) =>
      guarded(() => db.prepare(sql).all(...params) as T[]),
    transaction: (action) => guarded(() => inTransaction(db, action)),
    close: () => db.close(),
  };
}

export function isReservedName(name: string): boolean {
  return RESERVED_NAME.test(name);
}

export function assertSafeId(id: string): void {
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(id) || isReservedName(id)) {
    throw new TomeError('store.bad_id', { id });
  }
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
