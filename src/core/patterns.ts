import { Worker } from 'node:worker_threads';

// 規則包的正則是不受信任的資料，一律在 worker thread 裡執行（ADR-0049）。
// 正則跑起來會占住整條執行緒，所以限時只能從外面終止，不能在裡面檢查。

/** 這麼久沒有進度就終止。是提案，H-16 量過正常模式不會碰到。 */
export const PATTERN_TIMEOUT_MS = 1000;

const MEMORY_LIMIT_MB = 256;

export interface PatternInput {
  readonly id: string;
  readonly regex: string;
  readonly flags?: string | undefined;
}

export type MatchRange = readonly [number, number];

export type PatternOutcome =
  | {
      readonly status: 'ok';
      /** 依模式 ID，再依文字的順序，列出每段文字的命中範圍。 */
      readonly matches: Readonly<Record<string, readonly (readonly MatchRange[])[]>>;
    }
  | { readonly status: 'timeout' | 'failed'; readonly pattern: string };

function workerUrl(): URL {
  // 從原始碼跑與跑建置結果時，這個檔案的副檔名不同。
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new URL(`./pattern-worker.${extension}`, import.meta.url);
}

export function runPatterns(
  patterns: readonly PatternInput[],
  texts: readonly string[],
  timeoutMs: number = PATTERN_TIMEOUT_MS,
): Promise<PatternOutcome> {
  return new Promise((resolve) => {
    if (patterns.length === 0) {
      resolve({ status: 'ok', matches: {} });
      return;
    }
    // env 是空的：規則包碰不到金鑰（ADR-0044）。
    const worker = new Worker(workerUrl(), {
      workerData: { patterns, texts },
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: MEMORY_LIMIT_MB },
    });
    let current = 0;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const settle = (outcome: PatternOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(outcome);
    };
    const currentId = (): string => patterns[current]?.id ?? '';
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => settle({ status: 'timeout', pattern: currentId() }), timeoutMs);
    };

    worker.once('online', arm);
    worker.on('message', (message: { type: string; pattern?: number; matches?: MatchRange[][][] }) => {
      if (message.type === 'done') {
        const entries = patterns.map((pattern, index) => [pattern.id, message.matches?.[index] ?? []]);
        settle({ status: 'ok', matches: Object.fromEntries(entries) });
        return;
      }
      if (message.type === 'pattern') current = message.pattern ?? current;
      arm();
    });
    worker.on('error', () => settle({ status: 'failed', pattern: currentId() }));
    worker.on('exit', () => settle({ status: 'failed', pattern: currentId() }));
  });
}
