import { translateInBatchesLocked, type BatchOptions } from './batch.ts';
import { withBookLock } from './book.ts';
import { entityCards } from './entities.ts';
import { extractLocked, type ExtractOptions } from './extract.ts';
import { finding, type Finding } from './findings.ts';
import type { LLMHost } from './llm.ts';
import type { RequestMode } from './provider.ts';
import { estimateLocked, pendingFindings, saveSettings, type PlanOutcome } from './request.ts';
import { scanLocked } from './scan.ts';
import { openBookStore } from './store.ts';
import { translateLocked } from './translate.ts';
import { assembleLocked, type VaultTexts } from './vault.ts';

// tome run（白皮書 §6.1、ADR-0055、ADR-0127）：從加入過的書一路跑到下一個要人點頭的地方。依序是解析、
// Pass 0 的估價、審定、翻譯的估價、翻譯、輸出 vault。Pass 0 有要送的、還有待審的卡、估價還沒確認，
// 就停下來請使用者跑對應的指令，結束碼 0；某一步沒做完就停在那裡。各步的指令照樣能單獨跑。

/** `tome run` 的步驟，`--json` 的 `stages` 與 `stopped_at` 用這些名字。 */
export type RunStep = 'extract' | 'scan' | 'review' | 'estimate' | 'translate' | 'assemble';

export interface RunOptions {
  readonly home: string;
  readonly slug: string;
  readonly mode: RequestMode;
  /** 使用者打的字，照 `tome scan-terms` 與 `tome estimate` 驗證、寫回 `book.yaml`。 */
  readonly budget?: string | undefined;
  readonly chapters?: string | undefined;
  readonly chapterLevel?: string | undefined;
  readonly texts: VaultTexts;
  /** 解析的執行環境與進度，照 `tome extract`。 */
  readonly extract: Omit<ExtractOptions, 'home' | 'slug'>;
  /** 翻譯的進度，照 `tome translate`。 */
  readonly translate: Omit<BatchOptions, 'home' | 'slug' | 'host' | 'retryFailed'>;
  /** 到翻譯那一步才取金鑰，前面的步驟都不連網；取不到回它的發現。 */
  readonly host: () => Promise<LLMHost | Finding>;
  /** 每一步開始前叫一次（ADR-0111）。 */
  readonly onStep?: (step: RunStep) => void;
}

function failed(findings: readonly Finding[]): boolean {
  return findings.some(({ level }) => level === 'fail');
}

/**
 * 各步的發現接起來時，同一行會印兩次：分章層級（解析與估價都印）、預算（Pass 0 與估價都印）、
 * 價目表過期（兩次估價都印）。代碼、等級、參數都相同的只留最後一次。分章層級不論參數只留最後一次：
 * `--chapter-level` 在解析之後才寫進 `book.yaml`，解析那一步印的可能是舊的層級（ADR-0132）。
 */
function once(findings: readonly Finding[]): Finding[] {
  const keyOf = ({ code, level, params }: Finding): string =>
    code === 'chapters.levels' ? code : JSON.stringify([code, level, Object.entries(params).sort(([a], [b]) => a.localeCompare(b))]);
  const last = new Map(findings.map((item, index) => [keyOf(item), index]));
  return findings.filter((item, index) => last.get(keyOf(item)) === index);
}

async function runLocked(options: RunOptions): Promise<PlanOutcome> {
  const { home, slug, mode, budget } = options;
  const stages: { readonly stage: RunStep; readonly data: PlanOutcome['data'] }[] = [];
  const findings: Finding[] = [];
  const realtime = mode === 'realtime' ? ' --realtime' : '';
  const outcome = (stopped: RunStep | null, next: string | null, last: readonly Finding[] = []): PlanOutcome => ({
    data: { book: slug, stages, stopped_at: stopped, next },
    findings: once([...findings, ...last]),
  });
  // 停在要人點頭的地方：結束碼 0，說下一步要跑哪個指令（ADR-0127）。
  const gate = (step: RunStep, command: string): PlanOutcome => outcome(step, command, [finding('run.stopped', 'warn', { book: slug, command })]);
  const step = async (name: RunStep, work: () => Promise<PlanOutcome>): Promise<PlanOutcome> => {
    options.onStep?.(name);
    const result = await work();
    stages.push({ stage: name, data: result.data });
    findings.push(...result.findings);
    return result;
  };

  // 某一步有 `fail` 就是沒做完，停在那裡；那一步的發現已經說了原因與修法。
  const extracted = await step('extract', () => extractLocked({ ...options.extract, home, slug }));
  if (failed(extracted.findings)) return outcome('extract', null);
  // 預算與範圍在解析之後就驗證、寫進 `book.yaml`（章節要讀 document 層），停在前面的關卡也記得。
  saveSettings(home, slug, { budget, chapters: options.chapters, chapterLevel: options.chapterLevel });

  // Pass 0 不在這裡送：有要送的就顯示估價，請使用者看過之後用 `tome scan-terms --confirm` 送（ADR-0118、ADR-0127）。
  const scanned = await step('scan', () => scanLocked({ home, slug, mode, confirm: false }));
  if (failed(scanned.findings)) return outcome('scan', null);
  if (scanned.findings.some(({ code }) => code === 'scan.not_confirmed')) return gate('scan', `tome scan-terms ${slug} --confirm${realtime}`);

  // 關卡一：還有待審的卡就停（ADR-0055 第 3 項、ADR-0119 第 2 項）。
  const reviewed = await step('review', async () => {
    const store = openBookStore(home, slug);
    try {
      const cards = entityCards(store);
      return { data: { pending: cards.filter(({ status }) => status === 'proposed' || status === 'failed').length }, findings: pendingFindings(slug, cards) };
    } finally {
      store.close();
    }
  });
  if (reviewed.findings.length > 0) return gate('review', `tome glossary review ${slug}`);

  // 關卡二：沒有確認、或確認的估價跟現在的不同就停。沒有要送的就直接輸出。
  const estimated = await step('estimate', () => estimateLocked({ home, slug, confirm: false, mode }));
  if (failed(estimated.findings)) return outcome('estimate', null);
  const sending = estimated.data['requests'] !== 0;
  if (sending && estimated.data['confirmed'] !== true) return gate('estimate', `tome estimate ${slug} --confirm${realtime}`);

  if (sending) {
    const translated = await step('translate', async () => {
      const host = await options.host();
      if ('level' in host) return { data: { book: slug }, findings: [host] };
      const translation = { ...options.translate, home, slug, host, retryFailed: false };
      return mode === 'realtime' ? translateLocked(translation) : translateInBatchesLocked(translation);
    });
    // 翻譯跑完、只是有單位沒翻成（`translate.done` 是 `fail`）時照樣輸出，交付報告會列出它們；
    // 停在半路（個資閘門、預算、供應商、沒有金鑰）就不輸出（ADR-0127）。
    if (translated.findings.some(({ level, code }) => level === 'fail' && code !== 'translate.done')) return outcome('translate', null);
  }

  const assembled = await step('assemble', () => assembleLocked({ home, slug, texts: options.texts, force: false }));
  if (failed(assembled.findings)) return outcome('assemble', null);
  return outcome(null, null, [finding('run.done', 'info', { book: slug })]);
}

/** `tome run`。整條拿一次書的鎖，別的指令不會插進來（ADR-0054、ADR-0127）。 */
export function runBook(options: RunOptions): Promise<PlanOutcome> {
  return withBookLock(options.home, options.slug, () => runLocked(options));
}
