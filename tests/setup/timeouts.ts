import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, beforeEach } from 'vitest';
import { describeStall, measure, memory, reading, timedOut } from './stall.ts';

// 測試逾時才往 stderr 印一行診斷，平常不出聲（ADR-0131）。`vitest.config.ts` 的 `setupFiles` 讓每個測試檔都載入。

const delay = monitorEventLoopDelay({ resolution: 20 });
delay.enable();
afterAll(() => delay.disable());

beforeEach(({ onTestFailed }) => {
  const start = reading();
  delay.reset();
  onTestFailed(({ task }) => {
    if (!timedOut(task.result?.errors)) return;
    process.stderr.write(`${describeStall(task.fullName, measure(start, reading(), delay.max, memory()))}\n`);
  });
});
