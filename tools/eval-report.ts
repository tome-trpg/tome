import { readFileSync } from 'node:fs';
import type { EstimateFile, OutputFile, VariantSpec } from './eval-run.ts';
import type { SampleFile, SampleScores } from './eval-score.ts';
import { DROP_RATE, eliminationRates, fill } from './eval-score.ts';
import type { PassageFile } from './eval-select.ts';
import texts from './eval/texts.json' with { type: 'json' };

// 評測的報告（ADR-0139 第 9 到 12、16 項）：B 組抽出段落的人評分數與一致性、Q-8，6 組的自動指標（淘汰率、
// 只報告的問題、花費與 token）。寫進 `docs/evals/` 的只有數字、設定與段落的索引，不放原文與譯文。統計手寫，不加相依。

/** 差距在 1 以內的比例低於這個數字，標成「不穩定」（ADR-0139 第 9 項）。 */
export const STABLE_WITHIN = 0.8;
/** Q-8：平均 4 分以上（ADR-0079）。 */
export const Q8_THRESHOLD = 4;

export interface Summary {
  readonly n: number;
  readonly mean: number;
  /** 95% 信賴區間的半寬，常態近似。 */
  readonly half: number;
  /** 1 到 5 分各幾段。 */
  readonly counts: readonly number[];
}

export function summarize(scores: readonly number[]): Summary {
  const n = scores.length;
  const counts = [1, 2, 3, 4, 5].map((score) => scores.filter((value) => value === score).length);
  if (n === 0) return { n, mean: Number.NaN, half: Number.NaN, counts };
  const mean = scores.reduce((sum, value) => sum + value, 0) / n;
  const variance = n < 2 ? 0 : scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  return { n, mean, half: (1.96 * Math.sqrt(variance)) / Math.sqrt(n), counts };
}

export interface SampleSplit {
  readonly all: readonly number[];
  /** 沿用之前盲評的分數。 */
  readonly reused: readonly number[];
  /** 這次評的。 */
  readonly fresh: readonly number[];
}

/** 每段一個分數：沿用的照之前盲評的分數，其他照這次第一次評的；重複出現的那一次不算進平均。 */
export function sampleScores(sample: SampleFile, scores: SampleScores): SampleSplit {
  const reused: number[] = [];
  const fresh: number[] = [];
  for (const id of sample.passages) {
    const carried = sample.reused[id];
    if (carried !== undefined) {
      reused.push(carried);
      continue;
    }
    const slot = sample.slots.find(({ passage, round }) => passage === id && round === 1);
    const score = slot === undefined ? undefined : scores[String(slot.slot)];
    if (score !== undefined) fresh.push(score);
  }
  return { all: [...reused, ...fresh], reused, fresh };
}

export interface Consistency {
  readonly repeats: number;
  readonly pairs: number;
  readonly exact: number;
  readonly mad: number;
  readonly within: number;
  readonly stable: boolean;
}

/** 重複出現的段落：同一則譯文前後兩次的分數比；第一次是沿用的，就拿沿用的分數比（ADR-0139 第 9 項）。 */
export function consistency(sample: SampleFile, scores: SampleScores): Consistency {
  const pairs: [number, number][] = [];
  const repeats = sample.slots.filter(({ round }) => round === 2);
  for (const again of repeats) {
    const first = sample.slots.find(({ passage, round }) => passage === again.passage && round === 1);
    const before = first === undefined ? sample.reused[again.passage] : scores[String(first.slot)];
    const after = scores[String(again.slot)];
    if (before !== undefined && after !== undefined) pairs.push([before, after]);
  }
  const share = (test: (difference: number) => boolean): number =>
    pairs.length === 0 ? Number.NaN : pairs.filter(([a, b]) => test(Math.abs(a - b))).length / pairs.length;
  const within = share((difference) => difference <= 1);
  return {
    repeats: repeats.length,
    pairs: pairs.length,
    exact: share((difference) => difference === 0),
    mad: pairs.length === 0 ? Number.NaN : pairs.reduce((sum, [a, b]) => sum + Math.abs(a - b), 0) / pairs.length,
    within,
    stable: within >= STABLE_WITHIN,
  };
}

/** 每組的自動指標；只有評的那一組有人評。 */
export interface VariantResult {
  readonly code: string;
  readonly model: string;
  readonly scored: boolean;
  readonly rate: number;
  readonly dropped: boolean;
  readonly issues: number;
  readonly spent_usd: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface Results {
  readonly code: string;
  readonly model: string;
  /** 評的那一組在抽出的段落的分數。 */
  readonly summary: Summary;
  readonly reused: Summary;
  readonly fresh: Summary;
  /** 抽中、但沒翻成的段數。 */
  readonly failed: number;
  readonly variants: readonly VariantResult[];
  readonly consistency: Consistency;
  readonly q8: { readonly code: string; readonly mean: number; readonly half: number; readonly rate: number; readonly pass: boolean };
}

export function results(specs: readonly VariantSpec[], outputs: OutputFile, sample: SampleFile, scores: SampleScores): Results {
  const rates = eliminationRates(outputs, specs.map(({ code }) => code));
  const variants = specs.map((spec) => {
    const output = outputs[spec.code];
    const passages = Object.values(output?.passages ?? {});
    const rate = rates[spec.code] ?? Number.NaN;
    return {
      code: spec.code,
      model: spec.model,
      scored: spec.code === sample.code,
      rate,
      dropped: rate > DROP_RATE,
      issues: passages.reduce((sum, { issues }) => sum + issues.length, 0),
      spent_usd: output?.spent_usd ?? 0,
      input_tokens: output?.input_tokens ?? 0,
      output_tokens: output?.output_tokens ?? 0,
    };
  });
  const split = sampleScores(sample, scores);
  const summary = summarize(split.all);
  const chosen = variants.find(({ code }) => code === sample.code);
  return {
    code: sample.code,
    model: chosen?.model ?? '',
    summary,
    reused: summarize(split.reused),
    fresh: summarize(split.fresh),
    failed: sample.failed.length,
    variants,
    consistency: consistency(sample, scores),
    q8: {
      code: sample.code,
      mean: summary.mean,
      half: summary.half,
      rate: chosen?.rate ?? Number.NaN,
      pass: chosen !== undefined && !chosen.dropped && summary.mean >= Q8_THRESHOLD,
    },
  };
}

function fixed(value: number, digits = 2): string {
  return Number.isNaN(value) ? '-' : value.toFixed(digits);
}

function percent(value: number): string {
  return Number.isNaN(value) ? '-' : `${(value * 100).toFixed(1)}%`;
}

export interface ReportOptions {
  readonly date: string;
  readonly commit: string;
  readonly sdk: string;
  readonly specs: readonly VariantSpec[];
  readonly file: PassageFile;
  readonly sample: SampleFile;
  readonly estimate: EstimateFile;
  readonly results: Results;
}

/** `docs/evals/` 的報告：只有數字、設定與段落的索引。 */
export function renderReport({ date, commit, sdk, specs, file, sample, estimate, results: found }: ReportOptions, page = texts.report, scale = texts.scale): string {
  const perBook = (ids: readonly string[]): string =>
    file.books.map(({ label }) => `${label} ${file.passages.filter(({ id, book }) => book === label && ids.includes(id)).length}`).join('、');
  const chosen = new Set(sample.passages);
  const lines: string[] = [`# ${fill(page.title, { date })}`, '', fill(page.intro, { code: found.code, count: String(sample.passages.length) }), '', `## ${page.setup}`, ''];
  lines.push(`* ${fill(page.commit, { commit, sdk, seed: String(file.seed) })}`);
  lines.push(`* ${page.mode}`);
  for (const book of file.books) {
    const count = file.passages.filter((passage) => passage.book === book.label).length;
    lines.push(`* ${fill(page.books, { book: book.label, count: String(count), sha: book.document_sha256 })}`);
  }
  lines.push(`* ${fill(page.sample, { count: String(sample.passages.length), books: perBook(sample.passages) })}`);
  lines.push('', page.variant_head, '| :--- | :--- | :--- | :--- | :--- | :--- |');
  for (const spec of specs) {
    const planned = estimate.variants.find(({ code }) => code === spec.code);
    const thinking = spec.thinking === 'adaptive' ? page.thinking_on : spec.model === 'claude-opus-5-5' || spec.model.startsWith('claude-fable') ? page.thinking_low : page.thinking_off;
    const prompts = (planned?.books ?? []).map(({ book, prompt_hash }) => `${book} \`${prompt_hash.slice(0, 12)}\``).join('、');
    const packs = (planned?.books ?? []).map(({ book, pack_hash }) => `${book} \`${pack_hash.slice(0, 12)}\``).join('、');
    lines.push(`| ${spec.code} | \`${spec.model}\` | ${thinking} | ${spec.chinese === true ? page.chinese : page.english} | ${prompts} | ${packs} |`);
  }
  // 分數的定義跟評分頁上的同一套（ADR-0139 第 8 項）。
  const { n, mean, half, counts } = found.summary;
  const interval = (value: number, width: number): string => (Number.isNaN(width) ? '-' : fill(page.interval, { low: fixed(value - width), high: fixed(value + width) }));
  lines.push('', `## ${fill(page.results, { code: found.code })}`, '', fill(page.results_note, { code: found.code }), '', ...Object.values(scale).map((line) => `* ${line}`));
  lines.push('', page.result_head, '| ---: | ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: |');
  lines.push(`| ${sample.dropped ? page.dropped : String(n)} | ${fixed(mean)} | ${interval(mean, half)} | ${counts.join(' | ')} | ${found.failed} |`);
  lines.push('', fill(page.reuse_line, { code: found.code, reused: String(found.reused.n), reused_mean: fixed(found.reused.mean), fresh: String(found.fresh.n), fresh_mean: fixed(found.fresh.mean) }));
  lines.push('', `## ${page.auto}`, '', page.auto_note, '', page.auto_head, '| :--- | :--- | ---: | ---: | ---: | ---: | ---: |');
  for (const item of found.variants) {
    const scored = item.scored ? fill(page.scored_count, { count: String(sample.passages.length) }) : page.unscored;
    lines.push(`| ${item.code} | ${scored} | ${percent(item.rate)} | ${item.issues} | ${item.spent_usd.toFixed(4)} | ${item.input_tokens} | ${item.output_tokens} |`);
  }
  const { consistency: same } = found;
  lines.push('', `## ${page.consistency}`, '');
  lines.push(fill(page.consistency_line, { repeats: String(same.repeats), pairs: String(same.pairs), exact: percent(same.exact), mad: fixed(same.mad), within: percent(same.within) }));
  lines.push('', same.stable ? page.stable : page.unstable, '', `## ${page.q8}`, '');
  lines.push(
    fill(page.q8_line, {
      code: found.q8.code,
      model: found.model,
      n: String(n),
      mean: fixed(found.q8.mean),
      interval: interval(found.q8.mean, found.q8.half),
      rate: percent(found.q8.rate),
      verdict: found.q8.pass ? page.pass : page.fail,
    }),
  );
  lines.push('', `## ${page.index}`, '', page.index_head, '| :--- | :--- | :--- | ---: | :--- | ---: | :--- |');
  for (const passage of file.passages) {
    lines.push(`| ${passage.id} | ${passage.book} | ${passage.role} | ${passage.chars} | \`${passage.blocks[0] ?? ''}\` | ${passage.blocks.length} | ${chosen.has(passage.id) ? page.sampled : ''} |`);
  }
  return `${lines.join('\n')}\n`;
}

/** 依賴的 Anthropic SDK 版本，寫進報告。 */
export function sdkVersion(path = 'package.json'): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: Record<string, string> };
  return manifest.dependencies?.['@anthropic-ai/sdk'] ?? '-';
}
