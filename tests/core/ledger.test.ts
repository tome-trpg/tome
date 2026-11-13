import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { costOf, recordEstimate, recordUsage, spentUsd, type Usage } from '../../src/core/ledger.ts';
import { findModel, loadProvider } from '../../src/core/provider.ts';
import { openBookStore, type Store } from '../../src/core/store.ts';
import { tempDir } from '../helpers.ts';

const { profile } = loadProvider('anthropic');
const opus = findModel(profile, 'claude-opus-5-5');
const haiku = findModel(profile, 'claude-haiku-5-5');

const MILLION: Usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0 };
/** 回覆的 `stop_reason` 與請求的 `max_tokens`（ADR-0114）。 */
const REPLY = { stop_reason: 'end_turn', max_tokens: 1024 } as const;

function store(): Store {
  return openBookStore(join(tempDir(), 'home'), 'book');
}

describe('costOf', () => {
  it('uses the realtime price', () => {
    expect(costOf(MILLION, opus, 'realtime')).toBe(24);
  });

  it('uses the batch price', () => {
    expect(costOf(MILLION, opus, 'batch')).toBe(12);
  });

  it('counts cache tokens at their own prices', () => {
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000, cache_write_tokens: 1_000_000 };
    expect(costOf(usage, opus, 'realtime')).toBeCloseTo(0.2 + 5);
  });

  it('halves cache tokens in a batch, as the input and output are', () => {
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000, cache_write_tokens: 1_000_000 };
    expect(costOf(usage, opus, 'batch')).toBeCloseTo((0.2 + 5) / 2);
  });

  it('counts cache tokens toward the long prompt limit', () => {
    const usage = { input_tokens: 60_000, output_tokens: 0, cache_read_tokens: 60_000, cache_write_tokens: 0 };
    expect(costOf(usage, haiku, 'realtime')).toBeCloseTo((0.5 * 60_000 + 0.05 * 60_000) / 1_000_000);
    const written = { input_tokens: 60_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 60_000 };
    expect(costOf(written, haiku, 'realtime')).toBeCloseTo((0.5 * 60_000 + 0.625 * 60_000) / 1_000_000);
  });

  // 試翻的批次用 1 小時的快取，寫入的價錢是 5 分鐘的 1.6 倍（ADR-0135）。
  it('prices the one hour cache writes at their own price', () => {
    const hour = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000, cache_write_1h_tokens: 1_000_000 };
    expect(costOf(hour, opus, 'realtime')).toBeCloseTo(8);
    expect(costOf(hour, opus, 'batch')).toBeCloseTo(4);
    const mixed = { ...hour, cache_write_1h_tokens: 400_000 };
    expect(costOf(mixed, opus, 'realtime')).toBeCloseTo(0.6 * 5 + 0.4 * 8);
  });
});

describe('recordUsage (ADR-0081 item 12)', () => {
  function record(database: Store): void {
    recordUsage(database, {
      request_id: 'r1',
      model: opus,
      mode: 'batch',
      usage: { input_tokens: 900, output_tokens: 300, cache_read_tokens: 0, cache_write_tokens: 0 },
      units: [
        { unit_id: 'a', chars: 100 },
        { unit_id: 'b', chars: 200 },
      ],
      ...REPLY,
    });
  }

  it('splits the usage of a request by characters', () => {
    const database = store();
    record(database);
    const rows = database.all<{ unit_id: string; input_tokens: number; output_tokens: number }>(
      'SELECT unit_id, input_tokens, output_tokens FROM ledger ORDER BY unit_id',
    );
    database.close();
    expect(rows).toEqual([
      { unit_id: 'a', input_tokens: 300, output_tokens: 100 },
      { unit_id: 'b', input_tokens: 600, output_tokens: 200 },
    ]);
  });

  it('adds up to what the request really cost', () => {
    const database = store();
    record(database);
    const spent = spentUsd(database);
    database.close();
    expect(spent).toBeCloseTo((2 * 900 + 10 * 300) / 1_000_000);
  });

  it('keeps every token when the split does not divide evenly', () => {
    const database = store();
    recordUsage(database, {
      request_id: 'r1',
      model: opus,
      mode: 'batch',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 },
      units: [
        { unit_id: 'a', chars: 1 },
        { unit_id: 'b', chars: 1 },
        { unit_id: 'c', chars: 1 },
      ],
      ...REPLY,
    });
    const total = database.get<{ input: number }>('SELECT SUM(input_tokens) AS input FROM ledger');
    database.close();
    expect(total?.input).toBe(10);
  });

  it('never hands out more than there is, however many units share it', () => {
    const database = store();
    const units = Array.from({ length: 9 }, (_, index) => ({ unit_id: `u${index}`, chars: 1 }));
    recordUsage(database, {
      request_id: 'r1',
      model: opus,
      mode: 'batch',
      usage: { input_tokens: 7, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      units,
      ...REPLY,
    });
    const rows = database.all<{ input_tokens: number }>('SELECT input_tokens FROM ledger');
    database.close();
    expect(rows.every(({ input_tokens }) => input_tokens >= 0)).toBe(true);
    expect(rows.reduce((sum, { input_tokens }) => sum + input_tokens, 0)).toBe(7);
  });

  it('records a request with no characters, so its cost is not lost', () => {
    const database = store();
    recordUsage(database, {
      request_id: 'r1',
      model: opus,
      mode: 'realtime',
      usage: { input_tokens: 100, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      units: [{ unit_id: 'a', chars: 0 }],
      ...REPLY,
    });
    const spent = spentUsd(database);
    database.close();
    expect(spent).toBeCloseTo((4 * 100) / 1_000_000);
  });

  // 字數都是 0 時沒有比例可分：tokens 與費用整筆記在最後一個單位，不重複、不遺失。
  it('gives the whole of a request with no characters to its last unit', () => {
    const database = store();
    recordUsage(database, {
      request_id: 'r1',
      model: opus,
      mode: 'realtime',
      usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 },
      units: [
        { unit_id: 'a', chars: 0 },
        { unit_id: 'b', chars: 0 },
        { unit_id: 'c', chars: 0 },
      ],
      ...REPLY,
    });
    const rows = database.all<{ unit_id: string; input_tokens: number; output_tokens: number; cost_usd: number }>(
      'SELECT unit_id, input_tokens, output_tokens, cost_usd FROM ledger ORDER BY unit_id',
    );
    database.close();
    const cost = (4 * 100 + 20 * 10) / 1_000_000;
    expect(rows).toEqual([
      { unit_id: 'a', input_tokens: 0, output_tokens: 0, cost_usd: 0 },
      { unit_id: 'b', input_tokens: 0, output_tokens: 0, cost_usd: 0 },
      { unit_id: 'c', input_tokens: 100, output_tokens: 10, cost_usd: expect.closeTo(cost, 12) },
    ]);
  });

  it('splits the cost by characters', () => {
    const database = store();
    recordUsage(database, {
      request_id: 'r1',
      model: opus,
      mode: 'realtime',
      usage: { input_tokens: 100, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      units: [
        { unit_id: 'a', chars: 1 },
        { unit_id: 'b', chars: 3 },
      ],
      ...REPLY,
    });
    const costs = database.all<{ cost_usd: number }>('SELECT cost_usd FROM ledger ORDER BY unit_id').map(({ cost_usd }) => cost_usd);
    database.close();
    expect(costs[0]).toBeCloseTo((4 * 25) / 1_000_000, 12);
    expect(costs[1]).toBeCloseTo((4 * 75) / 1_000_000, 12);
  });

  // 截斷的回覆沒有段落，`response` 裡什麼都沒有，帳本才記得到（ADR-0114）。
  it('keeps the stop reason and max_tokens of the request on every unit', () => {
    const database = store();
    recordUsage(database, {
      request_id: 'r1',
      model: opus,
      mode: 'batch',
      usage: { input_tokens: 900, output_tokens: 1658, cache_read_tokens: 0, cache_write_tokens: 0 },
      units: [
        { unit_id: 'a', chars: 1 },
        { unit_id: 'b', chars: 2 },
      ],
      stop_reason: 'max_tokens',
      max_tokens: 1658,
    });
    const rows = database.all<{ stop_reason: string | null; max_tokens: number | null }>(
      'SELECT stop_reason, max_tokens FROM ledger ORDER BY unit_id',
    );
    database.close();
    expect(rows).toEqual([
      { stop_reason: 'max_tokens', max_tokens: 1658 },
      { stop_reason: 'max_tokens', max_tokens: 1658 },
    ]);
  });

  it('stores null when the provider gave no stop reason or the limit is unknown', () => {
    const database = store();
    recordUsage(database, {
      request_id: 'r1',
      model: opus,
      mode: 'batch',
      usage: MILLION,
      units: [{ unit_id: 'a', chars: 1 }],
      stop_reason: null,
      max_tokens: null,
    });
    const row = database.get<{ stop_reason: string | null; max_tokens: number | null }>(
      'SELECT stop_reason, max_tokens FROM ledger',
    );
    database.close();
    expect(row).toEqual({ stop_reason: null, max_tokens: null });
  });

  it('starts at zero', () => {
    const database = store();
    expect(spentUsd(database)).toBe(0);
    database.close();
  });

  // 試翻的花費要分得出來：Q-6 不含試翻，校準只看試翻的請求（ADR-0135）。
  it('marks the requests of a trial, and leaves the others unmarked', () => {
    const database = store();
    const usage = { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 };
    recordUsage(database, { request_id: 't1', model: opus, mode: 'batch', usage, units: [{ unit_id: 'a', chars: 1 }], ...REPLY, trial: true });
    recordUsage(database, { request_id: 'r1', model: opus, mode: 'batch', usage, units: [{ unit_id: 'b', chars: 1 }], ...REPLY });
    const rows = database.all<{ request_id: string; trial: number }>('SELECT request_id, trial FROM ledger ORDER BY request_id');
    database.close();
    expect(rows).toEqual([
      { request_id: 'r1', trial: 0 },
      { request_id: 't1', trial: 1 },
    ]);
  });

  // 批次收回到一半中斷時會再下載一次結果，同一筆費用不能記兩次（ADR-0107）。
  it('records a request only once, however often its result is read', () => {
    const database = store();
    record(database);
    record(database);
    const rows = database.all('SELECT id FROM ledger');
    const spent = spentUsd(database);
    database.close();
    expect(rows).toHaveLength(2);
    expect(spent).toBeCloseTo((2 * 900 + 10 * 300) / 1_000_000);
  });
});

describe('recordEstimate (ADR-0135)', () => {
  // Pass 0 的估價沒有中間值，也沒有校準，交付報告不拿它算 Q-6。
  it('keeps an estimate with no middle as not calibrated', () => {
    const database = store();
    recordEstimate(database, { stage: 'scan', mode: 'batch', model: opus.id, requests: 1, low_usd: 0.1, high_usd: 0.2 });
    const rows = database.all('SELECT stage, middle_usd, calibrated FROM estimate');
    database.close();
    expect(rows).toEqual([{ stage: 'scan', middle_usd: null, calibrated: 0 }]);
  });
});
