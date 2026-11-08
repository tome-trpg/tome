import { describe, expect, it } from 'vitest';
import { parseCsv, type CsvResult } from '../../src/core/csv.ts';

// 文字都是這裡編的（ADR-0119）。

function fields(result: CsvResult): (readonly string[])[] | null {
  return result.ok ? result.rows.map(({ fields: values }) => values) : null;
}

describe('parseCsv', () => {
  it('splits rows and fields, with CRLF or LF and a last line without one', () => {
    expect(fields(parseCsv('source,target\r\nSalt Marsh,鹽沼\nGrey Warden,灰色守望者'))).toEqual([
      ['source', 'target'],
      ['Salt Marsh', '鹽沼'],
      ['Grey Warden', '灰色守望者'],
    ]);
  });

  it('reads quoted fields with commas, line breaks and doubled quotes', () => {
    expect(fields(parseCsv('source,target\n"Ferry, Old","渡口\n舊的"\n"The ""Warden""",守望者\n'))).toEqual([
      ['source', 'target'],
      ['Ferry, Old', '渡口\n舊的'],
      ['The "Warden"', '守望者'],
    ]);
  });

  it('drops the byte order mark Excel writes, and blank lines', () => {
    expect(fields(parseCsv('﻿source,target\n\nSalt Marsh,鹽沼\n\n'))).toEqual([
      ['source', 'target'],
      ['Salt Marsh', '鹽沼'],
    ]);
  });

  it('keeps empty fields', () => {
    expect(fields(parseCsv('a,,c\n,,'))).toEqual([['a', '', 'c'], ['', '', '']]);
  });

  it('numbers rows the way a spreadsheet does: blank lines count, line breaks inside quotes do not', () => {
    const result = parseCsv('source,target\n\n"Ferry,\nOld",渡口\r\nSalt Marsh,鹽沼\n');
    expect(result.ok && result.rows.map(({ row }) => row)).toEqual([1, 3, 4]);
  });

  it('names the row of a quote that never closes', () => {
    expect(parseCsv('source,target\nSalt Marsh,鹽沼\n\n"Grey,灰')).toEqual({ ok: false, row: 4 });
  });

  it('reads a long file in time proportional to its length', () => {
    const text = 'source,target\n' + 'Salt Marsh,"鹽, 沼"\n'.repeat(100_000);
    const started = performance.now();
    const result = parseCsv(text);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.ok && result.rows.length).toBe(100_001);
  });
});
