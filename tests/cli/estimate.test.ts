import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { library, MODEL, setWorkspace, type Library } from '../helpers/library.ts';

// 文字都是合成 PDF 的假文字。這一輪不連網，所以每個流程都盯著 fetch。

function envelope(text: string): Envelope {
  return JSON.parse(text) as Envelope;
}

async function estimate(lib: Library, ...args: string[]): Promise<{ exit: number; output: Envelope; text: string }> {
  const { io, stdout } = lib.session();
  const exit = await run(['estimate', 'book', '--json', ...args], io);
  return { exit, output: envelope(stdout()), text: stdout() };
}

function codes(output: Envelope): string[] {
  return output.findings.map((item) => item.code);
}

function bookYaml(home: string): Record<string, unknown> {
  return parse(readFileSync(join(home, 'books', 'book', 'book.yaml'), 'utf8')) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tome estimate (ADR-0103)', () => {
  it('shows the range, the model and the retention, without a network', async () => {
    const lib = await library();
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const { exit, output } = await estimate(lib);
    expect(exit).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(output.data).toMatchObject({ book: 'book', model: MODEL, units: 3, requests: 1, confirmed: false, retention_days: 29 });
    expect(output.data['low_usd']).toBeGreaterThan(0);
    expect(output.data['high_usd']).toBeGreaterThan(output.data['low_usd'] as number);
    const done = output.findings.find((item) => item.code === 'estimate.done');
    expect(done?.params).toMatchObject({ model: MODEL, units: '3', requests: '1', retention: '29' });
  });

  it('says in Chinese that it is an estimate, and keeps book text out', async () => {
    const lib = await library();
    const { io, stdout } = lib.session();
    await run(['estimate', 'book'], io);
    expect(stdout()).toContain('尚未以實際用量校準');
    expect(stdout()).toContain('保留 29 天');
    expect(stdout()).not.toContain('warden');
    expect((await estimate(lib)).text).not.toContain('warden');
  });

  it('warns about a missing budget, and asks for a confirmation', async () => {
    const lib = await library();
    const { exit, output } = await estimate(lib);
    expect(exit).toBe(0);
    expect(output.findings.find((item) => item.code === 'estimate.no_budget')?.level).toBe('warn');
    expect(codes(output)).toContain('estimate.not_confirmed');
  });

  it('warns about an empty list of personal data (ADR-0099 item 21)', async () => {
    const lib = await library({ config: `translator_model: ${MODEL}\npii: []\n` });
    expect((await estimate(lib)).output.findings.find((item) => item.code === 'pii.empty')?.level).toBe('warn');
    setWorkspace(lib.home, `translator_model: ${MODEL}\npii: [Forged Buyer]\n`);
    expect(codes((await estimate(lib)).output)).not.toContain('pii.empty');
  });

  it('warns about an entry too short to match safely (ADR-0104 item 8)', async () => {
    const lib = await library({ config: `translator_model: ${MODEL}\npii: [Forged Buyer, Al]\n` });
    const { output, text } = await estimate(lib);
    expect(output.findings.find((item) => item.code === 'pii.too_short')).toMatchObject({
      level: 'warn',
      params: { entries: '2' },
    });
    expect(text).not.toContain('Forged Buyer');
  });

  it('keeps the budget in book.yaml, and says how much is left', async () => {
    const lib = await library();
    const { output } = await estimate(lib, '--budget', '12.5');
    expect(bookYaml(lib.home)['budget_usd']).toBe(12.5);
    expect(output.findings.find((item) => item.code === 'estimate.budget')?.params).toEqual({
      budget: '12.50',
      spent: '0.00',
    });
    expect((await estimate(lib)).output.data['budget_usd']).toBe(12.5);
  });

  it.each(['abc', '0', '-1', 'Infinity'])('refuses the budget %s', async (value) => {
    const lib = await library();
    const { exit, output } = await estimate(lib, `--budget=${value}`);
    expect(exit).toBe(2);
    expect(output.ok).toBe(false);
    expect(bookYaml(lib.home)['budget_usd']).toBeUndefined();
  });

  it('asks for a model, and refuses one that is not on the list', async () => {
    const missing = await library({ config: 'pii: [x]\n' });
    const { io, stderr } = missing.session();
    expect(await run(['estimate', 'book'], io)).toBe(2);
    expect(stderr()).toContain('translator_model');
    const unknown = await library({ config: 'translator_model: claude-nonexistent\n' });
    const other = unknown.session();
    expect(await run(['estimate', 'book'], other.io)).toBe(2);
    expect(other.stderr()).toContain('claude-nonexistent');
    expect(other.stderr()).toContain(MODEL);
  });

  it('asks to run tome extract first', async () => {
    const lib = await library({ extract: false });
    const { io, stderr } = lib.session();
    expect(await run(['estimate', 'book'], io)).toBe(2);
    expect(stderr()).toContain('tome extract book');
  });

  it('exits 2 for a book it does not know', async () => {
    const lib = await library();
    expect(await run(['estimate', 'nope'], lib.session().io)).toBe(2);
    expect(await run(['estimate'], lib.session().io)).toBe(2);
  });

  it('stops at a rule pack that cannot be trusted', async () => {
    const lib = await library();
    const dir = join(lib.home, 'systems', 'generic');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pack.yaml'), 'schema: [');
    const { exit, output } = await estimate(lib);
    expect(exit).toBe(1);
    expect(codes(output)).toContain('pack.invalid_yaml');
    expect(codes(output)).not.toContain('estimate.done');
  });
});

describe('--confirm (ADR-0103)', () => {
  it('needs a budget', async () => {
    const lib = await library();
    const { exit, output } = await estimate(lib, '--confirm');
    expect(exit).toBe(1);
    expect(output.findings.find((item) => item.code === 'estimate.no_budget')?.level).toBe('fail');
    expect(output.data['confirmed']).toBe(false);
  });

  it('records the confirmation, and remembers it', async () => {
    const lib = await library();
    const { exit, output } = await estimate(lib, '--budget', '100', '--confirm');
    expect(exit).toBe(0);
    expect(codes(output)).toContain('estimate.confirmed');
    expect(output.data['confirmed']).toBe(true);
    const later = (await estimate(lib)).output;
    expect(later.data['confirmed']).toBe(true);
    expect(codes(later)).not.toContain('estimate.not_confirmed');
  });

  it('refuses an estimate over the budget, and records nothing', async () => {
    const lib = await library();
    const { exit, output } = await estimate(lib, '--budget', '0.000001', '--confirm');
    expect(exit).toBe(1);
    expect(output.findings.find((item) => item.code === 'estimate.over_budget')?.level).toBe('fail');
    expect(output.data['confirmed']).toBe(false);
    expect((await estimate(lib)).output.data['confirmed']).toBe(false);
  });

  it('asks again when the budget changes', async () => {
    const lib = await library();
    await estimate(lib, '--budget', '100', '--confirm');
    expect((await estimate(lib, '--budget', '200')).output.data['confirmed']).toBe(false);
  });

  it('stays confirmed as units finish, so a resumed run does not ask again', async () => {
    const lib = await library();
    await estimate(lib, '--budget', '100', '--confirm');
    const { openBookStore } = await import('../../src/core/store.ts');
    const store = openBookStore(lib.home, 'book');
    store.run("UPDATE unit SET state = 'DONE' WHERE seq = 0");
    store.close();
    expect((await estimate(lib)).output.data['confirmed']).toBe(true);
  });

  it('asks again when the model changes', async () => {
    const lib = await library();
    await estimate(lib, '--budget', '100', '--confirm');
    setWorkspace(lib.home, 'translator_model: claude-opus-5-5\npii: [Forged Buyer]\n');
    expect((await estimate(lib)).output.data['confirmed']).toBe(false);
  });

  // 來源語言決定 `<glossary>` 列哪些詞條，只有 `keep_source` 的詞條會讓單位的文字變（ADR-0106）。
  it('asks again when only the source language changes', async () => {
    const lib = await library();
    await estimate(lib, '--budget', '100', '--confirm');
    expect((await estimate(lib)).output.data['confirmed']).toBe(true);
    const path = join(lib.home, 'books', 'book', 'book.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('source_lang: en', 'source_lang: ja'));
    expect(bookYaml(lib.home)['source_lang']).toBe('ja');
    expect((await estimate(lib)).output.data['confirmed']).toBe(false);
  });

  // 譯名與角色風格會改變送出的內容，卻不在靜態前綴裡（ADR-0104 第 41 項）。
  describe('with a rule pack of its own', () => {
    function setPackFile(home: string, file: string, text: string): void {
      const dir = join(home, 'systems', 'child');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), text);
    }

    async function withPack(): Promise<Library> {
      const lib = await library();
      setPackFile(lib.home, 'pack.yaml', 'schema: tome-pack/1\nid: child\nversion: 0.1.0\nlicense: UNLICENSED\nsource_langs: [en]\n');
      setPackFile(lib.home, 'glossary.yaml', 'terms:\n  - source: { en: warden }\n    target: 看守人\n');
      setPackFile(lib.home, 'roles.yaml', 'roles:\n  gm_note:\n    style: 語氣直接。\n');
      const path = join(lib.home, 'books', 'book', 'book.yaml');
      writeFileSync(path, `${readFileSync(path, 'utf8')}system: child\n`);
      await estimate(lib, '--budget', '100', '--confirm');
      expect((await estimate(lib)).output.data['confirmed']).toBe(true);
      return lib;
    }

    it('asks again when only the target of a term changes', async () => {
      const lib = await withPack();
      setPackFile(lib.home, 'glossary.yaml', 'terms:\n  - source: { en: warden }\n    target: 守衛\n');
      expect((await estimate(lib)).output.data['confirmed']).toBe(false);
    });

    it('asks again when only the style of a role changes', async () => {
      const lib = await withPack();
      setPackFile(lib.home, 'roles.yaml', 'roles:\n  gm_note:\n    style: 語氣溫和。\n');
      expect((await estimate(lib)).output.data['confirmed']).toBe(false);
    });

    it('stays confirmed when nothing in the pack changed', async () => {
      const lib = await withPack();
      expect((await estimate(lib)).output.data['confirmed']).toBe(true);
    });
  });
});

describe('tome estimate --realtime (ADR-0104)', () => {
  it('prices the requests at the realtime rate', async () => {
    const lib = await library();
    const batch = (await estimate(lib)).output.data;
    const realtime = (await estimate(lib, '--realtime')).output.data;
    expect(batch['mode']).toBe('batch');
    expect(realtime['mode']).toBe('realtime');
    expect(realtime['high_usd']).toBeGreaterThan(batch['high_usd'] as number);
  });

  it('is not kept in book.yaml', async () => {
    const lib = await library();
    await estimate(lib, '--realtime', '--budget', '100');
    expect(Object.values(bookYaml(lib.home))).not.toContain('realtime');
    expect((await estimate(lib)).output.data['mode']).toBe('batch');
  });

  it('asks again when the mode changes', async () => {
    const lib = await library();
    await estimate(lib, '--realtime', '--budget', '100', '--confirm');
    expect((await estimate(lib, '--realtime')).output.data['confirmed']).toBe(true);
    expect((await estimate(lib)).output.data['confirmed']).toBe(false);
  });
});

describe('--chapters (ADR-0103)', () => {
  it('keeps the range in book.yaml and uses it from then on', async () => {
    const lib = await library();
    await estimate(lib, '--chapters', '1');
    expect(bookYaml(lib.home)['chapters']).toBe('1');
    expect((await estimate(lib)).output.data['units']).toBe(3);
  });

  it('counts only the units of the chosen chapters', async () => {
    const lib = await library();
    const path = join(lib.home, 'books', 'book', 'ir', 'document.json');
    const document = JSON.parse(readFileSync(path, 'utf8')) as { blocks: { id: string }[]; sections: unknown[] };
    document.sections = [
      { title: 'One', block_id: document.blocks[0]?.id, children: [] },
      { title: 'Two', block_id: document.blocks[2]?.id, children: [] },
    ];
    writeFileSync(path, JSON.stringify(document));
    expect((await estimate(lib)).output.data['units']).toBe(3);
    expect((await estimate(lib, '--chapters', '1')).output.data['units']).toBe(2);
    expect((await estimate(lib, '--chapters', '2')).output.data['units']).toBe(1);
    expect((await estimate(lib, '--chapters', '1-2')).output.data['units']).toBe(3);
  });

  it('asks again when the range changes', async () => {
    const lib = await library();
    await estimate(lib, '--budget', '100', '--confirm');
    const path = join(lib.home, 'books', 'book', 'ir', 'document.json');
    const document = JSON.parse(readFileSync(path, 'utf8')) as { blocks: { id: string }[]; sections: unknown[] };
    document.sections = [
      { title: 'One', block_id: document.blocks[0]?.id, children: [] },
      { title: 'Two', block_id: document.blocks[2]?.id, children: [] },
    ];
    writeFileSync(path, JSON.stringify(document));
    expect((await estimate(lib, '--chapters', '2')).output.data['confirmed']).toBe(false);
  });

  it('refuses a range the book does not have, and keeps the old one', async () => {
    const lib = await library();
    await estimate(lib, '--chapters', '1');
    const { exit, output } = await estimate(lib, '--chapters', '9');
    expect(exit).toBe(2);
    expect(codes(output)).toEqual(['chapters.invalid']);
    expect(bookYaml(lib.home)['chapters']).toBe('1');
  });
});

describe('tome translate --dry-run (ADR-0103)', () => {
  async function dryRun(lib: Library): Promise<{ exit: number; output: Envelope }> {
    const { io, stdout } = lib.session();
    const exit = await run(['translate', 'book', '--dry-run', '--json'], io);
    return { exit, output: envelope(stdout()) };
  }

  it('builds every request, sends nothing, and says so', async () => {
    const lib = await library();
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const { exit, output } = await dryRun(lib);
    expect(exit).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(output.data).toMatchObject({ book: 'book', requests: 1, units: 3, model: MODEL });
    expect(codes(output)).toContain('dry_run.done');
  });

  it('puts no book text in what it reports', async () => {
    const lib = await library();
    const { io, stdout } = lib.session();
    await run(['translate', 'book', '--dry-run'], io);
    expect(stdout()).toContain('未送出任何資料');
    expect(stdout()).not.toContain('warden');
  });

  it('agrees with the estimate', async () => {
    const lib = await library();
    const planned = (await dryRun(lib)).output.data;
    const estimated = (await estimate(lib)).output.data;
    expect(planned['high_usd']).toBe(estimated['high_usd']);
  });

  it('agrees with the estimate in realtime too', async () => {
    const lib = await library();
    const { io, stdout } = lib.session();
    await run(['translate', 'book', '--dry-run', '--realtime', '--json'], io);
    const planned = envelope(stdout()).data;
    expect(planned['mode']).toBe('realtime');
    expect(planned['high_usd']).toBe((await estimate(lib, '--realtime')).output.data['high_usd']);
  });

  it('checks the gate, and repeats neither the entry nor the text (ADR-0099 item 21)', async () => {
    const lib = await library({ config: `translator_model: ${MODEL}\npii: [warden]\n` });
    const { io, stdout } = lib.session();
    expect(await run(['translate', 'book', '--dry-run', '--json'], io)).toBe(1);
    const blocked = envelope(stdout()).findings.find((item) => item.code === 'translate.blocked');
    expect(blocked?.level).toBe('fail');
    expect(Number(blocked?.params['count'])).toBeGreaterThan(0);
    expect(stdout()).not.toContain('warden');
  });

  it('leaves the units alone when the gate finds something, as it sends nothing', async () => {
    const lib = await library({ config: `translator_model: ${MODEL}\npii: [warden]\n` });
    await dryRun(lib);
    const { openBookStore } = await import('../../src/core/store.ts');
    const store = openBookStore(lib.home, 'book');
    const states = store.all<{ state: string }>("SELECT state FROM unit WHERE state <> 'PENDING'");
    store.close();
    expect(states).toEqual([]);
  });

  it('honors the exceptions of the book', async () => {
    const lib = await library({ config: `translator_model: ${MODEL}\npii: [warden]\n` });
    const path = join(lib.home, 'books', 'book', 'book.yaml');
    writeFileSync(path, `${readFileSync(path, 'utf8')}pii_exceptions: [warden]\n`);
    const { exit, output } = await dryRun(lib);
    expect(exit).toBe(0);
    expect(codes(output)).not.toContain('translate.blocked');
  });

  it('skips units that are done', async () => {
    const lib = await library();
    await dryRun(lib);
    const { openBookStore } = await import('../../src/core/store.ts');
    const store = openBookStore(lib.home, 'book');
    store.run("UPDATE unit SET state = 'DONE'");
    store.close();
    const { output } = await dryRun(lib);
    expect(output.data).toMatchObject({ requests: 0, units: 0 });
    expect(codes(output)).toContain('dry_run.done');
    expect(codes((await estimate(lib)).output)).toContain('estimate.nothing');
  });

  it.each(['FAILED_QA', 'REFUSED', 'BLOCKED', 'IN_FLIGHT', 'RECEIVED'])(
    'does not plan to send a unit in %s, which waits for something else',
    async (state) => {
      const lib = await library();
      await dryRun(lib);
      const { openBookStore } = await import('../../src/core/store.ts');
      const store = openBookStore(lib.home, 'book');
      store.run('UPDATE unit SET state = ?', state);
      store.close();
      expect((await dryRun(lib)).output.data).toMatchObject({ requests: 0, units: 0 });
    },
  );

  it.each(['QUEUED', 'STALE'])('plans to send a unit in %s', async (state) => {
    const lib = await library();
    await dryRun(lib);
    const { openBookStore } = await import('../../src/core/store.ts');
    const store = openBookStore(lib.home, 'book');
    store.run('UPDATE unit SET state = ?', state);
    store.close();
    expect((await dryRun(lib)).output.data).toMatchObject({ units: 3 });
  });

  it('needs a key without --dry-run, and with it needs none (ADR-0109 item 5)', async () => {
    const lib = await library();
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    // 開發者的機器可能設了金鑰，這裡要拿掉。
    const env = { ...lib.env, TOME_ANTHROPIC_API_KEY: undefined };
    const { io, stdout } = lib.session({ env });
    expect(await run(['translate', 'book'], io)).toBe(1);
    expect(stdout()).toContain('找不到 anthropic 的金鑰');
    expect(await run(['translate', 'book', '--dry-run'], lib.session({ env }).io)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
