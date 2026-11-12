import { describe, expect, it } from 'vitest';
import { pickTrial, TRIAL_TTL, trialSize } from '../../src/core/trial.ts';

// 試翻的大小與選法（ADR-0135）：範圍內規劃好的請求約 10%，最少 5 個、最多 30 個，平均間隔挑整個請求。

describe('trialSize (ADR-0135)', () => {
  it.each([
    [0, 0],
    [1, 1],
    [4, 4],
    [5, 5],
    [13, 5],
    [54, 5],
    [55, 6],
    [190, 19],
    [300, 30],
    [2000, 30],
  ])('takes %i planned requests to a trial of %i', (planned, size) => {
    expect(trialSize(planned)).toBe(size);
  });
});

describe('pickTrial (ADR-0135)', () => {
  const numbers = (count: number): number[] => Array.from({ length: count }, (_, index) => index);

  it('takes the middle of each even stretch, never the start of the book', () => {
    expect(pickTrial(numbers(13))).toEqual([1, 3, 6, 9, 11]);
    expect(pickTrial(numbers(190))).toEqual(numbers(19).map((index) => index * 10 + 5));
  });

  it('takes them all when there are no more than the smallest trial', () => {
    expect(pickTrial(numbers(4))).toEqual([0, 1, 2, 3]);
    expect(pickTrial([])).toEqual([]);
  });

  it('keeps the reading order and never takes one twice', () => {
    for (const count of [5, 6, 7, 55, 299, 301]) {
      const picked = pickTrial(numbers(count));
      expect(picked).toHaveLength(trialSize(count));
      expect([...picked].sort((a, b) => a - b)).toEqual(picked);
      expect(new Set(picked).size).toBe(picked.length);
    }
  });
});

describe('the cache of a trial (ADR-0135)', () => {
  // 批次可能要 5 分鐘到 1 小時才做完，同一批的請求相隔可能超過 5 分鐘；即時模式一個接一個送。
  it('lasts an hour in a batch and five minutes in real time', () => {
    expect(TRIAL_TTL).toEqual({ batch: '1h', realtime: '5m' });
  });
});
