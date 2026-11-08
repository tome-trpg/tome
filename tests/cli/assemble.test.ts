import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { openBookStore, type Store } from '../../src/core/store.ts';
import { library, MODEL, setWorkspace, type Library } from '../helpers/library.ts';
import { tempDir } from '../helpers.ts';

// tome assemble（ADR-0122）。文字都是這裡編的；vault 寫在暫存資料夾。

function block(id: string, role: string, text: string, page = 0): Record<string, unknown> {
  return {
    id,
    content_hash: createHash('sha256').update(text).digest('hex'),
    role,
    flow: 'main',
    spans: [{ page, bbox: [0, 0, 10, 10] }],
    text,
    raw: text,
    lang: 'en',
    writing_mode: 'horizontal-tb',
    provenance: { engine: 'fake', version: '1', config_hash: 'b'.repeat(64) },
  };
}

const BLOCKS = [
  block('p0000-aaaaa1', 'heading', 'The Ford'),
  block('p0000-aaaaa2', 'paragraph', 'The warden waits at the ford for the evening ferry.'),
  block('p0000-aaaaa3', 'heading', 'The Marsh', 1),
  block('p0000-aaaaa4', 'paragraph', 'Rain falls on the marsh through the long winter nights.', 1),
];
const SECTIONS = [
  { title: 'The Ford', block_id: 'p0000-aaaaa1', children: [] },
  { title: 'The Marsh', block_id: 'p0000-aaaaa3', children: [] },
];
const TRANSLATIONS: Record<string, string> = {
  'p0000-aaaaa1': '渡口',
  'p0000-aaaaa2': '守望者在渡口等待傍晚的渡船。',
  'p0000-aaaaa3': '沼澤',
};

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

/** 一本解析過的書，換成這裡的區塊，三個單位翻好、一個沒翻。`vault` 給了就設成 vault 路徑。 */
async function book(vault?: string): Promise<Library> {
  const lib = await library();
  if (vault !== undefined) setWorkspace(lib.home, `translator_model: ${MODEL}\npii: [Forged Buyer]\nvault_path: ${JSON.stringify(vault)}\n`);
  const path = join(lib.home, 'books', 'book', 'ir', 'document.json');
  const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...document, sections: SECTIONS, blocks: BLOCKS }));
  await tome(lib, 'estimate', 'book', '--realtime');
  withStore(lib.home, (store) => {
    for (const [id, translation] of Object.entries(TRANSLATIONS)) {
      store.run("UPDATE unit SET state = 'DONE', translation = ? WHERE unit_id = ?", translation, id);
    }
    store.run("UPDATE unit SET state = 'FAILED_QA' WHERE unit_id = 'p0000-aaaaa4'");
  });
  return lib;
}

function found(output: Envelope, code: string): Envelope['findings'][number] | undefined {
  return output.findings.find((item) => item.code === code);
}

describe('tome assemble (ADR-0122)', () => {
  it('writes the book into the vault, and says only where the vault is and how much it wrote', async () => {
    const vault = tempDir();
    const lib = await book(vault);
    const { exit, output, text } = await tome(lib, 'assemble', 'book');
    expect(exit).toBe(0);
    expect(found(output, 'assemble.done')?.params).toEqual({ root: vault, files: '6', units: '4', untranslated: '1' });
    expect(found(output, 'assemble.done')?.level).toBe('info');
    expect(output.data).toMatchObject({ overwritten: 0 });
    expect(found(output, 'vault.default')).toBeUndefined();
    const folder = join(vault, 'book');
    expect(readdirSync(folder).sort()).toEqual(['00-書目與來源.md', '01-渡口.md', '02-沼澤.md', 'review']);
    expect(readFileSync(join(folder, '01-渡口.md'), 'utf8')).toContain('# 渡口');
    // 合成 PDF 的中繼資料有書名、沒有作者。
    expect(readFileSync(join(folder, '00-書目與來源.md'), 'utf8')).toMatch(/^# Forged test document\n\n- 書名: Forged test document\n- 作者: 不明\n/u);
    expect(readFileSync(join(folder, '02-沼澤.md'), 'utf8')).toContain('> [!untranslated] FAILED_QA\n> Rain falls on the marsh');
    for (const word of ['渡口', '沼澤', 'warden', '01-']) expect(text).not.toContain(word);
  });

  it('writes into the vault folder of the workspace when no vault path is set, and says so', async () => {
    const lib = await book();
    const { exit, output } = await tome(lib, 'assemble', 'book');
    expect(exit).toBe(0);
    expect(found(output, 'vault.default')?.params).toEqual({ path: join(lib.home, 'vault') });
    expect(found(output, 'vault.default')?.level).toBe('info');
    expect(existsSync(join(lib.home, 'vault', 'book', '01-渡口.md'))).toBe(true);
  });

  it('refuses a vault inside a git repository, and writes nothing', async () => {
    const repo = tempDir();
    mkdirSync(join(repo, '.git'));
    const vault = join(repo, 'vault');
    const lib = await book(vault);
    const { exit, output } = await tome(lib, 'assemble', 'book');
    expect(exit).toBe(1);
    expect(found(output, 'vault.in_git_repo')?.level).toBe('fail');
    expect(output.data).toEqual({ book: 'book', root: vault });
    expect(existsSync(vault)).toBe(false);
  });

  it('keeps what it wrote in book.db for tome sync', async () => {
    const vault = tempDir();
    const lib = await book(vault);
    await tome(lib, 'assemble', 'book');
    const rows = withStore(lib.home, (store) => store.all<{ block_id: string; path: string }>('SELECT block_id, path FROM render ORDER BY block_id'));
    expect(rows.map(({ path }) => path)).toEqual(['01-渡口.md', '01-渡口.md', '02-沼澤.md', '02-沼澤.md']);
    const files = withStore(lib.home, (store) => store.all<{ path: string }>('SELECT path FROM render_file ORDER BY path'));
    expect(files).toHaveLength(6);
  });

  it('refuses to overwrite a file someone changed, counting the files only, unless told to', async () => {
    const vault = tempDir();
    const lib = await book(vault);
    await tome(lib, 'assemble', 'book');
    const chapter = join(vault, 'book', '01-渡口.md');
    writeFileSync(chapter, `${readFileSync(chapter, 'utf8')}\n我的筆記。\n`);
    const refused = await tome(lib, 'assemble', 'book');
    expect(refused.exit).toBe(1);
    expect(found(refused.output, 'assemble.edited')?.params).toEqual({ count: '1' });
    expect(refused.output.data).toEqual({ book: 'book', root: vault, edited: 1 });
    expect(readFileSync(chapter, 'utf8')).toContain('我的筆記。');
    expect(refused.text).not.toContain('01-');
    const forced = await tome(lib, 'assemble', 'book', '--force');
    expect(forced.exit).toBe(0);
    expect(forced.output.data).toMatchObject({ overwritten: 1 });
    expect(readFileSync(chapter, 'utf8')).not.toContain('我的筆記。');
  });

  it('writes again a file someone deleted, and removes the files it no longer writes, leaving other files alone', async () => {
    const vault = tempDir();
    const lib = await book(vault);
    withStore(lib.home, (store) =>
      store.run(
        `INSERT INTO entity (source, target, status, origin, sources, occurrences, created_at, updated_at)
         VALUES ('Grey Warden', '灰色守望者', 'locked', 'pass0', '[]', 1, 't', 't')`,
      ),
    );
    await tome(lib, 'assemble', 'book');
    const folder = join(vault, 'book');
    expect(existsSync(join(folder, 'entities', '灰色守望者.md'))).toBe(true);
    writeFileSync(join(folder, '我自己的筆記.md'), '筆記');
    rmSync(join(folder, '02-沼澤.md'));
    withStore(lib.home, (store) => {
      store.run("UPDATE entity SET status = 'rejected'");
      // 上次寫過、使用者已經刪掉、這次也不寫的檔。
      store.run("INSERT INTO render_file (path, sha256, rendered_at) VALUES ('舊的章節.md', 'x', 't')");
    });
    const { exit } = await tome(lib, 'assemble', 'book');
    expect(exit).toBe(0);
    expect(existsSync(join(folder, 'entities', '灰色守望者.md'))).toBe(false);
    expect(existsSync(join(folder, '02-沼澤.md'))).toBe(true);
    expect(existsSync(join(folder, '我自己的筆記.md'))).toBe(true);
  });
});
