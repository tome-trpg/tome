import { describe, expect, it } from 'vitest';
import { ENGINE_QUIET_MS, EngineProgress, PAGE_EVERY_MS, systemClock, type Clock } from '../../src/cli/progress.ts';

interface Timer {
  readonly ms: number;
  readonly tick: () => void;
  next: number;
  stopped: boolean;
}

/** 假時鐘：時間只在 `advance` 時前進，到期的計時器依序觸發。 */
function fakeClock(): { clock: Clock; advance(ms: number): void; running(): number } {
  let time = 0;
  const timers: Timer[] = [];
  return {
    clock: {
      now: () => time,
      every: (ms, tick) => {
        const timer: Timer = { ms, tick, next: time + ms, stopped: false };
        timers.push(timer);
        return () => {
          timer.stopped = true;
        };
      },
    },
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const due = timers.filter((timer) => !timer.stopped && timer.next <= end).sort((a, b) => a.next - b.next)[0];
        if (due === undefined) break;
        time = due.next;
        due.next += due.ms;
        due.tick();
      }
      time = end;
    },
    running: () => timers.filter((timer) => !timer.stopped).length,
  };
}

function progress(): { engine: EngineProgress; lines: string[]; time: ReturnType<typeof fakeClock> } {
  const time = fakeClock();
  const lines: string[] = [];
  return { engine: new EngineProgress(time.clock, (text) => lines.push(text)), lines, time };
}

describe('EngineProgress (ADR-0111)', () => {
  it('says which engine starts, on what, and how many pages, before the first event', () => {
    const { engine, lines, time } = progress();
    engine.start('docling', 'cpu', 20);
    expect(lines).toEqual(['正在啟動解析引擎 docling（cpu），本次要解析 20 頁。第一次載入模型可能需要一段時間。\n']);
    expect(time.running()).toBe(1);
  });

  it('prints the first page, then a page only once 5 seconds have passed, and always the last', () => {
    const { engine, lines, time } = progress();
    engine.start('fake', 'cpu', 6);
    lines.length = 0;
    engine.page(1, 6);
    time.advance(PAGE_EVERY_MS - 1);
    engine.page(2, 6);
    time.advance(1);
    engine.page(3, 6);
    time.advance(1_000);
    engine.page(4, 6);
    engine.page(5, 6);
    engine.page(6, 6);
    expect(lines).toEqual(['已解析 1/6 頁。\n', '已解析 3/6 頁。\n', '已解析 6/6 頁。\n']);
  });

  it('says the engine is still running after 30 quiet seconds, and every 30 seconds after that', () => {
    const { engine, lines, time } = progress();
    engine.start('fake', 'cpu', 3);
    lines.length = 0;
    time.advance(ENGINE_QUIET_MS - 1_000);
    expect(lines).toEqual([]);
    time.advance(1_000);
    expect(lines).toEqual(['解析引擎仍在執行，已等待 30 秒。\n']);
    time.advance(ENGINE_QUIET_MS);
    expect(lines).toEqual(['解析引擎仍在執行，已等待 30 秒。\n', '解析引擎仍在執行，已等待 60 秒。\n']);
  });

  it('counts the quiet from the last page, not from the start', () => {
    const { engine, lines, time } = progress();
    engine.start('fake', 'cpu', 3);
    time.advance(20_000);
    engine.page(1, 3);
    lines.length = 0;
    time.advance(ENGINE_QUIET_MS - 1_000);
    expect(lines).toEqual([]);
    time.advance(1_000);
    expect(lines).toEqual(['解析引擎仍在執行，已等待 30 秒。\n']);
  });

  it('stops watching when the engine ends, and a second start does not leave the first timer running', () => {
    const { engine, lines, time } = progress();
    engine.start('fake', 'cpu', 3);
    engine.start('fake', 'cpu', 3);
    expect(time.running()).toBe(1);
    engine.end();
    expect(time.running()).toBe(0);
    lines.length = 0;
    time.advance(ENGINE_QUIET_MS * 3);
    expect(lines).toEqual([]);
    engine.end();
  });

  it('reads the system time, and its timer can be stopped', () => {
    let ticks = 0;
    const stop = systemClock.every(60_000, () => (ticks += 1));
    stop();
    expect(ticks).toBe(0);
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(1_000);
  });
});
