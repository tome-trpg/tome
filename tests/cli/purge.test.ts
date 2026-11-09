import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { openBookStore, openSeriesStore, type Store } from '../../src/core/store.ts';
import {
  fakeHost,
  scanned,
  startFakeProvider,
  translated,
  type FakeHost,
  type FakeProvider,
  type FakeScript,
} from '../helpers/fake-provider.ts';
import { library, MODEL, type Library } from '../helpers/library.ts';

// tome purge（ADR-0128）。只在暫存的合成工作區跑，文字都是這裡編的；引擎與供應商都是假的，不連網。

const CONFIG = `scanner_model: ${MODEL}\ntranslator_model: ${MODEL}\npii: [Forged Buyer]\n`;
const WORDS = ['Salt Marsh', 'Grey Warden', 'tide stones'];

function block(id: string, text: string, role = 'paragraph'): Record<string, unknown> {
  return {
    id,
    content_hash: createHash('sha256').update(text).digest('hex'),
    role,
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
  block('p0000-aaaaa1', 'Salt Marsh Wardens', 'heading'),
  block('p0000-aaaaa2', 'The Grey Warden keeps the Salt Marsh. She counts the tide stones each night.'),
  block('p0000-aaaaa3', 'Travellers meet the Grey Warden at the ferry of Old Harrow, near the Salt Marsh.'),
];

/** Pass 0 回卡與提要，翻譯原樣翻回去，一定過得了驗證。 */
const GOOD: FakeScript = ({ user }) => ({ text: user.includes('<s id=') ? translated(user) : scanned(user) });

interface Ran {
  readonly exit: number;
  readonly output: Envelope;
  readonly text: string;
}

/** 金鑰的環境變數一律拿掉：沒給假的供應商時，連到真的 API 的路一定走不通。 */
async function tome(lib: Library, host: FakeHost | undefined, ...args: string[]): Promise<Ran> {
  const env = { ...lib.env, TOME_ANTHROPIC_API_KEY: undefined };
  const { io, stdout } = lib.session({ env, ...(host === undefined ? {} : { llm: host }) });
  const exit = await run([...args, '--json'], io);
  return { exit, output: JSON.parse(stdout()) as Envelope, text: stdout() };
}

function codes(output: Envelope): string[] {
  return output.findings.map(({ code }) => code);
}

function withStore<T>(home: string, action: (store: Store) => T): T {
  const store = openBookStore(home, 'book');
  try {
    return action(store);
  } finally {
    store.close();
  }
}

function withSeries<T>(home: string, action: (store: Store) => T): T {
  const store = openSeriesStore(home, 'book');
  try {
    return action(store);
  } finally {
    store.close();
  }
}

function addHuman(home: string, book: string, unit: string): void {
  withSeries(home, (series) =>
    series.run(
      'INSERT INTO human (book, unit_id, source_sha256, text, created_at) VALUES (?, ?, ?, ?, ?)',
      book,
      unit,
      'c'.repeat(64),
      '合成的人工譯文',
      new Date().toISOString(),
    ),
  );
}

function addMemory(home: string, book: string, key: string): void {
  withSeries(home, (series) =>
    series.run(
      'INSERT INTO memory (key, fragment, model, prompt_hash, pack_hash, sdk_version, book, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      key,
      '合成的片段',
      MODEL,
      'd'.repeat(64),
      'e'.repeat(64),
      '0.0.0',
      book,
      new Date().toISOString(),
    ),
  );
}

function addBatch(home: string, state: string, options: { remote?: string; deleted?: boolean; stage?: string } = {}): void {
  withStore(home, (store) =>
    store.run(
      'INSERT INTO batch (nonce, remote_id, state, requests, high_usd, created_at, deleted_at, stage) VALUES (?, ?, ?, 1, 0.1, ?, ?, ?)',
      `nonce-${Math.random()}`,
      options.remote ?? null,
      state,
      new Date().toISOString(),
      options.deleted === true ? new Date().toISOString() : null,
      options.stage ?? 'translate',
    ),
  );
}

/** 翻譯完、輸出過 vault 的書：Pass 0 送出、待審的卡都拒絕、估價確認，再一路跑完。 */
async function translatedBook(): Promise<{ lib: Library; provider: FakeProvider; host: FakeHost }> {
  const lib = await library({ config: CONFIG });
  const path = join(lib.home, 'books', 'book', 'ir', 'document.json');
  const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...document, sections: [], blocks: BLOCKS }));
  const provider = await startFakeProvider(GOOD);
  const host = fakeHost(provider);
  await tome(lib, undefined, 'run', 'book', '--budget', '5');
  expect((await tome(lib, host, 'scan-terms', 'book', '--confirm')).exit).toBe(0);
  withStore(lib.home, (store) => store.run("UPDATE entity SET status = 'rejected' WHERE status IN ('proposed', 'failed')"));
  expect((await tome(lib, undefined, 'estimate', 'book', '--confirm')).exit).toBe(0);
  expect(codes((await tome(lib, host, 'run', 'book')).output).at(-1)).toBe('run.done');
  return { lib, provider, host };
}

function rendered(home: string): string[] {
  return withStore(home, (store) => store.all<{ path: string }>('SELECT path FROM render_file ORDER BY path').map(({ path }) => path));
}

/** TOME 寫的檔：記進 `render_file`，雜湊跟內容相同。 */
function addRendered(home: string, path: string, text: string): void {
  const full = join(home, 'vault', 'book', path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  const sha256 = createHash('sha256').update(text).digest('hex');
  withStore(home, (store) => store.run('INSERT INTO render_file (path, sha256, rendered_at) VALUES (?, ?, ?)', path, sha256, new Date().toISOString()));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tome purge (ADR-0128)', () => {
  it('lists what it would delete and records the list, and deletes only on --confirm with the list it showed', async () => {
    const { lib } = await translatedBook();
    const { home } = lib;
    const bookPath = join(home, 'books', 'book');
    const pdf = (parse(readFileSync(join(bookPath, 'book.yaml'), 'utf8')) as { pdf: { path: string } }).pdf.path;
    // 一個單位沒翻成，數得出翻好的與全部的不同；系列記憶裡有這本書的人工譯文。
    withStore(home, (store) => store.run("UPDATE unit SET state = 'FAILED_QA' WHERE unit_id = (SELECT unit_id FROM unit ORDER BY seq DESC LIMIT 1)"));
    addHuman(home, 'book', 'p0000-aaaaa2');
    const memory = withSeries(home, (series) => series.get<{ count: number }>('SELECT COUNT(*) AS count FROM memory')?.count ?? 0);
    expect(memory).toBeGreaterThan(0);
    // 留下的：別的書、vault、備份、引擎、tome.yaml。
    mkdirSync(join(home, 'books', 'other'), { recursive: true });
    copyFileSync(join(bookPath, 'book.yaml'), join(home, 'books', 'other', 'book.yaml'));
    mkdirSync(join(home, 'backups', 'book-old'), { recursive: true });
    writeFileSync(join(home, 'backups', 'book-old', 'manifest.json'), '{}');
    const vaultFiles = rendered(home);

    const list = await tome(lib, undefined, 'purge', 'book');
    expect(list.exit).toBe(0);
    expect(codes(list.output)).toEqual(['purge.list', 'purge.not_confirmed']);
    expect(list.output.findings[0]).toMatchObject({
      level: 'info',
      params: { book: 'book', path: bookPath, units: '3', translated: '2', cards: '3', memory: String(memory), human: '1', batches: '0' },
    });
    expect(list.output.findings[1]).toMatchObject({ level: 'info', params: { book: 'book', flags: '' } });
    expect(list.output.findings[1]?.message).toContain('tome purge book --confirm');
    expect(list.output.data).toEqual({
      book: 'book',
      deleted: false,
      path: bookPath,
      series: join(home, 'series', 'book'),
      units: 3,
      translated: 2,
      cards: 3,
      memory,
      human: 1,
      remote_batches: 0,
      vault: null,
    });
    expect(existsSync(bookPath)).toBe(true);
    // 清單的指紋存在這本書的 stage 表（ADR-0128 第 3 項）。
    const stages = withStore(home, (store) => store.all<{ name: string }>("SELECT name FROM stage WHERE name LIKE 'purge%'"));
    expect(stages).toEqual([{ name: 'purge-list' }]);
    // 列兩次，清單一樣，照樣不刪。
    expect((await tome(lib, undefined, 'purge', 'book')).exit).toBe(0);
    expect(existsSync(join(bookPath, 'book.db'))).toBe(true);

    const done = await tome(lib, undefined, 'purge', 'book', '--confirm');
    expect(done.exit).toBe(0);
    expect(codes(done.output)).toEqual(['purge.done']);
    expect(done.output.findings[0]).toMatchObject({
      level: 'info',
      params: { book: 'book', path: bookPath, memory: String(memory), human: '1', batches: '0' },
    });
    expect(done.output.data).toMatchObject({ book: 'book', deleted: true });
    expect(existsSync(bookPath)).toBe(false);
    expect(existsSync(join(home, 'series', 'book'))).toBe(false);
    expect(existsSync(join(home, 'series'))).toBe(true);
    expect(existsSync(pdf)).toBe(true);
    expect(existsSync(join(home, 'books', 'other', 'book.yaml'))).toBe(true);
    expect(existsSync(join(home, 'backups', 'book-old', 'manifest.json'))).toBe(true);
    expect(existsSync(join(home, 'engines'))).toBe(true);
    expect(existsSync(join(home, 'tome.yaml'))).toBe(true);
    // 沒加 --vault，vault 不動。
    expect(vaultFiles.length).toBeGreaterThan(0);
    for (const path of vaultFiles) expect(existsSync(join(home, 'vault', 'book', path))).toBe(true);
    // 訊息與 --json 只有數量與路徑（ADR-0059）。
    for (const word of WORDS) {
      expect(list.text).not.toContain(word);
      expect(done.text).not.toContain(word);
    }
    // 書已經不在了。
    expect((await tome(lib, undefined, 'purge', 'book')).output.findings[0]?.code).toBe('book.not_found');
  });

  it('lists again and deletes nothing when the list was never shown or changed since', async () => {
    const { lib } = await translatedBook();
    const { home } = lib;
    const bookPath = join(home, 'books', 'book');
    const first = rendered(home)[0] ?? '';

    const never = await tome(lib, undefined, 'purge', 'book', '--confirm');
    expect(never.exit).toBe(1);
    expect(codes(never.output)).toEqual(['purge.list', 'purge.changed']);
    expect(never.output.findings[1]).toMatchObject({ level: 'fail', params: { book: 'book', flags: '' } });
    expect(never.output.data).toMatchObject({ deleted: false });
    expect(existsSync(join(bookPath, 'book.db'))).toBe(true);

    // 列過之後又多了一筆人工譯文。
    addHuman(home, 'book', 'p0000-aaaaa3');
    const changed = await tome(lib, undefined, 'purge', 'book', '--confirm');
    expect(changed.exit).toBe(1);
    expect(codes(changed.output)).toEqual(['purge.list', 'purge.changed']);
    expect(changed.output.findings[0]?.params['human']).toBe('1');
    expect(existsSync(join(bookPath, 'book.db'))).toBe(true);

    // 加不加 --vault 是不同的清單。
    const vault = await tome(lib, undefined, 'purge', 'book', '--vault', '--confirm');
    expect(vault.exit).toBe(1);
    expect(codes(vault.output)).toEqual(['purge.list', 'purge.vault', 'purge.changed']);
    expect(vault.output.findings[2]).toMatchObject({ params: { flags: ' --vault' } });
    expect(vault.output.findings[2]?.message).toContain('tome purge book --vault --confirm');

    // vault 的檔被改過。
    appendFileSync(join(home, 'vault', 'book', first), '\n合成的修改\n');
    const edited = await tome(lib, undefined, 'purge', 'book', '--vault', '--confirm');
    expect(edited.exit).toBe(1);
    expect(codes(edited.output)).toEqual(['purge.list', 'purge.vault', 'purge.changed']);
    expect(edited.output.findings[1]?.params['edited']).toBe('1');
    expect(existsSync(join(home, 'vault', 'book', first))).toBe(true);

    // 翻譯的狀態變了。
    withStore(home, (store) => store.run("UPDATE unit SET state = 'STALE' WHERE unit_id = (SELECT unit_id FROM unit ORDER BY seq LIMIT 1)"));
    const units = await tome(lib, undefined, 'purge', 'book', '--vault', '--confirm');
    expect(units.exit).toBe(1);
    expect(units.output.findings[0]?.params['translated']).toBe('2');

    // 每次重新列出的就是新的清單，再確認一次就刪。
    const done = await tome(lib, undefined, 'purge', 'book', '--vault', '--confirm');
    expect(done.exit).toBe(0);
    expect(codes(done.output)).toEqual(['purge.done', 'purge.vault_done']);
    expect(existsSync(bookPath)).toBe(false);
  });

  it('deletes only the files TOME wrote in the vault with --vault, and the folders that leaves empty', async () => {
    const { lib } = await translatedBook();
    const { home } = lib;
    const folder = join(home, 'vault', 'book');
    // TOME 寫在子資料夾裡的檔，其中一個資料夾也有使用者自己的檔。`deep/a.md` 排在 `deep/er/` 前面，
    // 上層資料夾先記下來，刪空資料夾時要先刪下層。
    addRendered(home, 'deep/a.md', '合成的輸出\n');
    addRendered(home, 'deep/er/part.md', '合成的輸出\n');
    addRendered(home, 'mine/part.md', '合成的輸出\n');
    const written = rendered(home);
    // 使用者自己的檔、自己建的空資料夾、改過還沒讀回的檔、已經不在的檔。
    writeFileSync(join(folder, 'notes.md'), '合成的筆記\n');
    writeFileSync(join(folder, 'mine', 'more.md'), '合成的筆記\n');
    mkdirSync(join(folder, 'empty'));
    const first = written.find((path) => !path.includes('/')) ?? '';
    appendFileSync(join(folder, first), '\n合成的修改\n');
    const gone = written.find((path) => !path.includes('/') && path !== first) ?? '';
    rmSync(join(folder, gone));
    const present = written.length - 1;

    const list = await tome(lib, undefined, 'purge', 'book', '--vault');
    expect(list.exit).toBe(0);
    expect(codes(list.output)).toEqual(['purge.list', 'purge.vault', 'purge.not_confirmed']);
    expect(list.output.findings[1]).toMatchObject({
      level: 'info',
      params: { folder, files: String(present), edited: '1', kept: '2' },
    });
    expect(list.output.findings[2]).toMatchObject({ params: { book: 'book', flags: ' --vault' } });
    expect(list.output.data['vault']).toEqual({ folder, files: present, edited: 1, kept: 2 });

    const done = await tome(lib, undefined, 'purge', 'book', '--vault', '--confirm');
    expect(done.exit).toBe(0);
    expect(codes(done.output)).toEqual(['purge.done', 'purge.vault_done']);
    expect(done.output.findings[1]).toMatchObject({ level: 'info', params: { folder, files: String(present), kept: '2' } });
    for (const path of written) expect(existsSync(join(folder, path))).toBe(false);
    expect(existsSync(join(folder, 'deep'))).toBe(false);
    expect(readFileSync(join(folder, 'notes.md'), 'utf8')).toBe('合成的筆記\n');
    expect(readFileSync(join(folder, 'mine', 'more.md'), 'utf8')).toBe('合成的筆記\n');
    expect(existsSync(join(folder, 'empty'))).toBe(true);
  });

  it('removes the book folder of the vault once nothing of the user is left in it, and keeps the vault itself', async () => {
    const { lib } = await translatedBook();
    const { home } = lib;
    addRendered(home, 'deep/part.md', '合成的輸出\n');
    expect((await tome(lib, undefined, 'purge', 'book', '--vault')).exit).toBe(0);
    const done = await tome(lib, undefined, 'purge', 'book', '--vault', '--confirm');
    expect(done.exit).toBe(0);
    expect(done.output.findings[1]?.params['kept']).toBe('0');
    expect(existsSync(join(home, 'vault', 'book'))).toBe(false);
    expect(existsSync(join(home, 'vault'))).toBe(true);
  });

  it('leaves an empty vault folder alone when TOME wrote nothing there, and opens no series memory the book does not have', async () => {
    const lib = await library();
    const { home } = lib;
    const folder = join(home, 'vault', 'book');
    mkdirSync(folder, { recursive: true });
    // 系列資料夾在、資料庫不在，也當成沒有系列記憶。
    mkdirSync(join(home, 'series', 'book'), { recursive: true });
    const list = await tome(lib, undefined, 'purge', 'book', '--vault');
    expect(list.exit).toBe(0);
    expect(list.output.data).toMatchObject({ series: null, memory: 0, human: 0, vault: { folder, files: 0, edited: 0, kept: 0 } });
    // 列清單不建立系列資料庫。
    expect(readdirSync(join(home, 'series', 'book'))).toEqual([]);
    const done = await tome(lib, undefined, 'purge', 'book', '--vault', '--confirm');
    expect(done.exit).toBe(0);
    expect(existsSync(join(home, 'books', 'book'))).toBe(false);
    expect(existsSync(folder)).toBe(true);
  });

  it('keeps the series folder while another book still has rows in it', async () => {
    const lib = await library();
    const { home } = lib;
    addMemory(home, 'book', 'key-book');
    addMemory(home, 'other', 'key-other');
    addHuman(home, 'book', 'p0000-aaaaa2');
    addHuman(home, 'other', 'p0000-aaaaa2');
    const list = await tome(lib, undefined, 'purge', 'book');
    expect(list.output.findings[0]).toMatchObject({ params: { memory: '1', human: '1' } });
    const done = await tome(lib, undefined, 'purge', 'book', '--confirm');
    expect(done.exit).toBe(0);
    expect(existsSync(join(home, 'books', 'book'))).toBe(false);
    const left = withSeries(home, (series) => [
      ...series.all<{ book: string }>('SELECT book FROM memory'),
      ...series.all<{ book: string }>('SELECT book FROM human'),
    ]);
    expect(left).toEqual([{ book: 'other' }, { book: 'other' }]);
  });

  it('deletes nothing while a batch is still out, translation or Pass 0, and says how to collect or cancel it', async () => {
    const lib = await library();
    const { home } = lib;
    // 收回的與放棄的批次不擋。
    addBatch(home, 'collected', { remote: 'msgbatch_done', deleted: true });
    addBatch(home, 'abandoned');
    expect((await tome(lib, undefined, 'purge', 'book')).exit).toBe(0);
    for (const [state, stage] of [['submitted', 'translate'], ['intent', 'scan']] as const) {
      addBatch(home, state, { stage, ...(state === 'submitted' ? { remote: `msgbatch_${stage}` } : {}) });
      for (const confirm of [[], ['--confirm']]) {
        const ran = await tome(lib, undefined, 'purge', 'book', ...confirm);
        expect(ran.exit).toBe(1);
        expect(codes(ran.output)).toEqual(['purge.batches_pending']);
        expect(ran.output.findings[0]).toMatchObject({ level: 'fail', params: { book: 'book' } });
        expect(ran.output.findings[0]?.message).toContain('tome batch collect book');
        expect(ran.output.findings[0]?.message).toContain('tome batch cancel book');
        expect(ran.output.data).toEqual({ book: 'book', deleted: false });
        expect(existsSync(join(home, 'books', 'book', 'book.db'))).toBe(true);
      }
    }
    expect((await tome(lib, undefined, 'purge', 'book')).output.findings[0]?.params['count']).toBe('2');
  });

  it('deletes the batches left at the provider first, and deletes nothing here while one of them cannot be deleted', async () => {
    const lib = await library();
    const { home } = lib;
    const provider = await startFakeProvider(GOOD, { deleteStatus: 500 });
    const host = fakeHost(provider);
    const left = provider.addForeignBatch({ requests: 1 });
    addBatch(home, 'collected', { remote: left.id });
    addBatch(home, 'collected', { remote: 'msgbatch_deleted', deleted: true });

    const list = await tome(lib, undefined, 'purge', 'book');
    expect(list.output.findings[0]?.params['batches']).toBe('1');
    expect(list.output.data['remote_batches']).toBe(1);

    const failed = await tome(lib, host, 'purge', 'book', '--confirm');
    expect(failed.exit).toBe(1);
    expect(codes(failed.output)).toEqual(['batch.delete_failed', 'purge.remote_failed']);
    expect(failed.output.findings[1]).toMatchObject({ level: 'fail', params: { book: 'book', count: '1', flags: '' } });
    expect(failed.output.data).toMatchObject({ deleted: false });
    expect(left.deleted).toBe(false);
    // 5xx 照批次模式的退避重試，用的是轉接層給的等待，不是真的等。
    expect(host.waits.length).toBeGreaterThan(0);
    expect(existsSync(join(home, 'books', 'book', 'book.db'))).toBe(true);

    // 一筆都沒刪掉，清單沒變，稍後再確認一次就好。
    provider.batch.deleteStatus = null;
    const done = await tome(lib, host, 'purge', 'book', '--confirm');
    expect(done.exit).toBe(0);
    expect(codes(done.output)).toEqual(['purge.done']);
    expect(done.output.findings[0]?.params['batches']).toBe('1');
    expect(left.deleted).toBe(true);
    expect(existsSync(join(home, 'books', 'book'))).toBe(false);
  });

  it('counts a batch the provider no longer has as deleted', async () => {
    const lib = await library();
    const host = fakeHost(await startFakeProvider(GOOD));
    addBatch(lib.home, 'collected', { remote: 'msgbatch_unknown' });
    await tome(lib, undefined, 'purge', 'book');
    const done = await tome(lib, host, 'purge', 'book', '--confirm');
    expect(done.exit).toBe(0);
    expect(codes(done.output)).toEqual(['batch.delete_not_found', 'purge.done']);
    expect(existsSync(join(lib.home, 'books', 'book'))).toBe(false);
  });

  it('needs no key and no network when nothing is left at the provider, and stops without a key when something is', async () => {
    const lib = await library();
    const { home } = lib;
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    addBatch(home, 'collected', { remote: 'msgbatch_left' });
    await tome(lib, undefined, 'purge', 'book', '--vault');
    const keyless = await tome(lib, undefined, 'purge', 'book', '--vault', '--confirm');
    expect(keyless.exit).toBe(1);
    expect(codes(keyless.output)).toEqual(['key.missing', 'purge.remote_failed']);
    expect(keyless.output.findings[1]).toMatchObject({ params: { count: '1', flags: ' --vault' } });
    expect(existsSync(join(home, 'books', 'book', 'book.db'))).toBe(true);

    withStore(home, (store) => store.run('UPDATE batch SET deleted_at = ?', new Date().toISOString()));
    await tome(lib, undefined, 'purge', 'book');
    const done = await tome(lib, undefined, 'purge', 'book', '--confirm');
    expect(done.exit).toBe(0);
    expect(existsSync(join(home, 'books', 'book'))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('stops while another command holds the book', async () => {
    const lib = await library();
    const lock = join(lib.home, 'books', 'book', 'book.lock');
    writeFileSync(lock, String(process.pid));
    const ran = await tome(lib, undefined, 'purge', 'book', '--confirm');
    expect(ran.exit).toBe(2);
    expect(ran.output.findings[0]?.code).toBe('book.busy');
    rmSync(lock);
    expect(existsSync(join(lib.home, 'books', 'book', 'book.db'))).toBe(true);
  });
});
