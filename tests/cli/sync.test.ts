import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { openBookStore, openSeriesStore, type Store } from '../../src/core/store.ts';
import { library, MODEL, setWorkspace, type Library } from '../helpers/library.ts';
import { tempDir } from '../helpers.ts';

// tome sync（ADR-0125）。文字都是這裡編的；vault 寫在暫存的工作區裡。

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
  block('p0000-aaaaa5', 'paragraph', 'Reeds grow thick along the bank where the boats tie up.'),
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
  'p0000-aaaaa5': '船隻停靠的岸邊長滿了蘆葦。',
  'p0000-aaaaa3': '沼澤',
};
const FORD = '01-渡口.md';
const MARSH = '02-沼澤.md';

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

function codes(output: Envelope): string[] {
  return output.findings.map(({ code }) => code);
}

function found(output: Envelope, code: string): Envelope['findings'][number] | undefined {
  return output.findings.find((item) => item.code === code);
}

function vaultPath(lib: Library, file: string): string {
  return join(lib.home, 'vault', 'book', file);
}

function edit(lib: Library, file: string, from: string, to: string): void {
  const path = vaultPath(lib, file);
  const text = readFileSync(path, 'utf8');
  expect(text).toContain(from);
  writeFileSync(path, text.replace(from, to));
}

interface UnitRow {
  readonly unit_id: string;
  readonly state: string;
  readonly translation: string | null;
  readonly human: number;
}

function unitOf(lib: Library, id: string): UnitRow | undefined {
  return withStore(lib.home, (store) => store.get<UnitRow>('SELECT unit_id, state, translation, human FROM unit WHERE unit_id = ?', id));
}

function humanRows(lib: Library): { unit_id: string; text: string }[] {
  const series = openSeriesStore(lib.home, 'book');
  try {
    return series.all('SELECT unit_id, text FROM human ORDER BY unit_id');
  } finally {
    series.close();
  }
}

/** 一本換成這裡的區塊的書，四個單位翻好、一個沒翻，輸出過一次。`translations` 換掉其中幾個譯文。 */
async function assembled(translations: Record<string, string> = {}): Promise<Library> {
  const lib = await library();
  const path = join(lib.home, 'books', 'book', 'ir', 'document.json');
  const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...document, sections: SECTIONS, blocks: BLOCKS }));
  await tome(lib, 'estimate', 'book', '--realtime');
  withStore(lib.home, (store) => {
    for (const [id, translation] of Object.entries({ ...TRANSLATIONS, ...translations })) {
      store.run("UPDATE unit SET state = 'DONE', translation = ? WHERE unit_id = ?", translation, id);
    }
    store.run("UPDATE unit SET state = 'FAILED_QA' WHERE unit_id = 'p0000-aaaaa4'");
  });
  const { exit } = await tome(lib, 'assemble', 'book');
  expect(exit).toBe(0);
  return lib;
}

describe('tome sync (ADR-0125)', () => {
  it('says there is nothing to take back before the first assemble, and after it while nothing changed', async () => {
    const lib = await library();
    expect((await tome(lib, 'sync', 'book')).output.findings.map(({ code }) => code)).toEqual(['sync.nothing']);
    const ready = await assembled();
    const { exit, output } = await tome(ready, 'sync', 'book');
    expect(exit).toBe(0);
    expect(output.findings).toEqual([expect.objectContaining({ code: 'sync.nothing', level: 'info', params: { book: 'book' } })]);
    expect(output.data).toMatchObject({ book: 'book', files: 0, recovered: 0, unrecovered: 0, in_flight: 0, orphaned: 0 });
    expect(codes((await tome(ready, 'status', 'book')).output)).not.toContain('units.human');
  });

  it('does not count a deleted file, which the next assemble writes again', async () => {
    const lib = await assembled();
    rmSync(vaultPath(lib, FORD));
    expect(codes((await tome(lib, 'sync', 'book')).output)).toEqual(['sync.nothing']);
    expect((await tome(lib, 'assemble', 'book')).exit).toBe(0);
  });

  it('refuses a vault inside a git repository, and reads nothing', async () => {
    const lib = await assembled();
    const repo = tempDir();
    mkdirSync(join(repo, '.git'));
    setWorkspace(lib.home, `translator_model: ${MODEL}\npii: [Forged Buyer]\nvault_path: ${JSON.stringify(join(repo, 'vault'))}\n`);
    const { exit, output } = await tome(lib, 'sync', 'book');
    expect(exit).toBe(1);
    expect(found(output, 'vault.in_git_repo')?.level).toBe('fail');
    expect(output.data).toEqual({ book: 'book', root: join(repo, 'vault') });
  });

  it('records a paragraph turned into a heading as a change of type', async () => {
    const lib = await assembled();
    edit(lib, FORD, '守望者在渡口等待傍晚的渡船。', '## 守望者在渡口等待傍晚的渡船。');
    const { output } = await tome(lib, 'sync', 'book');
    expect(output.data).toMatchObject({ files: 1, recovered: 0, unrecovered: 1 });
    expect(withStore(lib.home, (store) => store.all('SELECT kind, before_block, after_block FROM sync_change'))).toEqual([
      { kind: 'type', before_block: 'p0000-aaaaa2', after_block: 'p0000-aaaaa2' },
    ]);
    expect(unitOf(lib, 'p0000-aaaaa2')?.human).toBe(0);
  });

  it('calls a file recovered only once every edited paragraph of a translation with blank lines is in the human translation', async () => {
    const lib = await assembled({ 'p0000-aaaaa5': '甲段落原本的譯文內容。\n\n乙段落中間沒有改動的文字。\n\n丙段落原本的譯文內容。' });
    edit(lib, FORD, '甲段落原本', '甲段落改過');
    edit(lib, FORD, '丙段落原本', '丙段落改過');
    const { output } = await tome(lib, 'sync', 'book');
    expect(output.data).toMatchObject({ files: 1, recovered: 1, unrecovered: 0 });
    expect(humanRows(lib)).toEqual([{ unit_id: 'p0000-aaaaa5', text: '甲段落改過的譯文內容。\n\n乙段落中間沒有改動的文字。\n\n丙段落改過的譯文內容。' }]);
    // 整個檔都回收了，下次輸出不擋，兩處修改都寫回去。
    expect((await tome(lib, 'assemble', 'book')).exit).toBe(0);
    const text = readFileSync(vaultPath(lib, FORD), 'utf8');
    expect(text).toContain('甲段落改過');
    expect(text).toContain('丙段落改過');
  });

  it('drops a change recorded for a file that was put back, and lists nothing in the report', async () => {
    const lib = await assembled();
    withStore(lib.home, (store) =>
      store.run("INSERT INTO sync_change (path, kind, before_block, after_block, created_at) VALUES (?, 'merged', 'p0000-aaaaa1', NULL, 't')", FORD),
    );
    expect((await tome(lib, 'report', 'book')).output.data['counts']).toMatchObject({ sync_unrecovered: 1 });
    expect((await tome(lib, 'assemble', 'book')).exit).toBe(0);
    expect(readFileSync(vaultPath(lib, '00-交付報告.md'), 'utf8')).not.toContain('tome sync 無法回收的修改');
    expect(withStore(lib.home, (store) => store.all('SELECT * FROM sync_change'))).toEqual([]);
  });

  it('takes an edited paragraph back as a human translation, and lets assemble write it with no --force', async () => {
    const lib = await assembled();
    edit(lib, FORD, '守望者在渡口等待傍晚的渡船。', '守望者在渡口等候**傍晚**的渡船。');
    const { exit, output, text } = await tome(lib, 'sync', 'book');
    expect(exit).toBe(0);
    expect(output.data).toMatchObject({ files: 1, recovered: 1, unrecovered: 0, in_flight: 0, orphaned: 0 });
    expect(found(output, 'sync.done')).toMatchObject({ level: 'info', params: { book: 'book', files: '1', recovered: '1', unrecovered: '0' } });
    expect(codes(output)).toEqual(['sync.done']);
    expect(text).not.toContain('守望者');
    expect(text).not.toContain(FORD);
    expect(unitOf(lib, 'p0000-aaaaa2')).toEqual({ unit_id: 'p0000-aaaaa2', state: 'DONE', translation: '守望者在渡口等候**傍晚**的渡船。', human: 1 });
    expect(humanRows(lib)).toEqual([{ unit_id: 'p0000-aaaaa2', text: '守望者在渡口等候**傍晚**的渡船。' }]);
    expect(codes((await tome(lib, 'sync', 'book')).output)).toEqual(['sync.nothing']);
    const again = await tome(lib, 'assemble', 'book');
    expect(again.exit).toBe(0);
    expect(again.output.data['overwritten']).toBe(0);
    expect(readFileSync(vaultPath(lib, FORD), 'utf8')).toContain('守望者在渡口等候**傍晚**的渡船。');
  });

  it('takes an untranslated paragraph once its callout is replaced, and counts it in status', async () => {
    const lib = await assembled();
    const file = readFileSync(vaultPath(lib, MARSH), 'utf8');
    const callout = file.slice(file.indexOf('> [!untranslated] FAILED_QA'), file.indexOf('nights.') + 'nights.'.length);
    edit(lib, MARSH, callout, '漫長的冬夜裡，雨一直落在沼澤上。');
    expect((await tome(lib, 'sync', 'book')).output.data).toMatchObject({ recovered: 1, unrecovered: 0 });
    expect(unitOf(lib, 'p0000-aaaaa4')).toMatchObject({ state: 'DONE', human: 1, translation: '漫長的冬夜裡，雨一直落在沼澤上。' });
    const status = await tome(lib, 'status', 'book');
    expect(status.output.data).toMatchObject({ human: 1 });
    expect(found(status.output, 'units.human')).toMatchObject({ level: 'info', params: { count: '1' } });
    const report = await tome(lib, 'report', 'book');
    expect(report.output.data['coverage']).toMatchObject({ human: 1, done: 5, failed: 0 });
  });

  it('records a merge, keeps assemble from overwriting it, and lists it in the report once --force drops it', async () => {
    const lib = await assembled();
    edit(lib, FORD, '渡船。\n\n船隻', '渡船。船隻');
    const { exit, output } = await tome(lib, 'sync', 'book');
    expect(exit).toBe(0);
    expect(output.data).toMatchObject({ files: 1, recovered: 0, unrecovered: 1 });
    expect(found(output, 'sync.unrecovered')).toMatchObject({ level: 'warn', params: { count: '1' } });
    expect((await tome(lib, 'report', 'book')).output.data['counts']).toMatchObject({ sync_unrecovered: 1 });
    const blocked = await tome(lib, 'assemble', 'book');
    expect(blocked.exit).toBe(1);
    expect(codes(blocked.output)).toContain('assemble.edited');
    const forced = await tome(lib, 'assemble', 'book', '--force');
    expect(forced.exit).toBe(0);
    const report = readFileSync(vaultPath(lib, '00-交付報告.md'), 'utf8');
    expect(report).toContain('## 這次覆蓋的、tome sync 無法回收的修改（1）');
    expect(report).toContain(`- ${FORD}：合併段落，位於 [[01-渡口#^p0000-aaaaa1|01-渡口 p.1]] 之後`);
    expect(report).toContain('> 上列修改已被這次輸出覆蓋。');
    expect(readFileSync(vaultPath(lib, FORD), 'utf8')).toContain('# 渡口 ^p0000-aaaaa1');
    expect(withStore(lib.home, (store) => store.all('SELECT * FROM sync_change'))).toEqual([]);
    expect(readFileSync(vaultPath(lib, FORD), 'utf8')).toContain('渡船。\n\n船隻');
  });

  it('lists a file edited again after tome sync, and one never read back, as changes tome sync did not read, by file name only', async () => {
    const lib = await assembled();
    edit(lib, FORD, '渡船。\n\n船隻', '渡船。船隻');
    expect((await tome(lib, 'sync', 'book')).output.data).toMatchObject({ unrecovered: 1 });
    expect(withStore(lib.home, (store) => store.all('SELECT path FROM sync_file'))).toEqual([{ path: FORD }]);
    edit(lib, FORD, '渡口等待', '渡口等候');
    edit(lib, MARSH, '# 沼澤', '# 大沼澤');
    const forced = await tome(lib, 'assemble', 'book', '--force');
    expect(forced.output.data).toMatchObject({ overwritten: 2 });
    const report = readFileSync(vaultPath(lib, '00-交付報告.md'), 'utf8');
    expect(report).toContain('## 這次覆蓋的、tome sync 無法回收的修改（2）');
    expect(report).toContain(`- ${FORD}：未經 tome sync 讀回的修改`);
    expect(report).toContain(`- ${MARSH}：未經 tome sync 讀回的修改`);
    // 讀回之後又改過，上次記的合併不準了；報告不放書本文字。
    expect(report).not.toContain('合併段落');
    expect(report).not.toContain('大沼澤');
    expect(withStore(lib.home, (store) => [store.all('SELECT * FROM sync_change'), store.all('SELECT * FROM sync_file')])).toEqual([[], []]);
  });

  it('lists a file taken back whole and then edited again as a change tome sync did not read', async () => {
    const lib = await assembled();
    edit(lib, FORD, '等待', '等候');
    expect((await tome(lib, 'sync', 'book')).output.data).toMatchObject({ recovered: 1, unrecovered: 0 });
    expect(withStore(lib.home, (store) => store.all('SELECT * FROM sync_file'))).toEqual([]);
    edit(lib, FORD, '等候', '等著');
    expect(codes((await tome(lib, 'assemble', 'book')).output)).toContain('assemble.edited');
    await tome(lib, 'assemble', 'book', '--force');
    expect(readFileSync(vaultPath(lib, '00-交付報告.md'), 'utf8')).toContain(`- ${FORD}：未經 tome sync 讀回的修改`);
  });

  it('records an edit of a file that is not a chapter', async () => {
    const lib = await assembled();
    const path = vaultPath(lib, '00-交付報告.md');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n我的筆記\n`);
    const { output } = await tome(lib, 'sync', 'book');
    expect(output.data).toMatchObject({ files: 1, recovered: 0, unrecovered: 1 });
    expect(withStore(lib.home, (store) => store.all('SELECT kind, before_block, after_block FROM sync_change'))).toEqual([
      { kind: 'file', before_block: null, after_block: null },
    ]);
  });

  it('records a changed frontmatter, so assemble still stops, while it takes the edits next to it', async () => {
    const lib = await assembled();
    edit(lib, FORD, '章: 1', '章: 1\ntags: [game]');
    edit(lib, FORD, '等待', '等候');
    const { output } = await tome(lib, 'sync', 'book');
    expect(output.data).toMatchObject({ recovered: 1, unrecovered: 1 });
    expect(withStore(lib.home, (store) => store.all('SELECT kind FROM sync_change'))).toEqual([{ kind: 'other' }]);
    expect(codes((await tome(lib, 'assemble', 'book')).output)).toContain('assemble.edited');
  });

  it('leaves a unit that is out with the provider, and takes it after it comes back', async () => {
    const lib = await assembled();
    withStore(lib.home, (store) => store.run("UPDATE unit SET state = 'IN_FLIGHT' WHERE unit_id = 'p0000-aaaaa4'"));
    await tome(lib, 'assemble', 'book', '--force');
    const file = readFileSync(vaultPath(lib, MARSH), 'utf8');
    const callout = file.slice(file.indexOf('> [!untranslated] IN_FLIGHT'), file.indexOf('nights.') + 'nights.'.length);
    edit(lib, MARSH, callout, '雨落在沼澤上。');
    const first = await tome(lib, 'sync', 'book');
    expect(first.output.data).toMatchObject({ recovered: 0, in_flight: 1, unrecovered: 0 });
    expect(found(first.output, 'sync.in_flight')).toMatchObject({ level: 'warn', params: { count: '1' } });
    expect(unitOf(lib, 'p0000-aaaaa4')?.state).toBe('IN_FLIGHT');
    withStore(lib.home, (store) => store.run("UPDATE unit SET state = 'FAILED_QA' WHERE unit_id = 'p0000-aaaaa4'"));
    expect((await tome(lib, 'sync', 'book')).output.data).toMatchObject({ recovered: 1, in_flight: 0 });
    expect(unitOf(lib, 'p0000-aaaaa4')).toMatchObject({ state: 'DONE', human: 1 });
  });
});

describe('checks of human translations (ADR-0126)', () => {
  // 簡體字用碼位寫，受版控的文字檔才不用開例外（ADR-0086）。
  const SOFT = String.fromCodePoint(0x8f6f);
  const issuesOf = (lib: Library, id: string): { code: string; level: string }[] =>
    withStore(lib.home, (store) => store.all('SELECT code, level FROM issue WHERE unit_id = ? ORDER BY id', id));

  it('checks what tome sync takes back, keeps it as written, and only reports, in the delivery report too', async () => {
    const lib = await assembled();
    edit(lib, FORD, '守望者在渡口等待傍晚的渡船。', `守望者在渡口等待傍晚的渡船${SOFT}。`);
    const { exit, output, text } = await tome(lib, 'sync', 'book');
    expect(exit).toBe(0);
    expect(output.data).toMatchObject({ recovered: 1, human_checked: 1, human_flagged: 1 });
    expect(found(output, 'human.flagged')).toMatchObject({ level: 'warn', params: { checked: '1', flagged: '1' } });
    expect(text).not.toContain(SOFT);
    expect(unitOf(lib, 'p0000-aaaaa2')).toMatchObject({ state: 'DONE', human: 1, translation: `守望者在渡口等待傍晚的渡船${SOFT}。` });
    expect(issuesOf(lib, 'p0000-aaaaa2')).toEqual([{ code: 'script_mixed', level: 'report' }]);
    expect((await tome(lib, 'report', 'book')).output.data['counts']).toMatchObject({ human_checks: 1 });
    expect((await tome(lib, 'assemble', 'book')).exit).toBe(0);
    const report = readFileSync(vaultPath(lib, '00-交付報告.md'), 'utf8');
    expect(report).toContain('## 人工譯文的檢查（1）');
    expect(report).toContain(`混入簡體字 ${SOFT}`);
  });

  it('lets tome verify check every human translation, and keeps its exit code', async () => {
    const lib = await assembled();
    edit(lib, FORD, '守望者在渡口等待傍晚的渡船。', `守望者在渡口等待傍晚的渡船${SOFT}。`);
    await tome(lib, 'sync', 'book');
    withStore(lib.home, (store) => store.run('DELETE FROM issue'));
    const flagged = await tome(lib, 'verify', 'book');
    expect(flagged.exit).toBe(0);
    expect(flagged.output.data).toMatchObject({ checked: 0, human_checked: 1, human_flagged: 1 });
    expect(flagged.output.findings).toEqual([expect.objectContaining({ code: 'human.flagged', level: 'warn', params: { checked: '1', flagged: '1' } })]);
    expect(issuesOf(lib, 'p0000-aaaaa2')).toEqual([{ code: 'script_mixed', level: 'report' }]);
    edit(lib, FORD, `守望者在渡口等待傍晚的渡船${SOFT}。`, '守望者在渡口等候傍晚的渡船。');
    expect((await tome(lib, 'sync', 'book')).output.data).toMatchObject({ human_checked: 1, human_flagged: 0 });
    expect(issuesOf(lib, 'p0000-aaaaa2')).toEqual([]);
    const clean = await tome(lib, 'verify', 'book');
    expect(clean.output.findings).toEqual([expect.objectContaining({ code: 'human.checked', level: 'info', params: { checked: '1', flagged: '0' } })]);
  });

  it('still takes a translation back when the rule pack cannot be read, clears what was found before, and says why', async () => {
    const lib = await assembled();
    const dir = join(lib.home, 'systems', 'generic');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pack.yaml'), 'schema: [');
    // 沒有要存的人工譯文時不讀規則包。
    expect(await tome(lib, 'sync', 'book')).toMatchObject({ exit: 0 });
    withStore(lib.home, (store) =>
      store.run("INSERT INTO issue (unit_id, code, level, created_at) VALUES ('p0000-aaaaa2', 'term_suspect', 'report', 't')"),
    );
    edit(lib, FORD, '等待', '等候');
    const { exit, output } = await tome(lib, 'sync', 'book');
    expect(exit).toBe(1);
    expect(codes(output)).toContain('pack.invalid_yaml');
    expect(output.data).toMatchObject({ recovered: 1, human_checked: 0, human_flagged: 0 });
    expect(unitOf(lib, 'p0000-aaaaa2')).toMatchObject({ human: 1, translation: '守望者在渡口等候傍晚的渡船。' });
    expect(issuesOf(lib, 'p0000-aaaaa2')).toEqual([]);
  });
});

describe('a human translation stays (ADR-0125)', () => {
  async function synced(): Promise<Library> {
    const lib = await assembled();
    edit(lib, FORD, '等待', '等候');
    await tome(lib, 'sync', 'book');
    return lib;
  }

  it('through tome estimate, even when the unit is written anew', async () => {
    const lib = await synced();
    withStore(lib.home, (store) => store.run("UPDATE unit SET masked = 'old', state = 'PENDING', translation = NULL, human = 0 WHERE unit_id = 'p0000-aaaaa2'"));
    const { output } = await tome(lib, 'estimate', 'book', '--realtime');
    expect(output.data).toMatchObject({ units: 0 });
    expect(unitOf(lib, 'p0000-aaaaa2')).toMatchObject({ state: 'DONE', human: 1, translation: '守望者在渡口等候傍晚的渡船。' });
  });

  it('through tome verify, which does not check it against an old reply', async () => {
    const lib = await synced();
    withStore(lib.home, (store) =>
      store.run(
        "INSERT INTO response (unit_id, attempt, text, model, created_at) VALUES ('p0000-aaaaa2', 1, '<s id=\"1\">守望者在渡口等著傍晚的那艘渡船。</s>', 'm', 't')",
      ),
    );
    await tome(lib, 'verify', 'book');
    expect(unitOf(lib, 'p0000-aaaaa2')).toMatchObject({ state: 'DONE', human: 1, translation: '守望者在渡口等候傍晚的渡船。' });
  });

  it('in tome preview, as written', async () => {
    const lib = await assembled();
    edit(lib, FORD, '等待', '**等候**');
    await tome(lib, 'sync', 'book');
    await tome(lib, 'preview', 'book');
    const review = readFileSync(join(lib.home, 'books', 'book', 'review', '01.md'), 'utf8');
    expect(review).toContain('> 守望者在渡口**等候**傍晚的渡船。');
  });

  it('is counted as orphaned once its source changes', async () => {
    const lib = await synced();
    withStore(lib.home, (store) => store.run("UPDATE unit SET source = 'The warden waits.' WHERE unit_id = 'p0000-aaaaa2'"));
    const { output } = await tome(lib, 'sync', 'book');
    expect(output.data).toMatchObject({ files: 0, orphaned: 1 });
    expect(found(output, 'sync.orphaned')).toMatchObject({ level: 'warn', params: { count: '1' } });
  });
});
