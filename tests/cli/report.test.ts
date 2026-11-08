import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { openBookStore, type Store } from '../../src/core/store.ts';
import { library, type Library } from '../helpers/library.ts';

// tome report 與確認過的估價（ADR-0123）。文字都是這裡編的。

function block(id: string, text: string): Record<string, unknown> {
  return {
    id,
    content_hash: createHash('sha256').update(text).digest('hex'),
    role: 'paragraph',
    flow: 'main',
    spans: [{ page: 0, bbox: [0, 0, 10, 10] }],
    text,
    raw: text,
    lang: 'en',
    writing_mode: 'horizontal-tb',
    provenance: { engine: 'fake', version: '1', config_hash: 'b'.repeat(64) },
  };
}

const BLOCKS = [
  block('p0000-aaaaa1', 'The warden waits at the ford for the evening ferry to cross.'),
  block('p0000-aaaaa2', 'Rain falls on the marsh through the long winter nights again.'),
];

function withStore<T>(home: string, action: (store: Store) => T): T {
  const store = openBookStore(home, 'book');
  try {
    return action(store);
  } finally {
    store.close();
  }
}

async function tome(lib: Library, ...args: string[]): Promise<{ exit: number; output: Envelope; text: string }> {
  const { io, stdout } = lib.session();
  const exit = await run([...args, '--json'], io);
  return { exit, output: JSON.parse(stdout()) as Envelope, text: stdout() };
}

async function book(): Promise<Library> {
  const lib = await library();
  const path = join(lib.home, 'books', 'book', 'ir', 'document.json');
  const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...document, sections: [], blocks: BLOCKS }));
  return lib;
}

function estimates(home: string): number {
  return withStore(home, (store) => store.get<{ count: number }>('SELECT COUNT(*) AS count FROM estimate')?.count ?? 0);
}

describe('tome report (ADR-0123)', () => {
  it('prints only the numbers of each part, and writes nothing', async () => {
    const lib = await book();
    await tome(lib, 'estimate', 'book', '--realtime');
    withStore(lib.home, (store) => {
      store.run("UPDATE unit SET state = 'DONE', translation = '守望者在渡口等傍晚的渡船，作為一個老人。' WHERE unit_id = 'p0000-aaaaa1'");
      store.run(
        `INSERT INTO issue (unit_id, code, level, detail, created_at)
         VALUES ('p0000-aaaaa1', 'translationese', 'report', '{"text":"作為一個","prefer":"身為"}', 't')`,
      );
      store.run("UPDATE unit SET state = 'FAILED_QA' WHERE unit_id = 'p0000-aaaaa2'");
      store.run(
        `INSERT INTO ledger (request_id, unit_id, model, mode, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at)
         VALUES ('r1', 'p0000-aaaaa1', 'm', 'batch', 0, 0, 0, 0, 0.3, 't'), ('r2', 'term:1', 'm', 'batch', 0, 0, 0, 0, 0.1, 't')`,
      );
    });
    const { exit, output, text } = await tome(lib, 'report', 'book');
    expect(exit).toBe(0);
    expect(output.findings.map(({ code, level }) => [code, level])).toEqual([
      ['report.coverage', 'info'],
      ['report.issues', 'info'],
    ]);
    expect(output.findings[0]?.params).toMatchObject({ book: 'book', total: '2', done: '1', failed: '1', spent: '0.40', translate: '0.30', scan: '0.10' });
    expect(output.findings[1]?.params).toMatchObject({ untranslated: '1', translationese: '1', pronoun_mismatch: '0' });
    expect(output.data).toMatchObject({ counts: { untranslated: 1, translationese: 1 } });
    for (const word of ['作為一個', '守望者', 'warden', 'marsh']) expect(text).not.toContain(word);
    expect(existsSync(join(lib.home, 'vault'))).toBe(false);
  });

  it('keeps each confirmed estimate once, and sets the latest against what was spent', async () => {
    const lib = await book();
    await tome(lib, 'estimate', 'book', '--realtime', '--budget', '100');
    expect(estimates(lib.home)).toBe(0);
    await tome(lib, 'estimate', 'book', '--realtime', '--confirm');
    expect(estimates(lib.home)).toBe(1);
    await tome(lib, 'estimate', 'book', '--realtime', '--confirm');
    expect(estimates(lib.home)).toBe(1);
    const row = withStore(lib.home, (store) => store.get<{ stage: string; mode: string; requests: number }>('SELECT stage, mode, requests FROM estimate'));
    expect(row).toEqual({ stage: 'translate', mode: 'realtime', requests: 1 });
    const { output } = await tome(lib, 'report', 'book');
    expect(output.findings.map(({ code, level }) => [code, level])).toEqual([
      ['report.coverage', 'info'],
      ['report.estimate', 'info'],
      ['report.issues', 'info'],
    ]);
    const latest = (output.data['estimates'] as { position: number | null }[]).at(-1);
    expect(output.findings[1]?.params).toMatchObject({ spent: '0.00', position: String(latest?.position) });
    expect(output.data).toMatchObject({ spent: { budget: 100 } });
  });

  it('writes a dash where the estimate has no width', async () => {
    const lib = await book();
    withStore(lib.home, (store) =>
      store.run(
        "INSERT INTO estimate (stage, mode, model, requests, low_usd, high_usd, created_at) VALUES ('translate', 'batch', 'm', 1, 0.2, 0.2, 't')",
      ),
    );
    const { output } = await tome(lib, 'report', 'book');
    expect(output.findings.find(({ code }) => code === 'report.estimate')?.params).toMatchObject({ low: '0.20', high: '0.20', position: '-' });
  });
});
