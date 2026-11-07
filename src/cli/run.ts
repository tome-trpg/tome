import { createRequire } from 'node:module';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import {
  batchStatus,
  cancelBatches,
  collectBatches,
  translateInBatches,
  type BatchCommandOptions,
  type BatchOptions,
} from '../core/batch.ts';
import { addBook, probeBook, type ProbeOutcome } from '../core/book.ts';
import { runDoctor } from '../core/doctor.ts';
import { addEngine, listEngines, removeEngine } from '../core/engine.ts';
import { TomeError } from '../core/errors.ts';
import { extractBook } from '../core/extract.ts';
import { exitCodeOf, finding, type Finding } from '../core/findings.ts';
import type { LLMHost, OnRetry } from '../core/llm.ts';
import { lintPack } from '../core/pack-lint.ts';
import { testPack } from '../core/pack-test.ts';
import { createPack, listPacks, locatePack } from '../core/pack.ts';
import { previewBook } from '../core/preview.ts';
import { detectGpu } from '../core/probe.ts';
import { runTool, type StreamRunner, type ToolRunner } from '../core/process.ts';
import { testProvider } from '../core/provider-test.ts';
import { listProviders, type RequestMode } from '../core/provider.ts';
import { dryRunBook, estimateBook } from '../core/request.ts';
import {
  isProvider,
  normalizeKey,
  osSecretStore,
  PROVIDERS,
  resolveApiKey,
  SecretStoreUnavailable,
  keyEnvName,
  type SecretStore,
} from '../core/secrets.ts';
import { bookStatus } from '../core/status.ts';
import { translateBook } from '../core/translate.ts';
import { verifyBook } from '../core/verify.ts';
import {
  initWorkspace,
  readWorkspaceConfig,
  resolveHome,
  workspaceTargetLang,
} from '../core/workspace.ts';
import {
  argumentText,
  errorText,
  flagText,
  packTemplate,
  progressText,
  promptText,
  usageText,
  workspaceTemplate,
  type ArgumentKey,
} from './messages.ts';
import { errorEnvelope, renderFinding, successEnvelope } from './output.ts';
import { EngineProgress, systemClock, type Clock } from './progress.ts';
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
  /** 測試才給，把端點指到本機的假供應商。沒給就用使用者的金鑰接 Anthropic（ADR-0109 第 5 項）。 */
  readonly llm?: LLMHost;
  /** 進度依時間印，測試注入自己的時鐘（ADR-0111）。 */
  readonly clock?: Clock;
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

function missing(key: ArgumentKey): TomeError {
  return new TomeError('cli.missing_argument', { argument: argumentText(key) });
}

function stringValue(parsed: Parsed, name: string): string | undefined {
  const value = parsed.values[name];
  return typeof value === 'string' ? value : undefined;
}

function requestMode(values: Parsed['values']): RequestMode {
  return values['realtime'] === true ? 'realtime' : 'batch';
}

/** 機器要讀的值放 `data`（ADR-0091）。 */
function probeData({ summary, suggestion }: ProbeOutcome): Readonly<Record<string, unknown>> {
  return { ...summary, suggested_pack: suggestion };
}

/** 只有數字與路徑。書籤標題這類書本文字留在工作區（ADR-0059）。 */
function probeFindings({ summary, reused, suggestion, findings }: ProbeOutcome): Finding[] {
  const { kinds, assigned } = summary;
  const skipped = summary.pages - kinds.native;
  return [
    ...(reused ? [finding('probe.unchanged', 'info')] : []),
    finding('probe.done', 'info', {
      pages: String(summary.pages),
      native: String(kinds.native),
      full_image: String(kinds.full_image),
      broken_text: String(kinds.broken_text),
      image_only: String(kinds.image_only),
    }),
    finding('probe.structure', 'info', {
      tagged: flagText(summary.tagged),
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
    ...findings,
    ...(suggestion === null
      ? []
      : [
          finding('probe.pack_suggested', 'info', {
            id: suggestion.id,
            keyword_pages: String(suggestion.keyword_pages),
            pattern_pages: String(suggestion.pattern_pages),
          }),
        ]),
  ];
}

async function gpuFinding(io: Io): Promise<Finding> {
  const gpu = await detectGpu(io.env, io.tool ?? runTool);
  if (gpu === null) return finding('probe.no_gpu', 'info');
  return finding('probe.gpu', 'info', { name: gpu.name, vram: String(gpu.vram_mb) });
}

/** 探測要跑一陣子，先說要探測幾頁（ADR-0111）。 */
function probeProgress(io: Io): (pages: number) => void {
  return (pages) => io.stderr.write(progressText('probe', { pages: String(pages) }));
}

/** 重試之前說幾秒後重試、第幾次，退避時才不會整段沒有輸出（ADR-0111）。 */
function retryProgress(io: Io): OnRetry {
  return (status, seconds, attempt, max) =>
    io.stderr.write(
      progressText('retry', {
        status: String(status ?? '-'),
        seconds: String(seconds),
        attempt: String(attempt),
        max: String(max),
      }),
    );
}

/**
 * 要連網的指令一開始先取金鑰，沒有就停下，不開書也不連網（ADR-0034、ADR-0109 第 5 項）。
 * 轉接層延後載入，不連網的指令不用載入 SDK。
 */
async function llmHost(io: Io): Promise<LLMHost | Finding> {
  if (io.llm !== undefined) return io.llm;
  const env = keyEnvName('anthropic');
  let resolved: Awaited<ReturnType<typeof resolveApiKey>>;
  try {
    resolved = await resolveApiKey('anthropic', io.env, secretStore(io));
  } catch (error) {
    if (!(error instanceof SecretStoreUnavailable)) throw error;
    return finding('keyring.unavailable', 'fail', { env });
  }
  if (resolved === null) return finding('key.missing', 'fail', { provider: 'anthropic', env });
  const { anthropicHost } = await import('../core/egress/anthropic.ts');
  return anthropicHost(resolved.key);
}

/** 拿得到轉接層才做，拿不到就回報原因。 */
async function withHost(io: Io, data: Result['data'], work: (host: LLMHost) => Promise<Result>): Promise<Result> {
  const host = await llmHost(io);
  return 'level' in host ? { data, findings: [host] } : work(host);
}

/** 進度走 stderr，`--json` 的 stdout 不受影響。 */
function progressOf(io: Io): Pick<BatchOptions, 'onProgress' | 'onBatchSent' | 'onBatchWait' | 'onStart' | 'onRetry'> {
  return {
    onStart: (mode, requests) =>
      io.stderr.write(progressText(mode === 'realtime' ? 'translate_realtime' : 'translate_batch', { requests: String(requests) })),
    onRetry: retryProgress(io),
    onProgress: (done, total) => io.stderr.write(progressText('unit', { done: String(done), total: String(total) })),
    onBatchSent: (batch, requests) =>
      io.stderr.write(progressText('batch_sent', { batch: String(batch), requests: String(requests) })),
    onBatchWait: (batch, minutes) =>
      io.stderr.write(progressText('batch_wait', { batch: String(batch), minutes: String(minutes) })),
  };
}

/** `tome batch` 的三個指令都要連到供應商（ADR-0107 第 1 項、ADR-0109 第 6 項）。 */
async function withBook(
  positionals: readonly string[],
  io: Io,
  work: (options: BatchCommandOptions) => Promise<Result>,
): Promise<Result> {
  const slug = positionals[0];
  if (slug === undefined) throw missing('book');
  return withHost(io, { book: slug }, (host) =>
    work({ home: resolveHome(io.env, io.platform), slug, host, onRetry: retryProgress(io) }),
  );
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
    path: ['add'],
    options: {
      as: { type: 'string' },
      system: { type: 'string' },
      'source-lang': { type: 'string' },
    },
    positionals: 1,
    run: async (parsed, io) => {
      const pdf = parsed.positionals[0];
      if (pdf === undefined) throw missing('pdf');
      const result = await addBook({
        home: resolveHome(io.env, io.platform),
        pdf,
        name: stringValue(parsed, 'as'),
        system: stringValue(parsed, 'system'),
        sourceLang: stringValue(parsed, 'source-lang'),
        onProbe: probeProgress(io),
      });
      if (result.probe === undefined) {
        return { data: { book: result.book ?? null }, findings: result.findings };
      }
      return {
        data: { book: result.book ?? null, probe: probeData(result.probe) },
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
      if (book === undefined) throw missing('book');
      const outcome = await probeBook(resolveHome(io.env, io.platform), book, probeProgress(io));
      return {
        data: { book, probe: probeData(outcome) },
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
      if (slug === undefined) throw missing('book');
      // 進度走 stderr，`--json` 的 stdout 不受影響（ADR-0111）。
      const write = (text: string): unknown => io.stderr.write(text);
      const engine = new EngineProgress(io.clock ?? systemClock, write);
      try {
        const { data, findings } = await extractBook({
          ...hostOptions(io),
          home: resolveHome(io.env, io.platform),
          slug,
          onProbe: probeProgress(io),
          onEngineStart: ({ name, device, pages }) => engine.start(name, device, pages),
          onPage: (done, total) => engine.page(done, total),
          onEngineEnd: () => engine.end(),
          onAssemble: () => write(progressText('assemble')),
        });
        return { data: { book: slug, ...data }, findings };
      } finally {
        engine.end();
      }
    },
  },
  {
    path: ['estimate'],
    options: {
      budget: { type: 'string' },
      chapters: { type: 'string' },
      'chapter-level': { type: 'string' },
      confirm: { type: 'boolean' },
      realtime: { type: 'boolean' },
    },
    positionals: 1,
    run: async (parsed, io) => {
      const slug = parsed.positionals[0];
      if (slug === undefined) throw missing('book');
      return estimateBook({
        home: resolveHome(io.env, io.platform),
        slug,
        budget: stringValue(parsed, 'budget'),
        chapters: stringValue(parsed, 'chapters'),
        chapterLevel: stringValue(parsed, 'chapter-level'),
        confirm: parsed.values['confirm'] === true,
        mode: requestMode(parsed.values),
      });
    },
  },
  {
    path: ['translate'],
    options: {
      'dry-run': { type: 'boolean' },
      realtime: { type: 'boolean' },
      'retry-failed': { type: 'boolean' },
    },
    positionals: 1,
    run: async ({ positionals, values }, io) => {
      const slug = positionals[0];
      if (slug === undefined) throw missing('book');
      const home = resolveHome(io.env, io.platform);
      const mode = requestMode(values);
      const retryFailed = values['retry-failed'] === true;
      if (values['dry-run'] === true) {
        // 試算沒算到要重試的單位，一起用數字會誤導（ADR-0104）。
        if (retryFailed) throw new TomeError('cli.bad_args');
        return dryRunBook(home, slug, mode);
      }
      return withHost(io, { book: slug }, (host) => {
        const options = { home, slug, host, retryFailed, ...progressOf(io) };
        return mode === 'realtime' ? translateBook(options) : translateInBatches(options);
      });
    },
  },
  {
    path: ['batch', 'status'],
    options: {},
    positionals: 1,
    run: ({ positionals }, io) => withBook(positionals, io, (options) => batchStatus(options)),
  },
  {
    path: ['batch', 'collect'],
    options: {},
    positionals: 1,
    run: ({ positionals }, io) =>
      withBook(positionals, io, (options) => collectBatches({ ...options, retryFailed: false, ...progressOf(io) })),
  },
  {
    path: ['batch', 'cancel'],
    options: {},
    positionals: 1,
    run: ({ positionals }, io) => withBook(positionals, io, (options) => cancelBatches(options)),
  },
  {
    path: ['status'],
    options: {},
    positionals: 1,
    run: async ({ positionals }, io) => {
      const slug = positionals[0];
      if (slug === undefined) throw missing('book');
      return bookStatus(resolveHome(io.env, io.platform), slug);
    },
  },
  {
    path: ['preview'],
    options: {},
    positionals: 1,
    run: async ({ positionals }, io) => {
      const slug = positionals[0];
      if (slug === undefined) throw missing('book');
      return previewBook(resolveHome(io.env, io.platform), slug);
    },
  },
  {
    path: ['verify'],
    options: {},
    positionals: 1,
    run: async ({ positionals }, io) => {
      const slug = positionals[0];
      if (slug === undefined) throw missing('book');
      const { data, findings } = await verifyBook(resolveHome(io.env, io.platform), slug);
      return { data: { book: slug, ...data }, findings };
    },
  },
  {
    path: ['engine', 'add'],
    options: { gpu: { type: 'boolean' } },
    positionals: 1,
    run: async ({ positionals, values }, io) => {
      const target = positionals[0];
      if (target === undefined) throw missing('engine_target');
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
      if (name === undefined) throw missing('engine');
      return { data: { engine: name }, findings: removeEngine(resolveHome(io.env, io.platform), name) };
    },
  },
  {
    path: ['system', 'new'],
    options: {},
    positionals: 1,
    run: async ({ positionals }, io) => {
      const id = positionals[0];
      if (id === undefined) throw missing('pack_id');
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
      if (target === undefined) throw missing('pack_target');
      const home = resolveHome(io.env, io.platform);
      const findings = await lintPack(home, locatePack(home, target), {
        public: values['public'] === true,
        targetLang: workspaceTargetLang(home),
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
      if (target === undefined) throw missing('pack_target');
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
      if (provider === undefined) throw missing('provider');
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
  {
    path: ['provider', 'list'],
    options: {},
    positionals: 0,
    run: async () => listProviders(),
  },
  {
    path: ['provider', 'test'],
    options: {},
    positionals: 0,
    run: (_parsed, io) => withHost(io, { provider: 'anthropic' }, (host) => testProvider(host, retryProgress(io))),
  },
];

function findCommand(argv: readonly string[]): Command | null {
  return (
    COMMANDS.find((command) => command.path.every((word, index) => argv[index] === word)) ?? null
  );
}

/**
 * 說收到幾個、只接受幾個，不回顯多出來的值：`tome provider auth set anthropic <金鑰>` 會讓金鑰成為
 * 多出來的參數，PDF 的路徑也常含書名（ADR-0114）。路徑有空格沒加引號時，就會被切成好幾個參數。
 */
function extraArguments(command: Command, received: number): TomeError {
  const params = { command: ['tome', ...command.path].join(' '), received: String(received) };
  if (command.positionals === 0) return new TomeError('cli.no_arguments', params);
  return new TomeError('cli.extra_arguments', { ...params, expected: String(command.positionals) });
}

function parseCommand(command: Command, argv: readonly string[]): Parsed {
  try {
    const { values, positionals } = parseArgs({
      args: argv.slice(command.path.length),
      options: command.options,
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > command.positionals) throw extraArguments(command, positionals.length);
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
