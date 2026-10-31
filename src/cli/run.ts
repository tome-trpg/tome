import { createRequire } from 'node:module';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { runDoctor } from '../core/doctor.ts';
import { TomeError } from '../core/errors.ts';
import { exitCodeOf, finding, type Finding } from '../core/findings.ts';
import type { ToolRunner } from '../core/process.ts';
import {
  isProvider,
  normalizeKey,
  osSecretStore,
  PROVIDERS,
  SecretStoreUnavailable,
  keyEnvName,
  type SecretStore,
} from '../core/secrets.ts';
import { initWorkspace, resolveHome } from '../core/workspace.ts';
import { errorText, promptText, usageText, workspaceTemplate } from './messages.ts';
import { errorEnvelope, renderFinding, successEnvelope } from './output.ts';
import { readSecret, type SecretInput } from './read-secret.ts';

export interface Writable {
  write(text: string): unknown;
}

export interface Io {
  readonly stdin: SecretInput;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly secrets?: SecretStore;
  readonly tool?: ToolRunner;
}

interface Result {
  readonly data: Readonly<Record<string, unknown>>;
  readonly findings: readonly Finding[];
}

interface Parsed {
  readonly values: Readonly<Record<string, string | boolean | undefined>>;
  readonly positionals: readonly string[];
}

interface Command {
  readonly path: readonly string[];
  readonly options: NonNullable<ParseArgsConfig['options']>;
  readonly positionals: number;
  run(parsed: Parsed, io: Io): Promise<Result>;
}

function secretStore(io: Io): SecretStore {
  return io.secrets ?? osSecretStore();
}

const COMMANDS: readonly Command[] = [
  {
    path: ['init'],
    options: { vault: { type: 'string' } },
    positionals: 0,
    run: async ({ values }, io) => {
      const home = resolveHome(io.env, io.platform);
      const vault = values['vault'];
      const findings = initWorkspace({
        home,
        vaultPath: typeof vault === 'string' ? vault : undefined,
        env: io.env,
        template: workspaceTemplate,
        ...(io.platform === undefined ? {} : { platform: io.platform }),
      });
      return { data: { home }, findings };
    },
  },
  {
    path: ['doctor'],
    options: {},
    positionals: 0,
    run: async (_parsed, io) => {
      const home = resolveHome(io.env, io.platform);
      const findings = await runDoctor({
        home,
        env: io.env,
        store: secretStore(io),
        ...(io.platform === undefined ? {} : { platform: io.platform }),
        ...(io.tool === undefined ? {} : { tool: io.tool }),
      });
      return { data: { home }, findings };
    },
  },
  {
    path: ['provider', 'auth', 'set'],
    options: {},
    positionals: 1,
    run: async ({ positionals }, io) => {
      const provider = positionals[0];
      if (provider === undefined) {
        throw new TomeError('cli.missing_argument', { argument: '<provider>' });
      }
      if (!isProvider(provider)) {
        // 不回顯這個值：使用者可能把金鑰貼在這裡。
        throw new TomeError('provider.unknown', { supported: PROVIDERS.join(', ') });
      }
      // 提示走 stderr，`--json` 的 stdout 不受影響。
      const input = await readSecret(io.stdin, () => {
        io.stderr.write(promptText('secret', { provider }));
      });
      const key = normalizeKey(input);
      try {
        await secretStore(io).set(provider, key);
      } catch (error) {
        if (!(error instanceof SecretStoreUnavailable)) throw error;
        return {
          data: { provider },
          findings: [finding('keyring.unavailable', 'fail', { env: keyEnvName(provider) })],
        };
      }
      return { data: { provider }, findings: [finding('key.stored', 'info', { provider })] };
    },
  },
];

function findCommand(argv: readonly string[]): Command | null {
  return (
    COMMANDS.find((command) => command.path.every((word, index) => argv[index] === word)) ?? null
  );
}

function parseCommand(command: Command, argv: readonly string[]): Parsed {
  try {
    const { values, positionals } = parseArgs({
      args: argv.slice(command.path.length),
      options: command.options,
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > command.positionals) throw new TomeError('cli.bad_args');
    return { values: values as Parsed['values'], positionals };
  } catch (error) {
    if (error instanceof TomeError) throw error;
    const code = (error as { code?: string }).code;
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      const option = /'(-[^']*)'/.exec(String(error))?.[1] ?? '';
      throw new TomeError('cli.unknown_option', { option });
    }
    throw new TomeError('cli.bad_args');
  }
}

function packageVersion(): string {
  const require = createRequire(import.meta.url);
  return (require('../../package.json') as { version: string }).version;
}

function toTomeError(error: unknown): TomeError {
  // 未預期的錯誤只留代碼：錯誤物件可能帶著金鑰或書本文字。
  return error instanceof TomeError ? error : new TomeError('cli.internal');
}

/** 回傳結束碼。0 正常、1 有發現、2 結果不可信（ADR-0059）。 */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const json = argv.includes('--json');
  const args = argv.filter((token) => token !== '--json');
  try {
    if (args.length === 0 || args.includes('--help')) {
      io.stdout.write(usageText);
      return 0;
    }
    if (args[0] === '--version') {
      io.stdout.write(`${packageVersion()}\n`);
      return 0;
    }
    const matched = findCommand(args);
    if (matched === null) {
      // 不回顯輸入：使用者可能把金鑰貼在這裡。
      throw new TomeError('cli.unknown_command');
    }
    const parsed = parseCommand(matched, args);
    const { data, findings } = await matched.run(parsed, io);
    const exit = exitCodeOf(findings);
    if (json) {
      io.stdout.write(`${JSON.stringify(successEnvelope(exit === 0, data, findings))}\n`);
    } else {
      for (const item of findings) io.stdout.write(renderFinding(item));
    }
    return exit;
  } catch (raw) {
    const error = toTomeError(raw);
    if (json) io.stdout.write(`${JSON.stringify(errorEnvelope(error))}\n`);
    else io.stderr.write(`${errorText(error.code, error.params)}\n`);
    return 2;
  }
}
