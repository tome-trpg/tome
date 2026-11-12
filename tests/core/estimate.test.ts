import { describe, expect, it } from 'vitest';
import { estimateFixedOutput, estimateRequest, sumEstimates } from '../../src/core/estimate.ts';
import { findModel, loadProvider, type Provider } from '../../src/core/provider.ts';

const { profile } = loadProvider('anthropic');
const opus = findModel(profile, 'claude-opus-5-5');
const sonnet = findModel(profile, 'claude-sonnet-5-5');

// 比例都是提案。測試用固定的比例，算式才看得清楚。
const simple: Provider = {
  ...profile,
  estimate: {
    ...profile.estimate,
    chars_per_token: 3,
    prefix_chars_per_token: 3,
    output_ratio: 1,
    unit_input_tokens: 0,
    unit_output_tokens: 0,
    low: 0.5,
    high: 2,
    retry_margin: 0,
  },
};

function tuned(estimate: Partial<Provider['estimate']>): Provider {
  return { ...simple, estimate: { ...simple.estimate, ...estimate } };
}

/** 只有 `user` 的請求，跟 ADR-0134 之前的算式一樣。 */
const plain = { prefixChars: 0, userChars: 3000, sourceChars: 3000, units: 0 };

describe('estimateRequest (ADR-0103)', () => {
  it('turns characters into tokens and tokens into dollars at the batch price', () => {
    const { low_usd, high_usd } = estimateRequest(simple, sonnet, plain, 'batch');
    const middle = (1000 * 1 + 1000 * 5) / 1_000_000;
    expect(low_usd).toBeCloseTo(middle * 0.5);
    expect(high_usd).toBeCloseTo(middle * 2);
  });

  it('uses the realtime price when asked', () => {
    const { high_usd } = estimateRequest(simple, sonnet, plain, 'realtime');
    expect(high_usd).toBeCloseTo(((1000 * 2 + 1000 * 10) / 1_000_000) * 2);
  });

  it('counts thinking as output on a model that cannot turn it off (ADR-0037)', () => {
    const { high_usd } = estimateRequest(simple, opus, { ...plain, userChars: 0 }, 'batch');
    expect(high_usd).toBeCloseTo(((1000 * 1.5 * 10) / 1_000_000) * 2);
  });

  it('adds room for retries', () => {
    const base = estimateRequest(simple, sonnet, plain, 'batch');
    const padded = estimateRequest(tuned({ retry_margin: 0.1 }), sonnet, plain, 'batch');
    expect(padded.high_usd).toBeCloseTo(base.high_usd * 1.1);
  });

  it('has a range, with low under high', () => {
    const size = { prefixChars: 4000, userChars: 4000, sourceChars: 6000, units: 20 };
    const { low_usd, high_usd } = estimateRequest(profile, opus, size, 'batch');
    expect(low_usd).toBeGreaterThan(0);
    expect(low_usd).toBeLessThan(high_usd);
  });
});

// M3 的帳本：每個單位的標籤在輸入與輸出都吃 token，靜態前綴每個 token 的字元比 `user` 少（ADR-0129 第 7 項）。
describe('the gaps the M3 ledger showed (ADR-0134)', () => {
  // 下面的低與高都設成 1、沒有餘裕，估價就是中間值，算式最清楚。
  const nothing = { prefixChars: 0, userChars: 0, sourceChars: 0, units: 0 };

  it('reads the static prefix at its own ratio, and user at chars_per_token', () => {
    const prefix = estimateRequest(tuned({ low: 1, high: 1, prefix_chars_per_token: 2.4 }), sonnet, { ...nothing, prefixChars: 2400 }, 'batch');
    expect(prefix.high_usd).toBeCloseTo((1000 * 1) / 1_000_000, 12);
    const user = estimateRequest(tuned({ low: 1, high: 1, prefix_chars_per_token: 2.4 }), sonnet, { ...nothing, userChars: 2400 }, 'batch');
    expect(user.high_usd).toBeCloseTo((800 * 1) / 1_000_000, 12);
  });

  it('adds the tags of every unit to the input', () => {
    const { high_usd } = estimateRequest(tuned({ low: 1, high: 1, unit_input_tokens: 6 }), sonnet, { ...nothing, units: 40 }, 'batch');
    expect(high_usd).toBeCloseTo((240 * 1) / 1_000_000, 12);
  });

  it('adds the tags of every unit to the output, at the output price', () => {
    const { high_usd } = estimateRequest(tuned({ low: 1, high: 1, unit_output_tokens: 12 }), sonnet, { ...nothing, units: 40 }, 'batch');
    expect(high_usd).toBeCloseTo((480 * 5) / 1_000_000, 12);
  });

  // 跟 `max_tokens` 一樣，標籤加在思考的倍數之外（ADR-0114 第 2 項）。
  it('does not multiply the tags by the thinking factor', () => {
    const tags = tuned({ low: 1, high: 1, unit_output_tokens: 12 });
    const { high_usd } = estimateRequest(tags, opus, { ...nothing, sourceChars: 3000, units: 40 }, 'batch');
    expect(high_usd).toBeCloseTo(((1000 * 1.5 + 480) * 10) / 1_000_000, 12);
  });

  it('grows with each part on its own', () => {
    const shipped = { ...profile, estimate: { ...profile.estimate, low: 1, high: 1 } };
    const base = { prefixChars: 4000, userChars: 6000, sourceChars: 3000, units: 20 };
    const cost = (size: typeof base) => estimateRequest(shipped, sonnet, size, 'batch').high_usd;
    const margin = 1 + profile.estimate.retry_margin;
    const perToken = (price: number) => (price * margin) / 1_000_000;
    expect(cost({ ...base, prefixChars: 4240 }) - cost(base)).toBeCloseTo(100 * perToken(1), 12);
    expect(cost({ ...base, userChars: 6300 }) - cost(base)).toBeCloseTo(100 * perToken(1), 12);
    expect(cost({ ...base, units: 30 }) - cost(base)).toBeCloseTo(10 * (6 * perToken(1) + 12 * perToken(5)), 12);
    expect(cost({ ...base, sourceChars: 3300 }) - cost(base)).toBeCloseTo(120 * perToken(5), 12);
  });

  it('uses the long prompt price once the tags and the prefix pass the limit', () => {
    const haiku = findModel(profile, 'claude-haiku-5-5');
    const over = haiku.long_prompt?.over_tokens ?? 0;
    // 字元算起來剛好在上限，加上單位的標籤就超過。
    const size = { prefixChars: 0, userChars: over * 3, sourceChars: 0, units: 10 };
    const under = estimateRequest(tuned({ low: 1, high: 1 }), haiku, size, 'batch');
    const tagged = estimateRequest(tuned({ low: 1, high: 1, unit_input_tokens: 6 }), haiku, size, 'batch');
    expect(under.high_usd).toBeCloseTo((over * 0.05) / 1_000_000, 12);
    expect(tagged.high_usd).toBeCloseTo(((over + 60) * 0.25) / 1_000_000, 12);
  });

  it('ships the proposals of ADR-0134', () => {
    expect(profile.estimate).toMatchObject({
      prefix_chars_per_token: 2.4,
      unit_input_tokens: 6,
      unit_output_tokens: 12,
      retry_margin: 0.25,
    });
  });
});

// Pass 0 的實際花費已經在估價下限附近，ADR-0134 第 1 到 4 項不套在它身上（第 6 項）。
describe('estimateFixedOutput, for Pass 0 (ADR-0118)', () => {
  it('is what it was before ADR-0134 with the shipped provider', () => {
    // 3000 字元 ÷ 3 = 1000 個輸入 token，加 1000 個輸出 token，Sonnet 5.5 的批次價，乘 1.1 的餘裕。
    const { low_usd, high_usd } = estimateFixedOutput(profile, sonnet, 3000, 1000, 'batch');
    const middle = ((1000 * 1 + 1000 * 5) / 1_000_000) * 1.1;
    expect(low_usd).toBeCloseTo(middle * 0.8, 12);
    expect(high_usd).toBeCloseTo(middle * 1.3, 12);
  });

  it('ignores the prefix ratio and the tags of units', () => {
    const before = estimateFixedOutput(simple, opus, 3000, 1000, 'realtime');
    const after = estimateFixedOutput(
      tuned({ prefix_chars_per_token: 1, unit_input_tokens: 100, unit_output_tokens: 100 }),
      opus,
      3000,
      1000,
      'realtime',
    );
    expect(after).toEqual(before);
  });

  // 候選詞與全書提要都走這裡，用 `scan_retry_margin`，翻譯的 `retry_margin` 不影響它（ADR-0134 第 6 項）。
  it('uses scan_retry_margin, not the margin of translation', () => {
    const base = estimateFixedOutput(tuned({ scan_retry_margin: 0 }), sonnet, 3000, 1000, 'batch');
    expect(estimateFixedOutput(tuned({ scan_retry_margin: 0, retry_margin: 0.5 }), sonnet, 3000, 1000, 'batch')).toEqual(base);
    const padded = estimateFixedOutput(tuned({ scan_retry_margin: 0.3 }), sonnet, 3000, 1000, 'batch');
    expect(padded.high_usd).toBeCloseTo(base.high_usd * 1.3, 12);
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
