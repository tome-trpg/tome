import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { workspaceTemplate } from '../../src/cli/messages.ts';
import {
  addBook,
  bookDir,
  probeBook,
  readBook,
  stageFingerprint,
  withBookLock,
} from '../../src/core/book.ts';
import { addEngine, engineDir, type EngineManifest } from '../../src/core/engine.ts';
import { TomeError } from '../../src/core/errors.ts';
import {
  configHashOf,
  exitParam,
  extractBook,
  sourceDir,
  sourcePageFile,
  type ExtractResult,
} from '../../src/core/extract.ts';
import { exitCodeOf, type Finding } from '../../src/core/findings.ts';
import type { IrDocument } from '../../src/core/ir.ts';
import { keyEnvName } from '../../src/core/secrets.ts';
import type { StreamRunner, ToolRunner } from '../../src/core/process.ts';
import { validateIr, validateEngineManifest } from '../../src/core/schema.ts';
import { openBookStore } from '../../src/core/store.ts';
import { initWorkspace } from '../../src/core/workspace.ts';
import { forge, forgeFile, LAYOUT_TRUTH, type ForgeCase } from '../forge/index.ts';
import { tempDir } from '../helpers.ts';

const FAKE_ENGINE = resolve('tests/fixtures/engines/fake');
const RECORDED_LAYOUT = resolve('tests/fixtures/engine-outputs/docling/layout');
const SAMPLE_PACK = resolve('tests/fixtures/packs/sample-pack');
const NO_GPU: ToolRunner = async () => null;

function codes(findings: readonly Finding[]): string[] {
  return findings.map((item) => item.code);
}

async function library(forged: ForgeCase = 'plain', engine = true): Promise<string> {
  const home = join(tempDir(), 'home');
  initWorkspace({ home, env: {}, template: workspaceTemplate });
  if (engine) await addEngine({ home, target: FAKE_ENGINE, gpu: false, env: process.env, tool: NO_GPU });
  await addBook({ home, pdf: await forgeFile(forged, tempDir()), name: 'book' });
  writeFileSync(textFile(home), JSON.stringify((await forge(forged)).truth.text ?? []));
  return home;
}

function textFile(home: string): string {
  return join(home, 'forged-text.json');
}

function extract(home: string, scenario = 'ok', extraEnv: NodeJS.ProcessEnv = {}): Promise<ExtractResult> {
  return extractBook({
    home,
    slug: 'book',
    env: { ...process.env, FAKE_ENGINE_SCENARIO: scenario, FAKE_ENGINE_TEXT_FILE: textFile(home), ...extraEnv },
    tool: NO_GPU,
  });
}

function pagesDir(home: string): string {
  const { sha256 } = readBook(home, 'book').config.pdf;
  const install = JSON.parse(readFileSync(join(engineDir(home, 'fake'), 'install.json'), 'utf8')) as {
    version: string;
    tree_hash: string;
  };
  const config = configHashOf(install.tree_hash, 'cpu', 'en');
  return sourceDir(home, 'book', sha256, 'fake', install.version, config);
}

function seen<T>(home: string, file: string): T {
  return JSON.parse(readFileSync(join(pagesDir(home), file), 'utf8')) as T;
}

describe('assigning pages to engines', () => {
  it('records the engine of each page it can handle', async () => {
    const home = await library('scan');
    const { probe, summary } = await probeBook(home, 'book');
    expect(probe.pages.map((page) => page.engine)).toEqual([undefined, undefined, undefined, 'fake']);
    expect(summary.assigned).toBe(1);
  });

  it('assigns again when an engine is added, without the PDF changing', async () => {
    const home = await library('plain', false);
    expect((await probeBook(home, 'book')).summary.assigned).toBe(0);
    await addEngine({ home, target: FAKE_ENGINE, gpu: false, env: process.env, tool: NO_GPU });
    const { summary, reused } = await probeBook(home, 'book');
    expect(reused).toBe(false);
    expect(summary.assigned).toBe(3);
  });
});

describe('tome extract', () => {
  it('stores a source page for each page, in tome-ir/1', async () => {
    const home = await library();
    const { findings, data } = await extract(home);
    expect(exitCodeOf(findings)).toBe(0);
    expect(codes(findings)).toEqual(['extract.done', 'extract.assembled']);
    expect(findings[0]?.params).toEqual({ pages: '3', ran: '3', reused: '0' });
    expect(data).toMatchObject({ pages: 3, ran: 3, reused: 0, failed: 0 });
    for (const page of [0, 1, 2]) {
      const value: unknown = JSON.parse(readFileSync(join(pagesDir(home), sourcePageFile(page)), 'utf8'));
      expect(validateIr(value).ok).toBe(true);
    }
  });

  it('hands the engine a manifest that follows the protocol', async () => {
    const home = await library();
    await extract(home);
    const manifest = seen<EngineManifest>(home, 'manifest.json');
    expect(validateEngineManifest(manifest).ok).toBe(true);
    expect(manifest.pages).toEqual([0, 1, 2]);
    expect(manifest.options).toEqual({ device: 'cpu' });
    expect(manifest.data_dir).toBe(join(engineDir(home, 'fake'), 'data'));
  });

  it('keeps the path short enough for Windows', async () => {
    const home = await library();
    await extract(home);
    const relative = pagesDir(home).slice(bookDir(home, 'book').length);
    expect(relative.length).toBeLessThan(70);
  });

  it('records the stage once every page is in', async () => {
    const home = await library();
    await extract(home);
    const store = openBookStore(home, 'book');
    try {
      const row = store.get<{ status: string }>("SELECT status FROM stage WHERE name = 'source'");
      expect(row?.status).toBe('done');
    } finally {
      store.close();
    }
  });

  it('does not run an engine again for pages it already has', async () => {
    const home = await library();
    await extract(home);
    const { findings } = await extract(home, 'crash');
    expect(exitCodeOf(findings)).toBe(0);
    expect(findings[0]?.params).toEqual({ pages: '3', ran: '0', reused: '3' });
  });

  it('keeps going past a failed page, and only runs that page next time', async () => {
    const home = await library();
    const first = await extract(home, 'one_failed');
    expect(exitCodeOf(first.findings)).toBe(1);
    expect(first.findings.find((item) => item.code === 'extract.pages_failed')?.params).toEqual({
      count: '1',
      pages: '2:conversion_failed',
      exit: 'fake:0',
    });
    expect(existsSync(join(pagesDir(home), sourcePageFile(2)))).toBe(true);

    const second = await extract(home);
    expect(exitCodeOf(second.findings)).toBe(0);
    expect(seen<number[]>(home, 'seen-pages.json')).toEqual([1]);
    expect(second.findings[0]?.params).toEqual({ pages: '3', ran: '1', reused: '2' });
  });

  it('leaves the stage open while a page is missing', async () => {
    const home = await library();
    await extract(home, 'one_failed');
    const store = openBookStore(home, 'book');
    try {
      expect(store.get("SELECT status FROM stage WHERE name = 'source'")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('keeps the pages an engine finished before it crashed', async () => {
    const home = await library();
    const { findings } = await extract(home, 'crash');
    expect(exitCodeOf(findings)).toBe(1);
    expect(findings.find((item) => item.code === 'extract.pages_failed')?.params).toEqual({
      count: '2',
      pages: '2:engine_crashed, 3:engine_crashed',
      exit: 'fake:3',
    });
    expect(existsSync(join(pagesDir(home), sourcePageFile(0)))).toBe(true);
  });

  it('says how an engine that was killed ended (ADR-0101)', async () => {
    const home = await library();
    const { findings } = await extract(home, 'killed');
    const params = findings.find((item) => item.code === 'extract.pages_failed')?.params;
    expect(params?.['pages']).toBe('2:engine_crashed, 3:engine_crashed');
    // Windows 沒有訊號，行程被終止時 Node 回報的是結束碼 1。
    expect(params?.['exit']).toBe(process.platform === 'win32' ? 'fake:1' : 'fake:signal SIGKILL');
  });

  it.each([
    ['a native crash on Windows', { code: 3221225477, signal: null }, 'fake:3221225477 (0xC0000005)'],
    ['a signal', { code: null, signal: 'SIGSEGV' as const }, 'fake:signal SIGSEGV'],
    ['neither a code nor a signal', { code: null, signal: null }, 'fake:unknown'],
  ])('reports %s by how the engine ended (ADR-0101)', async (_name, ended, exit) => {
    const home = await library();
    const { findings } = await extractBook({
      home,
      slug: 'book',
      env: process.env,
      tool: NO_GPU,
      stream: async () => ({ status: 'exited', stderr: '', ...ended }),
    });
    expect(findings.find((item) => item.code === 'extract.pages_failed')?.params['exit']).toBe(exit);
  });

  it('lists only the engines that have failed pages', () => {
    const results = [
      { name: 'first', exit: '0', failed: [] },
      { name: 'second', exit: '3', failed: [{ page: 1, reason: 'engine_crashed' }] },
      { name: 'third', exit: 'timeout', failed: [{ page: 2, reason: 'timeout' }] },
    ];
    expect(exitParam(results)).toBe('second:3, third:timeout');
  });

  it('keeps stderr out of what it reports (ADR-0085)', async () => {
    const home = await library();
    const { findings } = await extractBook({
      home,
      slug: 'book',
      env: process.env,
      tool: NO_GPU,
      stream: async () => ({ status: 'exited', code: 1, signal: null, stderr: 'a line of the book' }),
    });
    expect(JSON.stringify(findings)).not.toContain('a line of the book');
  });

  it.each([
    ['broken JSON', 'not_json'],
    ['a page that does not pass the schema', 'bad_schema'],
    ['a page of another book', 'wrong_book'],
  ])('throws away %s', async (_name, scenario) => {
    const home = await library();
    const { findings } = await extract(home, scenario);
    expect(findings.find((item) => item.code === 'extract.pages_failed')?.params['pages']).toContain(
      '1:invalid_output',
    );
    expect(existsSync(join(pagesDir(home), sourcePageFile(0)))).toBe(false);
  });

  it('reports an engine that says it is done and wrote nothing', async () => {
    const home = await library();
    const { findings } = await extract(home, 'silent');
    expect(findings.find((item) => item.code === 'extract.pages_failed')?.params['pages']).toContain(
      '1:no_output',
    );
  });

  it('asks for the run record, which is where the licenses are kept (LC-3)', async () => {
    const home = await library();
    const { findings } = await extract(home, 'no_record');
    expect(findings.find((item) => item.code === 'extract.no_run_record')).toMatchObject({
      level: 'fail',
      params: { name: 'fake' },
    });
  });

  it('keeps asking for the run record when every page is reused', async () => {
    const home = await library();
    await extract(home, 'no_record');
    const { findings, data } = await extract(home);
    expect(data).toMatchObject({ ran: 0, reused: 3 });
    expect(codes(findings)).toContain('extract.no_run_record');
    expect(exitCodeOf(findings)).toBe(1);
  });

  it('reports an engine that went quiet or cannot start', async () => {
    const home = await library();
    const run = (outcome: Awaited<ReturnType<StreamRunner>>): Promise<ExtractResult> =>
      extractBook({ home, slug: 'book', env: process.env, tool: NO_GPU, stream: async () => outcome });
    const quiet = await run({ status: 'timeout' });
    const quietParams = quiet.findings.find((item) => item.code === 'extract.pages_failed')?.params;
    expect(quietParams?.['pages']).toContain('1:timeout');
    expect(quietParams?.['exit']).toBe('fake:timeout');
    const gone = await run({ status: 'not_found' });
    const goneParams = gone.findings.find((item) => item.code === 'extract.pages_failed')?.params;
    expect(goneParams?.['pages']).toContain('1:engine_not_found');
    expect(goneParams?.['exit']).toBe('fake:not_found');
  });

  it('gives the engine no keys, and gives it the offline settings it declared', async () => {
    const home = await library();
    const key = keyEnvName('anthropic');
    await extract(home, 'ok', { [key]: 'not-a-real-key', HF_TOKEN: 'not-a-real-token' });
    const names = seen<string[]>(home, 'seen-env.json');
    expect(names).not.toContain(key);
    expect(names).not.toContain('HF_TOKEN');
    expect(names).toContain('FAKE_ENGINE_OFFLINE');
  });

  it('asks for an engine when none is installed', async () => {
    const home = await library('plain', false);
    const { findings } = await extract(home);
    expect(findings).toMatchObject([{ code: 'extract.no_engine', level: 'fail' }]);
  });

  it('skips pages no engine handles, out loud', async () => {
    const home = await library('scan');
    const { findings } = await extract(home);
    expect(exitCodeOf(findings)).toBe(0);
    expect(findings.find((item) => item.code === 'probe.pages_skipped')?.params).toEqual({ count: '3' });
    expect(findings[0]?.params['pages']).toBe('1');
  });

  it('reports a book it does not know', async () => {
    const home = await library();
    await expect(extractBook({ home, slug: 'other', env: {}, tool: NO_GPU })).rejects.toMatchObject({
      code: 'book.not_found',
    });
  });

  it('counts pages for the progress line', async () => {
    const home = await library();
    const steps: string[] = [];
    await extractBook({
      home,
      slug: 'book',
      env: process.env,
      tool: NO_GPU,
      onPage: (done, total) => steps.push(`${done}/${total}`),
    });
    expect(steps).toEqual(['1/3', '2/3', '3/3']);
  });
});

function documentOf(home: string): IrDocument {
  const value: unknown = JSON.parse(readFileSync(join(bookDir(home, 'book'), 'ir', 'document.json'), 'utf8'));
  const checked = validateIr(value);
  expect(checked.ok).toBe(true);
  return value as IrDocument;
}

describe('the document layer', () => {
  it('turns a forged PDF into a document that passes tome-ir/1', async () => {
    const home = await library();
    const { data } = await extract(home);
    const document = documentOf(home);
    expect(document.pages.map(({ status }) => status)).toEqual(['ok', 'ok', 'ok']);
    expect(document.blocks.length).toBeGreaterThan(0);
    expect(document.blocks.every(({ flow }) => flow === 'main')).toBe(true);
    expect(data['document']).toMatchObject({ reused: false, pages: { ok: 3, skipped: 0, failed: 0 } });
  });

  it('fails a page whose characters got lost, and keeps it out of the document', async () => {
    const home = await library();
    const { findings } = await extract(home, 'lost_text');
    expect(exitCodeOf(findings)).toBe(1);
    const lost = findings.find((item) => item.code === 'extract.characters_missing');
    expect(lost).toMatchObject({ level: 'fail' });
    expect(lost?.params['pages']).toMatch(/^\d+:\d+\/\d+/);
    const document = documentOf(home);
    const failed = document.pages.filter(({ status }) => status === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]).toMatchObject({ reason: 'characters_missing' });
    const kept = new Set(document.blocks.flatMap(({ spans }) => spans.map(({ page }) => page)));
    for (const { page } of failed) expect(kept.has(page)).toBe(false);
  });

  it('never puts book text in what it reports', async () => {
    const home = await library();
    const { findings, data } = await extract(home, 'lost_text');
    const [firstPage] = (await forge('plain')).truth.text ?? [];
    const report = JSON.stringify({ findings, data });
    expect(report).not.toContain(firstPage?.[0]?.slice(0, 16));
  });

  it('lists pages that are not native as skipped', async () => {
    const home = await library('scan');
    await extract(home);
    expect(documentOf(home).pages.map(({ status, reason }) => [status, reason])).toEqual([
      ['skipped', 'scan'],
      ['skipped', 'scan'],
      ['skipped', 'scan'],
      ['ok', undefined],
    ]);
  });

  it('still writes a document when the book has no native page', async () => {
    const home = await library('images');
    const { findings } = await extract(home);
    expect(exitCodeOf(findings)).toBe(0);
    expect(codes(findings)).not.toContain('extract.done');
    expect(documentOf(home)).toMatchObject({ blocks: [], sections: [] });
    expect(documentOf(home).pages.map(({ status }) => status)).toEqual(['skipped', 'skipped']);
  });

  it('keeps a page the engine failed out of the blocks, and goes on with the others', async () => {
    const home = await library();
    const { findings } = await extract(home, 'one_failed');
    expect(exitCodeOf(findings)).toBe(1);
    expect(documentOf(home).pages[1]).toEqual({ page: 1, status: 'failed', reason: 'conversion_failed' });
    expect(documentOf(home).blocks.map(({ spans }) => spans[0]?.page)).toEqual([0, 2]);
  });

  it('does not assemble again when nothing changed', async () => {
    const home = await library();
    await extract(home);
    const before = readFileSync(join(bookDir(home, 'book'), 'ir', 'document.json'), 'utf8');
    const { data, findings } = await extract(home);
    expect(data['document']).toMatchObject({ reused: true });
    expect(codes(findings)).toContain('extract.document_reused');
    expect(readFileSync(join(bookDir(home, 'book'), 'ir', 'document.json'), 'utf8')).toBe(before);
  });

  it('builds a damaged document again instead of failing', async () => {
    const home = await library();
    await extract(home);
    const first = documentOf(home);
    writeFileSync(join(bookDir(home, 'book'), 'ir', 'document.json'), '{ not json');
    const { data, findings } = await extract(home);
    expect(exitCodeOf(findings)).toBe(0);
    expect(data['document']).toMatchObject({ reused: false });
    expect(documentOf(home)).toEqual(first);
  });

  it('builds the same document again from the same layers', async () => {
    const home = await library();
    await extract(home);
    const first = documentOf(home);
    rmSync(join(bookDir(home, 'book'), 'ir', 'document.json'));
    await extract(home);
    expect(documentOf(home)).toEqual(first);
  });

  it('applies overrides, keeps them across a rebuild, and reports what does not match', async () => {
    const home = await library();
    await extract(home);
    const [first, second] = documentOf(home).blocks;
    writeFileSync(
      join(bookDir(home, 'book'), 'overrides.yaml'),
      stringify({
        schema: 'tome-overrides/1',
        operations: [
          { op: 'role', block: first?.id, role: 'sidebar' },
          { op: 'skip', block: second?.id },
          { op: 'skip', block: 'p0099-abcdef' },
        ],
      }),
    );
    const { findings, data } = await extract(home);
    expect(data['document']).toMatchObject({ reused: false });
    expect(findings.find((item) => item.code === 'overrides.no_block')).toMatchObject({
      level: 'warn',
      params: { index: '3', block: 'p0099-abcdef' },
    });
    expect(exitCodeOf(findings)).toBe(0);
    const { blocks } = documentOf(home);
    expect(blocks[0]).toMatchObject({ id: first?.id, role: 'sidebar' });
    expect(blocks.map(({ id }) => id)).not.toContain(second?.id);
  });

  it('refuses an overrides file that is not the format', async () => {
    const home = await library();
    writeFileSync(join(bookDir(home, 'book'), 'overrides.yaml'), 'schema: tome-overrides/1\noperations: nope\n');
    await expect(extract(home)).rejects.toMatchObject({ code: 'config.bad_schema' });
  });

  it('decides the roles a rule pack declares', async () => {
    const home = await library();
    cpSync(SAMPLE_PACK, join(home, 'systems', 'sample-pack'), { recursive: true });
    await addBook({ home, pdf: await forgeFile('plain', tempDir()), name: 'book', system: 'sample-pack' });
    const texts = (await forge('plain')).truth.text ?? [];
    writeFileSync(textFile(home), JSON.stringify([[...(texts[0] ?? []), 'HP 12 AC 14.'], ...texts.slice(1)]));
    await extract(home);
    expect(documentOf(home).blocks.map(({ role }) => role)).toEqual([
      'sample-pack:stat_block',
      'paragraph',
      'paragraph',
    ]);
  });

  it('uses generic for a book with no --system (ADR-0100)', async () => {
    const home = await library();
    const dir = join(home, 'systems', 'generic');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'pack.yaml'),
      'schema: tome-pack/1\nid: generic\nversion: 0.1.0\nlicense: Apache-2.0\nsource_langs: [en]\n',
    );
    writeFileSync(join(dir, 'roles.yaml'), 'roles:\n  marked:\n    detect: [marker]\n');
    writeFileSync(join(dir, 'syntax_patterns.yaml'), "patterns:\n  - { id: marker, use: detect, regex: 'Marked here' }\n");
    const texts = (await forge('plain')).truth.text ?? [];
    writeFileSync(textFile(home), JSON.stringify([[...(texts[0] ?? []), 'Marked here.'], ...texts.slice(1)]));
    await extract(home);
    expect(documentOf(home).blocks.map(({ role }) => role)[0]).toBe('generic:marked');
  });

  it('says which pattern ran away, and stops short of recording the stage', async () => {
    const home = await library();
    const pack = join(home, 'systems', 'runaway');
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(pack, 'pack.yaml'), stringify({ schema: 'tome-pack/1', id: 'runaway', version: '0.1.0', license: 'Apache-2.0', source_langs: ['en'] }));
    writeFileSync(join(pack, 'syntax_patterns.yaml'), stringify({ patterns: [{ id: 'bad', use: 'detect', regex: '(a+)+$' }] }));
    writeFileSync(join(pack, 'roles.yaml'), stringify({ roles: { slow: { detect: ['bad'] } } }));
    await addBook({ home, pdf: await forgeFile('plain', tempDir()), name: 'book', system: 'runaway' });
    const texts = (await forge('plain')).truth.text ?? [];
    writeFileSync(textFile(home), JSON.stringify([[...(texts[0] ?? []), `${'a'.repeat(40)}!`], ...texts.slice(1)]));
    const { findings } = await extract(home);
    expect(findings.find((item) => item.code === 'pack.slow_regex')).toMatchObject({
      level: 'fail',
      params: { pattern: 'bad' },
    });
    const store = openBookStore(home, 'book');
    try {
      expect(stageFingerprint(store, 'document')).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe('the recorded layout book', () => {
  async function layoutBook(): Promise<IrDocument> {
    const home = await library('layout');
    const { findings } = await extract(home, 'ok', { FAKE_ENGINE_RECORDED: RECORDED_LAYOUT });
    expect(exitCodeOf(findings)).toBe(0);
    return documentOf(home);
  }

  it('reads the flow in order, past the sidebar, the columns and the page break', async () => {
    const { blocks } = await layoutBook();
    const flow = blocks.find(({ text }) => text.startsWith('Alpha opening'));
    const positions = LAYOUT_TRUTH.flow.map((phrase) => flow?.text.indexOf(phrase) ?? -1);
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(flow?.spans.map(({ page }) => page)).toEqual([0, 0, 0, 0, 1]);
  });

  it('takes the sidebar and the column box out of the main flow', async () => {
    const { blocks } = await layoutBook();
    const aside = blocks.filter(({ flow }) => flow === 'aside').map(({ text }) => text);
    expect(aside[0]).toBe(LAYOUT_TRUTH.sidebar[0]);
    expect(aside[1]?.startsWith(LAYOUT_TRUTH.sidebar[1] ?? '')).toBe(true);
    expect(aside[2]?.startsWith(LAYOUT_TRUTH.columnBox)).toBe(true);
  });

  it('closes the drop cap, joins the table, and marks the purchaser line', async () => {
    const { blocks } = await layoutBook();
    expect(blocks.some(({ text }) => text.startsWith(LAYOUT_TRUTH.dropCap))).toBe(true);
    expect(blocks.filter(({ role }) => role === 'table').map(({ table }) => table?.rows)).toEqual([
      LAYOUT_TRUTH.tableRows,
    ]);
    const purchaser = blocks.filter(({ text }) => text === LAYOUT_TRUTH.furniture);
    expect(purchaser.map(({ role }) => role)).toEqual(['furniture', 'furniture', 'furniture']);
  });

  it('turns the ligature into plain letters', async () => {
    const { blocks } = await layoutBook();
    expect(blocks.some(({ text }) => text === LAYOUT_TRUTH.ligature)).toBe(true);
  });

  it('builds sections from the headings, with no bookmarks in the book', async () => {
    const { sections, blocks, page_map: pageMap } = await layoutBook();
    expect(sections.map(({ title }) => title)).toEqual([LAYOUT_TRUTH.heading, LAYOUT_TRUTH.plainHeading]);
    expect(blocks.at(-1)?.role).toBe('furniture');
    expect(pageMap).toEqual([]);
  });
});

describe('choosing a device', () => {
  async function gpuBook(): Promise<string> {
    const source = join(tempDir(), 'gpu-engine');
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, 'engine.yaml'),
      stringify({
        schema: 'tome-engine/1',
        name: 'gpu-engine',
        pages: ['native'],
        command: ['python', 'main.py'],
        license: { code: 'MIT', weights: 'MIT' },
        setup: { kind: 'uv', extras: { cpu: 'cpu', gpu: 'gpu' } },
        gpu: { min_vram_mb: 4096 },
      }),
    );
    const home = join(tempDir(), 'home');
    initWorkspace({ home, env: {}, template: workspaceTemplate });
    await addEngine({
      home,
      target: source,
      gpu: true,
      env: {},
      tool: async () => ({ stdout: 'Forged GPU, 8192, 8000\n' }),
      stream: async (_command, args, _env, options) => {
        if (args.includes('--version')) options?.onLine?.('1.0.0');
        return { status: 'exited', code: 0, signal: null, stderr: '' };
      },
    });
    await addBook({ home, pdf: await forgeFile('plain', tempDir()), name: 'book' });
    return home;
  }

  async function deviceWith(free: number | null): Promise<string> {
    const home = await gpuBook();
    let device = '';
    const stream: StreamRunner = async (_command, args) => {
      const manifest = args[args.indexOf('--manifest') + 1] ?? '';
      device = (JSON.parse(readFileSync(manifest, 'utf8')) as EngineManifest).options.device;
      return { status: 'exited', code: 0, signal: null, stderr: '' };
    };
    const tool: ToolRunner = async () => (free === null ? null : { stdout: `Forged GPU, 8192, ${free}\n` });
    await extractBook({ home, slug: 'book', env: {}, tool, stream });
    return device;
  }

  it('uses the GPU build when enough VRAM is free', async () => {
    expect(await deviceWith(4096)).toBe('gpu');
  });

  it('falls back to the CPU when other programs hold the VRAM it needs', async () => {
    expect(await deviceWith(4095)).toBe('cpu');
  });

  it('falls back to the CPU when the GPU is gone', async () => {
    expect(await deviceWith(null)).toBe('cpu');
  });

  it('keeps the output of each device apart', () => {
    expect(configHashOf('a'.repeat(64), 'cpu', 'en')).not.toBe(configHashOf('a'.repeat(64), 'gpu', 'en'));
    expect(configHashOf('a'.repeat(64), 'cpu', 'en')).not.toBe(configHashOf('a'.repeat(64), 'cpu', 'ja'));
  });
});

describe('one process per book', () => {
  it('refuses a second run while the first is going', async () => {
    const home = await library();
    let release: () => void = () => {};
    const held = withBookLock(home, 'book', () => new Promise<void>((done) => (release = done)));
    await expect(extractBook({ home, slug: 'book', env: {}, tool: NO_GPU })).rejects.toMatchObject({
      code: 'book.busy',
    });
    release();
    await held;
  });

  it('takes over a lock whose process has gone', async () => {
    const home = await library();
    const path = join(bookDir(home, 'book'), 'book.lock');
    writeFileSync(path, '2147483646');
    const { findings } = await extract(home);
    expect(exitCodeOf(findings)).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it('lets go of the lock when the work fails', async () => {
    const home = await library();
    await expect(
      withBookLock(home, 'book', async () => {
        throw new TomeError('cli.internal');
      }),
    ).rejects.toBeInstanceOf(TomeError);
    expect(existsSync(join(bookDir(home, 'book'), 'book.lock'))).toBe(false);
  });
});
