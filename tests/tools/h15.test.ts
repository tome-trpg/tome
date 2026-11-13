import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/cli/run.ts';
import { measure } from '../../tools/h15.ts';
import { addBlock, library, type Library } from '../helpers/library.ts';

// H-15 的量測工具（ADR-0136）。書是合成 PDF，加上這裡編的三行數值塊，角色直接寫進 document 層。

const STAT = 'd100-orc:stat_block';

/** 數值塊三行：一行欄位化、一行原樣保留、一行要送 LLM。書改用 d100-orc。 */
async function statBook(): Promise<Library> {
  const lib = await library();
  addBlock(lib.home, 'p0001-000101', 'Move: 8 Hit Points 14');
  addBlock(lib.home, 'p0001-000102', 'STR CON SIZ INT POW DEX CHA');
  addBlock(lib.home, 'p0001-000103', 'Damage Modifier: +1D4 Armor 2-point hide (may wear armor)');
  const path = join(lib.home, 'books', 'book', 'ir', 'document.json');
  const document = JSON.parse(readFileSync(path, 'utf8')) as { blocks: { id: string; role: string }[] };
  for (const block of document.blocks) if (block.id.startsWith('p0001-0001')) block.role = STAT;
  writeFileSync(path, JSON.stringify(document));
  const yaml = join(lib.home, 'books', 'book', 'book.yaml');
  writeFileSync(yaml, `${readFileSync(yaml, 'utf8')}system: d100-orc\n`);
  expect(await run(['estimate', 'book', '--json'], lib.session().io)).toBe(0);
  return lib;
}

describe('measure', () => {
  it('counts the stat block units fielded, kept as they are, and sent', async () => {
    const lib = await statBook();
    const { whole } = measure(lib.home, 'book', 1, 9999);
    expect(whole.stat_blocks).toBe(3);
    expect(whole.stat_units).toEqual({ units: 3, fielded: 1, kept: 1, sent: 1 });
  });

  it('counts only the blocks that start on the pages asked for', async () => {
    const lib = await statBook();
    const pages = measure(lib.home, 'book', 1, 9999).pages;
    // 加的區塊照最後一個區塊的頁，合成 PDF 只有幾頁；從它之後的頁開始就什麼都不算。
    const after = measure(lib.home, 'book', pages + 1, pages + 10);
    expect(after.range).toMatchObject({ first_page: pages + 1, last_page: pages + 10, blocks: 0, stat_blocks: 0 });
    expect(after.range.stat_units).toEqual({ units: 0, fielded: 0, kept: 0, sent: 0 });
    expect(measure(lib.home, 'book', 1, pages).range.stat_units.units).toBe(3);
  });

  it('prints numbers, never the text of the book', async () => {
    const lib = await statBook();
    const { status, stdout } = spawnSync(process.execPath, ['tools/h15.ts', lib.home, 'book', '1', '9999'], { encoding: 'utf8' });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ whole: { stat_units: { units: 3 } } });
    expect(stdout).not.toMatch(/Move|Hit Points|Damage|hide/u);
  });

  it('asks for the pages', () => {
    expect(spawnSync(process.execPath, ['tools/h15.ts', 'home', 'book'], { encoding: 'utf8' }).status).toBe(2);
  });
});
