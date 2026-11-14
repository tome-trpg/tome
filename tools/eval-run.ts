import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BatchOptions } from '../src/core/batch.ts';
import { sendInBatches } from '../src/core/batch.ts';
import { bookDir, readBook, updateBook } from '../src/core/book.ts';
import { sumEstimates, type Estimate } from '../src/core/estimate.ts';
import type { Finding } from '../src/core/findings.ts';
import { spentUsd } from '../src/core/ledger.ts';
import type { LLMHost } from '../src/core/llm.ts';
import { packHash } from '../src/core/pack.ts';
import { promptHash } from '../src/core/prompt.ts';
import { planBook, planRequests, sizeRequest, type BookPlan, type EvalVariant } from '../src/core/request.ts';
import { openBookStore, type Store } from '../src/core/store.ts';
import { announce, recover, withRun } from '../src/core/translate.ts';
import { workspacePii } from '../src/core/workspace.ts';
import { copyBook, sourceHome, writeWorkspace, type PassageFile } from './eval-select.ts';

// 盲評的 6 組（ADR-0139 第 1 項），照產品的翻法跑：同一套提示、上下文、詞條、驗證、重送、帳本與外送紀錄。
// 每組一個工作區，書的 `book.db` 各自開，翻譯記憶不會在組之間共用。全部批次，一段一個請求。

export const BUDGET_USD = 30;
export const MODE = 'batch';
/** Q-8 用 050 收尾要用的那一組（ADR-0139 第 8 項）。 */
export const Q8_VARIANT = 'B';
export const ESTIMATE_FILE = 'estimate.json';
export const OUTPUT_FILE = 'outputs.json';
/** 中文指令的譯文，維護者逐字審過才跑（ADR-0139 第 2 項）。 */
export const CHINESE_INSTRUCTIONS = join(dirname(fileURLToPath(import.meta.url)), 'eval', 'translate.zh-TW.md');

export interface VariantSpec {
  readonly code: string;
  readonly model: string;
  readonly thinking?: 'adaptive';
  /** 換成中文指令。 */
  readonly chinese?: boolean;
}

export const VARIANTS: readonly VariantSpec[] = [
  { code: 'A', model: 'claude-haiku-5-5' },
  { code: 'B', model: 'claude-sonnet-5-5' },
  { code: 'C', model: 'claude-sonnet-5-5', thinking: 'adaptive' },
  { code: 'D', model: 'claude-sonnet-5-5', chinese: true },
  { code: 'E', model: 'claude-opus-5-5' },
  { code: 'F', model: 'claude-fable-5-2' },
];

export function variantHome(dir: string, code: string): string {
  return join(dir, 'variants', code);
}

/** 只給評測用的選項，一段一個請求（ADR-0139）。 */
export function variantOf(spec: VariantSpec, instructions: () => string): EvalVariant {
  return {
    separate: true,
    ...(spec.thinking === undefined ? {} : { thinking: spec.thinking }),
    ...(spec.chinese === true ? { instructions: instructions() } : {}),
  };
}

export function readInstructionsFile(path: string = CHINESE_INSTRUCTIONS): string {
  return readFileSync(path, 'utf8');
}

/** 第一次才複製書；續跑時 `book.db` 裡有送出去的批次，不能蓋掉。 */
export function prepareVariant(dir: string, spec: VariantSpec, file: PassageFile, pii: readonly string[]): string {
  const home = variantHome(dir, spec.code);
  writeWorkspace(home, spec.model, pii);
  for (const { slug } of file.books) {
    if (!existsSync(join(bookDir(home, slug), 'book.yaml'))) copyBook(sourceHome(dir), home, slug);
  }
  return home;
}

function goldenOf(file: PassageFile, label: string): Set<string> {
  return new Set(file.passages.filter(({ book }) => book === label).flatMap(({ units }) => units));
}

async function withPlan<T>(home: string, slug: string, variant: EvalVariant, work: (plan: BookPlan, store: Store) => Promise<T>): Promise<T> {
  const store = openBookStore(home, slug);
  try {
    const { plan, findings } = await planBook(home, readBook(home, slug), store, MODE, { cache: null, variant });
    if (plan === null) throw new Error(`cannot plan ${slug}: ${findings.map(({ code }) => code).join(', ')}`);
    return await work(plan, store);
  } finally {
    store.close();
  }
}

export interface BookEstimate {
  readonly book: string;
  readonly requests: number;
  readonly units: number;
  readonly estimate: Estimate;
  readonly prompt_hash: string;
  readonly pack_hash: string;
}

export interface VariantEstimate {
  readonly code: string;
  readonly model: string;
  readonly books: readonly BookEstimate[];
  readonly estimate: Estimate;
}

export interface EstimateFile {
  readonly variants: readonly VariantEstimate[];
  readonly estimate: Estimate;
  readonly budget_usd: number;
  /** 總估價的上限超過 30 美元：不送（ADR-0139 第 10 項）。 */
  readonly over: boolean;
}

/** 在本機估一組的花費，跟送出走同一段（`sizeRequest`），不連網。 */
export async function estimateVariant(dir: string, spec: VariantSpec, file: PassageFile, instructions: () => string): Promise<VariantEstimate> {
  const home = prepareVariant(dir, spec, file, workspacePii(sourceHome(dir)));
  const variant = variantOf(spec, instructions);
  const books: BookEstimate[] = [];
  for (const { label, slug } of file.books) {
    const golden = goldenOf(file, label);
    books.push(
      await withPlan(home, slug, variant, async (plan) => {
        const requests = planRequests(plan.units, plan.chapterOf, ({ unit_id }) => golden.has(unit_id), true);
        const sized = requests.map((request) =>
          sizeRequest(request, { prefix: plan.prefix, terms: plan.terms, pack: plan.pack, recent: plan.recent, model: plan.model, provider: plan.provider.profile, mode: MODE }),
        );
        return {
          book: label,
          requests: requests.length,
          units: requests.reduce((sum, { units }) => sum + units.length, 0),
          estimate: sumEstimates(sized.map(({ estimate }) => estimate)),
          prompt_hash: promptHash(plan.prefix),
          pack_hash: packHash(plan.pack),
        };
      }),
    );
  }
  return { code: spec.code, model: spec.model, books, estimate: sumEstimates(books.map(({ estimate }) => estimate)) };
}

export async function estimateAll(
  dir: string,
  file: PassageFile,
  instructions: () => string,
  specs: readonly VariantSpec[] = VARIANTS,
  budget: number = BUDGET_USD,
): Promise<EstimateFile> {
  const variants: VariantEstimate[] = [];
  for (const spec of specs) variants.push(await estimateVariant(dir, spec, file, instructions));
  const estimate = sumEstimates(variants.map((item) => item.estimate));
  const result: EstimateFile = { variants, estimate, budget_usd: budget, over: estimate.high_usd > budget };
  writeFileSync(join(dir, ESTIMATE_FILE), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export type PassageStatus = 'done' | 'failed' | 'missing';

export interface PassageOutput {
  /** `failed` 是淘汰：重送後還是沒翻成（ADR-0139 第 5 項）。`missing` 是還沒翻完。 */
  readonly status: PassageStatus;
  readonly text: string | null;
  /** 只報告的問題的代碼，評完才列。 */
  readonly issues: readonly string[];
}

export interface VariantOutput {
  readonly code: string;
  readonly spent_usd: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly passages: Readonly<Record<string, PassageOutput>>;
}

export type OutputFile = Readonly<Record<string, VariantOutput>>;

const UNFINISHED = new Set(['FAILED_QA', 'REFUSED', 'BLOCKED']);

/** 一組的結果：每段的狀態、譯文（一組多個單位時一行一個）與只報告的問題。 */
export function collectOutputs(dir: string, spec: VariantSpec, file: PassageFile): VariantOutput {
  const home = variantHome(dir, spec.code);
  const passages: Record<string, PassageOutput> = {};
  let spent = 0;
  let input = 0;
  let output = 0;
  for (const { label, slug } of file.books) {
    const store = openBookStore(home, slug);
    try {
      spent += spentUsd(store);
      const tokens = store.get<{ input: number | null; output: number | null }>('SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM ledger');
      input += tokens?.input ?? 0;
      output += tokens?.output ?? 0;
      for (const passage of file.passages.filter(({ book }) => book === label)) {
        const marks = passage.units.map(() => '?').join(', ');
        const rows = store.all<{ unit_id: string; state: string; translation: string | null }>(
          `SELECT unit_id, state, translation FROM unit WHERE unit_id IN (${marks})`,
          ...passage.units,
        );
        const byId = new Map(rows.map((row) => [row.unit_id, row]));
        const states = passage.units.map((unit) => byId.get(unit)?.state ?? 'PENDING');
        const status: PassageStatus = states.some((state) => UNFINISHED.has(state)) ? 'failed' : states.every((state) => state === 'DONE') ? 'done' : 'missing';
        const issues = store
          .all<{ code: string }>(`SELECT code FROM issue WHERE level = 'report' AND unit_id IN (${marks}) ORDER BY id`, ...passage.units)
          .map(({ code }) => code);
        const text = status === 'done' ? passage.units.map((unit) => byId.get(unit)?.translation ?? '').join('\n') : null;
        passages[passage.id] = { status, text, issues };
      }
    } finally {
      store.close();
    }
  }
  return { code: spec.code, spent_usd: spent, input_tokens: input, output_tokens: output, passages };
}

export function readOutputs(dir: string): OutputFile {
  const path = join(dir, OUTPUT_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as OutputFile) : {};
}

export function writeOutputs(dir: string, outputs: OutputFile): void {
  writeFileSync(join(dir, OUTPUT_FILE), `${JSON.stringify(outputs, null, 2)}\n`);
}

export interface RunCallbacks extends Pick<BatchOptions, 'onBatchSent' | 'onBatchWait' | 'onRetry' | 'onStart'> {
  readonly onVariant?: (code: string, book: string) => void;
}

export interface RunResult {
  readonly outputs: OutputFile;
  /** 停在半路的原因（預算、供應商、個資閘門），都跑完是 null。 */
  readonly stop: Finding | null;
}

/**
 * 依序跑每一組、每一本書。估價的上限超過 30 美元就一組都不送；每本書的預算是 30 美元減掉已經花的，
 * 照產品的預算把關（ADR-0103）。跑過的會接著跑：批次還在供應商那邊的，先收回來。
 */
export async function runAll(
  dir: string,
  file: PassageFile,
  estimate: EstimateFile,
  host: LLMHost,
  instructions: () => string,
  callbacks: RunCallbacks = {},
  specs: readonly VariantSpec[] = VARIANTS,
): Promise<RunResult> {
  if (estimate.over) throw new Error(`the estimate tops $${estimate.budget_usd}: $${estimate.estimate.high_usd.toFixed(2)}`);
  const outputs: Record<string, VariantOutput> = { ...readOutputs(dir) };
  const spentSoFar = (): number => Object.values(outputs).reduce((sum, item) => sum + item.spent_usd, 0);
  const pii = workspacePii(sourceHome(dir));
  for (const spec of specs) {
    const home = prepareVariant(dir, spec, file, pii);
    const variant = variantOf(spec, instructions);
    for (const { label, slug } of file.books) {
      const already = collectOutputs(dir, spec, file);
      const others = spentSoFar() - (outputs[spec.code]?.spent_usd ?? 0);
      updateBook(home, readBook(home, slug), { budget_usd: Math.max(0, estimate.budget_usd - others - already.spent_usd) });
      callbacks.onVariant?.(spec.code, label);
      const options: BatchOptions = { home, slug, host, retryFailed: false, ...callbacks };
      const setup = { mode: MODE, confirm: false, refusePending: false, trial: { only: goldenOf(file, label), override: { cache: null, variant } } } as const;
      const stop = await withRun(options, setup, async (run, findings) => {
        recover(run);
        announce(run, options);
        const halted = await sendInBatches(run, options);
        return { data: {}, findings: halted === null ? findings : [halted] };
      });
      outputs[spec.code] = collectOutputs(dir, spec, file);
      writeOutputs(dir, outputs);
      const halted = stop.findings.find(({ level }) => level === 'fail');
      if (halted !== undefined) return { outputs, stop: halted };
    }
  }
  return { outputs, stop: null };
}
