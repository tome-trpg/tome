import { describe, expect, it } from 'vitest';
import { UNIT_STATES } from '../../src/core/state.ts';
import { STATUS_BUCKETS, localTime, zoneText } from '../../src/core/status.ts';

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
