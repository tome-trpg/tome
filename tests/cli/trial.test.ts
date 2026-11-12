import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { openBookStore, type Store } from '../../src/core/store.ts';
import {
  fakeHost,
  startFakeProvider,
  translated,
  type FakeHost,
  type FakeProvider,
  type FakeScript,
} from '../helpers/fake-provider.ts';
import { addBlock, library, MODEL, type Library } from '../helpers/library.ts';

// 試翻（ADR-0135）。文字都是合成 PDF 的假文字與這裡編的句子，模型的回覆都是這裡寫的。
// 請求只到本機的假供應商，沒有金鑰，也沒有連到本機以外的地方。

const WORDS = ['Amber', 'Birch', 'Cedar', 'Dune', 'Elm', 'Fern', 'Grove', 'Heath', 'Iris', 'Juniper', 'Kestrel'];

const GOOD: FakeScript = ({ user }) => ({ text: translated(user) });

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

function count(home: string, sql: string): number {
  return withStore(home, (store) => store.get<{ count: number }>(sql)?.count ?? 0);
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

/** 有 `cache_control` 的請求：第一個寫入快取，之後的都讀快取。 */
function caching(hits: boolean): FakeScript {
  let warm = false;
  return ({ user, body }) => {
    const system = body['system'];
    if (!Array.isArray(system)) return { text: translated(user) };
    const ttl = (system[0] as { cache_control: { ttl: string } }).cache_control.ttl;
    const write = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_5m_input_tokens: ttl === '5m' ? 1000 : 0, ephemeral_1h_input_tokens: ttl === '1h' ? 1000 : 0 },
    };
    const read = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 };
    const usage = hits && warm ? read : write;
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
    expect(output.data).toMatchObject({ book: 'book', mode: 'realtime', model: MODEL, requests: 5, planned: 12, confirmed: false });
    expect(output.data['high_usd']).toBeGreaterThan(output.data['low_usd'] as number);
    expect(spy).not.toHaveBeenCalled();
    // 訊息與 --json 只有數量（ADR-0059）。
    expect(text).not.toContain('keeps the gate');
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
    expect(unseen.output.findings.find(({ code }) => code === 'trial.changed')?.params).toEqual({ book: 'book', flags: '--realtime --confirm' });
    expect(provider.requests).toHaveLength(0);
  });

  it('stops before the trial when it would go over the budget', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    await tome(lib, undefined, 'trial', 'book', '--realtime', '--budget', '0.0001');
    const over = await tome(lib, fakeHost(provider), 'trial', 'book', '--realtime', '--confirm');
    expect(over.exit).toBe(1);
    expect(codes(over.output)).toContain('trial.over_budget');
    expect(provider.requests).toHaveLength(0);
  });

  it('translates only the trial, in real time with a five minute cache, and calibrates the book', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    await shown(lib, '--realtime');
    const before = count(lib.home, "SELECT COUNT(*) AS count FROM unit WHERE state = 'DONE'");
    const done = await tome(lib, fakeHost(provider), 'trial', 'book', '--realtime', '--confirm');
    expect(done.exit).toBe(0);
    expect(codes(done.output)).toContain('trial.done');
    expect(done.output.findings.find(({ code }) => code === 'trial.done')?.params).toMatchObject({ book: 'book', requests: '5' });
    expect(provider.requests).toHaveLength(5);
    for (const { body } of provider.requests) {
      expect(body['system']).toEqual([{ type: 'text', text: expect.any(String), cache_control: { type: 'ephemeral', ttl: '5m' } }]);
    }
    // 試翻的譯文留下，主翻譯跳過它們；其他的還沒翻。
    expect(count(lib.home, "SELECT COUNT(*) AS count FROM unit WHERE state = 'DONE'") - before).toBe(5);
    // 試翻挑中的 5 個請求都是一個單位，剩下 7 個請求、9 個單位。
    expect(count(lib.home, "SELECT COUNT(*) AS count FROM unit WHERE state = 'PENDING'")).toBe(9);
    expect(count(lib.home, 'SELECT COUNT(DISTINCT request_id) AS count FROM ledger WHERE trial = 1')).toBe(5);
    expect(count(lib.home, 'SELECT COUNT(*) AS count FROM trial_unit')).toBe(0);
    const calibration = withStore(lib.home, (store) =>
      store.all<{ model: string; mode: string; requests: number; input_factor: number; output_factor: number }>(
        'SELECT model, mode, requests, input_factor, output_factor FROM calibration',
      ),
    );
    expect(calibration).toEqual([
      { model: MODEL, mode: 'realtime', requests: 5, input_factor: expect.any(Number), output_factor: expect.any(Number) },
    ]);
    expect(calibration[0]?.input_factor).toBeGreaterThan(0);
    expect(calibration[0]?.output_factor).toBeGreaterThan(0);
    expect(done.output.data).toMatchObject({ book: 'book', calibrated: true, requests: 5 });
  });

  it('sends a trial in batches with an hour cache', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    await shown(lib);
    const done = await tome(lib, fakeHost(provider), 'trial', 'book', '--confirm');
    expect(done.exit).toBe(0);
    expect(codes(done.output)).toContain('trial.done');
    expect(provider.batches).toHaveLength(1);
    expect(provider.batches[0]?.items).toHaveLength(5);
    expect(cached(provider)).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(withStore(lib.home, (store) => store.all('SELECT mode FROM calibration'))).toEqual([{ mode: 'batch' }]);
  });

  it('does not try again once the book is calibrated for the model and the mode', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    const host = fakeHost(provider);
    await shown(lib, '--realtime');
    await tome(lib, host, 'trial', 'book', '--realtime', '--confirm');
    const again = await tome(lib, host, 'trial', 'book', '--realtime', '--confirm');
    expect(again.exit).toBe(0);
    expect(codes(again.output)).toContain('trial.calibrated');
    expect(provider.requests).toHaveLength(5);
    // 批次模式沒有校準，可以再試翻。
    expect(codes((await shown(lib)).output)).toContain('trial.estimate');
  });

  it('calibrates the estimate, which then has to be confirmed again', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(GOOD);
    expect((await tome(lib, undefined, 'estimate', 'book', '--realtime', '--budget', '10', '--confirm')).output.data['confirmed']).toBe(true);
    await shown(lib, '--realtime');
    await tome(lib, fakeHost(provider), 'trial', 'book', '--realtime', '--confirm');
    const after = await tome(lib, undefined, 'estimate', 'book', '--realtime');
    expect(after.output.data).toMatchObject({ confirmed: false, calibrated: true, requests: 7 });
    expect(codes(after.output)).toContain('estimate.calibrated');
    expect(after.output.findings.find(({ code }) => code === 'estimate.calibrated')?.params).toMatchObject({ requests: '5' });
    // 批次模式沒有校準，估價照舊。
    const batch = await tome(lib, undefined, 'estimate', 'book');
    expect(batch.output.data).toMatchObject({ calibrated: false });
    expect(codes(batch.output)).not.toContain('estimate.calibrated');
  });

  it('turns the cache on for the translation when the trial hit often enough', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(caching(true));
    const host = fakeHost(provider);
    await shown(lib, '--realtime');
    await tome(lib, host, 'trial', 'book', '--realtime', '--confirm');
    // 寫入 1 次、讀取 4 次：命中 80%，高於即時 5 分鐘的損益兩平點約 21%。
    const estimate = await tome(lib, undefined, 'estimate', 'book', '--realtime', '--confirm');
    expect(codes(estimate.output)).toContain('estimate.cache_on');
    expect(estimate.output.findings.find(({ code }) => code === 'estimate.cache_on')?.params).toMatchObject({ rate: '80', ttl: '5m' });
    expect((await tome(lib, host, 'translate', 'book', '--realtime')).exit).toBe(0);
    expect(provider.requests).toHaveLength(12);
    expect(cached(provider)).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('leaves the cache off for the translation when the trial missed', async () => {
    const lib = await longBook();
    const provider = await startFakeProvider(caching(false));
    const host = fakeHost(provider);
    await shown(lib, '--realtime');
    await tome(lib, host, 'trial', 'book', '--realtime', '--confirm');
    const estimate = await tome(lib, undefined, 'estimate', 'book', '--realtime', '--confirm');
    expect(codes(estimate.output)).toContain('estimate.cache_off');
    expect(estimate.output.findings.find(({ code }) => code === 'estimate.cache_off')?.params).toMatchObject({ rate: '0' });
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
      middle_usd: number;
      spent_usd: number;
      q6: number | null;
    }[];
    expect(estimates.map(({ stage, calibrated }) => [stage, calibrated])).toEqual([
      ['trial', false],
      ['translate', true],
    ]);
    const [trial, translation] = estimates;
    const trialSpent = withStore(lib.home, (store) => store.get<{ spent: number }>('SELECT SUM(cost_usd) AS spent FROM ledger WHERE trial = 1')?.spent);
    expect(trial?.spent_usd).toBeCloseTo(trialSpent ?? -1, 12);
    expect(trial?.q6).toBeNull();
    expect(translation?.q6).toBeCloseTo((translation?.spent_usd ?? 0) / (translation?.middle_usd ?? 1) - 1, 12);
    const q6 = report.output.findings.find(({ code }) => code === 'report.q6');
    expect(q6?.params).toMatchObject({ percent: expect.stringMatching(/^[+−-]?\d+(\.\d)?$/u) });
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
    expect(waiting.output.findings.find(({ code }) => code === 'trial.in_flight')?.params).toEqual({
      book: 'book',
      count: '5',
      flags: '--confirm',
    });
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
});
