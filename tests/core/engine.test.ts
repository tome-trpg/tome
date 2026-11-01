import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { workspaceTemplate } from '../../src/cli/messages.ts';
import {
  addEngine,
  checkEngines,
  engineCommand,
  engineDir,
  engineForPage,
  hashTree,
  installedEngines,
  listEngines,
  locateEngine,
  readEngineSpec,
  removeEngine,
  type EngineSpec,
} from '../../src/core/engine.ts';
import { TomeError } from '../../src/core/errors.ts';
import { exitCodeOf, type Finding } from '../../src/core/findings.ts';
import type { StreamOptions, StreamOutcome, StreamRunner, ToolRunner } from '../../src/core/process.ts';
import { runTool } from '../../src/core/process.ts';
import { initWorkspace, workspaceEngines } from '../../src/core/workspace.ts';
import { tempDir } from '../helpers.ts';

export const FAKE_ENGINE = resolve('tests/fixtures/engines/fake');
const NVIDIA: ToolRunner = async () => ({ stdout: 'Forged GPU, 8192, 8000\n' });
const NO_GPU: ToolRunner = async () => null;
const CLEAN: StreamOutcome = { status: 'exited', code: 0, signal: null, stderr: '' };

function workspace(): string {
  const home = join(tempDir(), 'home');
  initWorkspace({ home, env: {}, template: workspaceTemplate });
  return home;
}

function codes(findings: readonly Finding[]): string[] {
  return findings.map((item) => item.code);
}

const UV_SPEC = {
  schema: 'tome-engine/1',
  name: 'uvish',
  pages: ['native'],
  command: ['python', 'main.py'],
  license: { code: 'MIT', weights: 'Apache-2.0' },
  setup: { kind: 'uv', extras: { cpu: 'cpu', gpu: 'gpu' }, prepare: true },
  env: { OFFLINE: '1' },
  gpu: { min_vram_mb: 4096, download_mb: 2000 },
};

function uvEngine(overrides: object = {}): string {
  const dir = join(tempDir(), 'uvish');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'engine.yaml'), stringify({ ...UV_SPEC, ...overrides }));
  writeFileSync(join(dir, 'main.py'), '# adapter');
  writeFileSync(join(dir, 'uv.lock'), 'lock');
  return dir;
}

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: StreamOptions | undefined;
}

/** 假的 uv 與 python。`--version` 回版本，其他照 `results` 的順序回。 */
function recorder(results: readonly StreamOutcome[] = []): { calls: Call[]; stream: StreamRunner } {
  const calls: Call[] = [];
  let index = 0;
  const stream: StreamRunner = async (command, args, _env, options) => {
    calls.push({ command, args, options });
    if (args.includes('--version')) {
      options?.onLine?.('9.9.9');
      return CLEAN;
    }
    const result = results[index] ?? CLEAN;
    index += 1;
    return result;
  };
  return { calls, stream };
}

describe('reading engine.yaml', () => {
  it('reads the fake engine', () => {
    expect(readEngineSpec(FAKE_ENGINE)).toMatchObject({ name: 'fake', pages: ['native'] });
  });

  it('reads the bundled engine by name', () => {
    expect(locateEngine('docling').origin).toBe('bundled');
    expect(readEngineSpec(locateEngine('docling').dir).setup.kind).toBe('uv');
  });

  it('declares the Intel library the Docling environment carries (ADR-0087)', () => {
    expect(readEngineSpec(locateEngine('docling').dir).license.proprietary).toEqual(['Intel oneMKL']);
  });

  it('says the same licenses in the adapter as in engine.yaml (LC-3)', () => {
    const { dir } = locateEngine('docling');
    const { license } = readEngineSpec(dir);
    const adapter = readFileSync(join(dir, 'main.py'), 'utf8');
    expect(adapter).toContain(`LICENSE = {"code": "${license.code}", "weights": "${license.weights}"}`);
  });

  it('pins the weights of the bundled engine to commits', () => {
    const adapter = readFileSync(join(locateEngine('docling').dir, 'main.py'), 'utf8');
    expect(adapter.match(/"revision": "[0-9a-f]{40}"/g)).toHaveLength(2);
    expect(adapter).not.toMatch(/"revision": "main"/);
  });

  it('takes a path to an engine of your own', () => {
    expect(locateEngine(FAKE_ENGINE)).toEqual({ dir: FAKE_ENGINE, origin: 'path' });
  });

  it('prefers the bundled engine over a folder of the same name', () => {
    const bundled = tempDir();
    mkdirSync(join(bundled, 'tests'), { recursive: true });
    writeFileSync(join(bundled, 'tests', 'engine.yaml'), stringify(UV_SPEC));
    expect(locateEngine('tests', bundled).origin).toBe('bundled');
  });

  it('reports an engine that is nowhere', () => {
    expect(() => locateEngine('no-such-engine')).toThrowError(TomeError);
  });

  it.each([
    ['a kind of setup that is not uv or none', { setup: { kind: 'shell', run: 'curl x | sh' } }],
    ['an install command of its own', { setup: { kind: 'uv', install: ['make'] } }],
    ['an unknown page kind', { pages: ['photo'] }],
    ['no weights license', { license: { code: 'MIT' } }],
  ])('refuses %s', (_name, overrides) => {
    expect(() => readEngineSpec(uvEngine(overrides))).toThrowError(TomeError);
  });
});

describe('engineCommand', () => {
  const spec = UV_SPEC as unknown as EngineSpec;

  it('finds the Python in the environment on each platform', () => {
    expect(engineCommand('/home', spec, 'linux').command).toBe(
      join('/home', 'engines', 'uvish', '.venv', 'bin', 'python'),
    );
    expect(engineCommand('/home', spec, 'win32').command).toBe(
      join('/home', 'engines', 'uvish', '.venv', 'Scripts', 'python.exe'),
    );
  });

  it('leaves the command alone when the environment is not ours', () => {
    const own = { ...spec, setup: { kind: 'none' }, command: ['python', 'main.py'] } as EngineSpec;
    expect(engineCommand('/home', own, 'linux')).toMatchObject({ command: 'python', args: ['main.py'] });
  });
});

describe('hashTree', () => {
  it('changes with the adapter and ignores the environment', () => {
    const dir = uvEngine();
    const before = hashTree(dir);
    mkdirSync(join(dir, '.venv'));
    writeFileSync(join(dir, '.venv', 'big'), 'wheels');
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'weights'), 'weights');
    writeFileSync(join(dir, 'install.json'), '{}');
    expect(hashTree(dir)).toBe(before);
    writeFileSync(join(dir, 'uv.lock'), 'another lock');
    expect(hashTree(dir)).not.toBe(before);
  });
});

describe('adding an engine', () => {
  it('needs a workspace', async () => {
    const { findings } = await addEngine({
      home: join(tempDir(), 'none'),
      target: FAKE_ENGINE,
      gpu: false,
      env: process.env,
      tool: NO_GPU,
    });
    expect(codes(findings)).toEqual(['workspace.missing']);
  });

  it('installs an engine that keeps its own environment, and warns about a path', async () => {
    const home = workspace();
    const { findings, engine } = await addEngine({
      home,
      target: FAKE_ENGINE,
      gpu: false,
      env: process.env,
      tool: NO_GPU,
    });
    expect(codes(findings)).toEqual(['engine.third_party', 'engine.added']);
    expect(findings[0]?.level).toBe('warn');
    expect(engine).toMatchObject({ name: 'fake', version: '1.2.3', device: 'cpu', origin: 'path' });
    expect(existsSync(join(engineDir(home, 'fake'), 'data', 'prepared.txt'))).toBe(true);
    expect(workspaceEngines(home)).toEqual(['fake']);
  });

  it('builds the CPU environment by default, from the lock file only', async () => {
    const home = workspace();
    const { calls, stream } = recorder();
    const stages: string[] = [];
    const { findings } = await addEngine({
      home,
      target: uvEngine(),
      gpu: false,
      env: { PATH: 'x' },
      tool: NO_GPU,
      stream,
      platform: 'linux',
      onStage: (stage) => stages.push(stage),
    });
    expect(exitCodeOf(findings)).toBe(0);
    expect(stages).toEqual(['sync', 'prepare']);
    expect(calls[0]).toMatchObject({
      command: 'uv',
      args: ['sync', '--frozen', '--no-dev', '--extra', 'cpu'],
    });
    expect(calls[0]?.options?.extraEnv).toEqual({
      UV_PROJECT_ENVIRONMENT: join(engineDir(home, 'uvish'), '.venv'),
    });
    expect(calls[1]?.args).toEqual(['main.py', '--prepare', '--data', join(engineDir(home, 'uvish'), 'data')]);
    expect(calls[2]?.args).toEqual(['main.py', '--version']);
  });

  it('does not set the offline variables while it may download', async () => {
    const { calls, stream } = recorder();
    await addEngine({ home: workspace(), target: uvEngine(), gpu: false, env: {}, tool: NO_GPU, stream });
    expect(calls[1]?.options?.extraEnv).toBeUndefined();
  });

  it('mentions the GPU build without downloading it', async () => {
    const { calls, stream } = recorder();
    const { findings } = await addEngine({
      home: workspace(),
      target: uvEngine(),
      gpu: false,
      env: {},
      tool: NVIDIA,
      stream,
    });
    expect(findings.find((item) => item.code === 'engine.gpu_available')).toMatchObject({
      level: 'info',
      params: { gpu: 'Forged GPU', size: '2000' },
    });
    expect(calls[0]?.args).toContain('cpu');
  });

  it('installs the CUDA build with --gpu', async () => {
    const { calls, stream } = recorder();
    const { engine } = await addEngine({
      home: workspace(),
      target: uvEngine(),
      gpu: true,
      env: {},
      tool: NVIDIA,
      stream,
    });
    expect(calls[0]?.args).toEqual(['sync', '--frozen', '--no-dev', '--extra', 'gpu']);
    expect(engine?.device).toBe('gpu');
  });

  it('says the CUDA build is proprietary once it is installed, and only then (ADR-0085)', async () => {
    const home = workspace();
    const target = uvEngine();
    const cpu = await addEngine({ home, target, gpu: false, env: {}, tool: NVIDIA, stream: recorder().stream });
    expect(codes(cpu.findings)).not.toContain('engine.gpu_license');

    const gpu = await addEngine({ home, target, gpu: true, env: {}, tool: NVIDIA, stream: recorder().stream });
    expect(gpu.findings.at(-2)).toMatchObject({ code: 'engine.added', level: 'info' });
    expect(gpu.findings.at(-1)).toMatchObject({ code: 'engine.gpu_license', level: 'info' });
    expect(exitCodeOf(gpu.findings)).toBe(0);
  });

  it('names the proprietary components an engine declares, on both builds (ADR-0087)', async () => {
    const home = workspace();
    const target = uvEngine({ license: { ...UV_SPEC.license, proprietary: ['Forged Library', 'Forged Runtime'] } });
    const cpu = await addEngine({ home, target, gpu: false, env: {}, tool: NO_GPU, stream: recorder().stream });
    expect(cpu.findings.at(-1)).toMatchObject({
      code: 'engine.proprietary',
      level: 'info',
      params: { name: 'uvish', components: 'Forged Library, Forged Runtime' },
    });
    expect(exitCodeOf(cpu.findings)).toBe(0);

    const gpu = await addEngine({ home, target, gpu: true, env: {}, tool: NVIDIA, stream: recorder().stream });
    expect(codes(gpu.findings)).toEqual(['engine.third_party', 'engine.added', 'engine.proprietary', 'engine.gpu_license']);
  });

  it('says nothing about proprietary components an engine does not declare', async () => {
    const { findings } = await addEngine({
      home: workspace(),
      target: uvEngine(),
      gpu: false,
      env: {},
      tool: NO_GPU,
      stream: recorder().stream,
    });
    expect(codes(findings)).not.toContain('engine.proprietary');
  });

  it('names them only when something was installed', async () => {
    const home = workspace();
    const target = uvEngine({ license: { ...UV_SPEC.license, proprietary: ['Forged Library'] } });
    const failed = await addEngine({
      home,
      target,
      gpu: false,
      env: {},
      tool: NO_GPU,
      stream: recorder([{ status: 'exited', code: 1, signal: null, stderr: 'boom' }]).stream,
    });
    expect(codes(failed.findings)).not.toContain('engine.proprietary');

    await addEngine({ home, target, gpu: false, env: {}, tool: NO_GPU, stream: recorder().stream });
    const again = await addEngine({ home, target, gpu: false, env: {}, tool: NO_GPU, stream: recorder().stream });
    expect(codes(again.findings)).toContain('engine.already_added');
    expect(codes(again.findings)).not.toContain('engine.proprietary');
  });

  it('refuses an empty or malformed list of proprietary components', () => {
    for (const proprietary of [[], [''], [1], 'Forged Library']) {
      const target = uvEngine({ license: { ...UV_SPEC.license, proprietary } });
      expect(() => readEngineSpec(target)).toThrow(TomeError);
    }
  });

  it('stays quiet about the CUDA license when the install fails', async () => {
    const { stream } = recorder([{ status: 'exited', code: 1, signal: null, stderr: 'boom' }]);
    const { findings } = await addEngine({
      home: workspace(),
      target: uvEngine(),
      gpu: true,
      env: {},
      tool: NVIDIA,
      stream,
    });
    expect(codes(findings)).toContain('engine.install_failed');
    expect(codes(findings)).not.toContain('engine.gpu_license');
  });

  it('refuses --gpu with no NVIDIA GPU, before anything is downloaded', async () => {
    const { calls, stream } = recorder();
    const { findings } = await addEngine({
      home: workspace(),
      target: uvEngine(),
      gpu: true,
      env: {},
      tool: NO_GPU,
      stream,
    });
    expect(findings.at(-1)).toMatchObject({ code: 'engine.no_gpu', level: 'fail' });
    expect(calls).toEqual([]);
  });

  it('refuses --gpu for an engine with no GPU build', async () => {
    const { calls, stream } = recorder();
    const { findings } = await addEngine({
      home: workspace(),
      target: uvEngine({ setup: { kind: 'uv' } }),
      gpu: true,
      env: {},
      tool: NVIDIA,
      stream,
    });
    expect(findings.at(-1)).toMatchObject({ code: 'engine.no_gpu_build', level: 'fail' });
    expect(calls).toEqual([]);
  });

  it('says so when uv is not there', async () => {
    const { stream } = recorder([{ status: 'not_found' }]);
    const home = workspace();
    const { findings } = await addEngine({ home, target: uvEngine(), gpu: false, env: {}, tool: NO_GPU, stream });
    expect(findings.at(-1)).toMatchObject({ code: 'engine.needs_uv', level: 'fail' });
    expect(installedEngines(home)).toEqual([]);
  });

  it('shows why uv failed and leaves no record of an install', async () => {
    const { stream } = recorder([{ status: 'exited', code: 2, signal: null, stderr: 'noise\nerror: no wheel\n' }]);
    const home = workspace();
    const { findings } = await addEngine({ home, target: uvEngine(), gpu: false, env: {}, tool: NO_GPU, stream });
    expect(findings.at(-1)).toMatchObject({
      code: 'engine.install_failed',
      level: 'fail',
      params: { name: 'uvish', step: 'sync', detail: 'error: no wheel' },
    });
    expect(existsSync(join(engineDir(home, 'uvish'), 'install.json'))).toBe(false);
    expect(workspaceEngines(home)).toEqual([]);
  });

  it('gives only an exit code when the engine fails to prepare', async () => {
    const { stream } = recorder([CLEAN, { status: 'exited', code: 7, signal: null, stderr: '' }]);
    const { findings } = await addEngine({
      home: workspace(),
      target: uvEngine(),
      gpu: false,
      env: {},
      tool: NO_GPU,
      stream,
    });
    expect(findings.at(-1)).toMatchObject({
      code: 'engine.install_failed',
      params: { step: 'prepare', detail: 'exit 7' },
    });
  });

  it('refuses a version that cannot be a folder name', async () => {
    const stream: StreamRunner = async (_command, args, _env, options) => {
      if (args.includes('--version')) options?.onLine?.('../../evil');
      return CLEAN;
    };
    const home = workspace();
    const { findings } = await addEngine({ home, target: uvEngine(), gpu: false, env: {}, tool: NO_GPU, stream });
    expect(findings.at(-1)).toMatchObject({ code: 'engine.install_failed', params: { step: 'version' } });
    expect(installedEngines(home)).toEqual([]);
  });

  it('does nothing when the same engine is added again', async () => {
    const home = workspace();
    const target = uvEngine();
    const first = recorder();
    await addEngine({ home, target, gpu: false, env: {}, tool: NO_GPU, stream: first.stream });
    const second = recorder();
    const { findings } = await addEngine({ home, target, gpu: false, env: {}, tool: NO_GPU, stream: second.stream });
    expect(codes(findings)).toContain('engine.already_added');
    expect(second.calls).toEqual([]);
  });

  it('rebuilds when the adapter or the device changes, and keeps the weights', async () => {
    const home = workspace();
    const target = uvEngine();
    await addEngine({ home, target, gpu: false, env: {}, tool: NO_GPU, stream: recorder().stream });
    const data = join(engineDir(home, 'uvish'), 'data');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'weights'), 'kept');
    writeFileSync(join(engineDir(home, 'uvish'), 'old.py'), 'left over');

    writeFileSync(join(target, 'uv.lock'), 'a newer lock');
    const update = recorder();
    await addEngine({ home, target, gpu: false, env: {}, tool: NO_GPU, stream: update.stream });
    expect(update.calls[0]?.args).toContain('sync');
    expect(readFileSync(join(engineDir(home, 'uvish'), 'uv.lock'), 'utf8')).toBe('a newer lock');
    expect(existsSync(join(engineDir(home, 'uvish'), 'old.py'))).toBe(false);
    expect(existsSync(join(data, 'weights'))).toBe(true);

    const toGpu = recorder();
    const { engine } = await addEngine({ home, target, gpu: true, env: {}, tool: NVIDIA, stream: toGpu.stream });
    expect(toGpu.calls[0]?.args).toContain('gpu');
    expect(engine?.device).toBe('gpu');
  });

  it('keeps the comments in tome.yaml', async () => {
    const home = workspace();
    await addEngine({ home, target: FAKE_ENGINE, gpu: false, env: process.env, tool: NO_GPU });
    const text = readFileSync(join(home, 'tome.yaml'), 'utf8');
    expect(text).toContain('不得存放金鑰');
    expect((parse(text) as { engines: string[] }).engines).toEqual(['fake']);
  });
});

describe('the installed engines', () => {
  it('lists them with both licenses (LC-3)', async () => {
    const home = workspace();
    await addEngine({ home, target: uvEngine(), gpu: false, env: {}, tool: NO_GPU, stream: recorder().stream });
    expect(listEngines(home)).toEqual([
      { name: 'uvish', version: '9.9.9', device: 'cpu', code_license: 'MIT', weights_license: 'Apache-2.0' },
    ]);
  });

  it('removes one and forgets it', async () => {
    const home = workspace();
    await addEngine({ home, target: FAKE_ENGINE, gpu: false, env: process.env, tool: NO_GPU });
    expect(codes(removeEngine(home, 'fake'))).toEqual(['engine.removed']);
    expect(existsSync(engineDir(home, 'fake'))).toBe(false);
    expect(workspaceEngines(home)).toEqual([]);
  });

  it('reports removing what is not there', () => {
    expect(removeEngine(workspace(), 'fake')).toMatchObject([{ code: 'engine.not_installed', level: 'fail' }]);
  });

  it('refuses a name that climbs out of the engines folder', () => {
    expect(() => removeEngine(workspace(), '..')).toThrowError(TomeError);
  });

  it('prefers the engine listed first', async () => {
    const home = workspace();
    const one = uvEngine({ name: 'one', pages: ['native', 'scan'] });
    const two = uvEngine({ name: 'two', pages: ['native'] });
    await addEngine({ home, target: two, gpu: false, env: {}, tool: NO_GPU, stream: recorder().stream });
    await addEngine({ home, target: one, gpu: false, env: {}, tool: NO_GPU, stream: recorder().stream });
    const engines = installedEngines(home);
    expect(engineForPage('native', engines)).toBe('two');
    expect(engineForPage('scan', engines)).toBe('one');
    expect(engineForPage('image_only', engines)).toBeUndefined();
  });
});

describe('tome doctor on engines', () => {
  it('says there is none yet', async () => {
    expect(codes(await checkEngines(workspace(), {}, NO_GPU))).toEqual(['engine.none']);
  });

  it('starts each engine', async () => {
    const home = workspace();
    await addEngine({ home, target: FAKE_ENGINE, gpu: false, env: process.env, tool: NO_GPU });
    expect(await checkEngines(home, process.env, runTool)).toMatchObject([
      { code: 'engine.ok', params: { name: 'fake', version: '1.2.3', device: 'cpu' } },
    ]);
  });

  it('warns about an engine that does not start or is gone', async () => {
    const home = workspace();
    await addEngine({ home, target: FAKE_ENGINE, gpu: false, env: process.env, tool: NO_GPU });
    expect(await checkEngines(home, {}, NO_GPU)).toMatchObject([{ code: 'engine.broken', level: 'warn' }]);
    removeEngine(home, 'fake');
    writeFileSync(join(home, 'tome.yaml'), 'schema: tome-workspace/1\nengines: [fake]\n');
    expect(await checkEngines(home, {}, NO_GPU)).toMatchObject([{ code: 'engine.broken', level: 'warn' }]);
  });

  it('says nothing without a workspace, because that has its own finding', async () => {
    expect(await checkEngines(join(tempDir(), 'none'), {}, NO_GPU)).toEqual([]);
  });

  it('reports a tome.yaml whose engines are not a list', () => {
    const home = workspace();
    writeFileSync(join(home, 'tome.yaml'), 'schema: tome-workspace/1\nengines: fake\n');
    expect(() => workspaceEngines(home)).toThrowError(TomeError);
  });
});
