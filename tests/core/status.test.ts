import { describe, expect, it } from 'vitest';
import { UNIT_STATES } from '../../src/core/state.ts';
import { STATUS_BUCKETS, localTime, nextStep, zoneText, type Progress } from '../../src/core/status.ts';

// `tome status` 給人看的時間與數字（ADR-0107）。時差由測試注入，在哪個時區跑結果都一樣。

describe('zoneText', () => {
  it('writes whole hours, minutes when there are any, and UTC for no offset', () => {
    expect(zoneText(480)).toBe('UTC+8');
    expect(zoneText(-300)).toBe('UTC-5');
    expect(zoneText(330)).toBe('UTC+5:30');
    expect(zoneText(345)).toBe('UTC+5:45');
    expect(zoneText(-570)).toBe('UTC-9:30');
    expect(zoneText(0)).toBe('UTC');
  });
});

describe('localTime', () => {
  it('shows the local time to the minute with its offset', () => {
    expect(localTime('2026-11-05T10:12:59.000Z', () => 480)).toEqual({ time: '2026-11-05 18:12', zone: 'UTC+8' });
    expect(localTime('2026-11-05T10:12:00Z', () => 0)).toEqual({ time: '2026-11-05 10:12', zone: 'UTC' });
  });

  it('moves to the day before or after when the offset crosses midnight', () => {
    expect(localTime('2026-11-05T02:00:00Z', () => -300)).toEqual({ time: '2026-11-04 21:00', zone: 'UTC-5' });
    expect(localTime('2026-11-05T20:00:00Z', () => 330)).toEqual({ time: '2026-11-06 01:30', zone: 'UTC+5:30' });
  });

  it('asks for the offset of each date, as summer time changes it', () => {
    const offsetOf = (date: Date): number => (date.getUTCMonth() === 6 ? 60 : 0);
    expect(localTime('2026-07-01T12:00:00Z', offsetOf).zone).toBe('UTC+1');
    expect(localTime('2026-12-01T12:00:00Z', offsetOf).zone).toBe('UTC');
  });
});

describe('STATUS_BUCKETS', () => {
  it('puts every state in exactly one of the six numbers, so they add up to the total', () => {
    const states = Object.values(STATUS_BUCKETS).flat();
    expect([...states].sort()).toEqual([...UNIT_STATES].sort());
    expect(new Set(states).size).toBe(UNIT_STATES.length);
    expect(Object.keys(STATUS_BUCKETS)).toEqual(['done', 'in_flight', 'blocked', 'failed', 'refused', 'left']);
  });

  it('counts a reply waiting to be verified as left, not as sent and gone', () => {
    expect(STATUS_BUCKETS['left']).toEqual(['PENDING', 'QUEUED', 'RECEIVED', 'STALE']);
  });
});

// `tome status` 的下一步，順序跟 `tome run` 的關卡相同（ADR-0130 第 16 項、ADR-0138）。
describe('nextStep', () => {
  const DONE: Progress = {
    extracted: true,
    scanned: true,
    review: 0,
    estimated: true,
    outstanding: 0,
    left: 0,
    unfinished: 0,
    realtime: false,
  };

  it('walks the gates of tome run in order, the first one not passed first', () => {
    const steps: [Partial<Progress>, string, string][] = [
      [{ extracted: false, scanned: false, review: 3, estimated: false, outstanding: 1, left: 5, unfinished: 2 }, 'extract', 'tome extract book'],
      [{ scanned: false, review: 3, estimated: false, outstanding: 1, left: 5, unfinished: 2 }, 'scan', 'tome scan-terms book --confirm'],
      [{ review: 3, estimated: false, outstanding: 1, left: 5, unfinished: 2 }, 'review', 'tome glossary review book --web'],
      [{ review: 1, estimated: false }, 'review', 'tome glossary review book --web'],
      [{ estimated: false, outstanding: 1, left: 5, unfinished: 2 }, 'estimate', 'tome estimate book --confirm'],
      [{ outstanding: 1, left: 5, unfinished: 2 }, 'collect', 'tome batch collect book'],
      [{ outstanding: 2 }, 'collect', 'tome batch collect book'],
      [{ left: 5, unfinished: 2 }, 'translate', 'tome translate book'],
      [{ left: 1 }, 'translate', 'tome translate book'],
      [{ unfinished: 2 }, 'retry', 'tome translate book --retry-failed'],
      [{ unfinished: 1 }, 'retry', 'tome translate book --retry-failed'],
      [{}, 'assemble', 'tome assemble book'],
    ];
    for (const [progress, step, command] of steps) {
      expect(nextStep('book', { ...DONE, ...progress })).toEqual({ step, command });
    }
  });

  it('adds --realtime where the mode matters, when the last estimate was realtime', () => {
    const realtime = { ...DONE, realtime: true };
    expect(nextStep('book', { ...realtime, extracted: false }).command).toBe('tome extract book');
    expect(nextStep('book', { ...realtime, scanned: false }).command).toBe('tome scan-terms book --confirm --realtime');
    expect(nextStep('book', { ...realtime, review: 1 }).command).toBe('tome glossary review book --web');
    expect(nextStep('book', { ...realtime, estimated: false }).command).toBe('tome estimate book --confirm --realtime');
    expect(nextStep('book', { ...realtime, outstanding: 1 }).command).toBe('tome batch collect book');
    expect(nextStep('book', { ...realtime, left: 1 }).command).toBe('tome translate book --realtime');
    expect(nextStep('book', { ...realtime, unfinished: 1 }).command).toBe('tome translate book --realtime --retry-failed');
    expect(nextStep('book', realtime).command).toBe('tome assemble book');
  });
});
