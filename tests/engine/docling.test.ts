import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { readEngineSpec, locateEngine } from '../../src/core/engine.ts';
import type { SourcePage } from '../../src/core/ir.ts';
import { runTool } from '../../src/core/process.ts';
import { validateEngineRun, validateIr } from '../../src/core/schema.ts';
import { forge, forgeFile, LAYOUT_TRUTH } from '../forge/index.ts';
import { capture, tempDir } from '../helpers.ts';

// 真的跑 Docling（ADR-0064）。平常的 CI 跳過，`.github/workflows/engine.yml` 裝好引擎後才跑。
const home = process.env['TOME_ENGINE_HOME'];

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe.skipIf(home === undefined)('Docling on a forged PDF', () => {
  it('writes source pages that pass tome-ir/1', { timeout: 900_000 }, async () => {
    const root = home ?? '';
    const session = () => capture({ env: { ...process.env, TOME_HOME: root }, tool: runTool });
    expect(await run(['add', await forgeFile('blocks', tempDir()), '--as', 'blocks'], session().io)).toBe(0);

    const extracted = session();
    expect(await run(['extract', 'blocks', '--json'], extracted.io)).toBe(0);
    const { data } = JSON.parse(extracted.stdout()) as Envelope;
    expect(data).toMatchObject({ pages: 2, failed: 0 });

    const files = filesUnder(join(root, 'books', 'blocks', 'ir', 'source'));
    const pages = files
      .filter((path) => /p\d{4}\.json$/.test(path))
      .sort()
      .map((path) => {
        const checked = validateIr(json(path));
        expect(checked.ok).toBe(true);
        return json(path) as SourcePage;
      });
    expect(pages.map((page) => page.page)).toEqual([0, 1]);

    // 角色是版面模型的判斷，會隨平台與字型渲染變動，所以印出來比對，不當成契約。
    // 轉接器要保證的是字都在，頁首頁尾也一樣，字元守恆看的是整頁（S-14）。
    const { truth } = await forge('blocks');
    for (const page of pages) {
      console.log(JSON.stringify(page.blocks.map((block) => [block.role, block.text.slice(0, 24)])));
      expect(page.blocks.every((block) => block.spans.every((span) => span.page === page.page))).toBe(true);
      const found = page.blocks
        .flatMap((block) => block.table?.cells.map((cell) => cell.text) ?? [block.text])
        .join(' ')
        .replace(/\s+/g, ' ');
      for (const text of truth.text?.[page.page] ?? []) expect(found).toContain(text);
      const table = page.blocks.find((block) => block.role === 'table')?.table;
      expect(table).toMatchObject({ rows: 4, cols: 4 });
    }

    const record = files.find((path) => path.endsWith('engine.json')) ?? '';
    const checked = validateEngineRun(json(record));
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      // 執行紀錄只記程式與權重的授權（LC-3）。專有元件是安裝時的提示，不是這次執行的事。
      const { code, weights } = readEngineSpec(locateEngine('docling').dir).license;
      expect(checked.value.license).toEqual({ code, weights });
    }
  });

  it('assembles the forged layouts in reading order', { timeout: 900_000 }, async () => {
    const root = home ?? '';
    const session = () => capture({ env: { ...process.env, TOME_HOME: root }, tool: runTool });
    expect(await run(['add', await forgeFile('layout', tempDir()), '--as', 'layout'], session().io)).toBe(0);
    expect(await run(['extract', 'layout'], session().io)).toBe(0);

    const checked = validateIr(json(join(root, 'books', 'layout', 'ir', 'document.json')));
    expect(checked.ok).toBe(true);
    if (!checked.ok || checked.value.layer !== 'document') return;
    const { blocks, pages } = checked.value;
    console.log(JSON.stringify(blocks.map(({ role, flow, text }) => [role, flow, text.slice(0, 24)])));
    console.log(JSON.stringify(pages));
    expect(pages.map(({ status }) => status)).toEqual(['ok', 'ok', 'ok']);

    // 這些是版面規則要保證的。角色的細節跟著模型變，不在這裡釘（ADR-0085）。
    const flow = blocks.find(({ text }) => text.startsWith('Alpha opening'));
    const positions = LAYOUT_TRUTH.flow.map((phrase) => flow?.text.indexOf(phrase) ?? -1);
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    const aside = blocks.filter((block) => block.flow === 'aside').map(({ text }) => text.slice(0, 20));
    expect(aside.join('\n')).toContain(LAYOUT_TRUTH.columnBox);
    expect(blocks.some(({ text }) => text.startsWith(LAYOUT_TRUTH.dropCap))).toBe(true);
    expect(blocks.find(({ table }) => table !== undefined)?.table?.rows).toBe(LAYOUT_TRUTH.tableRows);
  });
});
