import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  findModel,
  loadProvider,
  priceFinding,
  priceFor,
  thinkingParams,
  type Provider,
} from '../../src/core/provider.ts';
import { validateProvider } from '../../src/core/schema.ts';

const { profile, hash } = loadProvider('anthropic');

function model(id: string) {
  return findModel(profile, id);
}

describe('providers/anthropic.yaml', () => {
  it('fits tome-provider/1', () => {
    expect(validateProvider(parse(readFileSync('providers/anthropic.yaml', 'utf8'))).ok).toBe(true);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['claude-opus-5-5', 4, 20, 0.2, 2, 10],
    ['claude-sonnet-5-5', 2, 10, 0.1, 1, 5],
    ['claude-haiku-5-5', 0.1, 0.5, 0.01, 0.05, 0.25],
    ['claude-fable-5-1', 10, 50, 0.25, 5, 25],
    // 2026-11-14 讀官方的價目頁：批次價列在批次的表裡，快取命中是 0.025 倍（ADR-0139）。
    ['claude-fable-5-2', 8, 40, 0.2, 4, 20],
  ])('has the prices of the official page for %s', (id, input, output, read, batchIn, batchOut) => {
    expect(model(id).price).toMatchObject({
      input,
      output,
      cache_read: read,
      batch_input: batchIn,
      batch_output: batchOut,
    });
  });

  it('refuses extra fields, so a typo cannot slip through', () => {
    const value = parse(readFileSync('providers/anthropic.yaml', 'utf8')) as Record<string, unknown>;
    expect(validateProvider({ ...value, api_key: 'x' }).ok).toBe(false);
  });
});

// 每個單位的標籤與靜態前綴的比例（ADR-0134）。
describe('the estimate of tome-provider/1', () => {
  const value = parse(readFileSync('providers/anthropic.yaml', 'utf8')) as { estimate: Record<string, unknown> };

  function withEstimate(estimate: Record<string, unknown>): boolean {
    return validateProvider({ ...value, estimate }).ok;
  }

  it.each(['prefix_chars_per_token', 'unit_input_tokens', 'unit_output_tokens'])('needs %s', (key) => {
    const { [key]: _gone, ...rest } = value.estimate;
    expect(withEstimate(rest)).toBe(false);
  });

  it('refuses a typo in the estimate', () => {
    expect(withEstimate({ ...value.estimate, unit_output_token: 12 })).toBe(false);
  });

  it.each([
    ['prefix_chars_per_token', 0],
    ['unit_input_tokens', -1],
    ['unit_output_tokens', -1],
  ])('refuses %s of %d', (key, bad) => {
    expect(withEstimate({ ...value.estimate, [key]: bad })).toBe(false);
  });

  it('takes no tags at all', () => {
    expect(withEstimate({ ...value.estimate, unit_input_tokens: 0, unit_output_tokens: 0 })).toBe(true);
  });
});

describe('finding a model', () => {
  it('refuses a model that is not on the list, and says which are (ADR-0099 item 20)', () => {
    expect(() => findModel(profile, 'claude-nonexistent')).toThrow(
      expect.objectContaining({ code: 'model.unknown' }),
    );
  });

  it('reports an unknown provider, and names the ones it supports', () => {
    expect(() => loadProvider('nobody')).toThrow(
      expect.objectContaining({ code: 'provider.unknown', params: { supported: 'anthropic' } }),
    );
  });
});

describe('priceFor', () => {
  it('uses the normal price for most prompts', () => {
    expect(priceFor(model('claude-haiku-5-5'), 100_000).input).toBe(0.1);
  });

  it('moves the whole request to the long prompt price over the limit', () => {
    expect(priceFor(model('claude-haiku-5-5'), 100_001).input).toBe(0.5);
  });

  it('has one price for models with no such tier', () => {
    expect(priceFor(model('claude-opus-5-5'), 900_000).input).toBe(4);
    expect(priceFor(model('claude-fable-5-2'), 900_000).input).toBe(8);
  });

  it('writes the cache writes of Fable 5.2 from the official table', () => {
    expect(model('claude-fable-5-2').price).toMatchObject({ cache_write_5m: 10, cache_write_1h: 16 });
  });
});

describe('thinkingParams (ADR-0037)', () => {
  it('lowers effort on a model that cannot turn thinking off', () => {
    expect(thinkingParams(model('claude-opus-5-5'))).toEqual({ output_config: { effort: 'low' } });
    expect(thinkingParams(model('claude-fable-5-1'))).toEqual({ output_config: { effort: 'low' } });
    expect(thinkingParams(model('claude-fable-5-2'))).toEqual({ output_config: { effort: 'low' } });
  });

  it('turns it off the way each model wants, and leaves effort alone', () => {
    expect(thinkingParams(model('claude-sonnet-5-5'))).toEqual({ thinking: { type: 'between_tools' } });
    expect(thinkingParams(model('claude-haiku-5-5'))).toEqual({ thinking: { type: 'disabled' } });
  });
});

describe('priceFinding (ADR-0099 item 20)', () => {
  const sample: Provider = { ...profile, verified: '2026-11-02' };

  it('reports when the prices were checked', () => {
    expect(priceFinding(sample, new Date('2026-11-02T12:00:00Z'))).toEqual({
      code: 'prices.ok',
      level: 'info',
      params: { provider: 'anthropic', verified: '2026-11-02' },
    });
  });

  it('stays quiet up to 59 days', () => {
    expect(priceFinding(sample, new Date('2026-12-31T00:00:00Z')).code).toBe('prices.ok');
  });

  it('warns from 60 days, without failing', () => {
    expect(priceFinding(sample, new Date('2027-01-01T00:00:00Z'))).toEqual({
      code: 'prices.stale',
      level: 'warn',
      params: { provider: 'anthropic', verified: '2026-11-02', days: '60' },
    });
  });
});
