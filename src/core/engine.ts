import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { TomeError } from './errors.ts';
import { finding, type Finding } from './findings.ts';
import { detectGpu, type PageKind } from './probe.ts';
import {
  runStream,
  runTool,
  type StreamOutcome,
  type StreamRunner,
  type ToolRunner,
} from './process.ts';
import { validateEngineInstall, validateEngineSpec } from './schema.ts';
import { assertSafeId } from './store.ts';
import { readWorkspaceConfig, setWorkspaceEngines, workspaceEngines } from './workspace.ts';

// 解析引擎（白皮書 §5.3、ADR-0007）。主程式不依賴任何引擎套件，所有引擎都走同一套協定，
// 包含內建的那一個。這裡不認得任何引擎的名字。

export const ENGINE_SCHEMA = 'tome-engine/1';
const SPEC_FILE = 'engine.yaml';
const INSTALL_FILE = 'install.json';
const VENV_DIR = '.venv';
const DATA_DIR = 'data';
/** 轉接器以外的東西，換版本時要留著，雜湊也不算。 */
const KEPT_DIRS = new Set([VENV_DIR, DATA_DIR]);
const IGNORED = new Set([...KEPT_DIRS, INSTALL_FILE, '__pycache__']);
const SETUP_IDLE_MS = 10 * 60_000;
const DETAIL_LENGTH = 200;

export type Device = 'cpu' | 'gpu';
export type EngineOrigin = 'bundled' | 'path';

export interface EngineSpec {
  readonly schema: typeof ENGINE_SCHEMA;
  readonly name: string;
  readonly pages: readonly PageKind[];
  readonly command: readonly string[];
  readonly license: { readonly code: string; readonly weights: string };
  readonly setup: {
    readonly kind: 'uv' | 'none';
    readonly extras?: { readonly cpu: string; readonly gpu?: string };
    readonly prepare?: boolean;
  };
  readonly env?: Readonly<Record<string, string>>;
  readonly gpu?: { readonly min_vram_mb: number; readonly download_mb?: number };
}

export interface EngineInstall {
  readonly schema: typeof ENGINE_SCHEMA;
  readonly name: string;
  readonly version: string;
  readonly device: Device;
  readonly tree_hash: string;
  readonly origin: EngineOrigin;
}

export interface InstalledEngine {
  readonly spec: EngineSpec;
  readonly install: EngineInstall;
}

export interface EngineManifest {
  readonly schema: typeof ENGINE_SCHEMA;
  readonly pdf: string;
  readonly pdf_sha256: string;
  readonly pages: readonly number[];
  readonly output_dir: string;
  readonly data_dir: string;
  readonly source_lang: string;
  readonly config_hash: string;
  readonly options: { readonly device: Device };
}

export interface EnginePageResult {
  readonly page: number;
  readonly status: 'ok' | 'failed';
  readonly reason?: string;
}

export type EngineEvent =
  | ({ readonly event: 'page' } & EnginePageResult)
  | { readonly event: 'done' };

export interface EngineRun {
  readonly schema: typeof ENGINE_SCHEMA;
  readonly name: string;
  readonly version: string;
  readonly license: EngineSpec['license'];
  readonly config_hash: string;
  readonly pages: readonly EnginePageResult[];
}

function bundledDir(): string {
  // src 與 dist 到 repo 根目錄的深度相同。
  return fileURLToPath(new URL('../../engines/', import.meta.url));
}

export function engineDir(home: string, name: string): string {
  assertSafeId(name);
  return join(home, 'engines', name);
}

export function engineDataDir(home: string, name: string): string {
  return join(engineDir(home, name), DATA_DIR);
}

export function readEngineSpec(dir: string): EngineSpec {
  const path = join(dir, SPEC_FILE);
  let value: unknown;
  try {
    value = parse(readFileSync(path, 'utf8'));
  } catch {
    throw new TomeError('config.invalid_yaml', { path });
  }
  const checked = validateEngineSpec(value);
  if (!checked.ok) throw new TomeError('config.bad_schema', { path, expected: ENGINE_SCHEMA });
  return checked.value;
}

export interface EngineLocation {
  readonly dir: string;
  readonly origin: EngineOrigin;
}

/** 名稱先找隨附的引擎，找不到才當路徑。 */
export function locateEngine(target: string, bundled: string = bundledDir()): EngineLocation {
  const named = join(bundled, target);
  if (/^[a-z0-9-]+$/.test(target) && existsSync(join(named, SPEC_FILE))) {
    return { dir: named, origin: 'bundled' };
  }
  const path = resolve(target);
  if (existsSync(join(path, SPEC_FILE))) return { dir: path, origin: 'path' };
  throw new TomeError('engine.not_found', { name: target });
}

function treeFiles(root: string, dir: string = root): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !IGNORED.has(entry.name))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? treeFiles(root, path) : [relative(root, path)];
    })
    .sort();
}

/** 轉接器與鎖定檔的內容。一改就是另一份設定，`source` 層不沿用（ADR-0056）。 */
export function hashTree(root: string): string {
  const hash = createHash('sha256');
  for (const file of treeFiles(root)) {
    hash.update(`${file.split(sep).join('/')}\n`);
    hash.update(readFileSync(join(root, file)));
  }
  return hash.digest('hex');
}

export function readEngineInstall(home: string, name: string): EngineInstall | null {
  const path = join(engineDir(home, name), INSTALL_FILE);
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new TomeError('file.corrupt', { path });
  }
  const checked = validateEngineInstall(value);
  if (!checked.ok) throw new TomeError('config.bad_schema', { path, expected: ENGINE_SCHEMA });
  return checked.value;
}

/** 依 `tome.yaml` 的 `engines` 順序（白皮書 §5.3）。沒裝好的不算。 */
export function installedEngines(home: string): InstalledEngine[] {
  return workspaceEngines(home).flatMap((name) => {
    const install = readEngineInstall(home, name);
    if (install === null) return [];
    return [{ spec: readEngineSpec(engineDir(home, name)), install }];
  });
}

/** 同一種頁面有多個引擎時，排在前面的優先。 */
export function engineForPage(kind: PageKind, engines: readonly InstalledEngine[]): string | undefined {
  return engines.find(({ spec }) => spec.pages.includes(kind))?.spec.name;
}

function venvPython(dir: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? join(dir, VENV_DIR, 'Scripts', 'python.exe')
    : join(dir, VENV_DIR, 'bin', 'python');
}

export interface EngineCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export function engineCommand(
  home: string,
  spec: EngineSpec,
  platform: NodeJS.Platform = process.platform,
): EngineCommand {
  const cwd = engineDir(home, spec.name);
  const [first = '', ...args] = spec.command;
  const python = spec.setup.kind === 'uv' && first === 'python';
  return { command: python ? venvPython(cwd, platform) : first, args, cwd };
}

function replaceTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(target)) {
    if (!KEPT_DIRS.has(entry)) rmSync(join(target, entry), { recursive: true, force: true });
  }
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !path.split(sep).some((part) => IGNORED.has(part)),
  });
}

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  return (lines.at(-1) ?? '').trim().slice(-DETAIL_LENGTH);
}

function failure(name: string, step: string, outcome: StreamOutcome): Finding {
  const detail =
    outcome.status === 'exited'
      ? lastLine(outcome.stderr) || `exit ${String(outcome.code)}`
      : outcome.status;
  return finding('engine.install_failed', 'fail', { name, step, detail });
}

function succeeded(outcome: StreamOutcome): boolean {
  return outcome.status === 'exited' && outcome.code === 0;
}

export type InstallStage = 'sync' | 'prepare';

export interface AddEngineOptions {
  readonly home: string;
  readonly target: string;
  readonly gpu: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly tool?: ToolRunner;
  readonly stream?: StreamRunner;
  readonly bundled?: string;
  readonly onStage?: (stage: InstallStage) => void;
}

export interface AddEngineResult {
  readonly findings: readonly Finding[];
  readonly engine?: EngineInstall;
}

async function syncEnvironment(
  spec: EngineSpec,
  dir: string,
  device: Device,
  options: AddEngineOptions,
): Promise<Finding | null> {
  if (spec.setup.kind !== 'uv') return null;
  const { env, stream = runStream, onStage } = options;
  onStage?.('sync');
  const extra = spec.setup.extras?.[device];
  const outcome = await stream(
    'uv',
    ['sync', '--frozen', '--no-dev', ...(extra === undefined ? [] : ['--extra', extra])],
    env,
    {
      cwd: dir,
      extraEnv: { UV_PROJECT_ENVIRONMENT: join(dir, VENV_DIR) },
      idleTimeoutMs: SETUP_IDLE_MS,
      keepStderr: true,
    },
  );
  if (outcome.status === 'not_found') return finding('engine.needs_uv', 'fail');
  return succeeded(outcome) ? null : failure(spec.name, 'sync', outcome);
}

/** 權重只在這裡下載，這是對外出口模組之外唯一的例外（ADR-0039）。不帶 `env`，那是給執行時用的。 */
async function prepareData(spec: EngineSpec, options: AddEngineOptions): Promise<Finding | null> {
  if (spec.setup.prepare !== true) return null;
  const { home, env, platform, stream = runStream, onStage } = options;
  onStage?.('prepare');
  const { command, args, cwd } = engineCommand(home, spec, platform);
  const data = engineDataDir(home, spec.name);
  mkdirSync(data, { recursive: true });
  const outcome = await stream(command, [...args, '--prepare', '--data', data], env, {
    cwd,
    idleTimeoutMs: SETUP_IDLE_MS,
  });
  return succeeded(outcome) ? null : failure(spec.name, 'prepare', outcome);
}

async function reportedVersion(
  spec: EngineSpec,
  options: AddEngineOptions,
): Promise<{ version: string } | { failure: Finding }> {
  const { home, env, platform, stream = runStream } = options;
  const { command, args, cwd } = engineCommand(home, spec, platform);
  let version = '';
  const outcome = await stream(command, [...args, '--version'], env, {
    cwd,
    idleTimeoutMs: SETUP_IDLE_MS,
    onLine: (line) => {
      version ||= line.trim();
    },
  });
  if (!succeeded(outcome)) return { failure: failure(spec.name, 'version', outcome) };
  return { version };
}

function recordInstall(home: string, install: EngineInstall): void {
  writeFileSync(join(engineDir(home, install.name), INSTALL_FILE), JSON.stringify(install));
  const names = workspaceEngines(home);
  if (!names.includes(install.name)) setWorkspaceEngines(home, [...names, install.name]);
}

async function gpuPlan(
  spec: EngineSpec,
  options: AddEngineOptions,
): Promise<{ device: Device; findings: readonly Finding[] }> {
  const { env, gpu, tool = runTool } = options;
  const buildable = spec.setup.extras?.gpu !== undefined;
  const detected = buildable || gpu ? await detectGpu(env, tool) : null;
  if (gpu && !buildable) {
    return { device: 'gpu', findings: [finding('engine.no_gpu_build', 'fail', { name: spec.name })] };
  }
  if (gpu && detected === null) {
    return { device: 'gpu', findings: [finding('engine.no_gpu', 'fail')] };
  }
  if (!gpu && detected !== null) {
    const size = String(spec.gpu?.download_mb ?? '?');
    return {
      device: 'cpu',
      findings: [finding('engine.gpu_available', 'info', { gpu: detected.name, name: spec.name, size })],
    };
  }
  return { device: gpu ? 'gpu' : 'cpu', findings: [] };
}

/** 引擎放在工作區，每個一個環境（白皮書 §5.3）。中途失敗不寫紀錄，再跑一次就好。 */
export async function addEngine(options: AddEngineOptions): Promise<AddEngineResult> {
  const { home, target, bundled } = options;
  if (readWorkspaceConfig(home) === null) {
    return { findings: [finding('workspace.missing', 'fail', { path: home })] };
  }
  const { dir: source, origin } = locateEngine(target, bundled);
  const spec = readEngineSpec(source);
  const plan = await gpuPlan(spec, options);
  const findings: Finding[] = [
    ...(origin === 'path' ? [finding('engine.third_party', 'warn', { name: spec.name })] : []),
    ...plan.findings,
  ];
  if (findings.some((item) => item.level === 'fail')) return { findings };

  const treeHash = hashTree(source);
  const existing = readEngineInstall(home, spec.name);
  if (existing?.tree_hash === treeHash && existing.device === plan.device) {
    recordInstall(home, existing);
    return {
      engine: existing,
      findings: [...findings, finding('engine.already_added', 'info', { name: spec.name })],
    };
  }

  const dir = engineDir(home, spec.name);
  rmSync(join(dir, INSTALL_FILE), { force: true });
  replaceTree(source, dir);
  const blocked =
    (await syncEnvironment(spec, dir, plan.device, options)) ?? (await prepareData(spec, options));
  if (blocked !== null) return { findings: [...findings, blocked] };
  const reported = await reportedVersion(spec, options);
  if ('failure' in reported) return { findings: [...findings, reported.failure] };

  const install: EngineInstall = {
    schema: ENGINE_SCHEMA,
    name: spec.name,
    version: reported.version,
    device: plan.device,
    tree_hash: treeHash,
    origin,
  };
  if (!validateEngineInstall(install).ok) {
    const detail = 'bad version';
    return {
      findings: [...findings, finding('engine.install_failed', 'fail', { name: spec.name, step: 'version', detail })],
    };
  }
  recordInstall(home, install);
  const added = finding('engine.added', 'info', {
    name: spec.name,
    version: install.version,
    device: install.device,
    code: spec.license.code,
    weights: spec.license.weights,
  });
  return { engine: install, findings: [...findings, added] };
}

export function removeEngine(home: string, name: string): Finding[] {
  if (readWorkspaceConfig(home) === null) return [finding('workspace.missing', 'fail', { path: home })];
  const dir = engineDir(home, name);
  const names = workspaceEngines(home);
  if (!existsSync(dir) && !names.includes(name)) {
    return [finding('engine.not_installed', 'fail', { name })];
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  setWorkspaceEngines(home, names.filter((item) => item !== name));
  return [finding('engine.removed', 'info', { name })];
}

export interface EngineListing {
  readonly name: string;
  readonly version: string;
  readonly device: Device;
  readonly code_license: string;
  readonly weights_license: string;
}

export function listEngines(home: string): EngineListing[] {
  return installedEngines(home).map(({ spec, install }) => ({
    name: spec.name,
    version: install.version,
    device: install.device,
    code_license: spec.license.code,
    weights_license: spec.license.weights,
  }));
}

/** `tome doctor` 用：每個引擎真的啟動得了。 */
export async function checkEngines(
  home: string,
  env: NodeJS.ProcessEnv,
  tool: ToolRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<Finding[]> {
  if (readWorkspaceConfig(home) === null) return [];
  const names = workspaceEngines(home);
  if (names.length === 0) return [finding('engine.none', 'info')];
  const installed = installedEngines(home);
  const missing = names.filter((name) => !installed.some(({ spec }) => spec.name === name));
  const checks = await Promise.all(
    installed.map(async ({ spec, install }) => {
      const { command, args, cwd } = engineCommand(home, spec, platform);
      const started = await tool(command, [...args, '--version'], env, cwd);
      const { name, version, device } = install;
      return started === null
        ? finding('engine.broken', 'warn', { name })
        : finding('engine.ok', 'info', { name, version, device });
    }),
  );
  return [...checks, ...missing.map((name) => finding('engine.broken', 'warn', { name }))];
}
