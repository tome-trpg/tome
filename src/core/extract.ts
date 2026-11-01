import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bookDir,
  probeBook,
  readBook,
  recordStage,
  withBookLock,
  type Book,
} from './book.ts';
import {
  ENGINE_SCHEMA,
  engineCommand,
  engineDataDir,
  installedEngines,
  type Device,
  type EngineManifest,
  type InstalledEngine,
} from './engine.ts';
import { TomeError } from './errors.ts';
import { finding, type Finding } from './findings.ts';
import { detectGpu, type Probe } from './probe.ts';
import { runStream, runTool, type StreamOutcome, type StreamRunner, type ToolRunner } from './process.ts';
import { validateEngineEvent, validateEngineRun, validateIr } from './schema.ts';
import { openBookStore } from './store.ts';

// tome extract 的第一段：把頁面交給引擎，存成 source 層（白皮書 §5.1）。
// 組裝與字元守恆接在後面，所以現在只走到這裡（ADR-0085）。

const SOURCE_STAGE = 'source';
/** 完整的雜湊會讓路徑在 Windows 超過 260 個字元。 */
const PATH_HASH_LENGTH = 16;
/** 這麼久沒有事件就終止引擎。是提案，還沒有在真實書籍上量過。 */
const ENGINE_IDLE_MS = 10 * 60_000;
const LISTED_PAGES = 20;

export function sourceDir(
  home: string,
  slug: string,
  pdfSha256: string,
  engine: string,
  version: string,
  configHash: string,
): string {
  return join(
    bookDir(home, slug),
    'ir',
    'source',
    pdfSha256.slice(0, PATH_HASH_LENGTH),
    engine,
    version,
    configHash.slice(0, PATH_HASH_LENGTH),
  );
}

export function sourcePageFile(page: number): string {
  return `p${String(page).padStart(4, '0')}.json`;
}

/** 設定雜湊的輸入：引擎的內容，加上會改變輸出的選項。 */
export function configHashOf(treeHash: string, device: Device, sourceLang: string): string {
  return createHash('sha256').update(JSON.stringify([treeHash, device, sourceLang])).digest('hex');
}

function isGoodPage(path: string, pdfSha256: string, page: number, configHash: string): boolean {
  if (!existsSync(path)) return false;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
  const checked = validateIr(value);
  if (!checked.ok || checked.value.layer !== 'source') return false;
  const { pdf_sha256: sha, page: index, blocks } = checked.value;
  return (
    sha === pdfSha256 &&
    index === page &&
    blocks.every((block) => block.provenance.config_hash === configHash)
  );
}

interface EngineResult {
  readonly name: string;
  readonly version: string;
  readonly device: Device;
  readonly config_hash: string;
  readonly ran: number;
  readonly reused: number;
  readonly failed: readonly { readonly page: number; readonly reason: string }[];
  readonly recorded: boolean;
}

function parseEvent(line: string): ReturnType<typeof validateEngineEvent> | null {
  try {
    return validateEngineEvent(JSON.parse(line));
  } catch {
    return null;
  }
}

function hasRunRecord(dir: string, configHash: string): boolean {
  const path = join(dir, 'engine.json');
  if (!existsSync(path)) return false;
  try {
    const checked = validateEngineRun(JSON.parse(readFileSync(path, 'utf8')));
    return checked.ok && checked.value.config_hash === configHash;
  } catch {
    return false;
  }
}

function reasonFor(
  outcome: StreamOutcome,
  reported: string | undefined,
  wrote: boolean,
): string {
  if (wrote) return 'invalid_output';
  if (reported !== undefined) return reported;
  if (outcome.status === 'timeout') return 'timeout';
  if (outcome.status === 'not_found') return 'engine_not_found';
  return outcome.code === 0 ? 'no_output' : 'engine_crashed';
}

export interface ExtractOptions {
  readonly home: string;
  readonly slug: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly tool?: ToolRunner;
  readonly stream?: StreamRunner;
  readonly onPage?: (done: number, total: number) => void;
}

async function chooseDevice(engine: InstalledEngine, options: ExtractOptions): Promise<Device> {
  if (engine.install.device !== 'gpu') return 'cpu';
  const { env, tool = runTool } = options;
  const gpu = await detectGpu(env, tool);
  const needed = engine.spec.gpu?.min_vram_mb ?? 0;
  return gpu !== null && gpu.vram_free_mb >= needed ? 'gpu' : 'cpu';
}

async function runEngine(
  engine: InstalledEngine,
  pages: readonly number[],
  book: Book,
  options: ExtractOptions,
): Promise<EngineResult> {
  const { home, slug, env, platform, stream = runStream, onPage } = options;
  const { spec, install } = engine;
  const { path: pdf, sha256 } = book.config.pdf;
  const device = await chooseDevice(engine, options);
  const configHash = configHashOf(install.tree_hash, device, book.config.source_lang);
  const dir = sourceDir(home, slug, sha256, spec.name, install.version, configHash);
  mkdirSync(dir, { recursive: true });

  // 相同的鍵不重跑。source 層不可變，所以中斷之後從還沒做的頁接著做（白皮書 §5.2）。
  const pathOf = (page: number): string => join(dir, sourcePageFile(page));
  const pending = pages.filter((page) => !isGoodPage(pathOf(page), sha256, page, configHash));
  const summary = {
    name: spec.name,
    version: install.version,
    device,
    config_hash: configHash,
    ran: pending.length,
    reused: pages.length - pending.length,
  };
  if (pending.length === 0) return { ...summary, failed: [], recorded: true };

  const manifest: EngineManifest = {
    schema: ENGINE_SCHEMA,
    pdf,
    pdf_sha256: sha256,
    pages: pending,
    output_dir: dir,
    data_dir: engineDataDir(home, spec.name),
    source_lang: book.config.source_lang,
    config_hash: configHash,
    options: { device },
  };
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const reported = new Map<number, string>();
  let done = 0;
  const { command, args, cwd } = engineCommand(home, spec, platform);
  const outcome = await stream(command, [...args, '--manifest', manifestPath], env, {
    cwd,
    extraEnv: spec.env ?? {},
    idleTimeoutMs: ENGINE_IDLE_MS,
    onLine: (line) => {
      const event = parseEvent(line);
      if (event?.ok !== true || event.value.event !== 'page') return;
      if (event.value.status === 'failed') {
        reported.set(event.value.page, event.value.reason ?? 'engine_failed');
      }
      done += 1;
      onPage?.(done, pending.length);
    },
  });

  // 事件只是進度，算數的是檔案。
  const failed = pending.flatMap((page) => {
    const path = pathOf(page);
    if (isGoodPage(path, sha256, page, configHash)) return [];
    const wrote = existsSync(path);
    rmSync(path, { force: true });
    return [{ page, reason: reasonFor(outcome, reported.get(page), wrote) }];
  });
  const exited = outcome.status === 'exited' && outcome.code === 0;
  return { ...summary, failed, recorded: !exited || hasRunRecord(dir, configHash) };
}

function failedParams(failed: EngineResult['failed']): Readonly<Record<string, string>> {
  const shown = failed.slice(0, LISTED_PAGES).map(({ page, reason }) => `${page}:${reason}`);
  return {
    count: String(failed.length),
    pages: `${shown.join(', ')}${failed.length > LISTED_PAGES ? ', …' : ''}`,
  };
}

function pagesByEngine(probe: Probe): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const { page, engine } of probe.pages) {
    if (engine === undefined) continue;
    groups.set(engine, [...(groups.get(engine) ?? []), page]);
  }
  return groups;
}

export interface ExtractResult {
  readonly findings: readonly Finding[];
  readonly data: Readonly<Record<string, unknown>>;
}

/** 一本書同時只跑一個流程（ADR-0054）。 */
export function extractBook(options: ExtractOptions): Promise<ExtractResult> {
  return withBookLock(options.home, options.slug, () => extractLocked(options));
}

async function extractLocked(options: ExtractOptions): Promise<ExtractResult> {
  const { home, slug } = options;
  const book = readBook(home, slug);
  const { probe, summary } = await probeBook(home, slug);
  const skipped = summary.pages - summary.kinds.native;
  const warnings = skipped > 0 ? [finding('probe.pages_skipped', 'warn', { count: String(skipped) })] : [];
  const groups = pagesByEngine(probe);
  if (groups.size === 0) {
    const none = summary.kinds.native === 0 ? [] : [finding('extract.no_engine', 'fail')];
    return { data: { pages: 0, engines: [] }, findings: [...warnings, ...none] };
  }

  const engines = installedEngines(home);
  const results: EngineResult[] = [];
  for (const [name, pages] of groups) {
    const engine = engines.find(({ spec }) => spec.name === name);
    if (engine === undefined) throw new TomeError('engine.not_found', { name });
    results.push(await runEngine(engine, pages, book, options));
  }

  const failed = results.flatMap((item) => item.failed);
  const pages = [...groups.values()].flat().length;
  const unrecorded = results.filter((item) => !item.recorded);
  if (failed.length === 0 && unrecorded.length === 0) {
    const store = openBookStore(home, slug);
    try {
      const keys = results.map((item) => [item.name, item.version, item.config_hash]);
      const fingerprint = createHash('sha256').update(JSON.stringify([probe.pdf_sha256, keys])).digest('hex');
      recordStage(store, SOURCE_STAGE, fingerprint);
    } finally {
      store.close();
    }
  }
  const sum = (key: 'ran' | 'reused'): number => results.reduce((total, item) => total + item[key], 0);
  return {
    data: {
      pages,
      ran: sum('ran'),
      reused: sum('reused'),
      failed: failed.length,
      engines: results.map(({ name, version, device, config_hash }) => ({ name, version, device, config_hash })),
    },
    findings: [
      finding('extract.done', 'info', {
        pages: String(pages - failed.length),
        ran: String(sum('ran') - failed.length),
        reused: String(sum('reused')),
      }),
      ...(failed.length > 0 ? [finding('extract.pages_failed', 'fail', failedParams(failed))] : []),
      ...unrecorded.map(({ name }) => finding('extract.no_run_record', 'fail', { name })),
      ...warnings,
      finding('extract.source_only', 'info'),
    ],
  };
}
