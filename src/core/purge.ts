import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { retryDeletes, type BatchHost } from './batch.ts';
import { bookDir, readBook, recordStage, stageFingerprint, withBookLock, type Book } from './book.ts';
import { finding, type Finding } from './findings.ts';
import { sleepSeconds, type LLMHost, type OnRetry } from './llm.ts';
import type { PlanOutcome } from './request.ts';
import { openBookStore, openSeriesStore, type Store } from './store.ts';
import { connect, OUTSTANDING } from './translate.ts';
import { readWorkspaceConfig } from './workspace.ts';

// tome purge（白皮書 §6.3、ADR-0058、ADR-0128）：刪掉一本書在工作區的資料。先列出清單、記下指紋，
// `--confirm` 時清單跟上次列的相同才刪。還有沒收回的批次就不刪；遠端殘留先刪，有一筆刪不掉就整個不刪。
// PDF、引擎、`tome.yaml`、金鑰、別的書與備份都不動；vault 加 `--vault` 才刪，而且只刪 TOME 寫的檔。

/** 上次列出的清單的指紋，存在這本書的 `stage` 表，刪書時跟著刪。 */
const LIST_STAGE = 'purge-list';

export interface PurgeOptions {
  readonly home: string;
  readonly slug: string;
  readonly vault: boolean;
  readonly confirm: boolean;
  /** 確認刪除、又有遠端殘留時才取金鑰；沒有殘留就不連網（ADR-0128）。 */
  readonly host: () => Promise<LLMHost | Finding>;
  readonly onRetry?: OnRetry | undefined;
}

interface VaultList {
  readonly folder: string;
  /** TOME 寫的、現在還在的檔：書的資料夾底下的相對路徑（分隔字元是 `/`）與現在的雜湊。 */
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  /** 改過、還沒用 `tome sync` 讀回的檔，照樣刪。 */
  readonly edited: number;
  /** 使用者自己放的檔，不刪。 */
  readonly kept: number;
}

/** 要刪的東西。整份的雜湊就是清單的指紋，任何一項變了都要再列一次。 */
interface PurgeList {
  readonly path: string;
  readonly series: string | null;
  readonly units: number;
  readonly translated: number;
  readonly cards: number;
  readonly memory: number;
  readonly human: number;
  /** 已收回、遠端還沒刪掉的批次。 */
  readonly remote: readonly { readonly remote_id: string }[];
  /** 沒加 `--vault` 時是 null。 */
  readonly vault: VaultList | null;
}

function count(store: Store, sql: string, ...params: string[]): number {
  return store.get<{ count: number }>(sql, ...params)?.count ?? 0;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function remoteResidue(store: Store): { remote_id: string }[] {
  return store.all<{ remote_id: string }>(
    "SELECT remote_id FROM batch WHERE state = 'collected' AND remote_id IS NOT NULL AND deleted_at IS NULL ORDER BY id",
  );
}

/** 資料夾底下所有的檔。連結當成檔，不跟進去。 */
function filesUnder(folder: string, prefix = ''): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(join(folder, entry.name), path) : [path];
  });
}

/** vault 的位置照 `tome assemble`（ADR-0122）。TOME 寫的檔就是 `render_file` 記得的檔，判斷改過的方法也一樣。 */
function vaultList(home: string, slug: string, store: Store): VaultList {
  const folder = join(readWorkspaceConfig(home)?.vault_path ?? join(home, 'vault'), slug);
  const present = new Set(existsSync(folder) && statSync(folder).isDirectory() ? filesUnder(folder) : []);
  const rendered = store.all<{ path: string; sha256: string }>('SELECT path, sha256 FROM render_file ORDER BY path');
  const recorded = new Map(rendered.map(({ path, sha256: hash }) => [path, hash]));
  // `tome assemble` 寫的是 UTF-8，雜湊文字跟雜湊位元組一樣。
  const files = rendered.filter(({ path }) => present.has(path)).map(({ path }) => ({ path, sha256: sha256(readFileSync(join(folder, path))) }));
  return {
    folder,
    files,
    edited: files.filter(({ path, sha256: now }) => recorded.get(path) !== now).length,
    kept: present.size - files.length,
  };
}

/** 系列的 ID 目前就是書的 slug，每本書自成一個系列。還沒有系列資料庫（沒翻過）時不建立。 */
function seriesCounts(home: string, slug: string): Pick<PurgeList, 'series' | 'memory' | 'human'> {
  const folder = join(home, 'series', slug);
  if (!existsSync(join(folder, 'series.db'))) return { series: null, memory: 0, human: 0 };
  const series = openSeriesStore(home, slug);
  try {
    return {
      series: folder,
      memory: count(series, 'SELECT COUNT(*) AS count FROM memory WHERE book = ?', slug),
      human: count(series, 'SELECT COUNT(*) AS count FROM human WHERE book = ?', slug),
    };
  } finally {
    series.close();
  }
}

function listOf(home: string, slug: string, store: Store, vault: boolean): PurgeList {
  return {
    path: bookDir(home, slug),
    ...seriesCounts(home, slug),
    units: count(store, 'SELECT COUNT(*) AS count FROM unit'),
    translated: count(store, "SELECT COUNT(*) AS count FROM unit WHERE state = 'DONE'"),
    cards: count(store, 'SELECT COUNT(*) AS count FROM entity'),
    remote: remoteResidue(store),
    vault: vault ? vaultList(home, slug, store) : null,
  };
}

function fingerprintOf(list: PurgeList): string {
  return sha256(JSON.stringify(list));
}

/** 只有數量與工作區的路徑，不放書本文字（ADR-0059）。 */
function listData(slug: string, list: PurgeList, deleted: boolean): Readonly<Record<string, unknown>> {
  const { path, series, units, translated, cards, memory, human, remote, vault } = list;
  return {
    book: slug,
    deleted,
    path,
    series,
    units,
    translated,
    cards,
    memory,
    human,
    remote_batches: remote.length,
    vault: vault === null ? null : { folder: vault.folder, files: vault.files.length, edited: vault.edited, kept: vault.kept },
  };
}

function listFindings(slug: string, list: PurgeList): Finding[] {
  const { path, units, translated, cards, memory, human, remote, vault } = list;
  const counts = {
    units: String(units),
    translated: String(translated),
    cards: String(cards),
    memory: String(memory),
    human: String(human),
    batches: String(remote.length),
  };
  return [
    finding('purge.list', 'info', { book: slug, path, ...counts }),
    ...(vault === null
      ? []
      : [finding('purge.vault', 'info', { folder: vault.folder, files: String(vault.files.length), edited: String(vault.edited), kept: String(vault.kept) })]),
  ];
}

/** 遠端殘留用批次模式原本的刪除（ADR-0107 第 15 項）。刪掉的記下 `deleted_at`，下次只刪剩下的。 */
async function removeRemote(options: PurgeOptions, book: Book, store: Store): Promise<{ readonly notes: readonly Finding[]; readonly left: number }> {
  const host = await options.host();
  if ('level' in host) return { notes: [host], left: remoteResidue(store).length };
  const run: BatchHost = {
    store,
    llm: connect(options.home, book, store, host),
    sleep: host.sleep ?? sleepSeconds,
    onRetry: options.onRetry,
    notes: [],
  };
  await retryDeletes(run);
  return { notes: run.notes, left: remoteResidue(store).length };
}

function removeIfEmpty(folder: string): void {
  if (existsSync(folder) && readdirSync(folder).length === 0) rmdirSync(folder);
}

/** 只刪 TOME 寫的檔，再由下往上刪因此變空的資料夾，書的資料夾空了也刪（ADR-0128）。 */
function deleteVault({ folder, files }: VaultList): void {
  const parents = new Set<string>();
  for (const { path } of files) {
    rmSync(join(folder, path), { force: true });
    for (let parent = posix.dirname(path); parent !== '.'; parent = posix.dirname(parent)) parents.add(parent);
  }
  // 子資料夾的路徑一定比上層長，照長度由長到短就是由下往上。
  for (const parent of [...parents].sort((a, b) => b.length - a.length)) removeIfEmpty(join(folder, parent));
  if (files.length > 0) removeIfEmpty(folder);
}

/** 刪系列記憶裡這本書的列；沒有別的書的項目，就刪整個系列資料夾。資料庫先關掉，Windows 才刪得掉。 */
function deleteSeries(home: string, slug: string, folder: string): void {
  const series = openSeriesStore(home, slug);
  let left: number;
  try {
    series.transaction(() => {
      series.run('DELETE FROM memory WHERE book = ?', slug);
      series.run('DELETE FROM human WHERE book = ?', slug);
    });
    left = count(series, 'SELECT (SELECT COUNT(*) FROM memory) + (SELECT COUNT(*) FROM human) AS count');
  } finally {
    series.close();
  }
  if (left === 0) rmSync(folder, { recursive: true });
}

async function purgeLocked(options: PurgeOptions): Promise<PlanOutcome> {
  const { home, slug } = options;
  const flags = options.vault ? ' --vault' : '';
  const book = readBook(home, slug);
  const store = openBookStore(home, slug);
  let list: PurgeList;
  let notes: readonly Finding[] = [];
  try {
    // 本機的紀錄一刪，就不知道遠端還有哪些批次要清：還在跑或只記了意圖的批次要先收回（ADR-0128）。
    const pending = count(store, `SELECT COUNT(*) AS count FROM batch WHERE ${OUTSTANDING}`);
    if (pending > 0) {
      return { data: { book: slug, deleted: false }, findings: [finding('purge.batches_pending', 'fail', { book: slug, count: String(pending) })] };
    }
    list = listOf(home, slug, store, options.vault);
    const fingerprint = fingerprintOf(list);
    // 沒加 `--confirm`、沒列過或清單變了：列出這次的清單、記下指紋，不刪。
    if (!options.confirm || stageFingerprint(store, LIST_STAGE) !== fingerprint) {
      recordStage(store, LIST_STAGE, fingerprint);
      const last = options.confirm
        ? finding('purge.changed', 'fail', { book: slug, flags })
        : finding('purge.not_confirmed', 'info', { book: slug, flags });
      return { data: listData(slug, list, false), findings: [...listFindings(slug, list), last] };
    }
    if (list.remote.length > 0) {
      const removed = await removeRemote(options, book, store);
      notes = removed.notes;
      if (removed.left > 0) {
        const failed = finding('purge.remote_failed', 'fail', { book: slug, count: String(removed.left), flags });
        return { data: listData(slug, list, false), findings: [...notes, failed] };
      }
    }
  } finally {
    store.close();
  }
  // 遠端都清掉了才刪本機：vault 的檔、系列記憶、書的資料夾。
  if (list.vault !== null) deleteVault(list.vault);
  if (list.series !== null) deleteSeries(home, slug, list.series);
  rmSync(list.path, { recursive: true });
  const { memory, human, remote, vault } = list;
  return {
    data: listData(slug, list, true),
    findings: [
      ...notes,
      finding('purge.done', 'info', { book: slug, path: list.path, memory: String(memory), human: String(human), batches: String(remote.length) }),
      ...(vault === null
        ? []
        : [finding('purge.vault_done', 'info', { folder: vault.folder, files: String(vault.files.length), kept: String(vault.kept) })]),
    ],
  };
}

/** `tome purge`。拿著書的鎖，別的指令不會插進來（ADR-0054）；鎖檔跟著書的資料夾一起刪掉。 */
export function purgeBook(options: PurgeOptions): Promise<PlanOutcome> {
  return withBookLock(options.home, options.slug, () => purgeLocked(options));
}
