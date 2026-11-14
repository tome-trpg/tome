import { readFileSync } from 'node:fs';
import type { EstimateFile, OutputFile, VariantSpec } from './eval-run.ts';
import { Q8_VARIANT } from './eval-run.ts';
import type { BlindFile, ScoreFile } from './eval-score.ts';
import { fill } from './eval-score.ts';
import type { PassageFile } from './eval-select.ts';
import texts from './eval/texts.json' with { type: 'json' };

// 盲評的報告（ADR-0139 第 7 到 9 項）：每組的分數、淘汰率、只報告的問題、花費與 token，評審的一致性，Q-8。
// 寫進 `docs/evals/` 的只有數字、設定與段落的索引，不放原文與譯文。統計手寫，不加相依。

/** 差距在 1 以內的比例低於這個數字，標成「不穩定」（ADR-0139 第 7 項）。 */
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

/** 每組在第一次出現的段落拿到的分數：那一則譯文的分數，合併顯示的算給每一組。 */
export function variantScores(blind: BlindFile, scores: ScoreFile, code: string): number[] {
  const passages = new Map(blind.passages.map((passage) => [passage.id, passage]));
  return blind.slots.flatMap((slot) => {
    if (slot.round !== 1) return [];
    const item = passages.get(slot.passage)?.items.findIndex(({ variants }) => variants.includes(code)) ?? -1;
    const score = item === -1 ? undefined : scores[String(slot.slot)]?.[String(item)];
    return score === undefined ? [] : [score];
  });
}

export interface Consistency {
  readonly repeats: number;
  readonly pairs: number;
  readonly exact: number;
  readonly mad: number;
  readonly within: number;
  readonly stable: boolean;
}

/** 重複出現的段落：同一則譯文前後兩次的分數比（ADR-0139 第 7 項）。 */
export function consistency(blind: BlindFile, scores: ScoreFile): Consistency {
  const pairs: [number, number][] = [];
  const repeats = blind.slots.filter(({ round }) => round === 2);
  for (const again of repeats) {
    const first = blind.slots.find(({ passage, round }) => passage === again.passage && round === 1);
    if (first === undefined) continue;
    for (const item of again.order) {
      const before = scores[String(first.slot)]?.[String(item)];
      const after = scores[String(again.slot)]?.[String(item)];
      if (before !== undefined && after !== undefined) pairs.push([before, after]);
    }
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

export interface VariantResult {
  readonly code: string;
  readonly model: string;
  readonly summary: Summary;
  readonly rate: number;
  readonly dropped: boolean;
  readonly issues: number;
  readonly spent_usd: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface Results {
  readonly variants: readonly VariantResult[];
  readonly consistency: Consistency;
  readonly q8: { readonly code: string; readonly mean: number; readonly rate: number; readonly pass: boolean };
}

export function results(specs: readonly VariantSpec[], outputs: OutputFile, blind: BlindFile, scores: ScoreFile): Results {
  const variants = specs.map((spec) => {
    const output = outputs[spec.code];
    const passages = Object.values(output?.passages ?? {});
    return {
      code: spec.code,
      model: spec.model,
      summary: summarize(variantScores(blind, scores, spec.code)),
      rate: blind.rates[spec.code] ?? Number.NaN,
      dropped: blind.dropped.includes(spec.code),
      issues: passages.reduce((sum, { issues }) => sum + issues.length, 0),
      spent_usd: output?.spent_usd ?? 0,
      input_tokens: output?.input_tokens ?? 0,
      output_tokens: output?.output_tokens ?? 0,
    };
  });
  const chosen = variants.find(({ code }) => code === Q8_VARIANT);
  const mean = chosen?.summary.mean ?? Number.NaN;
  return {
    variants,
    consistency: consistency(blind, scores),
    q8: { code: Q8_VARIANT, mean, rate: chosen?.rate ?? Number.NaN, pass: chosen !== undefined && !chosen.dropped && mean >= Q8_THRESHOLD },
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
  readonly estimate: EstimateFile;
  readonly results: Results;
}

/** `docs/evals/` 的報告：只有數字、設定與段落的索引。 */
export function renderReport({ date, commit, sdk, specs, file, estimate, results: found }: ReportOptions, page = texts.report, scale = texts.scale): string {
  const lines: string[] = [`# ${fill(page.title, { date })}`, '', page.intro, '', `## ${page.setup}`, ''];
  lines.push(`* ${fill(page.commit, { commit, sdk, seed: String(file.seed) })}`);
  lines.push(`* ${page.mode}`);
  for (const book of file.books) {
    const count = file.passages.filter((passage) => passage.book === book.label).length;
    lines.push(`* ${fill(page.books, { book: book.label, count: String(count), sha: book.document_sha256 })}`);
  }
  lines.push('', page.variant_head, '| :--- | :--- | :--- | :--- | :--- | :--- |');
  for (const spec of specs) {
    const planned = estimate.variants.find(({ code }) => code === spec.code);
    const thinking = spec.thinking === 'adaptive' ? page.thinking_on : spec.model === 'claude-opus-5-5' || spec.model.startsWith('claude-fable') ? page.thinking_low : page.thinking_off;
    const prompts = (planned?.books ?? []).map(({ book, prompt_hash }) => `${book} \`${prompt_hash.slice(0, 12)}\``).join('、');
    const packs = (planned?.books ?? []).map(({ book, pack_hash }) => `${book} \`${pack_hash.slice(0, 12)}\``).join('、');
    lines.push(`| ${spec.code} | \`${spec.model}\` | ${thinking} | ${spec.chinese === true ? page.chinese : page.english} | ${prompts} | ${packs} |`);
  }
  // 分數的定義跟評分頁上的同一套（ADR-0139 第 8 項）。
  lines.push('', `## ${page.results}`, '', page.results_note, '', ...Object.values(scale).map((line) => `* ${line}`));
  lines.push('', page.result_head, '| :--- | ---: | ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const item of found.variants) {
    const { n, mean, half, counts } = item.summary;
    const scored = item.dropped ? page.dropped : String(n);
    const interval = Number.isNaN(half) ? '-' : fill(page.interval, { low: fixed(mean - half), high: fixed(mean + half) });
    lines.push(
      `| ${item.code} | ${scored} | ${fixed(mean)} | ${interval} | ${counts.join(' | ')} | ${percent(item.rate)} | ${item.issues} | ${item.spent_usd.toFixed(4)} | ${item.input_tokens} | ${item.output_tokens} |`,
    );
  }
  const { consistency: same } = found;
  lines.push('', `## ${page.consistency}`, '');
  lines.push(fill(page.consistency_line, { repeats: String(same.repeats), pairs: String(same.pairs), exact: percent(same.exact), mad: fixed(same.mad), within: percent(same.within) }));
  lines.push('', same.stable ? page.stable : page.unstable, '', `## ${page.q8}`, '');
  const q8 = specs.find(({ code }) => code === found.q8.code);
  lines.push(fill(page.q8_line, { code: found.q8.code, model: q8?.model ?? '', mean: fixed(found.q8.mean), rate: percent(found.q8.rate), verdict: found.q8.pass ? page.pass : page.fail }));
  lines.push('', `## ${page.index}`, '', page.index_head, '| :--- | :--- | :--- | ---: | :--- | ---: |');
  for (const passage of file.passages) {
    lines.push(`| ${passage.id} | ${passage.book} | ${passage.role} | ${passage.chars} | \`${passage.blocks[0] ?? ''}\` | ${passage.blocks.length} |`);
  }
  return `${lines.join('\n')}\n`;
}

/** 依賴的 Anthropic SDK 版本，寫進報告。 */
export function sdkVersion(path = 'package.json'): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: Record<string, string> };
  return manifest.dependencies?.['@anthropic-ai/sdk'] ?? '-';
}
