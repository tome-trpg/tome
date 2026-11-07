import { progressText } from './messages.ts';

// 長時間指令的進度（ADR-0111）。都走 stderr，`--json` 的 stdout 不受影響。時間由呼叫端注入，
// 測試不用真的等。

export interface Clock {
  now(): number;
  /** 每隔 `ms` 叫一次 `tick`，回傳停止的函式。 */
  every(ms: number, tick: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  every: (ms, tick) => {
    const timer = setInterval(tick, ms);
    // 指令做完就該結束，不等這個計時器。
    timer.unref();
    return () => clearInterval(timer);
  },
};

/** 頁的進度距離上一行滿這麼久才再印。 */
export const PAGE_EVERY_MS = 5_000;
/** 引擎這麼久沒有事件，就說它仍在執行，之後每隔這麼久再說一次。 */
export const ENGINE_QUIET_MS = 30_000;
/** 多久看一次引擎有沒有事件。只決定「仍在執行」那一行最多晚多久印出。 */
const QUIET_CHECK_MS = 1_000;

/** `tome extract` 的進度：第一頁、距離上一行滿 5 秒、最後一頁才印，引擎 30 秒沒有事件時說它仍在執行。 */
export class EngineProgress {
  readonly #clock: Clock;
  readonly #write: (text: string) => void;
  #lastLine = Number.NEGATIVE_INFINITY;
  #lastEvent = 0;
  #lastWait = Number.NEGATIVE_INFINITY;
  #stop: (() => void) | null = null;

  constructor(clock: Clock, write: (text: string) => void) {
    this.#clock = clock;
    this.#write = write;
  }

  start(engine: string, device: string, pages: number): void {
    this.end();
    this.#write(progressText('engine_start', { engine, device, pages: String(pages) }));
    this.#lastEvent = this.#clock.now();
    this.#lastWait = Number.NEGATIVE_INFINITY;
    this.#stop = this.#clock.every(QUIET_CHECK_MS, () => this.#quiet());
  }

  page(done: number, total: number): void {
    const now = this.#clock.now();
    this.#lastEvent = now;
    if (done !== 1 && done !== total && now - this.#lastLine < PAGE_EVERY_MS) return;
    this.#write(progressText('page', { done: String(done), total: String(total) }));
    this.#lastLine = now;
  }

  end(): void {
    this.#stop?.();
    this.#stop = null;
  }

  #quiet(): void {
    const now = this.#clock.now();
    const quiet = now - this.#lastEvent;
    if (quiet < ENGINE_QUIET_MS || now - this.#lastWait < ENGINE_QUIET_MS) return;
    this.#write(progressText('engine_wait', { seconds: String(Math.floor(quiet / 1000)) }));
    this.#lastWait = now;
  }
}
