import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lintPack } from '../../src/core/pack-lint.ts';
import { testPack } from '../../src/core/pack-test.ts';
import { runPatterns } from '../../src/core/patterns.ts';
import { tempDir } from '../helpers.ts';

// 限時的行為要在機器忙的時候才看得到，真的 worker 又測不穩。這裡換成假的 worker，
// 由測試決定它什麼時候說話、用掉多少 CPU，慢啟動與等不到 CPU 都能重現。

const { FakeWorker } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');

  class FakeWorker extends EventEmitter {
    static latest: FakeWorker;
    static script: ((worker: FakeWorker) => void) | null = null;
    static oldNode = false;

    readonly job: { patterns: unknown[]; texts: unknown[] };
    cpuMs = 0;
    terminated = false;
    cpuUsage: (() => Promise<{ user: number; system: number }>) | undefined = async () => ({
      user: this.cpuMs * 1000,
      system: 0,
    });

    constructor(_url: URL, options: { workerData: FakeWorker['job'] }) {
      super();
      this.job = options.workerData;
      if (FakeWorker.oldNode) this.cpuUsage = undefined;
      FakeWorker.latest = this;
      queueMicrotask(() => FakeWorker.script?.(this));
    }

    async terminate(): Promise<number> {
      this.terminated = true;
      return 0;
    }

    say(type: string, pattern?: number): void {
      this.emit('message', { type, pattern });
    }

    finish(): void {
      const matches = this.job.patterns.map(() => this.job.texts.map(() => []));
      this.emit('message', { type: 'done', matches });
    }
  }
  return { FakeWorker };
});

vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }));

const LIMIT_MS = 20;
const ONE = [{ id: 'dice', regex: 'd' }];
const TWO = [...ONE, { id: 'runaway', regex: 'r' }];
const OK = { status: 'ok', matches: { dice: [[]] } };

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 假裝 worker 卡在正則裡：CPU 一直用，什麼話都不說，直到被終止。 */
async function spin(worker: InstanceType<typeof FakeWorker>): Promise<void> {
  while (!worker.terminated) {
    worker.cpuMs += 10;
    await wait(5);
  }
}

beforeEach(() => {
  FakeWorker.script = null;
  FakeWorker.oldNode = false;
});

describe('the time limit of runPatterns', () => {
  it('does not count the time the worker takes to load', async () => {
    const run = runPatterns(ONE, ['text'], LIMIT_MS);
    const worker = FakeWorker.latest;
    worker.emit('online');
    await wait(LIMIT_MS * 5);
    worker.cpuMs = 5000;
    worker.say('pattern', 0);
    worker.finish();
    expect(await run).toEqual(OK);
    expect(worker.terminated).toBe(true);
  });

  it('does not count the time the worker waits for a processor', async () => {
    const run = runPatterns(ONE, ['text'], LIMIT_MS);
    const worker = FakeWorker.latest;
    worker.emit('online');
    worker.say('pattern', 0);
    await wait(LIMIT_MS * 5);
    worker.finish();
    expect(await run).toEqual(OK);
  });

  it('ends a pattern that spends its budget, and names it', async () => {
    const run = runPatterns(TWO, ['text'], LIMIT_MS);
    const worker = FakeWorker.latest;
    worker.emit('online');
    worker.say('pattern', 0);
    worker.say('pattern', 1);
    await Promise.all([spin(worker), run]);
    expect(await run).toEqual({ status: 'timeout', pattern: 'runaway' });
    expect(worker.terminated).toBe(true);
  });

  it('does not end a slow run while it keeps making progress', async () => {
    const run = runPatterns(ONE, ['text'], LIMIT_MS);
    const worker = FakeWorker.latest;
    worker.emit('online');
    worker.say('pattern', 0);
    for (let step = 0; step < 6; step += 1) {
      worker.cpuMs += LIMIT_MS - 5;
      worker.say('tick');
      await wait(LIMIT_MS + 5);
    }
    worker.finish();
    expect(await run).toEqual(OK);
  });

  it('lets a progress message in the queue win over the verdict', async () => {
    const run = runPatterns(ONE, ['text'], LIMIT_MS);
    const worker = FakeWorker.latest;
    worker.emit('online');
    worker.say('pattern', 0);
    await wait(LIMIT_MS * 2);
    const usage = worker.cpuUsage;
    worker.cpuUsage = async () => {
      setImmediate(() => worker.say('tick'));
      worker.cpuUsage = usage;
      return { user: 60_000, system: 0 };
    };
    await wait(LIMIT_MS * 3);
    worker.finish();
    expect(await run).toEqual(OK);
  });

  it('falls back to the wall clock where Node has no cpuUsage', async () => {
    FakeWorker.oldNode = true;
    const run = runPatterns(ONE, ['text'], LIMIT_MS);
    const worker = FakeWorker.latest;
    worker.emit('online');
    worker.say('pattern', 0);
    expect(await run).toEqual({ status: 'timeout', pattern: 'dice' });
  });

  it('copes with a worker that has already gone', async () => {
    const run = runPatterns(ONE, ['text'], LIMIT_MS);
    const worker = FakeWorker.latest;
    worker.cpuUsage = async () => {
      throw new Error('ERR_WORKER_NOT_RUNNING');
    };
    worker.emit('online');
    worker.say('pattern', 0);
    await wait(LIMIT_MS * 2);
    worker.emit('exit', 1);
    expect(await run).toEqual({ status: 'failed', pattern: 'dice' });
  });
});

describe('the tools on a busy machine', () => {
  function pack(home: string): { dir: string; source: 'workspace' } {
    const dir = join(home, 'systems', 'busy');
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(
      join(dir, 'pack.yaml'),
      'schema: tome-pack/1\nid: busy\nversion: 0.1.0\nlicense: UNLICENSED\nsource_langs: [en]\n',
    );
    writeFileSync(join(dir, 'syntax_patterns.yaml'), "patterns:\n  - { id: dice, use: mask, regex: 'd' }\n");
    writeFileSync(join(dir, 'tests', 'one.yaml'), 'cases:\n  - { id: one, text: words }\n');
    return { dir, source: 'workspace' };
  }

  /** 啟動比舊程式的限時還久的 worker，之後很快就做完。 */
  function slowStart(ms: number): void {
    FakeWorker.script = (worker) => {
      worker.emit('online');
      setTimeout(() => {
        worker.say('pattern', 0);
        worker.finish();
      }, ms);
    };
  }

  it('does not fail a normal pattern in lint', { timeout: 10_000 }, async () => {
    slowStart(600);
    const home = tempDir();
    const findings = await lintPack(home, pack(home), { public: false, targetLang: 'zh-TW' });
    expect(findings.map((item) => item.code)).toEqual(['pack.lint_ok']);
  });

  it('does not fail a normal pattern in test', { timeout: 10_000 }, async () => {
    slowStart(1100);
    const home = tempDir();
    const findings = await testPack(home, pack(home));
    expect(findings.map((item) => item.code)).toEqual(['pack.test_passed']);
  });

  it('still fails a runaway pattern in lint', { timeout: 10_000 }, async () => {
    FakeWorker.script = (worker) => {
      worker.emit('online');
      worker.say('pattern', 0);
      void spin(worker);
    };
    const home = tempDir();
    const findings = await lintPack(home, pack(home), { public: false, targetLang: 'zh-TW' });
    expect(findings.map((item) => item.code)).toEqual(['pack.slow_regex']);
  });

  it('still fails a runaway pattern in test', { timeout: 10_000 }, async () => {
    FakeWorker.script = (worker) => {
      worker.emit('online');
      worker.say('pattern', 0);
      void spin(worker);
    };
    const home = tempDir();
    const findings = await testPack(home, pack(home));
    expect(findings.map((item) => item.code)).toEqual(['pack.slow_regex']);
  });

  it('is stricter in lint than in a real run', { timeout: 10_000 }, async () => {
    // 第一次檢查先定好起點，之後才用掉 CPU，所以兩邊都看得到完整的 800 毫秒。
    FakeWorker.script = (worker) => {
      worker.emit('online');
      worker.say('pattern', 0);
      setTimeout(() => {
        worker.cpuMs = 800;
      }, 150);
      setTimeout(() => worker.finish(), 300);
    };
    const home = tempDir();
    const location = pack(home);
    const linted = await lintPack(home, location, { public: false, targetLang: 'zh-TW' });
    expect(linted.map((item) => item.code)).toEqual(['pack.slow_regex']);
    const tested = await testPack(home, location);
    expect(tested.map((item) => item.code)).toEqual(['pack.test_passed']);
  });
});
