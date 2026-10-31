import { parentPort, workerData } from 'node:worker_threads';

// 在 worker thread 裡執行規則包的正則，見 patterns.ts（ADR-0049）。

const TICK_MS = 50;

interface Job {
  readonly patterns: readonly { readonly regex: string; readonly flags?: string }[];
  readonly texts: readonly string[];
}

const { patterns, texts } = workerData as Job;
const port = parentPort;
let lastTick = performance.now();

function tick(): void {
  const now = performance.now();
  if (now - lastTick < TICK_MS) return;
  lastTick = now;
  port?.postMessage({ type: 'tick' });
}

const matches = patterns.map((pattern, index) => {
  port?.postMessage({ type: 'pattern', pattern: index });
  const regex = new RegExp(pattern.regex, `gu${pattern.flags ?? ''}`);
  return texts.map((text) => {
    const ranges = [...text.matchAll(regex)].map((match) => [
      match.index,
      match.index + match[0].length,
    ]);
    tick();
    return ranges;
  });
});

port?.postMessage({ type: 'done', matches });
