import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { TomeError } from './errors.ts';
import { finding, type Finding } from './findings.ts';
import { inspectPath } from './path-guard.ts';

export const WORKSPACE_SCHEMA = 'tome-workspace/1';
/** 目標語言只承諾這一個（ADR-0009）。`tome.yaml` 沒寫或沒有工作區時用它（ADR-0100）。 */
export const DEFAULT_TARGET_LANG = 'zh-TW';
const CONFIG_FILE = 'tome.yaml';
const SUBDIRECTORIES = ['systems', 'engines', 'series', 'books'] as const;
const SECRET_KEY_NAME = /api[_-]?key|secret|token|password/i;

export interface WorkspaceConfig {
  readonly schema: typeof WORKSPACE_SCHEMA;
  readonly vault_path?: string;
  readonly [key: string]: unknown;
}

/** ADR-0053 與白皮書 §6.3 的預設位置，`TOME_HOME` 優先。 */
export function resolveHome(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env['TOME_HOME']) return resolve(env['TOME_HOME']);
  switch (platform) {
    case 'win32':
      return join(env['LOCALAPPDATA'] || join(home, 'AppData', 'Local'), 'tome');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'tome');
    default:
      return join(home, '.local', 'share', 'tome');
  }
}

function pathFindings(
  subject: 'workspace' | 'vault',
  path: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Finding[] {
  return inspectPath(path, env, platform).map((issue) =>
    issue.kind === 'git_repo'
      ? finding(`${subject}.in_git_repo`, 'fail', { path, repo: issue.root })
      : finding(`${subject}.sync_folder`, 'warn', { path, provider: issue.provider }),
  );
}

export function readWorkspaceConfig(home: string): WorkspaceConfig | null {
  const path = join(home, CONFIG_FILE);
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = parse(readFileSync(path, 'utf8'));
  } catch {
    throw new TomeError('config.invalid_yaml', { path });
  }
  if (typeof value !== 'object' || value === null || !('schema' in value)) {
    throw new TomeError('config.bad_schema', { path, expected: WORKSPACE_SCHEMA });
  }
  if (value.schema !== WORKSPACE_SCHEMA) {
    throw new TomeError('config.bad_schema', { path, expected: WORKSPACE_SCHEMA });
  }
  return value as WorkspaceConfig;
}

export function workspaceTargetLang(home: string): string {
  const value: unknown = readWorkspaceConfig(home)?.['target_lang'] ?? DEFAULT_TARGET_LANG;
  if (typeof value !== 'string') {
    throw new TomeError('config.bad_schema', { path: join(home, CONFIG_FILE), expected: WORKSPACE_SCHEMA });
  }
  return value;
}

/** `tome.yaml` 裡的模型，用到時才檢查（ADR-0099 第 10 項）。沒設時是 undefined。 */
export function workspaceModel(home: string, key: 'translator_model' | 'fallback_model'): string | undefined {
  const value: unknown = readWorkspaceConfig(home)?.[key];
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new TomeError('config.bad_schema', { path: join(home, CONFIG_FILE), expected: WORKSPACE_SCHEMA });
  }
  return value ?? undefined;
}

/** 個資清單（ADR-0099 第 21 項）。 */
export function workspacePii(home: string): string[] {
  const value: unknown = readWorkspaceConfig(home)?.['pii'] ?? [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TomeError('config.bad_schema', { path: join(home, CONFIG_FILE), expected: WORKSPACE_SCHEMA });
  }
  return value as string[];
}

/** 清單空的時候要警告，閘門攔不到任何東西（ADR-0099 第 21 項）。 */
export function piiFindings(home: string): Finding[] {
  if (readWorkspaceConfig(home) === null) return [];
  return workspacePii(home).length === 0 ? [finding('pii.empty', 'warn')] : [];
}

/** 解析引擎的順序，同一種頁面有多個引擎時排前面的優先（白皮書 §5.3）。 */
export function workspaceEngines(home: string): string[] {
  const value: unknown = readWorkspaceConfig(home)?.['engines'] ?? [];
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
    throw new TomeError('config.bad_schema', { path: join(home, CONFIG_FILE), expected: WORKSPACE_SCHEMA });
  }
  return value as string[];
}

/** 改動時留著使用者寫的註解。 */
export function setWorkspaceEngines(home: string, names: readonly string[]): void {
  const path = join(home, CONFIG_FILE);
  const document = parseDocument(readFileSync(path, 'utf8'));
  document.set('engines', document.createNode([...names]));
  writeFileSync(path, document.toString());
}

function secretKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return SECRET_KEY_NAME.test(key) ? [path] : secretKeys(child, path);
  });
}

export interface InitOptions {
  readonly home: string;
  readonly vaultPath?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** `tome.yaml` 的範本。內容是給人看的，由呼叫端提供，核心不放文字。 */
  readonly template: string;
}

export function initWorkspace(options: InitOptions): Finding[] {
  const { home, env, template, platform = process.platform } = options;
  const vaultPath = options.vaultPath === undefined ? undefined : resolve(options.vaultPath);
  const findings = pathFindings('workspace', home, env, platform);
  if (vaultPath !== undefined) findings.push(...pathFindings('vault', vaultPath, env, platform));
  if (findings.some((item) => item.level === 'fail')) return findings;

  const existing = readWorkspaceConfig(home);
  if (existing !== null) {
    if (vaultPath !== undefined && existing.vault_path !== vaultPath) {
      findings.push(finding('workspace.vault_ignored', 'warn', { path: join(home, CONFIG_FILE) }));
    }
    findings.push(finding('workspace.already_exists', 'info', { path: home }));
    return findings;
  }

  for (const name of SUBDIRECTORIES) mkdirSync(join(home, name), { recursive: true });
  const document = parseDocument(template);
  if (vaultPath !== undefined) document.set('vault_path', vaultPath);
  // wx：就算剛好有別的行程先寫了，也不覆蓋。
  writeFileSync(join(home, CONFIG_FILE), document.toString(), { flag: 'wx' });
  findings.push(finding('workspace.created', 'info', { path: home }));
  return findings;
}

/** `tome doctor` 用：工作區與 vault 是否還符合 ADR-0053、ADR-0059。 */
export function checkWorkspace(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Finding[] {
  const config = readWorkspaceConfig(home);
  if (config === null) return [finding('workspace.missing', 'fail', { path: home })];
  const findings = pathFindings('workspace', home, env, platform);
  if (typeof config.vault_path === 'string') {
    findings.push(...pathFindings('vault', config.vault_path, env, platform));
  }
  for (const key of secretKeys(config)) {
    findings.push(finding('workspace.secret_in_config', 'fail', { key }));
  }
  if (!findings.some((item) => item.level === 'fail')) {
    findings.push(finding('workspace.ok', 'info', { path: home }));
  }
  return findings;
}
