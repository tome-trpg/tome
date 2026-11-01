import { Worker } from 'node:worker_threads';

// 規則包的正則是不受信任的資料，一律在 worker thread 裡執行（ADR-0049）。
// 正則跑起來會占住整條執行緒，所以限時只能從外面終止，不能在裡面檢查。
//
// 限時算的是 worker 用掉的 CPU 時間，不是牆鐘：機器忙時執行緒排不到 CPU，
// 牆鐘照走，正常的模式也會超時。失控的正則一直在用 CPU，所以擋得下來。

/** 單段文字最多用掉這麼多 CPU 時間，沒有進度就終止。是提案，H-16 量過正常模式不會碰到。 */
export const PATTERN_TIMEOUT_MS = 1000;

const MEMORY_LIMIT_MB = 256;
const POLL_MS = 50;

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

/** 回傳毫秒。`worker.cpuUsage()` 要 Node 24.6，更舊的 24.x 只能退回牆鐘。 */
function elapsedClock(worker: Worker): () => Promise<number> {
  if (typeof worker.cpuUsage !== 'function') return async () => performance.now();
  return async () => {
    const { user, system } = await worker.cpuUsage();
    return (user + system) / 1000;
  };
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
    const elapsed = elapsedClock(worker);
    let current = 0;
    let settled = false;
    // 第一個訊息之前是在載入模組，不算。之後每個訊息都是進度，重新起算。
    let running = false;
    let progressed = false;
    let mark: number | null = null;
    let polling = false;

    const settle = (outcome: PatternOutcome): void => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      void worker.terminate();
      resolve(outcome);
    };
    const currentId = (): string => patterns[current]?.id ?? '';
    const check = async (): Promise<void> => {
      if (!running || polling) return;
      polling = true;
      try {
        const now = await elapsed();
        if (mark === null || progressed) {
          mark = now;
          progressed = false;
        } else if (now - mark >= timeoutMs) {
          // 主執行緒忙時，進度訊息可能還在佇列裡，讓它們先處理完才下結論。
          await new Promise(setImmediate);
          if (!progressed) settle({ status: 'timeout', pattern: currentId() });
        }
      } catch {
        // worker 已經結束，`exit` 事件會收尾。
      } finally {
        polling = false;
      }
    };
    const poller = setInterval(() => void check(), Math.min(POLL_MS, timeoutMs));

    worker.on('message', (message: { type: string; pattern?: number; matches?: MatchRange[][][] }) => {
      if (message.type === 'done') {
        const entries = patterns.map((pattern, index) => [pattern.id, message.matches?.[index] ?? []]);
        settle({ status: 'ok', matches: Object.fromEntries(entries) });
        return;
      }
      if (message.type === 'pattern') current = message.pattern ?? current;
      running = true;
      progressed = true;
    });
    worker.on('error', () => settle({ status: 'failed', pattern: currentId() }));
    worker.on('exit', () => settle({ status: 'failed', pattern: currentId() }));
  });
}
