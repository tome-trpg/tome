import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { workspaceTemplate } from '../../src/cli/messages.ts';
import { addBook, bookDir, probeBook, readBook, withBookLock } from '../../src/core/book.ts';
import { addEngine, engineDir, type EngineManifest } from '../../src/core/engine.ts';
import { TomeError } from '../../src/core/errors.ts';
import {
  configHashOf,
  extractBook,
  sourceDir,
  sourcePageFile,
  type ExtractResult,
} from '../../src/core/extract.ts';
import { exitCodeOf, type Finding } from '../../src/core/findings.ts';
import { keyEnvName } from '../../src/core/secrets.ts';
import type { StreamRunner, ToolRunner } from '../../src/core/process.ts';
import { validateIr, validateEngineManifest } from '../../src/core/schema.ts';
import { openBookStore } from '../../src/core/store.ts';
import { initWorkspace } from '../../src/core/workspace.ts';
import { forgeFile, type ForgeCase } from '../forge/index.ts';
import { tempDir } from '../helpers.ts';

const FAKE_ENGINE = resolve('tests/fixtures/engines/fake');
const NO_GPU: ToolRunner = async () => null;

function codes(findings: readonly Finding[]): string[] {
  return findings.map((item) => item.code);
}

async function library(forged: ForgeCase = 'plain', engine = true): Promise<string> {
  const home = join(tempDir(), 'home');
  initWorkspace({ home, env: {}, template: workspaceTemplate });
  if (engine) await addEngine({ home, target: FAKE_ENGINE, gpu: false, env: process.env, tool: NO_GPU });
  await addBook({ home, pdf: await forgeFile(forged, tempDir()), name: 'book' });
  return home;
}

function extract(home: string, scenario = 'ok', extraEnv: NodeJS.ProcessEnv = {}): Promise<ExtractResult> {
  return extractBook({
    home,
    slug: 'book',
    env: { ...process.env, FAKE_ENGINE_SCENARIO: scenario, ...extraEnv },
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
    expect(codes(findings)).toEqual(['extract.done', 'extract.source_only']);
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
    });
    expect(existsSync(join(pagesDir(home), sourcePageFile(0)))).toBe(true);
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

  it('reports an engine that went quiet or cannot start', async () => {
    const home = await library();
    const run = (outcome: Awaited<ReturnType<StreamRunner>>): Promise<ExtractResult> =>
      extractBook({ home, slug: 'book', env: process.env, tool: NO_GPU, stream: async () => outcome });
    const quiet = await run({ status: 'timeout' });
    expect(quiet.findings.find((item) => item.code === 'extract.pages_failed')?.params['pages']).toContain(
      '1:timeout',
    );
    const gone = await run({ status: 'not_found' });
    expect(gone.findings.find((item) => item.code === 'extract.pages_failed')?.params['pages']).toContain(
      '1:engine_not_found',
    );
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
        return { status: 'exited', code: 0, stderr: '' };
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
      return { status: 'exited', code: 0, stderr: '' };
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
