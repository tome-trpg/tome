import { createRequire } from 'node:module';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { addBook, probeBook, type ProbeOutcome } from '../core/book.ts';
import { runDoctor } from '../core/doctor.ts';
import { addEngine, listEngines, removeEngine } from '../core/engine.ts';
import { TomeError } from '../core/errors.ts';
import { extractBook } from '../core/extract.ts';
import { exitCodeOf, finding, type Finding } from '../core/findings.ts';
import { lintPack } from '../core/pack-lint.ts';
import { testPack } from '../core/pack-test.ts';
import { createPack, listPacks, locatePack } from '../core/pack.ts';
import { detectGpu } from '../core/probe.ts';
import { runTool, type StreamRunner, type ToolRunner } from '../core/process.ts';
import {
  isProvider,
  normalizeKey,
  osSecretStore,
  PROVIDERS,
  SecretStoreUnavailable,
  keyEnvName,
  type SecretStore,
} from '../core/secrets.ts';
import { initWorkspace, readWorkspaceConfig, resolveHome } from '../core/workspace.ts';
import {
  errorText,
  packTemplate,
  progressText,
  promptText,
  usageText,
  workspaceTemplate,
} from './messages.ts';
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
  readonly stream?: StreamRunner;
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

/** 只有指定了才傳，測試才換得掉，core 也才有自己的預設值。 */
function hostOptions(io: Io): Pick<Io, 'env' | 'platform' | 'tool' | 'stream'> {
  return {
    env: io.env,
    ...(io.platform === undefined ? {} : { platform: io.platform }),
    ...(io.tool === undefined ? {} : { tool: io.tool }),
    ...(io.stream === undefined ? {} : { stream: io.stream }),
  };
}

function stringValue(parsed: Parsed, name: string): string | undefined {
  const value = parsed.values[name];
  return typeof value === 'string' ? value : undefined;
}

/** 只有數字與路徑。書籤標題這類書本文字留在工作區（ADR-0059）。 */
function probeFindings({ summary, reused }: ProbeOutcome): Finding[] {
  const { kinds, assigned } = summary;
  const skipped = summary.pages - kinds.native;
  return [
    ...(reused ? [finding('probe.unchanged', 'info')] : []),
    finding('probe.done', 'info', {
      pages: String(summary.pages),
      native: String(kinds.native),
      scan: String(kinds.scan),
      broken_text: String(kinds.broken_text),
      image_only: String(kinds.image_only),
    }),
    finding('probe.structure', 'info', {
      tagged: summary.tagged ? 'yes' : 'no',
      outline: String(summary.outline_items),
      unresolved: String(summary.outline_unresolved),
      labels: String(summary.label_pages),
      links: String(summary.links),
    }),
    ...(summary.spread ? [finding('probe.spread', 'warn')] : []),
    ...(skipped > 0 ? [finding('probe.pages_skipped', 'warn', { count: String(skipped) })] : []),
    assigned > 0
      ? finding('probe.assigned', 'info', { count: String(assigned) })
      : finding('probe.no_engine', 'info'),
  ];
}

async function gpuFinding(io: Io): Promise<Finding> {
  const gpu = await detectGpu(io.env, io.tool ?? runTool);
  if (gpu === null) return finding('probe.no_gpu', 'info');
  return finding('probe.gpu', 'info', { name: gpu.name, vram: String(gpu.vram_mb) });
}

const PROGRESS_EVERY = 10;

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
    path: ['add'],
    options: {
      as: { type: 'string' },
      system: { type: 'string' },
      'source-lang': { type: 'string' },
    },
    positionals: 1,
    run: async (parsed, io) => {
      const pdf = parsed.positionals[0];
      if (pdf === undefined) throw new TomeError('cli.missing_argument', { argument: '<pdf>' });
      const result = await addBook({
        home: resolveHome(io.env, io.platform),
        pdf,
        name: stringValue(parsed, 'as'),
        system: stringValue(parsed, 'system'),
        sourceLang: stringValue(parsed, 'source-lang'),
      });
      if (result.probe === undefined) {
        return { data: { book: result.book ?? null }, findings: result.findings };
      }
      return {
        data: { book: result.book ?? null, probe: result.probe.summary },
        findings: [...result.findings, ...probeFindings(result.probe), await gpuFinding(io)],
      };
    },
  },
  {
    path: ['probe'],
    options: {},
    positionals: 1,
    run: async ({ positionals }, io) => {
      const book = positionals[0];
      if (book === undefined) throw new TomeError('cli.missing_argument', { argument: '<book>' });
      const outcome = await probeBook(resolveHome(io.env, io.platform), book);
      return {
        data: { book, probe: outcome.summary },
        findings: [...probeFindings(outcome), await gpuFinding(io)],
      };
    },
  },
  {
    path: ['extract'],
    options: {},
    positionals: 1,
    run: async ({ positionals }, io) => {
      const slug = positionals[0];
      if (slug === undefined) throw new TomeError('cli.missing_argument', { argument: '<book>' });
      const { data, findings } = await extractBook({
        ...hostOptions(io),
        home: resolveHome(io.env, io.platform),
        slug,
        onPage: (done, total) => {
          // 進度走 stderr，`--json` 的 stdout 不受影響。
          if (done % PROGRESS_EVERY === 0 || done === total) {
            io.stderr.write(progressText('page', { done: String(done), total: String(total) }));
          }
        },
      });
      return { data: { book: slug, ...data }, findings };
    },
  },
  {
    path: ['engine', 'add'],
    options: { gpu: { type: 'boolean' } },
    positionals: 1,
    run: async ({ positionals, values }, io) => {
      const target = positionals[0];
      if (target === undefined) throw new TomeError('cli.missing_argument', { argument: '<engine>' });
      const { engine, findings } = await addEngine({
        ...hostOptions(io),
        home: resolveHome(io.env, io.platform),
        target,
        gpu: values['gpu'] === true,
        onStage: (stage) => io.stderr.write(progressText(stage)),
      });
      return { data: { engine: engine ?? null }, findings };
    },
  },
  {
    path: ['engine', 'list'],
    options: {},
    positionals: 0,
    run: async (_parsed, io) => {
      const engines = listEngines(resolveHome(io.env, io.platform));
      const findings = engines.map(({ name, version, device, code_license, weights_license }) =>
        finding('engine.listed', 'info', {
          name,
          version,
          device,
          code: code_license,
          weights: weights_license,
        }),
      );
      return { data: { engines }, findings: engines.length > 0 ? findings : [finding('engine.none', 'info')] };
    },
  },
  {
    path: ['engine', 'remove'],
    options: {},
    positionals: 1,
    run: async ({ positionals }, io) => {
      const name = positionals[0];
      if (name === undefined) throw new TomeError('cli.missing_argument', { argument: '<engine>' });
      return { data: { engine: name }, findings: removeEngine(resolveHome(io.env, io.platform), name) };
    },
  },
  {
    path: ['system', 'new'],
    options: {},
    positionals: 1,
    run: async ({ positionals }, io) => {
      const id = positionals[0];
      if (id === undefined) throw new TomeError('cli.missing_argument', { argument: '<id>' });
      const home = resolveHome(io.env, io.platform);
      if (readWorkspaceConfig(home) === null) {
        return { data: { id }, findings: [finding('workspace.missing', 'fail', { path: home })] };
      }
      return { data: { id }, findings: createPack(home, id, packTemplate(id)) };
    },
  },
  {
    path: ['system', 'list'],
    options: {},
    positionals: 0,
    run: async (_parsed, io) => {
      const packs = listPacks(resolveHome(io.env, io.platform));
      const findings = packs.map(({ id, version, source }) =>
        finding('pack.listed', 'info', { id, version, source }),
      );
      return { data: { packs }, findings: packs.length > 0 ? findings : [finding('pack.none', 'info')] };
    },
  },
  {
    path: ['system', 'lint'],
    options: { public: { type: 'boolean' } },
    positionals: 1,
    run: async ({ positionals, values }, io) => {
      const target = positionals[0];
      if (target === undefined) throw new TomeError('cli.missing_argument', { argument: '<id>' });
      const home = resolveHome(io.env, io.platform);
      const findings = await lintPack(home, locatePack(home, target), {
        public: values['public'] === true,
      });
      return { data: { pack: target }, findings };
    },
  },
  {
    path: ['system', 'test'],
    options: {},
    positionals: 1,
    run: async ({ positionals }, io) => {
      const target = positionals[0];
      if (target === undefined) throw new TomeError('cli.missing_argument', { argument: '<id>' });
      const home = resolveHome(io.env, io.platform);
      return { data: { pack: target }, findings: await testPack(home, locatePack(home, target)) };
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
      const input = await readSecret(io.stdin, io.stderr, promptText('secret', { provider }));
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
