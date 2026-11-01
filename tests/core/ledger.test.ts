import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { costOf, recordUsage, spentUsd, type Usage } from '../../src/core/ledger.ts';
import { findModel, loadProvider } from '../../src/core/provider.ts';
import { openBookStore, type Store } from '../../src/core/store.ts';
import { tempDir } from '../helpers.ts';

const { profile } = loadProvider('anthropic');
const opus = findModel(profile, 'claude-opus-5-5');
const haiku = findModel(profile, 'claude-haiku-5-5');

const MILLION: Usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0 };

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
    });
    const spent = spentUsd(database);
    database.close();
    expect(spent).toBeCloseTo((4 * 100) / 1_000_000);
  });

  it('starts at zero', () => {
    const database = store();
    expect(spentUsd(database)).toBe(0);
    database.close();
  });
});
