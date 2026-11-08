// CSV（RFC 4180），手寫，不另加相依（ADR-0113 第 19 項、ADR-0119）。逗號分隔，雙引號包住的欄位可以有逗號、
// 換行與兩個雙引號代表的一個雙引號。開頭的 BOM（Excel 存的檔）拿掉。從頭掃一次，耗時跟長度成正比。

export interface CsvRow {
  /** 第幾列，從 1 起算，空行也算一列，跟試算表的列號一樣；引號裡的換行不另算。 */
  readonly row: number;
  readonly fields: readonly string[];
}

export type CsvResult =
  | { readonly ok: true; readonly rows: readonly CsvRow[] }
  /** `row` 是引號沒有收尾的那一列。 */
  | { readonly ok: false; readonly row: number };

export function parseCsv(input: string): CsvResult {
  const text = input.startsWith('﻿') ? input.slice(1) : input;
  const rows: CsvRow[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let current = 1;
  let started = 0;
  let index = 0;
  const endField = (): void => {
    fields.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    // 空行不回傳，但照樣算一列。
    if (!(fields.length === 1 && fields[0] === '')) rows.push({ row: current, fields });
    fields = [];
    current += 1;
  };
  while (index < text.length) {
    const char = text[index] ?? '';
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
      } else {
        field += char;
      }
      index += 1;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      started = current;
    } else if (char === ',') {
      endField();
    } else if (char === '\r' || char === '\n') {
      endRow();
      if (char === '\r' && text[index + 1] === '\n') index += 1;
    } else {
      field += char;
    }
    index += 1;
  }
  if (quoted) return { ok: false, row: started };
  if (field !== '' || fields.length > 0) endRow();
  return { ok: true, rows };
}
