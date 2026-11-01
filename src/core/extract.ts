import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASSEMBLY_VERSION,
  assembleBlocks,
  withSections,
  type AssemblyPage,
  type PageLayout,
} from './assemble.ts';
import {
  bookDir,
  probeBook,
  readBook,
  recordStage,
  stageFingerprint,
  systemOf,
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
import type { DocumentBlock, IrDocument, SourcePage } from './ir.ts';
import { loadSourceLanguage } from './language.ts';
import { applyOverrides, readOverrides } from './overrides.ts';
import { detectRole, findPack, patternInputs, resolvePack, type ResolvedPack } from './pack.ts';
import { runPatterns } from './patterns.ts';
import { openPdf } from './pdf.ts';
import { detectGpu, type Probe } from './probe.ts';
import { runStream, runTool, type StreamOutcome, type StreamRunner, type ToolRunner } from './process.ts';
import { validateEngineEvent, validateEngineRun, validateIr } from './schema.ts';
import { openBookStore } from './store.ts';

// tome extract：把頁面交給引擎存成 source 層，再組裝成 document 層（白皮書 §5.1）。

const SOURCE_STAGE = 'source';
const DOCUMENT_STAGE = 'document';
const DOCUMENT_FILE = join('ir', 'document.json');
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
  /** 這個引擎的頁面檔放在哪裡。 */
  readonly dir: string;
  readonly pages: readonly number[];
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
    dir,
    pages,
    ran: pending.length,
    reused: pages.length - pending.length,
  };
  // 全部沿用時引擎不會跑，但授權紀錄還是要在（LC-3）。
  if (pending.length === 0) return { ...summary, failed: [], recorded: hasRunRecord(dir, configHash) };

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

/** 內部的頁索引從 0 起算，給人看的是 PDF 閱讀器顯示的頁次（ADR-0091）。 */
function shownPage(page: number): number {
  return page + 1;
}

function failedParams(failed: EngineResult['failed']): Readonly<Record<string, string>> {
  const shown = failed.slice(0, LISTED_PAGES).map(({ page, reason }) => `${shownPage(page)}:${reason}`);
  return {
    count: String(failed.length),
    pages: `${shown.join(', ')}${failed.length > LISTED_PAGES ? ', …' : ''}`,
  };
}

function readSourcePage(path: string): SourcePage | null {
  const checked = validateIr(JSON.parse(readFileSync(path, 'utf8')));
  return checked.ok && checked.value.layer === 'source' ? checked.value : null;
}

async function readLayouts(path: string, pages: readonly number[]): Promise<Map<number, PageLayout>> {
  const opened = await openPdf(path);
  if (opened.status !== 'ok') throw new TomeError('pdf.unreadable', { path });
  const layouts = new Map<number, PageLayout>();
  try {
    for (const page of pages) {
      const { width, height, runs, boxes, invisibleGlyphs } = await opened.pdf.page(page);
      layouts.set(page, { width, height, runs, boxes, invisibleGlyphs });
    }
  } finally {
    await opened.pdf.close();
  }
  return layouts;
}

interface BookPack {
  readonly pack: ResolvedPack | null;
  readonly hash: string;
  readonly findings: readonly Finding[];
}

function bookPack(home: string, book: Book): BookPack {
  const id = systemOf(book);
  const location = findPack(home, id);
  if (location === null) throw new TomeError('pack.not_found', { id });
  const { pack, findings } = resolvePack(home, location);
  const content = pack === null ? [] : [pack.id, pack.roles, pack.patterns];
  return { pack, hash: createHash('sha256').update(JSON.stringify(content)).digest('hex'), findings };
}

/** 規則包宣告的角色。判到就蓋過核心角色，頁首頁尾與表格不判定（ADR-0092）。 */
async function assignPackRoles(
  pack: ResolvedPack,
  blocks: readonly DocumentBlock[],
): Promise<{ readonly blocks: readonly DocumentBlock[]; readonly findings: readonly Finding[] }> {
  const candidates = blocks.filter(
    ({ role, table, text }) => role !== 'furniture' && table === undefined && text !== '',
  );
  const outcome = await runPatterns(patternInputs(pack, 'detect'), candidates.map(({ text }) => text));
  if (outcome.status !== 'ok') {
    return { blocks, findings: [finding('pack.slow_regex', 'fail', { pattern: outcome.pattern })] };
  }
  const roles = new Map<string, string>();
  candidates.forEach(({ id }, index) => {
    const role = detectRole(pack, (pattern) => outcome.matches[pattern]?.[index] ?? []);
    if (role !== null) roles.set(id, role);
  });
  return {
    blocks: blocks.map((block) => {
      const role = roles.get(block.id) as DocumentBlock['role'] | undefined;
      return role === undefined ? block : { ...block, role };
    }),
    findings: [],
  };
}

function assemblyPages(
  probe: Probe,
  results: readonly EngineResult[],
  layouts: ReadonlyMap<number, PageLayout>,
): AssemblyPage[] {
  const dirs = new Map(results.flatMap(({ dir, pages }) => pages.map((page) => [page, dir] as const)));
  const failures = new Map(results.flatMap(({ failed }) => failed.map((item) => [item.page, item.reason] as const)));
  return probe.pages.map(({ page, kind }) => {
    const dir = dirs.get(page);
    const failure = failures.get(page);
    const source =
      dir === undefined || failure !== undefined ? null : readSourcePage(join(dir, sourcePageFile(page)));
    return {
      page,
      kind,
      source,
      layout: layouts.get(page) ?? null,
      ...(failure === undefined ? {} : { failure }),
    };
  });
}

function writeDocument(path: string, document: IrDocument): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(document));
  renameSync(temporary, path);
}

function missingParams(document: IrDocument): Readonly<Record<string, string>> | null {
  const lost = document.pages.filter(({ reason }) => reason === 'characters_missing');
  if (lost.length === 0) return null;
  const shown = lost
    .slice(0, LISTED_PAGES)
    .map(({ page, missing = 0, total = 0 }) => `${shownPage(page)}:${missing}/${total}`);
  return {
    count: String(lost.length),
    pages: `${shown.join(', ')}${lost.length > LISTED_PAGES ? ', …' : ''}`,
  };
}

function documentData(document: IrDocument, reused: boolean): Readonly<Record<string, unknown>> {
  const count = (status: string): number => document.pages.filter((page) => page.status === status).length;
  return {
    reused,
    blocks: document.blocks.length,
    sections: document.sections.length,
    pages: { ok: count('ok'), skipped: count('skipped'), failed: count('failed') },
  };
}

/** document 層隨時可以重建，檔案壞了就當作沒有。 */
function reusableDocument(path: string, fingerprint: string, previous: string | null): IrDocument | null {
  if (previous !== fingerprint || !existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const checked = validateIr(value);
  return checked.ok && checked.value.layer === 'document' ? checked.value : null;
}

interface DocumentResult {
  readonly data: Readonly<Record<string, unknown>>;
  readonly findings: readonly Finding[];
}

/** 組裝 document 層。可隨時由 source 與 overrides 重建，輸入沒變就不重算（白皮書 §5.2）。 */
async function buildDocument(
  home: string,
  slug: string,
  book: Book,
  probe: Probe,
  results: readonly EngineResult[],
): Promise<DocumentResult> {
  const language = loadSourceLanguage(book.config.source_lang);
  const overrides = readOverrides(home, slug);
  const { pack, hash: packHash, findings: packFindings } = bookPack(home, book);
  const keys = results.map((item) => [item.name, item.version, item.config_hash, item.failed]);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([ASSEMBLY_VERSION, probe.pdf_sha256, keys, overrides.hash, language.hash, packHash]))
    .digest('hex');
  const path = join(bookDir(home, slug), DOCUMENT_FILE);
  const store = openBookStore(home, slug);
  try {
    const previous = reusableDocument(path, fingerprint, stageFingerprint(store, DOCUMENT_STAGE));
    if (previous !== null) {
      const { blocks, sections } = previous;
      const params = { blocks: String(blocks.length), sections: String(sections.length) };
      return { data: documentData(previous, true), findings: [finding('extract.document_reused', 'info', params)] };
    }

    const native = probe.pages.filter(({ kind }) => kind === 'native').map(({ page }) => page);
    const layouts = await readLayouts(book.config.pdf.path, native);
    const pages = assemblyPages(probe, results, layouts);
    const assembled = assembleBlocks({ language: language.profile, pages });
    const roles =
      pack === null ? { blocks: assembled.blocks, findings: [] } : await assignPackRoles(pack, assembled.blocks);
    const corrected = applyOverrides(language.profile, roles.blocks, overrides.operations);
    const { blocks, sections } = withSections(corrected.blocks, probe.outline);
    const document: IrDocument = {
      schema: 'tome-ir/1',
      layer: 'document',
      pdf_sha256: probe.pdf_sha256,
      pages: assembled.pages,
      page_map: probe.page_labels,
      sections,
      blocks,
    };
    if (!validateIr(document).ok) throw new TomeError('config.bad_schema', { path, expected: 'tome-ir/1' });
    writeDocument(path, document);

    const lost = missingParams(document);
    const findings = [
      ...packFindings,
      ...roles.findings,
      ...corrected.findings,
      ...(lost === null ? [] : [finding('extract.characters_missing', 'fail', lost)]),
      finding('extract.assembled', 'info', {
        blocks: String(blocks.length),
        sections: String(sections.length),
        ok: String(assembled.pages.filter(({ status }) => status === 'ok').length),
      }),
    ];
    const clean = !findings.some(({ level }) => level === 'fail') && results.every(({ failed }) => failed.length === 0);
    if (clean) recordStage(store, DOCUMENT_STAGE, fingerprint);
    return { data: documentData(document, false), findings };
  } finally {
    store.close();
  }
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
  if (groups.size === 0 && summary.kinds.native > 0) {
    return {
      data: { pages: 0, engines: [] },
      findings: [...warnings, finding('extract.no_engine', 'fail')],
    };
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
  const document = await buildDocument(home, slug, book, probe, results);
  return {
    data: {
      pages,
      ran: sum('ran'),
      reused: sum('reused'),
      failed: failed.length,
      engines: results.map(({ name, version, device, config_hash }) => ({ name, version, device, config_hash })),
      document: document.data,
    },
    findings: [
      ...(results.length === 0
        ? []
        : [
            finding('extract.done', 'info', {
              pages: String(pages - failed.length),
              ran: String(sum('ran') - failed.length),
              reused: String(sum('reused')),
            }),
          ]),
      ...(failed.length > 0 ? [finding('extract.pages_failed', 'fail', failedParams(failed))] : []),
      ...unrecorded.map(({ name }) => finding('extract.no_run_record', 'fail', { name })),
      ...warnings,
      ...document.findings,
    ],
  };
}
