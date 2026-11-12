import { describe, expect, it } from 'vitest';
import { describeStall, machineTimes, measure, memory, reading, timedOut, type Reading } from './stall.ts';

// 逾時診斷的讀數與格式（ADR-0131）。數字都是編的。

function at(ms: number, workerUs: number, busy: number, total: number): Reading {
  return { at: ms, cpu: { user: workerUs, system: 0 }, machine: { busy, total, count: 4 } };
}

const USED = { freeBytes: 2 * 2 ** 30, totalBytes: 16 * 2 ** 30, rssBytes: 300 * 2 ** 20 };

describe('timeout diagnostics', () => {
  it('reads the CPUs, the worker and the memory of this machine', () => {
    const machine = machineTimes();
    expect(machine.count).toBeGreaterThan(0);
    expect(machine.busy).toBeGreaterThanOrEqual(0);
    expect(machine.busy).toBeLessThanOrEqual(machine.total);
    expect(reading().cpu.user).toBeGreaterThan(0);
    expect(memory().freeBytes).toBeLessThanOrEqual(memory().totalBytes);
  });

  it('measures the wall time, the CPU of the worker and how busy the machine was', () => {
    const stall = measure(at(1_000, 500_000, 100, 1_000), at(31_000, 900_000, 1_000, 2_000), 12_300_000_000, USED);
    expect(stall).toEqual({
      wallMs: 30_000,
      workerCpuMs: 400,
      machineBusy: 0.9,
      cpuCount: 4,
      loopDelayMs: 12_300,
      ...USED,
    });
  });

  it('counts system time with user time, and says 0 when the CPU times did not move', () => {
    const start: Reading = { at: 0, cpu: { user: 100, system: 200 }, machine: { busy: 5, total: 10, count: 2 } };
    const end: Reading = { at: 10, cpu: { user: 1_100, system: 2_200 }, machine: { busy: 5, total: 10, count: 2 } };
    expect(measure(start, end, 0, USED)).toMatchObject({ workerCpuMs: 3, machineBusy: 0, loopDelayMs: 0 });
  });

  it('says it all on one line', () => {
    const stall = measure(at(0, 0, 0, 1_000), at(30_000, 400_000, 970, 2_000), 12_300_000_000, USED);
    expect(describeStall('tests/a.test.ts > a test', stall)).toBe(
      '[timeout diagnostics] tests/a.test.ts > a test: wall 30.0 s, this worker\'s CPU 0.4 s, ' +
        'machine CPU 97% busy across 4 CPUs, event loop delay up to 12.3 s, free memory 2.0 of 16.0 GiB, worker RSS 300 MiB',
    );
  });

  it('speaks up only for a test that timed out', () => {
    expect(timedOut([{ message: 'Test timed out in 30000ms.' }])).toBe(true);
    expect(timedOut([{ message: 'expected 1 to be 2' }, { message: 'Test timed out in 5000ms.' }])).toBe(true);
    expect(timedOut([{ message: 'expected 1 to be 2' }])).toBe(false);
    expect(timedOut([{}])).toBe(false);
    expect(timedOut([])).toBe(false);
    expect(timedOut(undefined)).toBe(false);
  });
});
