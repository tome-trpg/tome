import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { engineForPage, installedEngines, type InstalledEngine } from './engine.ts';
import { TomeError } from './errors.ts';
import { finding, type Finding } from './findings.ts';
import { loadSourceLanguage } from './language.ts';
import { findPack } from './pack.ts';
import { openPdf } from './pdf.ts';
import { probePdf, PROBE_VERSION, summarizeProbe, type Probe, type ProbeSummary } from './probe.ts';
import { validateBook, validateProbe } from './schema.ts';
import { assertSafeId, isReservedName, openBookStore, type Store } from './store.ts';
import { readWorkspaceConfig } from './workspace.ts';

// 一本書在工作區的樣子（白皮書 §6.3）。來源 PDF 不複製，只記路徑與雜湊（ADR-0053）。

export const BOOK_SCHEMA = 'tome-book/1';
const BOOK_FILE = 'book.yaml';
const LOCK_FILE = 'book.lock';
const PROBE_FILE = join('ir', 'probe.json');
const PROBE_STAGE = 'probe';
const DEFAULT_SOURCE_LANG = 'en';
const MAX_SLUG_LENGTH = 64;

export interface BookConfig {
  readonly schema: typeof BOOK_SCHEMA;
  readonly pdf: { readonly path: string; readonly sha256: string };
  readonly source_lang: string;
  readonly system?: string;
}

export interface Book {
  readonly slug: string;
  readonly config: BookConfig;
}

export function bookDir(home: string, slug: string): string {
  return join(home, 'books', slug);
}

/** 預設取檔名，清掉不合法的字元（ADR-0084）。結果一定過得了 `assertSafeId`。 */
export function slugFromPath(path: string): string {
  const stem = basename(path, extname(path)).normalize('NFC');
  const cleaned = stem
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+/, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/[-_]+$/, '');
  if (cleaned === '') return 'book';
  return isReservedName(cleaned) ? `book-${cleaned}` : cleaned;
}

export function hashFile(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', () => fail(new TomeError('pdf.not_found', { path })))
      .on('end', () => done(hash.digest('hex')));
  });
}

export function readBook(home: string, slug: string): Book {
  assertSafeId(slug);
  const path = join(bookDir(home, slug), BOOK_FILE);
  if (!existsSync(path)) throw new TomeError('book.not_found', { name: slug });
  let value: unknown;
  try {
    value = parse(readFileSync(path, 'utf8'));
  } catch {
    throw new TomeError('config.invalid_yaml', { path });
  }
  const checked = validateBook(value);
  if (!checked.ok) throw new TomeError('config.bad_schema', { path, expected: BOOK_SCHEMA });
  return { slug, config: checked.value };
}

export interface BookScan {
  readonly books: readonly Book[];
  /** 讀不出來的資料夾。一本壞掉不該擋住其他書，由呼叫端回報。 */
  readonly unreadable: readonly string[];
}

export function scanBooks(home: string): BookScan {
  const root = join(home, 'books');
  if (!existsSync(root)) return { books: [], unreadable: [] };
  const books: Book[] = [];
  const unreadable: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(join(root, entry.name, BOOK_FILE))) continue;
    try {
      books.push(readBook(home, entry.name));
    } catch (error) {
      if (!(error instanceof TomeError)) throw error;
      unreadable.push(entry.name);
    }
  }
  return { books, unreadable };
}

function writeBook(home: string, slug: string, config: BookConfig, flag: 'w' | 'wx'): void {
  const path = join(bookDir(home, slug), BOOK_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(config), { flag });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function claimLock(path: string, retry = true): void {
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = Number(readFileSync(path, 'utf8'));
    if (!retry || (Number.isInteger(owner) && owner > 0 && isRunning(owner))) {
      throw new TomeError('book.busy', { path });
    }
    // 上一個流程沒收尾就結束了，鎖是留下來的。
    rmSync(path, { force: true });
    claimLock(path, false);
  }
}

/** 一本書同時只跑一個流程（ADR-0054）。 */
export async function withBookLock<T>(home: string, slug: string, work: () => Promise<T>): Promise<T> {
  readBook(home, slug);
  const path = join(bookDir(home, slug), LOCK_FILE);
  claimLock(path);
  try {
    return await work();
  } finally {
    rmSync(path, { force: true });
  }
}

function fingerprintOf(
  sha256: string,
  languageHash: string,
  engines: readonly InstalledEngine[],
): string {
  const routes = engines.map(({ spec }) => [spec.name, spec.pages]);
  return createHash('sha256')
    .update(`${PROBE_VERSION}\n${sha256}\n${languageHash}\n${JSON.stringify(routes)}`)
    .digest('hex');
}

export function recordStage(store: Store, name: string, fingerprint: string): void {
  store.run(
    `INSERT INTO stage (name, fingerprint, status, updated_at) VALUES (?, ?, 'done', ?)
     ON CONFLICT (name) DO UPDATE SET
       fingerprint = excluded.fingerprint, status = 'done', updated_at = excluded.updated_at`,
    name,
    fingerprint,
    new Date().toISOString(),
  );
}

function stageFingerprint(store: Store, name: string): string | null {
  const row = store.get<{ fingerprint: string }>(
    'SELECT fingerprint FROM stage WHERE name = ?',
    name,
  );
  return row?.fingerprint ?? null;
}

export function readProbe(home: string, slug: string): Probe | null {
  const path = join(bookDir(home, slug), PROBE_FILE);
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new TomeError('file.corrupt', { path });
  }
  const checked = validateProbe(value);
  if (!checked.ok) throw new TomeError('config.bad_schema', { path, expected: 'tome-probe/1' });
  return checked.value;
}

function writeProbe(home: string, slug: string, probe: Probe): void {
  const path = join(bookDir(home, slug), PROBE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(probe));
}

export interface ProbeOutcome {
  readonly probe: Probe;
  readonly summary: ProbeSummary;
  readonly reused: boolean;
}

async function verifiedPdf(book: Book): Promise<void> {
  const { path, sha256 } = book.config.pdf;
  if (!existsSync(path)) throw new TomeError('book.pdf_missing', { path });
  if ((await hashFile(path)) !== sha256) throw new TomeError('book.pdf_changed', { path });
}

/** 輸入的內容指紋沒變就沿用（ADR-0056）。PDF 被換掉時不靜默重算。 */
export async function probeBook(home: string, slug: string): Promise<ProbeOutcome> {
  const book = readBook(home, slug);
  await verifiedPdf(book);
  const { path, sha256 } = book.config.pdf;
  const language = loadSourceLanguage(book.config.source_lang);
  const engines = installedEngines(home);
  const fingerprint = fingerprintOf(sha256, language.hash, engines);
  const store = openBookStore(home, slug);
  try {
    const previous = stageFingerprint(store, PROBE_STAGE) === fingerprint ? readProbe(home, slug) : null;
    if (previous !== null) {
      return { probe: previous, summary: summarizeProbe(previous), reused: true };
    }
    const opened = await openPdf(path);
    // 雜湊對得上卻變成加密，只有 book.yaml 被手改才會發生。
    if (opened.status === 'encrypted') throw new TomeError('book.pdf_changed', { path });
    try {
      const probe = await probePdf(opened.pdf, sha256, language.profile.text_quality, (kind) =>
        engineForPage(kind, engines),
      );
      writeProbe(home, slug, probe);
      recordStage(store, PROBE_STAGE, fingerprint);
      return { probe, summary: summarizeProbe(probe), reused: false };
    } finally {
      await opened.pdf.close();
    }
  } finally {
    store.close();
  }
}

export interface AddOptions {
  readonly home: string;
  readonly pdf: string;
  readonly name?: string | undefined;
  readonly system?: string | undefined;
  readonly sourceLang?: string | undefined;
}

export interface AddResult {
  readonly findings: readonly Finding[];
  readonly book?: string;
  readonly probe?: ProbeOutcome;
}

function sameConfig(a: BookConfig, b: BookConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function existingBook(
  options: AddOptions,
  book: Book,
  path: string,
  warnings: readonly Finding[],
): AddResult {
  const next: BookConfig = {
    ...book.config,
    pdf: { ...book.config.pdf, path },
    source_lang: options.sourceLang ?? book.config.source_lang,
    ...(options.system === undefined ? {} : { system: options.system }),
  };
  if (sameConfig(book.config, next)) {
    return {
      book: book.slug,
      findings: [...warnings, finding('book.already_added', 'info', { name: book.slug })],
    };
  }
  writeBook(options.home, book.slug, next, 'w');
  return {
    book: book.slug,
    findings: [...warnings, finding('book.updated', 'info', { name: book.slug })],
  };
}

/** 登記一本書並探測。加密的 PDF 一律拒絕，也不留下書的目錄（PC-3）。 */
export async function addBook(options: AddOptions): Promise<AddResult> {
  const { home } = options;
  if (readWorkspaceConfig(home) === null) {
    return { findings: [finding('workspace.missing', 'fail', { path: home })] };
  }
  if (options.sourceLang !== undefined) loadSourceLanguage(options.sourceLang);
  if (options.system !== undefined && findPack(home, options.system) === null) {
    throw new TomeError('pack.not_found', { id: options.system });
  }
  const path = resolve(options.pdf);
  if (!existsSync(path) || !statSync(path).isFile()) throw new TomeError('pdf.not_found', { path });
  const opened = await openPdf(path);
  if (opened.status === 'encrypted') {
    return { findings: [finding('pdf.encrypted', 'fail', { path })] };
  }
  await opened.pdf.close();

  const sha256 = await hashFile(path);
  const { books, unreadable } = scanBooks(home);
  const warnings = unreadable.map((name) => finding('book.unreadable', 'warn', { name }));
  const existing = books.find((book) => book.config.pdf.sha256 === sha256);
  if (existing !== undefined) return existingBook(options, existing, path, warnings);

  const slug = options.name ?? slugFromPath(path);
  assertSafeId(slug);
  if (existsSync(bookDir(home, slug))) {
    return { findings: [...warnings, finding('book.name_taken', 'fail', { name: slug })] };
  }
  const config: BookConfig = {
    schema: BOOK_SCHEMA,
    pdf: { path, sha256 },
    source_lang: options.sourceLang ?? DEFAULT_SOURCE_LANG,
    ...(options.system === undefined ? {} : { system: options.system }),
  };
  writeBook(home, slug, config, 'wx');
  const probe = await probeBook(home, slug);
  return {
    book: slug,
    probe,
    findings: [...warnings, finding('book.added', 'info', { name: slug, path: bookDir(home, slug) })],
  };
}
