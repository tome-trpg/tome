import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { bookDir, withBookLock } from './book.ts';
import { TomeError } from './errors.ts';
import { finding } from './findings.ts';
import type { PlanOutcome } from './request.ts';
import { openBookStore, openSeriesStore, type Store } from './store.ts';
import { pathFindings } from './workspace.ts';

// tome backup（白皮書 §6.4、ADR-0058、ADR-0128）：把一本書的資料庫、設定與 document 層照工作區的目錄排進
// 一個新資料夾，附 `manifest.json`。還原就是把資料夾的內容放回工作區。不含 PDF、source 層、`review/`、
// vault、`tome.yaml` 與金鑰。備份含書本文字與譯文，跟工作區一樣查路徑（ADR-0053）。

export const BACKUP_FORMAT = 'tome-backup/1';
const MANIFEST = 'manifest.json';
/** 書的資料夾底下要備份的檔，沒有就不放。分隔字元一律是 `/`。 */
const BOOK_FILES = ['book.yaml', 'overrides.yaml', 'ir/document.json', 'ir/probe.json'] as const;

export interface BackupOptions {
  readonly home: string;
  readonly slug: string;
  /** `--out`。沒指定時是 `<工作區>/backups/<slug>-<UTC 時間>/`。 */
  readonly out?: string | undefined;
  /** TOME 的版本，寫進 manifest。 */
  readonly version: string;
  readonly env: NodeJS.ProcessEnv;
  /** 沒給就是這台機器的平台，只有測試會換。 */
  readonly platform?: NodeJS.Platform | undefined;
  readonly now?: () => Date;
}

interface BackupFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface Manifest {
  readonly format: typeof BACKUP_FORMAT;
  readonly book: string;
  readonly created_at: string;
  readonly tome_version: string;
  /** 兩個資料庫的遷移版本。還沒有系列資料庫（沒翻過）時是 null。 */
  readonly user_version: { readonly book: number; readonly series: number | null };
  readonly files: readonly BackupFile[];
}

/** 例如 `20261109T120000Z`：排序就是時間順序，資料夾名稱也沒有冒號。 */
export function backupStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

function described(root: string, path: string): BackupFile {
  const full = join(root, path);
  return { path, bytes: statSync(full).size, sha256: createHash('sha256').update(readFileSync(full)).digest('hex') };
}

/** `VACUUM INTO` 在 WAL 模式下也是一致的複本，寫出來是單一個檔，遷移版本跟著過去（ADR-0128）。 */
function copyDatabase(store: Store, target: string): number {
  try {
    mkdirSync(dirname(target), { recursive: true });
    store.run('VACUUM INTO ?', target);
    return store.schemaVersion();
  } finally {
    store.close();
  }
}

/** 目的地由這裡建立：已經存在就不覆蓋，結束碼 2。 */
function claim(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new TomeError('backup.exists', { path });
  }
}

function writeBackup(options: BackupOptions, target: string, createdAt: Date): Manifest {
  const { home, slug } = options;
  const book = `books/${slug}`;
  const series = `series/${slug}/series.db`;
  const database = `${book}/book.db`;
  const paths = [database];
  const bookVersion = copyDatabase(openBookStore(home, slug), join(target, database));
  let seriesVersion: number | null = null;
  if (existsSync(join(home, series))) {
    seriesVersion = copyDatabase(openSeriesStore(home, slug), join(target, series));
    paths.push(series);
  }
  for (const file of BOOK_FILES) {
    const source = join(bookDir(home, slug), file);
    if (!existsSync(source)) continue;
    const path = `${book}/${file}`;
    mkdirSync(dirname(join(target, path)), { recursive: true });
    copyFileSync(source, join(target, path));
    paths.push(path);
  }
  const manifest: Manifest = {
    format: BACKUP_FORMAT,
    book: slug,
    created_at: createdAt.toISOString(),
    tome_version: options.version,
    user_version: { book: bookVersion, series: seriesVersion },
    files: paths.map((path) => described(target, path)),
  };
  writeFileSync(join(target, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function backupLocked(options: BackupOptions): Promise<PlanOutcome> {
  const { home, slug } = options;
  const createdAt = (options.now ?? (() => new Date()))();
  const target = resolve(options.out ?? join(home, 'backups', `${slug}-${backupStamp(createdAt)}`));
  const placement = pathFindings('backup', target, options.env, options.platform);
  if (placement.some(({ level }) => level === 'fail')) return { data: { book: slug, path: target }, findings: placement };
  claim(target);
  let manifest: Manifest;
  try {
    manifest = writeBackup(options, target, createdAt);
  } catch (error) {
    // 寫到一半失敗，留下的資料夾不完整，而且是這次建立的。
    rmSync(target, { recursive: true });
    throw error;
  }
  const files = manifest.files.length;
  return {
    data: { book: slug, path: target, files, manifest },
    findings: [finding('backup.done', 'info', { book: slug, path: target, files: String(files) }), finding('backup.private', 'warn'), ...placement],
  };
}

/** `tome backup`。拿著書的鎖，複製時不會有別的指令在寫（ADR-0054）。 */
export function backupBook(options: BackupOptions): Promise<PlanOutcome> {
  return withBookLock(options.home, options.slug, () => backupLocked(options));
}
