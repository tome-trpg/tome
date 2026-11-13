import { describe, expect, it, onTestFinished } from 'vitest';
import { readBook } from '../../src/core/book.ts';
import { recordUsage, type Usage } from '../../src/core/ledger.ts';
import { findModel, type ProviderModel, type RequestMode } from '../../src/core/provider.ts';
import { planBook, type BookPlan } from '../../src/core/request.ts';
import { openBookStore, type Store } from '../../src/core/store.ts';
import { calibrate, pickTrial, TRIAL_TTL, trialBook, trialSize } from '../../src/core/trial.ts';
import { addBlock, library, MODEL } from '../helpers/library.ts';

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

// 校準只用帳本裡試翻的列（ADR-0135）。帳都是這裡編的，書是合成 PDF 加上這裡編的段落。

const NOW = new Date('2026-11-13T00:00:00.000Z');
const WORDS = ['Amber', 'Birch', 'Cedar'];

interface Planned {
  readonly home: string;
  readonly store: Store;
  readonly plan: BookPlan;
  /** 規劃好的第 2、3 個請求，各只有一個單位。 */
  readonly first: string;
  readonly second: string;
}

/** 合成 PDF 的短段落跟第一段長段落併成一個請求，之後的長段落一段一個。 */
async function planned(mode: RequestMode = 'realtime'): Promise<Planned> {
  const lib = await library();
  WORDS.forEach((word, index) => {
    addBlock(lib.home, `p0010-${String(index).padStart(6, '0')}`, `${word} keeps the gate and counts the stones. `.repeat(115));
  });
  const store = openBookStore(lib.home, 'book');
  // 暫存資料夾刪除之前先關，Windows 才刪得掉。
  onTestFinished(() => store.close());
  const { plan } = await planBook(lib.home, readBook(lib.home, 'book'), store, mode);
  if (plan === null) throw new Error('the book has no plan');
  const single = plan.requests.slice(1).map(({ units }) => units.map(({ unit_id }) => unit_id));
  const [first, second] = single.map((ids) => (ids.length === 1 ? ids[0] : undefined));
  if (first === undefined || second === undefined) throw new Error('the book has no single unit requests');
  return { home: lib.home, store, plan, first, second };
}

function charge(at: Planned, id: string, units: readonly string[], usage: Partial<Usage>, model: ProviderModel = at.plan.model): void {
  recordUsage(at.store, {
    request_id: id,
    model,
    mode: at.plan.mode,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, ...usage },
    units: units.map((unit_id) => ({ unit_id, chars: 1 })),
    stop_reason: 'end_turn',
    max_tokens: null,
    trial: true,
  });
}

describe('calibrate (ADR-0135)', () => {
  it('has nothing to calibrate from before the trial', async () => {
    const at = await planned();
    expect(calibrate(at.store, at.plan, NOW)).toBeNull();
  });

  it('sets the tokens of a request against the estimate, and counts the cache reads and writes in the prompt', async () => {
    const at = await planned();
    charge(at, 'plain', [at.first], { input_tokens: 100, output_tokens: 50 });
    const plain = calibrate(at.store, at.plan, NOW);
    expect(plain).toEqual({
      model: MODEL,
      mode: 'realtime',
      input_factor: expect.any(Number),
      output_factor: expect.any(Number),
      requests: 1,
      resend_ratio: 0,
      cache_ttl: null,
      cache_hit_rate: null,
      created_at: NOW.toISOString(),
    });
    at.store.run('DELETE FROM ledger');
    // 快取讀寫不算在 `input_tokens` 裡：整個提示是 100 + 300 + 600，是上面的 10 倍。
    charge(at, 'cached', [at.first], { input_tokens: 100, output_tokens: 50, cache_read_tokens: 300, cache_write_tokens: 600 });
    const cached = calibrate(at.store, at.plan, NOW);
    expect((cached?.input_factor ?? 0) / (plain?.input_factor ?? 1)).toBeCloseTo(10, 9);
    expect(cached?.output_factor).toBe(plain?.output_factor);
    expect(cached?.cache_ttl).toBe('5m');
    expect(cached?.cache_hit_rate).toBeCloseTo(1 / 3, 12);
  });

  it('keeps the hour cache of a batch', async () => {
    const at = await planned('batch');
    charge(at, 'cached', [at.first], { input_tokens: 100, output_tokens: 50, cache_write_tokens: 600 });
    expect(calibrate(at.store, at.plan, NOW)).toMatchObject({ mode: 'batch', cache_ttl: '1h', cache_hit_rate: 0 });
  });

  it('compares only the first send of a unit, and counts a resend in the resend ratio', async () => {
    const at = await planned();
    charge(at, 'first', [at.first], { input_tokens: 200, output_tokens: 100 });
    const once = calibrate(at.store, at.plan, NOW);
    // 重送花了第一次的四分之一：200 + 10 × 100 對 50 + 10 × 25（Sonnet 5.5 的價格）。
    charge(at, 'again', [at.first], { input_tokens: 50, output_tokens: 25 });
    const twice = calibrate(at.store, at.plan, NOW);
    expect(twice).toMatchObject({ requests: 1, input_factor: once?.input_factor, output_factor: once?.output_factor });
    expect(twice?.resend_ratio).toBeCloseTo(0.25, 12);
  });

  it('leaves out a request whose units were sent before in another request', async () => {
    const at = await planned();
    charge(at, 'early', [at.first], { input_tokens: 100, output_tokens: 50 });
    const alone = calibrate(at.store, at.plan, NOW);
    charge(at, 'pair', [at.first, at.second], { input_tokens: 100, output_tokens: 50 });
    expect(calibrate(at.store, at.plan, NOW)).toMatchObject({ requests: 1, input_factor: alone?.input_factor });
  });

  it('leaves out a request of another model, which only counts as resent', async () => {
    const at = await planned();
    charge(at, 'main', [at.first], { input_tokens: 200, output_tokens: 100 });
    const main = calibrate(at.store, at.plan, NOW);
    // Opus 5.5 的價格：100 × 4 + 50 × 20 = 1,400，跟上面 200 × 2 + 100 × 10 一樣。
    charge(at, 'fallback', [at.second], { input_tokens: 100, output_tokens: 50 }, findModel(at.plan.provider.profile, 'claude-opus-5-5'));
    const both = calibrate(at.store, at.plan, NOW);
    expect(both).toMatchObject({ requests: 1, input_factor: main?.input_factor });
    expect(both?.resend_ratio).toBeCloseTo(1, 12);
  });

  it('leaves out a request with a unit that is no longer in the book', async () => {
    const at = await planned();
    charge(at, 'gone', [at.first, 'p9999-000000'], { input_tokens: 100, output_tokens: 50 });
    expect(calibrate(at.store, at.plan, NOW)).toBeNull();
  });

  it('has no resend ratio when the trial cost nothing', async () => {
    const at = await planned();
    charge(at, 'free', [at.first], {});
    expect(calibrate(at.store, at.plan, NOW)).toMatchObject({ requests: 1, resend_ratio: 0 });
  });
});

describe('trialBook (ADR-0135)', () => {
  it('says when the prices it estimates with are old', async () => {
    const at = await planned();
    const codes = async (today: Date): Promise<string[]> =>
      (await trialBook({ home: at.home, slug: 'book', mode: 'realtime', confirm: false, today })).findings.map(({ code }) => code);
    expect(await codes(new Date('2028-01-01T00:00:00.000Z'))).toContain('prices.stale');
    const fresh = await codes(NOW);
    expect(fresh).toContain('trial.estimate');
    expect(fresh.filter((code) => code.startsWith('prices.'))).toEqual([]);
  });

  it('needs a provider to send', async () => {
    const at = await planned();
    const options = { home: at.home, slug: 'book', mode: 'realtime', budget: '10', today: NOW } as const;
    await trialBook({ ...options, confirm: false });
    await expect(trialBook({ ...options, confirm: true })).rejects.toThrow(new RangeError('trial --confirm needs a provider'));
  });
});
