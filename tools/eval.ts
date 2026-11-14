import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { browserCommand } from '../src/cli/review/web.ts';
import type { LLMHost } from '../src/core/llm.ts';
import { runTool, type ToolRunner } from '../src/core/process.ts';
import { osSecretStore, resolveApiKey, type SecretStore } from '../src/core/secrets.ts';
import { resolveHome } from '../src/core/workspace.ts';
import { estimateAll, readInstructionsFile, readOutputs, runAll, VARIANTS, ESTIMATE_FILE } from './eval-run.ts';
import { renderReport, results, sdkVersion } from './eval-report.ts';
import { BLIND_FILE, buildBlind, fill, readBlind, readScores, secretRandom, startScoreServer } from './eval-score.ts';
import { readPassages, REVIEW_FILE, selectPassages, sourceTexts, type BookSpec } from './eval-select.ts';
import texts from './eval/texts.json' with { type: 'json' };

// 盲評的工具（ADR-0139）：維護者在自己的電腦、用自己的金鑰跑，不隨套件發佈。
// 步驟：select 挑段落 → estimate 試算 → run 送出 → score 評分 → report 寫報告。結束碼：0 正常、1 停下來了、2 用法錯了。

const SEED = 48;
const QUOTAS = { orc: 60, cthulhu: 40 } as const;
const CLI = texts.cli;

export interface EvalIo {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly write: (text: string) => void;
  /** 測試給假的供應商；沒給就用維護者的金鑰。 */
  readonly host?: LLMHost;
  readonly secrets?: SecretStore;
  readonly tool?: ToolRunner;
  /** 評分頁開著時等使用者結束；沒給就等 Ctrl+C。 */
  readonly stopped?: () => Promise<void>;
  readonly instructions?: string;
  readonly today?: () => Date;
}

function untilInterrupted(): Promise<void> {
  return new Promise((resolve) => process.once('SIGINT', () => resolve()));
}

async function hostOf(io: EvalIo): Promise<LLMHost | null> {
  if (io.host !== undefined) return io.host;
  const resolved = await resolveApiKey('anthropic', io.env, io.secrets ?? osSecretStore());
  if (resolved === null) return null;
  const { anthropicHost } = await import('../src/core/egress/anthropic.ts');
  return anthropicHost(resolved.key);
}

function usd(value: number): string {
  return value.toFixed(2);
}

export async function main(argv: readonly string[], io: EvalIo): Promise<number> {
  const [command, ...rest] = argv;
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: [...rest],
      options: {
        dir: { type: 'string' },
        orc: { type: 'string' },
        cthulhu: { type: 'string' },
        seed: { type: 'string' },
        exclude: { type: 'string' },
        commit: { type: 'string' },
        out: { type: 'string' },
        'no-open': { type: 'boolean' },
      },
      strict: true,
    }).values;
  } catch {
    io.write(CLI.usage);
    return 2;
  }
  const dir = typeof values['dir'] === 'string' ? values['dir'] : undefined;
  if (dir === undefined) {
    io.write(CLI.usage);
    return 2;
  }
  mkdirSync(dir, { recursive: true });
  const instructions = (): string => io.instructions ?? readInstructionsFile();

  if (command === 'select') {
    const previous = readPassages(dir);
    const orc = typeof values['orc'] === 'string' ? values['orc'] : previous?.books.find(({ label }) => label === 'orc')?.slug;
    const cthulhu = typeof values['cthulhu'] === 'string' ? values['cthulhu'] : previous?.books.find(({ label }) => label === 'cthulhu')?.slug;
    if (orc === undefined || cthulhu === undefined) {
      io.write(CLI.usage);
      return 2;
    }
    const seed = typeof values['seed'] === 'string' ? Number(values['seed']) : (previous?.seed ?? SEED);
    if (!Number.isInteger(seed)) {
      io.write(CLI.usage);
      return 2;
    }
    // 剔除的照上一次的段號換成段落的鍵，跟之前剔除的一起跳過。
    const asked = typeof values['exclude'] === 'string' ? values['exclude'].split(',').map((id) => id.trim()) : [];
    const keys = asked.flatMap((id) => previous?.passages.filter((passage) => passage.id === id).map(({ key }) => key) ?? []);
    const books: BookSpec[] = [
      { label: 'orc', slug: orc, quota: QUOTAS.orc },
      { label: 'cthulhu', slug: cthulhu, quota: QUOTAS.cthulhu },
    ];
    const file = await selectPassages({ dir, home: resolveHome(io.env, io.platform), books, seed, excluded: [...(previous?.excluded ?? []), ...keys] });
    const counts = books.map(({ label }) => `${label} ${file.passages.filter(({ book }) => book === label).length}`).join('、');
    io.write(fill(CLI.selected, { count: String(file.passages.length), books: counts, review: join(dir, REVIEW_FILE) }));
    return 0;
  }

  const file = readPassages(dir);
  if (file === null) {
    io.write(CLI.no_passages);
    return 1;
  }

  if (command === 'estimate') {
    const estimate = await estimateAll(dir, file, instructions);
    for (const variant of estimate.variants) {
      const requests = variant.books.reduce((sum, { requests: count }) => sum + count, 0);
      io.write(fill(CLI.estimate_line, { code: variant.code, model: variant.model, requests: String(requests), low: usd(variant.estimate.low_usd), high: usd(variant.estimate.high_usd) }));
    }
    io.write(fill(CLI.estimate_total, { low: usd(estimate.estimate.low_usd), high: usd(estimate.estimate.high_usd), budget: usd(estimate.budget_usd) }));
    if (estimate.over) {
      io.write(fill(CLI.over, { budget: usd(estimate.budget_usd) }));
      return 1;
    }
    return 0;
  }

  if (command === 'run') {
    const { readFileSync, existsSync } = await import('node:fs');
    const path = join(dir, ESTIMATE_FILE);
    if (!existsSync(path)) {
      io.write(CLI.no_estimate);
      return 1;
    }
    const estimate = JSON.parse(readFileSync(path, 'utf8')) as Parameters<typeof runAll>[2];
    if (estimate.over) {
      io.write(fill(CLI.over, { budget: usd(estimate.budget_usd) }));
      return 1;
    }
    const host = await hostOf(io);
    if (host === null) {
      io.write(CLI.no_key);
      return 1;
    }
    const { outputs, stop } = await runAll(dir, file, estimate, host, instructions, {
      onVariant: (code, book) => io.write(fill(CLI.variant, { code, book })),
      onBatchSent: (batch, requests, planned) => io.write(fill(CLI.batch_sent, { batch: String(batch), requests: String(requests), planned: String(planned) })),
      onBatchWait: (_batch, minutes) => io.write(fill(CLI.batch_wait, { minutes: String(minutes) })),
      onRetry: (_status, seconds, attempt) => io.write(fill(CLI.retry, { attempt: String(attempt), seconds: String(seconds) })),
    });
    const spent = Object.values(outputs).reduce((sum, item) => sum + item.spent_usd, 0);
    if (stop !== null) {
      io.write(fill(CLI.stopped, { code: stop.code, spent: usd(spent) }));
      return 1;
    }
    io.write(fill(CLI.ran, { spent: usd(spent) }));
    return 0;
  }

  if (command === 'score') {
    const outputs = readOutputs(dir);
    let blind = readBlind(dir);
    if (blind === null) {
      try {
        blind = buildBlind(outputs, file, VARIANTS.map(({ code }) => code), secretRandom);
      } catch {
        io.write(CLI.no_outputs);
        return 1;
      }
      writeFileSync(join(dir, BLIND_FILE), `${JSON.stringify(blind, null, 2)}\n`);
    }
    const server = await startScoreServer({ dir, blind, outputs, sources: await sourceTexts(dir, file) });
    try {
      io.write(fill(CLI.score, { url: server.url }));
      if (values['no-open'] !== true) {
        const { command: opener, args } = browserCommand(server.url, io.platform);
        void (io.tool ?? runTool)(opener, args, io.env).then((result) => {
          if (result === null) io.write(CLI.no_browser);
        });
      }
      await (io.stopped ?? untilInterrupted)();
    } finally {
      await server.close();
    }
    return 0;
  }

  if (command === 'report') {
    const commit = typeof values['commit'] === 'string' ? values['commit'] : undefined;
    const out = typeof values['out'] === 'string' ? values['out'] : undefined;
    if (commit === undefined || out === undefined) {
      io.write(CLI.usage);
      return 2;
    }
    const blind = readBlind(dir);
    if (blind === null) {
      io.write(CLI.no_blind);
      return 1;
    }
    const { readFileSync } = await import('node:fs');
    const estimate = JSON.parse(readFileSync(join(dir, ESTIMATE_FILE), 'utf8')) as Parameters<typeof renderReport>[0]['estimate'];
    const found = results(VARIANTS, readOutputs(dir), blind, readScores(dir));
    const date = (io.today?.() ?? new Date()).toISOString().slice(0, 10);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderReport({ date, commit, sdk: sdkVersion(), specs: VARIANTS, file, estimate, results: found }));
    io.write(fill(CLI.reported, { path: out, verdict: found.q8.pass ? texts.report.pass : texts.report.fail }));
    return 0;
  }

  io.write(CLI.usage);
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    platform: process.platform,
    write: (text) => process.stdout.write(text),
  });
}
