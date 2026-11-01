import { checkEngines } from './engine.ts';
import { finding, type Finding } from './findings.ts';
import { runTool, type ToolRunner } from './process.ts';
import {
  keyEnvName,
  PROVIDERS,
  resolveApiKey,
  SecretStoreUnavailable,
  type ProviderId,
  type SecretStore,
} from './secrets.ts';
import { checkWorkspace } from './workspace.ts';

const MINIMUM_NODE_MAJOR = 24;

export interface DoctorOptions {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly store: SecretStore;
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly tool?: ToolRunner;
}

function checkNode(version: string): Finding {
  const major = Number.parseInt(version, 10);
  return major >= MINIMUM_NODE_MAJOR
    ? finding('node.ok', 'info', { version })
    : finding('node.too_old', 'fail', { version, minimum: String(MINIMUM_NODE_MAJOR) });
}

// 動態載入：Node 太舊時內建模組不存在，要回報成發現，不是整支程式起不來。
async function checkSqlite(): Promise<Finding> {
  try {
    const { sqliteVersion } = await import('./store.ts');
    return finding('sqlite.ok', 'info', { version: sqliteVersion() });
  } catch {
    return finding('sqlite.unavailable', 'fail');
  }
}

async function checkUv(env: NodeJS.ProcessEnv, tool: ToolRunner): Promise<Finding> {
  const result = await tool('uv', ['--version'], env);
  if (result === null) return finding('uv.missing', 'info');
  const version = /\d+\.\d+\.\d+/.exec(result.stdout)?.[0] ?? result.stdout.trim();
  return finding('uv.ok', 'info', { version });
}

async function checkKey(
  provider: ProviderId,
  env: NodeJS.ProcessEnv,
  store: SecretStore,
): Promise<Finding[]> {
  const missing = finding('key.missing', 'fail', { provider, env: keyEnvName(provider) });
  try {
    const resolved = await resolveApiKey(provider, env, store);
    if (resolved === null) return [missing];
    return [finding('key.ok', 'info', { provider, source: resolved.source })];
  } catch (error) {
    if (!(error instanceof SecretStoreUnavailable)) throw error;
    return [finding('keyring.unavailable', 'warn', { env: keyEnvName(provider) }), missing];
  }
}

export async function runDoctor(options: DoctorOptions): Promise<Finding[]> {
  const {
    home,
    env,
    store,
    nodeVersion = process.versions.node,
    platform = process.platform,
    tool = runTool,
  } = options;
  const keys = await Promise.all(PROVIDERS.map((provider) => checkKey(provider, env, store)));
  return [
    checkNode(nodeVersion),
    await checkSqlite(),
    await checkUv(env, tool),
    ...keys.flat(),
    ...checkWorkspace(home, env, platform),
    ...(await checkEngines(home, env, tool, platform)),
    finding('prices.pending', 'info'),
  ];
}
