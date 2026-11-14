import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { openBookStore, type Store } from '../../src/core/store.ts';
import { fakeHost, scanned, startFakeProvider, translated, type FakeHost, type FakeScript } from '../helpers/fake-provider.ts';
import { library, MODEL, setWorkspace, type Library } from '../helpers/library.ts';

// tome run（ADR-0127）。文字都是這裡編的；引擎與供應商都是假的，不連網。

const SCANNER = 'claude-sonnet-5-5';
const CONFIG = `scanner_model: ${SCANNER}\ntranslator_model: ${MODEL}\npii: [Forged Buyer]\n`;

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
  readonly progress: string;
}

/** 金鑰的環境變數一律拿掉：沒給假的供應商時，連到真的 API 的路一定走不通。 */
async function tome(lib: Library, host: FakeHost | undefined, ...args: string[]): Promise<Ran> {
  const env = { ...lib.env, TOME_ANTHROPIC_API_KEY: undefined };
  const { io, stdout, stderr } = lib.session({ env, ...(host === undefined ? {} : { llm: host }) });
  const exit = await run([...args, '--json'], io);
  return { exit, output: JSON.parse(stdout()) as Envelope, text: stdout(), progress: stderr() };
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

async function book(config = CONFIG): Promise<Library> {
  const lib = await library({ config });
  const path = join(lib.home, 'books', 'book', 'ir', 'document.json');
  const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...document, sections: [], blocks: BLOCKS }));
  return lib;
}

async function provider(script: FakeScript = GOOD): Promise<FakeHost> {
  return fakeHost(await startFakeProvider(script));
}

/** 審定完：待審的卡都拒絕，假的翻譯才不用管鎖定譯名。 */
function reviewed(lib: Library): void {
  withStore(lib.home, (store) => store.run("UPDATE entity SET status = 'rejected' WHERE status IN ('proposed', 'failed')"));
}

/** 過完 Pass 0 與兩個關卡：Pass 0 送出、審定完、估價確認。 */
async function ready(lib: Library, host: FakeHost, ...mode: string[]): Promise<void> {
  await tome(lib, undefined, 'run', 'book', '--budget', '5', ...mode);
  expect((await tome(lib, host, 'scan-terms', 'book', '--confirm', ...mode)).exit).toBe(0);
  reviewed(lib);
  await tome(lib, undefined, 'run', 'book', ...mode);
  expect((await tome(lib, undefined, 'estimate', 'book', '--confirm', ...mode)).exit).toBe(0);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tome run (ADR-0127)', () => {
  it('stops at each place a person has to say yes, with exit code 0, and runs to the vault once they did', async () => {
    const lib = await book();
    const host = await provider();
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);

    const scan = await tome(lib, undefined, 'run', 'book', '--budget', '5');
    expect(scan.exit).toBe(0);
    expect(codes(scan.output)).toContain('scan.estimate');
    expect(codes(scan.output).slice(-2)).toEqual(['scan.not_confirmed', 'run.stopped']);
    expect(scan.output.findings.at(-1)).toMatchObject({
      level: 'warn',
      params: { book: 'book', command: 'tome scan-terms book --confirm', rerun: 'tome run book' },
    });
    expect(scan.output.data).toMatchObject({ book: 'book', stopped_at: 'scan', next: 'tome scan-terms book --confirm', rerun: 'tome run book' });
    expect((scan.output.data['stages'] as { stage: string }[]).map(({ stage }) => stage)).toEqual(['extract', 'scan']);
    expect(readFileSync(join(lib.home, 'books', 'book', 'book.yaml'), 'utf8')).toContain('budget_usd: 5');
    expect(scan.progress).toContain('tome run：解析頁面。');
    expect(scan.progress).toContain('tome run：Pass 0 的估價。');
    vi.unstubAllGlobals();

    expect((await tome(lib, host, 'scan-terms', 'book', '--confirm')).exit).toBe(0);
    const review = await tome(lib, undefined, 'run', 'book');
    expect(review.exit).toBe(0);
    expect(codes(review.output).slice(-2)).toEqual(['glossary.pending', 'run.stopped']);
    // 停在審定時建議網頁，YAML 審定檔的用法寫在說明裡（ADR-0138）。
    expect(review.output.data).toMatchObject({ stopped_at: 'review', next: 'tome glossary review book --web' });
    expect((review.output.data['stages'] as { stage: string; data: unknown }[]).at(-1)).toEqual({ stage: 'review', data: { pending: 3 } });
    // 待審的是 proposed 與 failed，拒絕或鎖定的不算。
    const pending = async (statuses: readonly string[]): Promise<unknown> => {
      withStore(lib.home, (store) => {
        const ids = store.all<{ id: number }>('SELECT id FROM entity ORDER BY id').map(({ id }) => id);
        ids.forEach((id, index) => store.run('UPDATE entity SET status = ? WHERE id = ?', statuses[index] ?? 'rejected', id));
      });
      const stages = (await tome(lib, undefined, 'run', 'book')).output.data['stages'] as { stage: string; data: unknown }[];
      return stages.at(-1);
    };
    expect(await pending(['proposed', 'failed', 'rejected'])).toEqual({ stage: 'review', data: { pending: 2 } });
    expect(await pending(['proposed', 'failed', 'failed'])).toEqual({ stage: 'review', data: { pending: 3 } });

    reviewed(lib);
    const estimate = await tome(lib, undefined, 'run', 'book');
    expect(estimate.exit).toBe(0);
    expect(codes(estimate.output)).toContain('estimate.not_confirmed');
    expect(estimate.output.findings.at(-1)).toMatchObject({ code: 'run.stopped', params: { command: 'tome estimate book --confirm' } });
    expect(estimate.output.data).toMatchObject({ stopped_at: 'estimate', next: 'tome estimate book --confirm' });

    expect((await tome(lib, undefined, 'estimate', 'book', '--confirm')).exit).toBe(0);
    const done = await tome(lib, host, 'run', 'book');
    expect(done.exit).toBe(0);
    expect(done.output.findings.at(-1)).toMatchObject({ code: 'run.done', level: 'info', params: { book: 'book' } });
    expect(codes(done.output)).toEqual(expect.arrayContaining(['translate.done', 'assemble.done']));
    expect(done.output.data).toMatchObject({ stopped_at: null, next: null, rerun: null });
    expect((done.output.data['stages'] as { stage: string }[]).map(({ stage }) => stage)).toEqual(['extract', 'scan', 'review', 'estimate', 'translate', 'assemble']);
    expect(existsSync(join(lib.home, 'vault', 'book', '00-交付報告.md'))).toBe(true);
    expect(done.progress).toContain('tome run：翻譯。');
    expect(done.progress).toContain('tome run：輸出 vault。');
    // 訊息與 --json 只有數量與指令（ADR-0059）。
    for (const word of ['Salt Marsh', 'Grey Warden', 'tide stones']) expect(done.text).not.toContain(word);

    // 再跑一次沒有要翻的，直接輸出。
    const again = await tome(lib, undefined, 'run', 'book');
    expect(again.exit).toBe(0);
    expect((again.output.data['stages'] as { stage: string }[]).map(({ stage }) => stage)).toEqual(['extract', 'scan', 'review', 'estimate', 'assemble']);
    expect(codes(again.output).at(-1)).toBe('run.done');
  });

  // 解析與估價都印分章層級、Pass 0 與估價都印預算，接起來只留最後一次；同一次改了層級時，
  // 解析那一步印的是舊的層級（ADR-0132）。
  it('prints the chapter level and the budget once, as the estimate sees them', async () => {
    const lib = await book();
    const path = join(lib.home, 'books', 'book', 'ir', 'document.json');
    const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const sections = [
      {
        title: 'Book',
        block_id: 'p0000-aaaaa1',
        children: [
          { title: 'One', block_id: 'p0000-aaaaa2', children: [] },
          { title: 'Two', block_id: 'p0000-aaaaa3', children: [] },
        ],
      },
    ];
    writeFileSync(path, JSON.stringify({ ...document, sections }));
    const host = await provider();
    const first = await tome(lib, undefined, 'run', 'book', '--budget', '5');
    expect(codes(first.output).filter((code) => code === 'chapters.levels')).toHaveLength(1);
    expect((await tome(lib, host, 'scan-terms', 'book', '--confirm')).exit).toBe(0);
    reviewed(lib);

    const { output } = await tome(lib, undefined, 'run', 'book', '--chapter-level', '2');
    const found = codes(output);
    expect(output.data).toMatchObject({ stopped_at: 'estimate' });
    expect(found.filter((code) => code === 'estimate.budget')).toHaveLength(1);
    expect(found.indexOf('estimate.budget')).toBeGreaterThan(found.indexOf('estimate.done'));
    const levels = output.findings.filter(({ code }) => code === 'chapters.levels');
    expect(levels.map(({ params }) => params['level'])).toEqual(['2']);
    expect(found.indexOf('chapters.levels')).toBeGreaterThan(found.indexOf('estimate.done'));
  });

  it('carries the real-time mode into the commands it asks for, and translates in real time', async () => {
    const lib = await book();
    const host = await provider();
    const scan = await tome(lib, undefined, 'run', 'book', '--realtime', '--budget', '5');
    expect(scan.output.data).toMatchObject({ next: 'tome scan-terms book --confirm --realtime' });
    await ready(lib, host, '--realtime');
    const done = await tome(lib, host, 'run', 'book', '--realtime');
    expect(done.exit).toBe(0);
    expect(codes(done.output).at(-1)).toBe('run.done');
    expect((done.output.data['stages'] as { stage: string; data: Record<string, unknown> }[]).find(({ stage }) => stage === 'translate')?.data).toMatchObject({ mode: 'realtime' });
  });

  it('writes the vault when the translation finished with units it could not translate, with exit code 1', async () => {
    const lib = await book();
    const refusing: FakeScript = (request) => (request.user.includes('<s id=') ? { refusal: true } : GOOD(request, 0));
    const host = await provider(refusing);
    await ready(lib, host, '--realtime');
    const done = await tome(lib, host, 'run', 'book', '--realtime');
    expect(done.exit).toBe(1);
    expect(done.output.findings.find(({ code }) => code === 'translate.done')?.level).toBe('fail');
    expect(codes(done.output)).toContain('assemble.done');
    expect(codes(done.output).at(-1)).toBe('run.done');
  });

  it('stops at the translation, writing no vault, once the personal data gate holds a request back', async () => {
    const lib = await book();
    const host = await provider();
    await ready(lib, host);
    setWorkspace(lib.home, `scanner_model: ${SCANNER}\ntranslator_model: ${MODEL}\npii: [tide stones]\n`);
    const stopped = await tome(lib, host, 'run', 'book');
    expect(stopped.exit).toBe(1);
    expect(codes(stopped.output)).toContain('translate.blocked');
    expect(codes(stopped.output)).not.toContain('run.stopped');
    expect(stopped.output.data).toMatchObject({ stopped_at: 'translate', next: null });
    expect((stopped.output.data['stages'] as { stage: string }[]).at(-1)?.stage).toBe('translate');
    expect(existsSync(join(lib.home, 'vault', 'book'))).toBe(false);

    // 之前就被擋下的單位不再送，跟遭拒答的一樣照樣輸出（維護者選的「停在翻譯」）。這一批的請求含全部的單位，
    // 都被擋下了，沒有要翻的，直接輸出。
    setWorkspace(lib.home, CONFIG);
    const blocked = withStore(lib.home, (store) => store.all("SELECT unit_id FROM unit WHERE state = 'BLOCKED'"));
    expect(blocked.length).toBeGreaterThan(0);
    const after = await tome(lib, undefined, 'run', 'book');
    expect(after.exit).toBe(0);
    expect(after.output.data).toMatchObject({ stopped_at: null });
    expect(codes(after.output).at(-1)).toBe('run.done');
    expect(readFileSync(join(lib.home, 'vault', 'book', '00-交付報告.md'), 'utf8')).toContain('個資閘門擋下');
  });

  it('stops at the translation without a key, and sends nothing', async () => {
    const lib = await book();
    const host = await provider();
    await ready(lib, host);
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const stopped = await tome(lib, undefined, 'run', 'book');
    expect(stopped.exit).toBe(1);
    expect(codes(stopped.output).at(-1)).toBe('key.missing');
    expect(stopped.output.data).toMatchObject({ stopped_at: 'translate', next: null });
    expect((stopped.output.data['stages'] as { stage: string; data: unknown }[]).at(-1)).toEqual({ stage: 'translate', data: { book: 'book' } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not send again the units it could not translate, as tome translate without --retry-failed', async () => {
    const lib = await book();
    const refusing: FakeScript = (request) => (request.user.includes('<s id=') && request.user.includes('Old Harrow') ? { refusal: true } : GOOD(request, 0));
    const fake = await startFakeProvider(refusing);
    const host = fakeHost(fake);
    await ready(lib, host, '--realtime');
    expect((await tome(lib, host, 'run', 'book', '--realtime')).exit).toBe(1);
    const stateOf = (id: string): string | undefined =>
      withStore(lib.home, (store) => store.get<{ state: string }>('SELECT state FROM unit WHERE unit_id = ?', id)?.state);
    expect(stateOf('p0000-aaaaa3')).toBe('REFUSED');
    withStore(lib.home, (store) => store.run("UPDATE unit SET state = 'PENDING', translation = NULL WHERE unit_id = 'p0000-aaaaa2'"));
    const before = fake.requests.length;
    const again = await tome(lib, host, 'run', 'book', '--realtime');
    // 重設的那一段由翻譯記憶補上；遭拒答的那一段不再送。
    expect((again.output.data['stages'] as { stage: string }[]).map(({ stage }) => stage)).toContain('translate');
    expect(fake.requests.slice(before).some(({ user }) => user.includes('Old Harrow'))).toBe(false);
    expect(stateOf('p0000-aaaaa3')).toBe('REFUSED');
  });

  it('stops at the parse when the rule pack cannot be read, and at the estimate when a pattern of the book is broken', async () => {
    // 探測也讀規則包，所以規則包讀不全時停在解析，到不了 Pass 0。
    const broken = await book();
    const dir = join(broken.home, 'systems', 'generic');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pack.yaml'), 'schema: [');
    const parse = await tome(broken, undefined, 'run', 'book');
    expect(parse.exit).toBe(1);
    expect(codes(parse.output)).toContain('pack.invalid_yaml');
    expect(parse.output.data).toMatchObject({ stopped_at: 'extract', next: null });

    const lib = await book();
    const host = await provider();
    await tome(lib, undefined, 'run', 'book', '--budget', '5');
    await tome(lib, host, 'scan-terms', 'book', '--confirm');
    reviewed(lib);
    const path = join(lib.home, 'books', 'book', 'book.yaml');
    writeFileSync(path, `${readFileSync(path, 'utf8')}patterns:\n  - id: broken\n    use: mask\n    regex: 'TC-(\\d'\n`);
    const estimate = await tome(lib, undefined, 'run', 'book');
    expect(estimate.exit).toBe(1);
    expect(codes(estimate.output)).toContain('book.bad_pattern');
    expect(estimate.output.data).toMatchObject({ stopped_at: 'estimate', next: null });
    // 加了 `--trial`，試翻的估價先停下，不往下估價（ADR-0135）。
    const trial = await tome(lib, undefined, 'run', 'book', '--trial');
    expect(trial.exit).toBe(1);
    expect(codes(trial.output)).toContain('book.bad_pattern');
    expect(trial.output.data).toMatchObject({ stopped_at: 'trial', next: null });
    expect((trial.output.data['stages'] as { stage: string }[]).map(({ stage }) => stage)).toEqual(['extract', 'scan', 'review', 'trial']);
  });

  it('parses a book that was never parsed, telling how it goes, and asks for the book', async () => {
    const lib = await library({ extract: false, config: CONFIG });
    const parsed = await tome(lib, undefined, 'run', 'book');
    expect(parsed.output.data).toMatchObject({ stopped_at: 'scan' });
    expect(codes(parsed.output)).toContain('extract.done');
    expect(parsed.progress).toContain('正在啟動解析引擎');
    expect(parsed.progress).toContain('正在組裝文件');
    const { io, stdout } = lib.session({ env: { ...lib.env, TOME_ANTHROPIC_API_KEY: undefined } });
    expect(await run(['run', '--json'], io)).toBe(2);
    expect((JSON.parse(stdout()) as Envelope).findings[0]).toMatchObject({ code: 'cli.missing_argument', params: { argument: '<名稱>' } });
  });

  it('stops at the vault when it was edited, and asks for tome sync', async () => {
    const lib = await book();
    const host = await provider();
    await ready(lib, host);
    expect((await tome(lib, host, 'run', 'book')).exit).toBe(0);
    const report = join(lib.home, 'vault', 'book', '00-交付報告.md');
    writeFileSync(report, `${readFileSync(report, 'utf8')}\n我的筆記\n`);
    const stopped = await tome(lib, undefined, 'run', 'book');
    expect(stopped.exit).toBe(1);
    expect(codes(stopped.output)).toContain('assemble.edited');
    expect(codes(stopped.output)).not.toContain('run.done');
    expect(stopped.output.data).toMatchObject({ stopped_at: 'assemble', next: null });
  });

  it('stops at the parse when no engine can read the book', async () => {
    const lib = await library({ extract: false, config: CONFIG });
    await run(['engine', 'remove', 'fake'], lib.session().io);
    const stopped = await tome(lib, undefined, 'run', 'book');
    expect(stopped.exit).toBe(1);
    expect(codes(stopped.output)).toContain('extract.no_engine');
    expect(stopped.output.data).toMatchObject({ stopped_at: 'extract', next: null, stages: [expect.objectContaining({ stage: 'extract' })] });
  });

  // 試翻排在審定之後、估價之前；試翻也要花錢，所以先停下來請使用者確認（ADR-0135）。
  it('stops for the trial after the review when asked, and goes on once the book is calibrated', async () => {
    const lib = await book();
    const host = await provider();
    await tome(lib, undefined, 'run', 'book', '--budget', '5', '--realtime');
    expect((await tome(lib, host, 'scan-terms', 'book', '--confirm', '--realtime')).exit).toBe(0);
    reviewed(lib);
    const trial = await tome(lib, undefined, 'run', 'book', '--trial', '--realtime');
    expect(trial.exit).toBe(0);
    expect(codes(trial.output).slice(-2)).toEqual(['trial.not_confirmed', 'run.stopped']);
    // 接著要跑的 `tome run` 帶上這次的 `--trial` 與 `--realtime`：兩個都不存檔（045 實測找到，ADR-0138）。
    expect(trial.output.data).toMatchObject({
      stopped_at: 'trial',
      next: 'tome trial book --confirm --realtime',
      rerun: 'tome run book --trial --realtime',
    });
    expect(trial.output.findings.at(-1)).toMatchObject({ code: 'run.stopped', params: { rerun: 'tome run book --trial --realtime' } });
    expect((trial.output.data['stages'] as { stage: string }[]).map(({ stage }) => stage)).toEqual(['extract', 'scan', 'review', 'trial']);
    expect(trial.progress).toContain('tome run：試翻的估價。');
    // `--trial` 不存進 `book.yaml`：沒加的時候不試翻，直接到估價。
    expect(readFileSync(join(lib.home, 'books', 'book', 'book.yaml'), 'utf8')).not.toContain('trial');
    const plain = await tome(lib, undefined, 'run', 'book', '--realtime');
    expect(plain.output.data).toMatchObject({ stopped_at: 'estimate', rerun: 'tome run book --realtime' });

    expect((await tome(lib, host, 'trial', 'book', '--confirm', '--realtime')).exit).toBe(0);
    // 這本書只有一個請求，試翻就翻完了，估價沒有要送的，直接輸出。
    const after = await tome(lib, undefined, 'run', 'book', '--trial', '--realtime');
    expect(after.exit).toBe(0);
    expect(codes(after.output)).toContain('trial.calibrated');
    expect((after.output.data['stages'] as { stage: string }[]).map(({ stage }) => stage)).toEqual([
      'extract',
      'scan',
      'review',
      'trial',
      'estimate',
      'assemble',
    ]);
    expect(after.output.data).toMatchObject({ stopped_at: null });
  });

  // 試翻的批次還沒收回時不能往下估價、翻譯：收回的帳要記成試翻，校準才完整（ADR-0135 第 3 項）。
  it('stops at the trial while its batch has not come back', async () => {
    const lib = await book();
    const fake = await startFakeProvider(GOOD, { polls: 5, pollStatus: 500 });
    const host = fakeHost(fake);
    // Pass 0 用即時模式，查詢失敗只擋得到批次。
    await tome(lib, undefined, 'run', 'book', '--budget', '5', '--realtime');
    expect((await tome(lib, host, 'scan-terms', 'book', '--confirm', '--realtime')).exit).toBe(0);
    reviewed(lib);
    expect((await tome(lib, undefined, 'run', 'book', '--trial')).output.data).toMatchObject({ stopped_at: 'trial' });
    expect((await tome(lib, host, 'trial', 'book', '--confirm')).exit).toBe(1);
    const out = await tome(lib, undefined, 'run', 'book', '--trial');
    expect(out.exit).toBe(0);
    expect(codes(out.output)).toContain('trial.in_flight');
    expect(out.output.data).toMatchObject({ stopped_at: 'trial', next: 'tome trial book --confirm' });
    expect((out.output.data['stages'] as { stage: string }[]).map(({ stage }) => stage)).toEqual(['extract', 'scan', 'review', 'trial']);
    expect(withStore(lib.home, (store) => store.all('SELECT model FROM calibration'))).toEqual([]);
  });

  it('asks for the trial in the mode it runs in', async () => {
    const lib = await book();
    const host = await provider();
    await tome(lib, undefined, 'run', 'book', '--budget', '5');
    expect((await tome(lib, host, 'scan-terms', 'book', '--confirm')).exit).toBe(0);
    reviewed(lib);
    const trial = await tome(lib, undefined, 'run', 'book', '--trial');
    expect(trial.output.data).toMatchObject({ stopped_at: 'trial', next: 'tome trial book --confirm' });
  });

  it('keeps the budget and the chapters in book.yaml even when it stops at Pass 0, and knows no --confirm', async () => {
    const lib = await book();
    const stopped = await tome(lib, undefined, 'run', 'book', '--budget', '5', '--chapter-level', '1', '--chapters', '1');
    expect(stopped.output.data).toMatchObject({ stopped_at: 'scan' });
    const config = readFileSync(join(lib.home, 'books', 'book', 'book.yaml'), 'utf8');
    expect(config).toContain('budget_usd: 5');
    expect(config).toMatch(/chapters: ['"]?1['"]?/u);
    expect(config).toContain('chapter_level: 1');
    expect((await tome(lib, undefined, 'run', 'book', '--chapters', '9')).exit).toBe(2);
    expect((await tome(lib, undefined, 'run', 'book', '--confirm')).exit).toBe(2);
  });
});
