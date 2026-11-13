import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IrDocument } from '../src/core/ir.ts';
import { openBookStore } from '../src/core/store.ts';

// H-15 的量測（白皮書 §11、ADR-0121、ADR-0136）：數值塊有多少在本機翻好、不送 LLM。
// 讀工作區裡一本書的 document 層與 book.db，只輸出數字，不輸出任何書本文字。
// 先跑過 `tome extract` 與 `tome estimate`，單位才有角色與欄位化的結果。結束碼：0 正常、2 用法錯了。

interface UnitRow {
  readonly block_id: string;
  readonly role: string;
  readonly state: string;
  readonly fielded: number;
}

export interface StatUnits {
  /** 判成數值塊的單位。 */
  readonly units: number;
  /** 整塊在本機用詞條翻好（ADR-0121）。 */
  readonly fielded: number;
  /** 遮蔽之後沒有要翻的字，原樣保留。 */
  readonly kept: number;
  /** 還要送 LLM。 */
  readonly sent: number;
}

export interface Counts {
  readonly blocks: number;
  readonly stat_blocks: number;
  /** 表格不判角色（ADR-0092），另外數。 */
  readonly tables: number;
  readonly stat_units: StatUnits;
}

export interface Measurement {
  readonly pages: number;
  readonly whole: Counts;
  readonly range: Counts & { readonly first_page: number; readonly last_page: number };
}

function isStatBlock(role: string): boolean {
  return role === 'stat_block' || role.endsWith(':stat_block');
}

function count(blocks: IrDocument['blocks'], units: readonly UnitRow[]): Counts {
  const ids = new Set(blocks.map(({ id }) => id));
  const stat = units.filter(({ block_id, role }) => ids.has(block_id) && isStatBlock(role));
  const done = stat.filter(({ state }) => state === 'DONE');
  return {
    blocks: blocks.length,
    stat_blocks: blocks.filter(({ role }) => isStatBlock(role)).length,
    tables: blocks.filter(({ table }) => table !== undefined).length,
    stat_units: {
      units: stat.length,
      fielded: done.filter(({ fielded }) => fielded === 1).length,
      kept: done.filter(({ fielded }) => fielded === 0).length,
      sent: stat.length - done.length,
    },
  };
}

/** 頁碼從 1 算起，含頭含尾；區塊照它第一個片段的頁算。 */
export function measure(home: string, slug: string, firstPage: number, lastPage: number): Measurement {
  const path = join(home, 'books', slug, 'ir', 'document.json');
  const document = JSON.parse(readFileSync(path, 'utf8')) as IrDocument;
  const store = openBookStore(home, slug);
  let units: UnitRow[];
  try {
    units = store.all<UnitRow>('SELECT block_id, role, state, fielded FROM unit');
  } finally {
    store.close();
  }
  const inRange = document.blocks.filter(({ spans }) => {
    const page = (spans[0]?.page ?? -1) + 1;
    return page >= firstPage && page <= lastPage;
  });
  return {
    pages: document.pages.length,
    whole: count(document.blocks, units),
    range: { first_page: firstPage, last_page: lastPage, ...count(inRange, units) },
  };
}

function main(args: readonly string[]): number {
  const [home, slug, first, last] = args;
  const firstPage = Number(first);
  const lastPage = Number(last);
  if (home === undefined || slug === undefined || !Number.isInteger(firstPage) || !Number.isInteger(lastPage)) {
    process.stderr.write('usage: node tools/h15.ts <TOME_HOME> <book> <first page> <last page>\n');
    return 2;
  }
  process.stdout.write(`${JSON.stringify(measure(home, slug, firstPage, lastPage), null, 2)}\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
