import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/cli/run.ts';
import { forgeFile } from '../forge/index.ts';
import { capture, tempDir } from '../helpers.ts';

function envelope(text: string): {
  ok: boolean;
  data: Record<string, unknown>;
  findings: { code: string; level: string; params: Record<string, string> }[];
} {
  return JSON.parse(text);
}

async function workspace(): Promise<NodeJS.ProcessEnv> {
  const env = { TOME_HOME: join(tempDir(), 'home') };
  await run(['init'], capture({ env }).io);
  return env;
}

describe('tome add', () => {
  it('adds a book, probes it, and tells the reader in Chinese', async () => {
    const env = await workspace();
    const { io, stdout } = capture({ env });
    expect(await run(['add', await forgeFile('structure', tempDir())], io)).toBe(0);
    expect(stdout()).toContain('已加入 structure');
    expect(stdout()).toContain('共 5 頁');
    expect(stdout()).toContain('頁碼標籤 5 頁');
    expect(stdout()).toContain('標記結構 有');
    expect(stdout()).toContain('未偵測到 NVIDIA GPU');
  });

  it('keeps book text out of the output', async () => {
    const env = await workspace();
    const pdf = await forgeFile('structure', tempDir());
    const plain = capture({ env });
    await run(['add', pdf], plain.io);
    const json = capture({ env });
    await run(['probe', 'structure', '--json'], json.io);
    for (const text of [plain.stdout(), json.stdout()]) {
      expect(text).not.toContain('Forged Part One');
      expect(text).not.toContain('forged-target');
      expect(text).not.toContain('warden');
    }
  });

  it('takes --as, --system and --source-lang', async () => {
    const env = await workspace();
    await run(['system', 'new', 'my-pack'], capture({ env }).io);
    const pdf = await forgeFile('plain', tempDir());
    const argv = ['add', pdf, '--as', 'chosen', '--system', 'my-pack', '--source-lang', 'en', '--json'];
    const { io, stdout } = capture({ env });
    expect(await run(argv, io)).toBe(0);
    expect(envelope(stdout()).data['book']).toBe('chosen');
  });

  it('exits 1 on an encrypted PDF', async () => {
    const env = await workspace();
    const { io, stdout } = capture({ env });
    expect(await run(['add', await forgeFile('encrypted-owner', tempDir()), '--json'], io)).toBe(1);
    expect(envelope(stdout())).toMatchObject({
      ok: false,
      data: { book: null },
      findings: [{ code: 'pdf.encrypted', level: 'fail' }],
    });
  });

  it('exits 1 when the name is taken, and says how to go on', async () => {
    const env = await workspace();
    await run(['add', await forgeFile('plain', tempDir())], capture({ env }).io);
    const other = await forgeFile('hidden', tempDir());
    const { io, stdout } = capture({ env });
    expect(await run(['add', other, '--as', 'plain'], io)).toBe(1);
    expect(stdout()).toContain('--as');
  });

  it('exits 2 without a path, and on a file it cannot read', async () => {
    const env = await workspace();
    const missing = capture({ env });
    expect(await run(['add'], missing.io)).toBe(2);
    const absent = capture({ env });
    expect(await run(['add', join(tempDir(), 'nope.pdf')], absent.io)).toBe(2);
    expect(absent.stderr()).toContain('找不到檔案');
  });

  it('exits 2 with a clear message on a reserved name, not an internal error', async () => {
    const env = await workspace();
    const { io, stdout } = capture({ env });
    const pdf = await forgeFile('plain', tempDir());
    expect(await run(['add', pdf, '--as', 'con', '--json'], io)).toBe(2);
    expect(envelope(stdout()).findings[0]?.code).toBe('store.bad_id');
  });

  it('exits 0 and warns when another book is broken', async () => {
    const env = await workspace();
    const home = env['TOME_HOME'] ?? '';
    mkdirSync(join(home, 'books', 'broken'), { recursive: true });
    writeFileSync(join(home, 'books', 'broken', 'book.yaml'), 'a: [');
    const { io, stdout } = capture({ env });
    expect(await run(['add', await forgeFile('plain', tempDir())], io)).toBe(0);
    expect(stdout()).toContain('無法讀取書籍 broken 的資料');
  });

  it('warns about pages the first version will not translate', async () => {
    const env = await workspace();
    const { io, stdout } = capture({ env });
    expect(await run(['add', await forgeFile('scan', tempDir())], io)).toBe(0);
    expect(stdout()).toContain('有 3 頁不是原生文字頁');
    expect(stdout()).toContain('警告');
  });
});

describe('tome probe', () => {
  it('reuses the result and reports the GPU it finds', async () => {
    const env = await workspace();
    await run(['add', await forgeFile('plain', tempDir())], capture({ env }).io);
    const tool = async () => ({ stdout: 'Forged GPU, 4096, 4000\n' });
    const { io, stdout } = capture({ env, tool });
    expect(await run(['probe', 'plain', '--json'], io)).toBe(0);
    const result = envelope(stdout());
    expect(result.findings.map((item) => item.code)).toEqual([
      'probe.unchanged',
      'probe.done',
      'probe.structure',
      'probe.no_engine',
      'probe.gpu',
    ]);
    expect(result.findings.at(-1)?.params).toEqual({ name: 'Forged GPU', vram: '4096' });
    expect(result.data['probe']).toMatchObject({ pages: 3, tagged: false });
  });

  it('reports a corrupt stored result as a damaged file, not a bug in TOME', async () => {
    const env = await workspace();
    await run(['add', await forgeFile('plain', tempDir())], capture({ env }).io);
    writeFileSync(join(env['TOME_HOME'] ?? '', 'books', 'plain', 'ir', 'probe.json'), '{ not json');
    const { io, stderr } = capture({ env });
    expect(await run(['probe', 'plain'], io)).toBe(2);
    expect(stderr()).toContain('已損毀');
    expect(stderr()).not.toContain('回報');
  });

  it('exits 2 without a book, and on a book it does not know', async () => {
    const env = await workspace();
    expect(await run(['probe'], capture({ env }).io)).toBe(2);
    const unknown = capture({ env });
    expect(await run(['probe', 'nope'], unknown.io)).toBe(2);
    expect(unknown.stderr()).toContain('找不到書籍 nope');
  });

  it('warns about a spread layout', async () => {
    const env = await workspace();
    const { io, stdout } = capture({ env });
    await run(['add', await forgeFile('spread', tempDir())], io);
    expect(stdout()).toContain('跨頁攤開');
  });
});
