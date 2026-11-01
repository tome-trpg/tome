import { describe, expect, it } from 'vitest';
import { estimateRequest, sumEstimates } from '../../src/core/estimate.ts';
import { findModel, loadProvider } from '../../src/core/provider.ts';

const { profile } = loadProvider('anthropic');
const opus = findModel(profile, 'claude-opus-5-5');
const sonnet = findModel(profile, 'claude-sonnet-5-5');

// 比例都是提案。測試用固定的比例，算式才看得清楚。
const simple = {
  ...profile,
  estimate: { chars_per_token: 3, output_ratio: 1, low: 0.5, high: 2, retry_margin: 0 },
};

describe('estimateRequest (ADR-0103)', () => {
  it('turns characters into tokens and tokens into dollars at the batch price', () => {
    const { low_usd, high_usd } = estimateRequest(simple, sonnet, { promptChars: 3000, sourceChars: 3000 }, 'batch');
    const middle = (1000 * 1 + 1000 * 5) / 1_000_000;
    expect(low_usd).toBeCloseTo(middle * 0.5);
    expect(high_usd).toBeCloseTo(middle * 2);
  });

  it('uses the realtime price when asked', () => {
    const { high_usd } = estimateRequest(simple, sonnet, { promptChars: 3000, sourceChars: 3000 }, 'realtime');
    expect(high_usd).toBeCloseTo(((1000 * 2 + 1000 * 10) / 1_000_000) * 2);
  });

  it('counts thinking as output on a model that cannot turn it off (ADR-0037)', () => {
    const { high_usd } = estimateRequest(simple, opus, { promptChars: 0, sourceChars: 3000 }, 'batch');
    expect(high_usd).toBeCloseTo(((1000 * 1.5 * 10) / 1_000_000) * 2);
  });

  it('adds room for retries', () => {
    const retrying = { ...simple, estimate: { ...simple.estimate, retry_margin: 0.1 } };
    const base = estimateRequest(simple, sonnet, { promptChars: 3000, sourceChars: 3000 }, 'batch');
    const padded = estimateRequest(retrying, sonnet, { promptChars: 3000, sourceChars: 3000 }, 'batch');
    expect(padded.high_usd).toBeCloseTo(base.high_usd * 1.1);
  });

  it('has a range, with low under high', () => {
    const { low_usd, high_usd } = estimateRequest(profile, opus, { promptChars: 8000, sourceChars: 6000 }, 'batch');
    expect(low_usd).toBeGreaterThan(0);
    expect(low_usd).toBeLessThan(high_usd);
  });
});

describe('sumEstimates', () => {
  it('adds both ends of the range', () => {
    expect(
      sumEstimates([
        { low_usd: 1, high_usd: 2 },
        { low_usd: 3, high_usd: 4 },
      ]),
    ).toEqual({ low_usd: 4, high_usd: 6 });
  });

  it('is zero for nothing', () => {
    expect(sumEstimates([])).toEqual({ low_usd: 0, high_usd: 0 });
  });
});
