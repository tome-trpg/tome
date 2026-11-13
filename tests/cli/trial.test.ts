import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { usd } from '../../src/core/provider.ts';
import { q6Text } from '../../src/core/report.ts';
import { openBookStore, type Store } from '../../src/core/store.ts';
import {
  fakeHost,
  startFakeProvider,
  translated,
  type FakeHost,
  type FakeProvider,
  type FakeScript,
} from '../helpers/fake-provider.ts';
import { addBlock, library, MODEL, setWorkspace, type Library } from '../helpers/library.ts';

// 試翻（ADR-0135）。文字都是合成 PDF 的假文字與這裡編的句子，模型的回覆都是這裡寫的。
// 請求只到本機的假供應商，沒有金鑰，也沒有連到本機以外的地方。

const WORDS = ['Amber', 'Birch', 'Cedar', 'Dune', 'Elm', 'Fern', 'Grove', 'Heath', 'Iris', 'Juniper', 'Kestrel'];

const GOOD: FakeScript = ({ user }) => ({ text: translated(user) });

interface Ran {
  readonly exit: number;
  readonly output: Envelope;
  readonly text: string;
  /** stderr 的進度。 */
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

/** 代碼、等級與參數，不含訊息的文字。 */
function found(output: Envelope, code: string): Omit<Envelope['findings'][number], 'message'> | undefined {
  const item = output.findings.find((entry) => entry.code === code);
  return item === undefined ? undefined : { code: item.code, level: item.level, params: item.params };
}

function withStore<T>(home: string, action: (store: Store) => T): T {
  const store = openBookStore(home, 'book');
  try {
    return action(store);
  } finally {
    store.close();
  }
}

function count(home: string, sql: string): number {
  return withStore(home, (store) => store.get<{ count: number }>(sql)?.count ?? 0);
}

function trialSpent(home: string): number {
  return withStore(home, (store) => store.get<{ spent: number }>('SELECT SUM(cost_usd) AS spent FROM ledger WHERE trial = 1')?.spent ?? -1);
}

interface Calibration {
  readonly model: string;
  readonly mode: string;
  readonly requests: number;
  readonly input_factor: number;
  readonly output_factor: number;
}

function calibrationOf(home: string): Calibration[] {
  return withStore(home, (store) => store.all<Calibration>('SELECT model, mode, requests, input_factor, output_factor FROM calibration'));
}

/**
 * 合成 PDF 的 3 個單位，再加 11 段各約 5,000 個字元、用詞都不同的段落。第一段跟前面的短段落併成一個請求，
 * 之後一段一個：共 12 個請求、14 個單位，試翻挑 5 個。用詞不同，翻譯記憶才不會讓後面的段落不用送。
 */
async function longBook(): Promise<Library> {
  const lib = await library();
  WORDS.forEach((word, index) => {
    addBlock(lib.home, `p0010-${String(index).padStart(6, '0')}`, `${word} keeps the gate and counts the stones. `.repeat(115));
  });
  return lib;
}

/** 試翻送出之前先顯示估價、設好預算。 */
async function shown(lib: Library, ...mode: string[]): Promise<Ran> {
  return tome(lib, undefined, 'trial', 'book', '--budget', '10', ...mode);
}

/** 書的額外模式寫進 `book.yaml`（ADR-0124）。 */
function addPattern(lib: Library, regex: string): void {
  const path = join(lib.home, 'books', 'book', 'book.yaml');
  writeFileSync(path, `${readFileSync(path, 'utf8')}patterns:\n  - id: code\n    use: mask\n    regex: '${regex}'\n`);
}

/**
 * 有 `cache_control` 的請求：第一個寫入 `write` 個 token，之後的各讀 `read` 個；`read` 是 0 就每個都寫入。
 * 沒有 `cache_control` 的照預設的用量。
 */
function caching(write: number, read: number): FakeScript {
  let warm = false;
  return ({ user, body }) => {
    const system = body['system'];
    if (!Array.isArray(system)) return { text: translated(user) };
    const ttl = (system[0] as { cache_control: { ttl: string } }).cache_control.ttl;
    const writing = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: write,
      cache_creation: { ephemeral_5m_input_tokens: ttl === '5m' ? write : 0, ephemeral_1h_input_tokens: ttl === '1h' ? write : 0 },
    };
    const reading = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: read };
    const usage = read > 0 && warm ? reading : writing;
    warm = true;
    return { text: translated(user), usage };
  };
}

function cached(provider: FakeProvider): { ttl: string } | null {
  const last = provider.requests.at(-1);
  const system = last?.body['system'];
  if (!Array.isArray(system)) return null;
  return (system[0] as { cache_control: { ttl: string } }).cache_control;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tome trial (ADR-0135)', () => {
  it('shows the estimate of a trial and sends nothing, without a key', async () => {
    const lib = await longBook();
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const { exit, output, text } = await tome(lib, undefined, 'trial', 'book', '--realtime');
    expect(exit).toBe(0);
    expect(codes(output)).toEqual(expect.arrayContaining(['trial.estimate', 'estimate.retention_realtime', 'trial.not_confirmed']));
    expect(output.data).toEqual({
      book: 'book',
      mode: 'realtime',
      model: MODEL,
      requests: 5,
      planned: 12,
      units: 5,
      low_usd: expect.any(Number),
      high_usd: expect.any(Number),
      budget_usd: null,
      spent_usd: 0,
      confirmed: false,
    });
    const low = output.data['low_usd'] as number;
    const high = output.data['high_usd'] as number;
    expect(high).toBeGreaterThan(low);
    expect(found(output, 'trial.estimate')).toEqual({
      code: 'trial.estimate',
      level: 'info',
      params: { requests: '5', planned: '12', units: '5', model: MODEL, low: usd(low), high: usd(high) },
    });
    expect(found(output, 'trial.not_confirmed')).toEqual({
      code: 'trial.not_confirmed',
      level: 'info',
      params: { book: 'book', flags: '--realtime --confirm' },
    });
    // 這次顯示的估價記在自己的階段，跟翻譯的估價分開。
    expect(count(lib.home, "SELECT COUNT(*) AS count FROM stage WHERE name = 'trial-estimate'")).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    // 訊息與 --json 只有數量（ADR-0059）。
    expect(text).not.toContain('keeps the gate');
  });

  it('shows the estimate of a trial in batches against the budget', async () => {
    const { output } = await shown(await longBook());
    expect(output.data).toMatchObject({ mode: 'batch', budget_usd: 10, spent_usd: 0 });
    expect(found(output, 'estimate.budget')).toEqual({ code: 'estimate.budget', level: 'info', params: { budget: '10.00', spent: '0.00' } });
    expect(found(output, 'trial.not_confirmed')?.params).toEqual({ book: 'book', flags: '--confirm' });
  });

  it('needs a budget, and the estimate it showed last', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    const host = fakeHost(provider);
    const unbudgeted = await tome(lib, host, 'trial', 'book', '--realtime', '--confirm');
    expect(unbudgeted.exit).toBe(1);
    expect(codes(unbudgeted.output)).toContain('trial.no_budget');
    // 直接確認，沒有先看過這次的估價。
    const unseen = await tome(lib, host, 'trial', 'book', '--realtime', '--budget', '10', '--confirm');
    expect(unseen.exit).toBe(1);
    expect(codes(unseen.output)).toContain('trial.changed');
    expect(found(unseen.output, 'trial.changed')?.params).toEqual({ book: 'book', flags: '--realtime --confirm' });
    expect(provider.requests).toHaveLength(0);
  });

  it('stops before the trial when it would go over the budget', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    const estimate = await tome(lib, undefined, 'trial', 'book', '--realtime', '--budget', '0.0001');
    const over = await tome(lib, fakeHost(provider), 'trial', 'book', '--realtime', '--confirm');
    expect(over.exit).toBe(1);
    expect(found(over.output, 'trial.over_budget')).toEqual({
      code: 'trial.over_budget',
      level: 'fail',
      params: { budget: usd(0.0001), spent: usd(0), high: usd(estimate.output.data['high_usd'] as number) },
    });
    expect(provider.requests).toHaveLength(0);
  });

  it('asks for the book, and for a key before it sends', async () => {
    const lib = await longBook();
    const unnamed = await tome(lib, undefined, 'trial');
    expect(unnamed.exit).toBe(2);
    expect(unnamed.output.findings[0]).toMatchObject({ code: 'cli.missing_argument', params: { argument: '<名稱>' } });
    const keyless = await tome(lib, undefined, 'trial', 'book', '--confirm');
    expect(codes(keyless.output)).toContain('key.missing');
    expect(keyless.output.data).toEqual({ book: 'book' });
  });

  it('stops at a book pattern that does not compile, and plans nothing', async () => {
    const lib = await longBook();
    addPattern(lib, 'TC-(\\d');
    const { exit, output } = await tome(lib, undefined, 'trial', 'book', '--realtime');
    expect(exit).toBe(1);
    expect(codes(output)).toContain('book.bad_pattern');
    expect(output.data).toEqual({ book: 'book' });
  });

  it('translates only the trial, in real time with a five minute cache, and calibrates the book', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    await shown(lib, '--realtime');
    const before = count(lib.home, "SELECT COUNT(*) AS count FROM unit WHERE state = 'DONE'");
    const done = await tome(lib, fakeHost(provider), 'trial', 'book', '--realtime', '--confirm');
    expect(done.exit).toBe(0);
    expect(provider.requests).toHaveLength(5);
    expect(provider.batches).toHaveLength(0);
    expect(done.progress).toContain('開始翻譯：即時模式，共 5 個請求。');
    for (const { body } of provider.requests) {
      expect(body['system']).toEqual([{ type: 'text', text: expect.any(String), cache_control: { type: 'ephemeral', ttl: '5m' } }]);
    }
    // 試翻的譯文留下，主翻譯跳過它們；其他的還沒翻。
    expect(count(lib.home, "SELECT COUNT(*) AS count FROM unit WHERE state = 'DONE'") - before).toBe(5);
    // 試翻挑中的 5 個請求都是一個單位，剩下 7 個請求、9 個單位。
    expect(count(lib.home, "SELECT COUNT(*) AS count FROM unit WHERE state = 'PENDING'")).toBe(9);
    expect(count(lib.home, 'SELECT COUNT(DISTINCT request_id) AS count FROM ledger WHERE trial = 1')).toBe(5);
    expect(count(lib.home, 'SELECT COUNT(*) AS count FROM trial_unit')).toBe(0);
    const calibration = calibrationOf(lib.home);
    expect(calibration).toEqual([
      { model: MODEL, mode: 'realtime', requests: 5, input_factor: expect.any(Number), output_factor: expect.any(Number) },
    ]);
    const [{ input_factor, output_factor } = { input_factor: 0, output_factor: 0 }] = calibration;
    expect(input_factor).toBeGreaterThan(0);
    expect(output_factor).toBeGreaterThan(0);
    const spent = trialSpent(lib.home);
    expect(found(done.output, 'trial.done')).toEqual({
      code: 'trial.done',
      level: 'info',
      params: { book: 'book', requests: '5', input: input_factor.toFixed(2), output: output_factor.toFixed(2), resend: '0', spent: usd(spent) },
    });
    expect(found(done.output, 'trial.next')).toEqual({ code: 'trial.next', level: 'info', params: { book: 'book', flags: '--realtime --confirm' } });
    // 沒有快取的讀寫，就不說快取。
    expect(codes(done.output).filter((code) => code.startsWith('trial.cache'))).toEqual([]);
    expect(done.output.data).toEqual({
      book: 'book',
      mode: 'realtime',
      model: MODEL,
      calibrated: true,
      requests: 5,
      input_factor,
      output_factor,
      resend_ratio: 0,
      cache_hit_rate: null,
      spent_usd: spent,
    });
  });

  it('counts the units it had to send again in the resend ratio, not in the calibration', async () => {
    const lib = await longBook();
    // 第一個請求的譯文太短，重送一次。每個請求的用量都一樣，重送花了第一次送出的 1/5。
    const provider = await startFakeProvider((request, index) =>
      index === 0 ? { text: translated(request.user).replace(/^<s id="1">[^\n]*/u, '<s id="1">短</s>') } : GOOD(request, index),
    );
    await shown(lib, '--realtime');
    const done = await tome(lib, fakeHost(provider), 'trial', 'book', '--realtime', '--confirm');
    expect(done.exit).toBe(0);
    expect(provider.requests).toHaveLength(6);
    expect(found(done.output, 'trial.done')?.params).toMatchObject({ requests: '5', resend: '20' });
    expect(done.output.data['resend_ratio']).toBeCloseTo(0.2, 12);
  });

  it('sends a trial in batches with an hour cache', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    await shown(lib);
    const done = await tome(lib, fakeHost(provider), 'trial', 'book', '--confirm');
    expect(done.exit).toBe(0);
    expect(codes(done.output)).toContain('trial.done');
    expect(done.progress).toContain('開始翻譯：批次模式，共 5 個請求。');
    expect(found(done.output, 'trial.next')?.params).toEqual({ book: 'book', flags: '--confirm' });
    expect(provider.batches).toHaveLength(1);
    expect(provider.batches[0]?.items).toHaveLength(5);
    expect(cached(provider)).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(withStore(lib.home, (store) => store.all('SELECT mode FROM calibration'))).toEqual([{ mode: 'batch' }]);
  });

  it('leaves a unit that failed before alone when it sends a batch', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    await shown(lib);
    // 第一個單位不在試翻裡，先前翻譯沒通過檢查。
    withStore(lib.home, (store) => store.run("UPDATE unit SET state = 'FAILED_QA' WHERE seq = 0"));
    await shown(lib);
    expect((await tome(lib, fakeHost(provider), 'trial', 'book', '--confirm')).exit).toBe(0);
    expect(withStore(lib.home, (store) => store.get<{ state: string }>('SELECT state FROM unit WHERE seq = 0')?.state)).toBe('FAILED_QA');
  });

  it('keeps the notes of the plan in what it shows and in what it reports', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    // 不會比對到任何文字的書的額外模式，只多一則說明。
    addPattern(lib, 'ZZ-\\d+');
    expect(codes((await shown(lib, '--realtime')).output)).toContain('book.patterns');
    const done = await tome(lib, fakeHost(provider), 'trial', 'book', '--realtime', '--confirm');
    expect(codes(done.output)).toEqual(expect.arrayContaining(['trial.done', 'book.patterns']));
  });

  it('will not send a trial in real time while a batch is out', async () => {
    const lib = await longBook();
    const stuck = await startFakeProvider(GOOD, { polls: 5, pollStatus: 500 });
    await tome(lib, undefined, 'estimate', 'book', '--budget', '10', '--confirm');
    expect((await tome(lib, fakeHost(stuck), 'translate', 'book')).exit).toBe(1);
    const provider = await startFakeProvider(GOOD);
    await shown(lib, '--realtime');
    const refused = await tome(lib, fakeHost(provider), 'trial', 'book', '--realtime', '--confirm');
    expect(refused.exit).toBe(1);
    expect(found(refused.output, 'batch.pending')).toEqual({ code: 'batch.pending', level: 'fail', params: { book: 'book' } });
    expect(refused.output.data).toEqual({ book: 'book' });
    expect(count(lib.home, 'SELECT COUNT(*) AS count FROM trial_unit')).toBe(0);
    expect(provider.requests).toHaveLength(0);
  });

  it('has nothing to try once the book is translated', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    await tome(lib, undefined, 'estimate', 'book', '--realtime', '--budget', '10', '--confirm');
    expect((await tome(lib, fakeHost(provider), 'translate', 'book', '--realtime')).exit).toBe(0);
    const { exit, output } = await tome(lib, undefined, 'trial', 'book', '--realtime');
    expect(exit).toBe(0);
    expect(found(output, 'trial.nothing')).toEqual({ code: 'trial.nothing', level: 'info', params: {} });
    expect(output.data).toMatchObject({ requests: 0, units: 0, confirmed: false });
    expect(codes(output)).not.toContain('trial.estimate');
  });

  it('does not try again once the book is calibrated for the model and the mode', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    const host = fakeHost(provider);
    await shown(lib, '--realtime');
    await tome(lib, host, 'trial', 'book', '--realtime', '--confirm');
    const again = await tome(lib, host, 'trial', 'book', '--realtime', '--confirm');
    expect(again.exit).toBe(0);
    expect(found(again.output, 'trial.calibrated')).toEqual({ code: 'trial.calibrated', level: 'info', params: { book: 'book', requests: '5' } });
    expect(again.output.data).toEqual({ book: 'book', mode: 'realtime', model: MODEL, calibrated: true });
    expect(provider.requests).toHaveLength(5);
    // 批次模式沒有校準，可以再試翻。
    expect(codes((await shown(lib)).output)).toContain('trial.estimate');
  });

  it('calibrates the estimate, which then has to be confirmed again', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    const plain = await tome(lib, undefined, 'estimate', 'book', '--realtime', '--budget', '10', '--confirm');
    expect(plain.output.data['confirmed']).toBe(true);
    expect(found(plain.output, 'estimate.uncalibrated')).toEqual({ code: 'estimate.uncalibrated', level: 'info', params: {} });
    await shown(lib, '--realtime');
    await tome(lib, fakeHost(provider), 'trial', 'book', '--realtime', '--confirm');
    const after = await tome(lib, undefined, 'estimate', 'book', '--realtime');
    expect(after.output.data).toMatchObject({ confirmed: false, calibrated: true, requests: 7, cache_ttl: null });
    expect(found(after.output, 'estimate.calibrated')).toEqual({ code: 'estimate.calibrated', level: 'info', params: { requests: '5' } });
    // 試翻沒有快取的讀寫，就不說快取。
    expect(codes(after.output).filter((code) => code.startsWith('estimate.cache'))).toEqual([]);
    // 同樣 7 個請求，沒有校準的估價不同：倍數真的用上了。
    withStore(lib.home, (store) => store.run('DELETE FROM calibration'));
    const uncalibrated = await tome(lib, undefined, 'estimate', 'book', '--realtime');
    expect(uncalibrated.output.data).toMatchObject({ calibrated: false, requests: 7 });
    expect(uncalibrated.output.data['low_usd']).not.toBeCloseTo(after.output.data['low_usd'] as number, 6);
    // 批次模式沒有校準，估價照舊。
    const batch = await tome(lib, undefined, 'estimate', 'book');
    expect(batch.output.data).toMatchObject({ calibrated: false });
    expect(codes(batch.output)).not.toContain('estimate.calibrated');
  });

  it('needs the estimate confirmed again when the calibration changes', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    await shown(lib, '--realtime');
    await tome(lib, fakeHost(provider), 'trial', 'book', '--realtime', '--confirm');
    expect((await tome(lib, undefined, 'estimate', 'book', '--realtime', '--confirm')).output.data['confirmed']).toBe(true);
    expect((await tome(lib, undefined, 'estimate', 'book', '--realtime')).output.data['confirmed']).toBe(true);
    withStore(lib.home, (store) => store.run('UPDATE calibration SET input_factor = input_factor * 2'));
    expect((await tome(lib, undefined, 'estimate', 'book', '--realtime')).output.data['confirmed']).toBe(false);
  });

  it('gives the main translation in batches the calibrated estimate', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    const host = fakeHost(provider);
    await shown(lib);
    await tome(lib, host, 'trial', 'book', '--confirm');
    const estimate = await tome(lib, undefined, 'estimate', 'book', '--confirm');
    expect(estimate.output.data).toMatchObject({ calibrated: true, confirmed: true });
    expect((await tome(lib, host, 'translate', 'book')).exit).toBe(0);
    // 試翻那一批之後的批次，估價的上限加起來就是確認過的估價。
    const high = withStore(lib.home, (store) =>
      store.get<{ high: number }>('SELECT SUM(high_usd) AS high FROM batch WHERE id > (SELECT MIN(id) FROM batch)'),
    )?.high;
    expect(high).toBeCloseTo(estimate.output.data['high_usd'] as number, 9);
  });

  it('turns the cache on for the translation when the trial hit often enough', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(caching(1000, 1000));
    const host = fakeHost(provider);
    await shown(lib, '--realtime');
    const trial = await tome(lib, host, 'trial', 'book', '--realtime', '--confirm');
    // 寫入 1 次、讀取 4 次：命中 80%，高於即時 5 分鐘的損益兩平點約 21%。
    const params = { rate: '80', break_even: '21', ttl: '5m', minutes: '5' };
    expect(found(trial.output, 'trial.cache_on')).toEqual({ code: 'trial.cache_on', level: 'info', params });
    expect(trial.output.data['cache_hit_rate']).toBeCloseTo(0.8, 12);
    const estimate = await tome(lib, undefined, 'estimate', 'book', '--realtime', '--confirm');
    expect(found(estimate.output, 'estimate.cache_on')).toEqual({ code: 'estimate.cache_on', level: 'info', params });
    expect(estimate.output.data).toMatchObject({ cache_ttl: '5m' });
    expect((await tome(lib, host, 'translate', 'book', '--realtime')).exit).toBe(0);
    expect(provider.requests).toHaveLength(12);
    expect(cached(provider)).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  // 命中率剛好等於損益兩平點：開不開都一樣貴。要高於才開（ADR-0036 第 4 項、ADR-0135 第 12 項）。
  // 20 ÷ (20 + 76) 跟 (2.5 − 2) ÷ (2.5 − 0.1) 是同一個浮點數。
  it('leaves the cache off when the trial hit exactly as often as it takes to break even', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(caching(76, 5));
    await shown(lib, '--realtime');
    const trial = await tome(lib, fakeHost(provider), 'trial', 'book', '--realtime', '--confirm');
    expect(found(trial.output, 'trial.cache_off')?.params).toEqual({ rate: '21', break_even: '21', ttl: '5m', minutes: '5' });
    const estimate = await tome(lib, undefined, 'estimate', 'book', '--realtime');
    expect(codes(estimate.output)).toContain('estimate.cache_off');
    expect(estimate.output.data).toMatchObject({ cache_ttl: null });
  });

  it('turns the hour cache on for the translation in batches', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(caching(1000, 1000));
    await shown(lib);
    const trial = await tome(lib, fakeHost(provider), 'trial', 'book', '--confirm');
    // 批次 1 小時的損益兩平點約 51%。
    const params = { rate: '80', break_even: '51', ttl: '1h', minutes: '60' };
    expect(found(trial.output, 'trial.cache_on')?.params).toEqual(params);
    const estimate = await tome(lib, undefined, 'estimate', 'book');
    expect(found(estimate.output, 'estimate.cache_on')?.params).toEqual(params);
    expect(estimate.output.data).toMatchObject({ cache_ttl: '1h' });
  });

  it('leaves the cache off for the translation when the trial missed', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(caching(1000, 0));
    const host = fakeHost(provider);
    await shown(lib, '--realtime');
    const trial = await tome(lib, host, 'trial', 'book', '--realtime', '--confirm');
    expect(found(trial.output, 'trial.cache_off')).toEqual({
      code: 'trial.cache_off',
      level: 'info',
      params: { rate: '0', break_even: '21', ttl: '5m', minutes: '5' },
    });
    const estimate = await tome(lib, undefined, 'estimate', 'book', '--realtime', '--confirm');
    expect(found(estimate.output, 'estimate.cache_off')?.params).toMatchObject({ rate: '0' });
    expect(estimate.output.data).toMatchObject({ cache_ttl: null });
    expect((await tome(lib, host, 'translate', 'book', '--realtime')).exit).toBe(0);
    expect(cached(provider)).toBeNull();
  });

  // 沒有試翻的書，請求跟以前一樣，不帶 `cache_control`（ADR-0036 第 4 項）。
  it('sends the prefix as plain text for a book with no trial', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    await tome(lib, undefined, 'estimate', 'book', '--realtime', '--budget', '10', '--confirm');
    expect((await tome(lib, fakeHost(provider), 'translate', 'book', '--realtime')).exit).toBe(0);
    expect(provider.requests).toHaveLength(12);
    for (const { body } of provider.requests) expect(typeof body['system']).toBe('string');
    expect(count(lib.home, 'SELECT COUNT(*) AS count FROM ledger WHERE trial = 1')).toBe(0);
    // 沒有試翻就沒有校準，交付報告不算 Q-6；還有要送的，估價才說沒校準。
    const report = await tome(lib, undefined, 'report', 'book');
    const estimates = report.output.data['estimates'] as { stage: string; calibrated: boolean; q6: number | null }[];
    expect(estimates.map(({ stage, calibrated, q6 }) => [stage, calibrated, q6])).toEqual([['translate', false, null]]);
    expect(codes(report.output)).not.toContain('report.q6');
    expect(codes((await tome(lib, undefined, 'estimate', 'book', '--realtime')).output)).not.toContain('estimate.uncalibrated');
  });

  // 只有整個請求都是試翻挑中的單位，那筆帳才算試翻。
  it('does not mark a request as the trial when only some of its units are', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    await tome(lib, undefined, 'estimate', 'book', '--realtime', '--budget', '10', '--confirm');
    withStore(lib.home, (store) => store.run(`INSERT INTO trial_unit (unit_id, model, mode) SELECT unit_id, ?, 'realtime' FROM unit WHERE seq = 0`, MODEL));
    expect((await tome(lib, fakeHost(provider), 'translate', 'book', '--realtime')).exit).toBe(0);
    expect(count(lib.home, 'SELECT COUNT(*) AS count FROM ledger WHERE trial = 1')).toBe(0);
  });

  // Q-6：實際的翻譯花費 ÷ 校準後估價的中間值 − 1，不含 Pass 0 與試翻。
  it('reports Q-6 for the translation estimate confirmed after the trial', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    const host = fakeHost(provider);
    await shown(lib, '--realtime');
    await tome(lib, host, 'trial', 'book', '--realtime', '--confirm');
    await tome(lib, undefined, 'estimate', 'book', '--realtime', '--confirm');
    await tome(lib, host, 'translate', 'book', '--realtime');
    const report = await tome(lib, undefined, 'report', 'book');
    const estimates = report.output.data['estimates'] as {
      stage: string;
      calibrated: boolean;
      low_usd: number;
      high_usd: number;
      middle_usd: number;
      spent_usd: number;
      q6: number | null;
    }[];
    expect(estimates.map(({ stage, calibrated }) => [stage, calibrated])).toEqual([
      ['trial', false],
      ['translate', true],
    ]);
    const [trial, translation] = estimates;
    expect(trial?.spent_usd).toBeCloseTo(trialSpent(lib.home), 12);
    expect(trial?.q6).toBeNull();
    // 中間值落在估價區間裡。
    expect(translation?.middle_usd).toBeGreaterThan(translation?.low_usd ?? Infinity);
    expect(translation?.middle_usd).toBeLessThan(translation?.high_usd ?? -Infinity);
    const q6 = (translation?.spent_usd ?? 0) / (translation?.middle_usd ?? 1) - 1;
    expect(translation?.q6).toBeCloseTo(q6, 12);
    const expected = { code: 'report.q6', level: 'info', params: { percent: q6Text(q6) } };
    expect(found(report.output, 'report.q6')).toEqual(expected);
    // 之後又確認了一次還沒花費的估價：Q-6 照舊是最近一次量得到的那個。
    withStore(lib.home, (store) =>
      store.run(
        "INSERT INTO estimate (stage, mode, model, requests, low_usd, high_usd, created_at) VALUES ('scan', 'realtime', ?, 1, 0.1, 0.2, '9999-01-01T00:00:00.000Z')",
        MODEL,
      ),
    );
    expect(found((await tome(lib, undefined, 'report', 'book')).output, 'report.q6')).toEqual(expected);
  });
});

// 試翻的批次送出之後被中斷（Ctrl+C、休眠、重開機）：單位是 `IN_FLIGHT`，不是做完了。校準要等收回，
// 挑中的單位不能清掉，否則收回的帳會記成翻譯、算進 Q-6，下次還要再試翻一次（ADR-0135 第 3 項）。
describe('a trial whose batch has not come back (ADR-0135)', () => {
  /** 批次送出了，查詢一直失敗：`tome trial --confirm` 停在還沒收回，跟被中斷一樣。之後查詢就正常、批次已結束。 */
  async function interrupted(): Promise<{ lib: Library; provider: FakeProvider; host: FakeHost }> {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD, { polls: 5, pollStatus: 500 });
    const host = fakeHost(provider);
    await shown(lib);
    const stopped = await tome(lib, host, 'trial', 'book', '--confirm');
    expect(stopped.exit).toBe(1);
    expect(stopped.output.data).toEqual({ book: 'book', mode: 'batch', calibrated: false });
    expect(provider.batches).toHaveLength(1);
    expect(count(lib.home, "SELECT COUNT(*) AS count FROM unit WHERE state = 'IN_FLIGHT'")).toBe(5);
    provider.batch.pollStatus = null;
    provider.batch.polls = 0;
    provider.batches.forEach((batch) => (batch.polls = 0));
    return { lib, provider, host };
  }

  function calibrations(home: string): number {
    return count(home, 'SELECT COUNT(*) AS count FROM calibration');
  }

  it('neither calibrates nor forgets the trial while its batch is out', async () => {
    const { lib, provider } = await interrupted();
    const calls = provider.calls.length;
    const waiting = await tome(lib, undefined, 'trial', 'book');
    expect(waiting.exit).toBe(0);
    expect(codes(waiting.output)).toContain('trial.in_flight');
    expect(found(waiting.output, 'trial.in_flight')).toMatchObject({
      level: 'warn',
      params: { book: 'book', count: '5', flags: '--confirm' },
    });
    expect(waiting.output.data).toMatchObject({ book: 'book', mode: 'batch', calibrated: false, in_flight: 5 });
    expect(codes(waiting.output)).not.toContain('trial.done');
    expect(calibrations(lib.home)).toBe(0);
    expect(count(lib.home, 'SELECT COUNT(*) AS count FROM trial_unit')).toBe(5);
    expect(provider.calls).toHaveLength(calls);
  });

  it('collects the batch on tome trial --confirm, then calibrates without sending again', async () => {
    const { lib, provider, host } = await interrupted();
    const done = await tome(lib, host, 'trial', 'book', '--confirm');
    expect(done.exit).toBe(0);
    expect(codes(done.output)).toContain('trial.done');
    expect(provider.batches).toHaveLength(1);
    expect(count(lib.home, 'SELECT COUNT(DISTINCT request_id) AS count FROM ledger WHERE trial = 1')).toBe(5);
    expect(count(lib.home, 'SELECT COUNT(*) AS count FROM ledger WHERE trial = 0')).toBe(0);
    expect(calibrations(lib.home)).toBe(1);
    expect(count(lib.home, 'SELECT COUNT(*) AS count FROM trial_unit')).toBe(0);
  });

  it('stops while the batch it waits on cannot be read, and keeps the trial', async () => {
    const { lib, provider, host } = await interrupted();
    provider.batch.pollStatus = 500;
    const stopped = await tome(lib, host, 'trial', 'book', '--confirm');
    expect(stopped.exit).toBe(1);
    expect(stopped.output.data).toEqual({ book: 'book', mode: 'batch', calibrated: false });
    expect(provider.batches).toHaveLength(1);
    expect(calibrations(lib.home)).toBe(0);
    expect(count(lib.home, 'SELECT COUNT(*) AS count FROM trial_unit')).toBe(5);
  });

  it('calibrates without sending once tome batch collect brought the trial back', async () => {
    const { lib, provider, host } = await interrupted();
    expect((await tome(lib, host, 'batch', 'collect', 'book')).exit).toBe(0);
    expect(count(lib.home, 'SELECT COUNT(DISTINCT request_id) AS count FROM ledger WHERE trial = 1')).toBe(5);
    const calls = provider.calls.length;
    const done = await tome(lib, undefined, 'trial', 'book');
    expect(done.exit).toBe(0);
    expect(codes(done.output)).toContain('trial.done');
    expect(provider.calls).toHaveLength(calls);
    expect(calibrations(lib.home)).toBe(1);
    expect(count(lib.home, 'SELECT COUNT(*) AS count FROM trial_unit')).toBe(0);
  });

  // 收回之後換了翻譯模型：試翻的帳不是這個模型的，不能拿來校準它，挑中的單位也不再是試翻。
  it('calibrates nothing from a trial of another model', async () => {
    const { lib, host } = await interrupted();
    expect((await tome(lib, host, 'batch', 'collect', 'book')).exit).toBe(0);
    setWorkspace(lib.home, 'translator_model: claude-opus-5-5\npii: [Forged Buyer]\n');
    const { exit, output } = await tome(lib, undefined, 'trial', 'book');
    expect(exit).toBe(0);
    expect(found(output, 'trial.no_data')).toEqual({ code: 'trial.no_data', level: 'warn', params: {} });
    expect(output.data).toEqual({ book: 'book', mode: 'batch', calibrated: false, spent_usd: trialSpent(lib.home) });
    expect(trialSpent(lib.home)).toBeGreaterThan(0);
    expect(calibrations(lib.home)).toBe(0);
    expect(count(lib.home, 'SELECT COUNT(*) AS count FROM trial_unit')).toBe(0);
  });
});

// 即時模式的試翻做到一半停下：做完的留著，下次只送剩下的，還是同一次試翻（ADR-0135）。
describe('a trial in real time that stopped part way (ADR-0135)', () => {
  /** 前兩個請求翻好，之後供應商都拒絕：挑中的 5 個做完 2 個。 */
  async function stopped(): Promise<Library> {
    const lib = await longBook();
    const failing = await startFakeProvider((request, index) => (index < 2 ? GOOD(request, index) : { status: 400 }));
    await shown(lib, '--realtime');
    expect((await tome(lib, fakeHost(failing), 'trial', 'book', '--realtime', '--confirm')).exit).toBe(1);
    expect(count(lib.home, 'SELECT COUNT(*) AS count FROM trial_unit')).toBe(5);
    return lib;
  }

  it('shows and sends only the rest of the trial', async () => {
    const lib = await stopped();
    const rest = await shown(lib, '--realtime');
    expect(rest.output.data).toMatchObject({ requests: 3, units: 3 });
    const provider = await startFakeProvider(GOOD);
    const done = await tome(lib, fakeHost(provider), 'trial', 'book', '--realtime', '--confirm');
    expect(done.exit).toBe(0);
    expect(provider.requests).toHaveLength(3);
    expect(found(done.output, 'trial.done')?.params).toMatchObject({ requests: '5' });
  });

  // 確認的是顯示過的那幾個單位：挑中的單位變了，就要重新顯示（比照 ADR-0118 第 8 項）。
  it('asks again when the units it would send are not the ones it showed', async () => {
    const lib = await stopped();
    await shown(lib, '--realtime');
    withStore(lib.home, (store) => store.run('DELETE FROM trial_unit'));
    const provider = await startFakeProvider(GOOD);
    const changed = await tome(lib, fakeHost(provider), 'trial', 'book', '--realtime', '--confirm');
    expect(changed.exit).toBe(1);
    expect(codes(changed.output)).toContain('trial.changed');
    expect(provider.requests).toHaveLength(0);
  });
});

// 即時模式的試翻送出去之後被中斷：單位是 `IN_FLIGHT`、沒有批次，要重送（ADR-0104 第 28 項）。
describe('a trial in real time that was interrupted (ADR-0135)', () => {
  it('sends the units that were in flight again on tome trial --confirm', async () => {
    const lib = await longBook();
    // 第一次送出就失敗，挑中的單位留在試翻裡；再假裝它們送出去時被中斷。
    const failing = await startFakeProvider(() => ({ status: 400 }));
    await shown(lib, '--realtime');
    expect((await tome(lib, fakeHost(failing), 'trial', 'book', '--realtime', '--confirm')).exit).toBe(1);
    expect(count(lib.home, 'SELECT COUNT(*) AS count FROM trial_unit')).toBe(5);
    withStore(lib.home, (store) => store.run("UPDATE unit SET state = 'IN_FLIGHT' WHERE unit_id IN (SELECT unit_id FROM trial_unit)"));
    const provider = await startFakeProvider(GOOD);
    const done = await tome(lib, fakeHost(provider), 'trial', 'book', '--realtime', '--confirm');
    expect(done.exit).toBe(0);
    expect(provider.requests).toHaveLength(5);
    expect(found(done.output, 'trial.done')?.params).toMatchObject({ requests: '5' });
  });
});
