import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { POLL_SECONDS } from '../../src/core/batch.ts';
import { guardedFetch } from '../../src/core/egress/client.ts';
import type { LLMProvider } from '../../src/core/llm.ts';
import { openBookStore, type Store } from '../../src/core/store.ts';
import { parseUnits } from '../../src/core/tags.ts';
import {
  adapterHost,
  fakeHost,
  startFakeProvider,
  translated,
  type FakeBatchOptions,
  type FakeHost,
  type FakeProvider,
  type FakeScript,
} from '../helpers/fake-provider.ts';
import { addSceneBreak, library, MODEL, type Library } from '../helpers/library.ts';

// 批次模式（ADR-0107）。文字都是合成 PDF 的假文字，模型的回覆都是這裡寫的。
// 請求只到本機的假供應商，這一輪沒有金鑰，也沒有連到本機以外的地方。

const FALLBACK = 'claude-opus-5-5';
const GOOD: FakeScript = ({ user }) => ({ text: translated(user) });

interface UnitRow {
  readonly unit_id: string;
  readonly state: string;
  readonly attempts: number;
  readonly source: string;
  readonly translation: string | null;
}

interface BatchRow {
  readonly nonce: string;
  readonly remote_id: string | null;
  readonly state: string;
  readonly requests: number;
  readonly deleted_at: string | null;
}

function withStore<T>(home: string, action: (store: Store) => T): T {
  const store = openBookStore(home, 'book');
  try {
    return action(store);
  } finally {
    store.close();
  }
}

function rows(home: string): UnitRow[] {
  return withStore(home, (store) =>
    store.all<UnitRow>('SELECT unit_id, state, attempts, source, translation FROM unit ORDER BY seq'),
  );
}

function statesOf(home: string): string[] {
  return rows(home).map(({ state }) => state);
}

function batchRows(home: string): BatchRow[] {
  return withStore(home, (store) =>
    store.all<BatchRow>('SELECT nonce, remote_id, state, requests, deleted_at FROM batch ORDER BY id'),
  );
}

function ledger(home: string): { mode: string; request_id: string }[] {
  return withStore(home, (store) => store.all('SELECT mode, request_id FROM ledger ORDER BY id'));
}

async function confirmed(options: { config?: string; budget?: string } = {}): Promise<Library> {
  const lib = await library(options.config === undefined ? {} : { config: options.config });
  const { io } = lib.session();
  await run(['estimate', 'book', '--budget', options.budget ?? '100', '--confirm'], io);
  return lib;
}

interface Ran {
  readonly exit: number;
  readonly output: Envelope;
  readonly text: string;
  readonly progress: string;
}

async function tome(lib: Library, host: FakeHost | undefined, ...args: string[]): Promise<Ran> {
  const { io, stdout, stderr } = lib.session(host === undefined ? {} : { llm: host });
  const exit = await run([...args, '--json'], io);
  return { exit, output: JSON.parse(stdout()) as Envelope, text: stdout(), progress: stderr() };
}

function translate(lib: Library, host: FakeHost, ...args: string[]): Promise<Ran> {
  return tome(lib, host, 'translate', 'book', ...args);
}

async function fake(script: FakeScript, options: Partial<FakeBatchOptions> = {}): Promise<{ provider: FakeProvider; host: FakeHost }> {
  const provider = await startFakeProvider(script, options);
  return { provider, host: fakeHost(provider) };
}

function codes(output: Envelope): string[] {
  return output.findings.map((item) => item.code);
}

function found(output: Envelope, code: string): Envelope['findings'][number] | undefined {
  return output.findings.find((item) => item.code === code);
}

/** 第一個請求被拒，之後的照樣翻好。被拒的請求對半拆成兩個，排進下一批。 */
const REFUSE_FIRST: FakeScript = (request, index) => (index === 0 ? { refusal: true } : GOOD(request, index));

/** 換掉轉接層的一個方法，其他照舊。 */
function patched(host: FakeHost, change: (provider: LLMProvider) => Partial<LLMProvider>): FakeHost {
  return {
    ...host,
    connect: (fetcher, endpoint) => {
      const provider = host.connect(fetcher, endpoint);
      return { ...provider, ...change(provider) };
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('tome translate in batches (ADR-0107)', () => {
  it('translates the whole book in one batch, and deletes it from the provider', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD);
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(provider.batches).toHaveLength(1);
    expect(provider.batches[0]?.deleted).toBe(true);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.model).toBe(MODEL);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
    expect(output.data).toMatchObject({ book: 'book', mode: 'batch', requests: 1, batches: 1, done: 3, left: 0 });
    const [batch] = batchRows(lib.home);
    expect(batch).toMatchObject({ state: 'collected', requests: 1, remote_id: provider.batches[0]?.id });
    expect(batch?.deleted_at).not.toBeNull();
  });

  it('names each request with a random code and its number, and nothing from the book (item 10)', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD);
    await translate(lib, host);
    const [request] = provider.requests;
    expect(request?.customId).toMatch(/^tome-[0-9a-f]{16}-1$/);
    expect(request?.customId).toBe(`tome-${batchRows(lib.home)[0]?.nonce}-1`);
    expect(request?.customId).not.toContain('book');
  });

  it('pays the batch price, and keeps book text out of what it reports', async () => {
    const lib = await confirmed();
    const { host } = await fake(GOOD);
    const { text, progress } = await translate(lib, host);
    expect(ledger(lib.home).every(({ mode }) => mode === 'batch')).toBe(true);
    expect(text).not.toContain('warden');
    expect(progress).not.toContain('warden');
  });

  it('records the model of every request that went out, and the polls with no body (item 20)', async () => {
    const lib = await confirmed();
    const { host } = await fake(GOOD);
    await translate(lib, host);
    const egress = withStore(lib.home, (store) => store.all<{ model: string; bytes: number }>('SELECT model, bytes FROM egress ORDER BY id'));
    expect(egress[0]).toMatchObject({ model: MODEL });
    expect(egress[0]?.bytes).toBeGreaterThan(0);
    expect(egress.slice(1).every(({ model, bytes }) => model === '' && bytes === 0)).toBe(true);
  });

  it('waits a minute between polls, and says so on stderr (item 12)', async () => {
    const lib = await confirmed();
    const { host } = await fake(GOOD, { polls: 2 });
    const { exit, progress } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(host.waits).toEqual([POLL_SECONDS, POLL_SECONDS]);
    expect(progress.startsWith('開始翻譯：批次模式，共 1 個請求。\n')).toBe(true);
    expect(progress).toContain('已送出第 1 批（預計共 1 批），含 1 個請求。');
    expect(progress).toContain('第 1 批處理中，已等待 1 分鐘。');
    expect(progress).toContain('第 1 批處理中，已等待 2 分鐘。');
  });

  // 進度的編號是這次執行送出的第幾批，不是 `batch` 表的列號：Pass 0 也用這張表（ADR-0132）。
  it('counts the batches of this run from one, past the rows Pass 0 left in the table', async () => {
    const lib = await confirmed();
    withStore(lib.home, (store) => {
      for (let index = 0; index < 3; index += 1) {
        store.run(
          "INSERT INTO batch (nonce, state, requests, high_usd, created_at, stage) VALUES (?, 'collected', 1, 0.01, ?, 'scan')",
          `scan${index}`,
          new Date().toISOString(),
        );
      }
    });
    const { host } = await fake(GOOD, { polls: 1 });
    const { exit, output, progress } = await translate(lib, host);
    expect(exit).toBe(0);
    // 剛送出的批次不是認回來的，不說找回上次中斷前的批次。
    expect(codes(output)).not.toContain('batch.recovered');
    expect(progress).toContain('已送出第 1 批（預計共 1 批），含 1 個請求。');
    expect(progress).toContain('第 1 批處理中，已等待 1 分鐘。');
    expect(progress).not.toContain('第 4 批');
  });

  // 預計的批數每送一批重算，重送讓批數變多時跟著變大（ADR-0132）。
  it('raises the planned count when a split adds a batch', async () => {
    const lib = await confirmed();
    const { host } = await fake(REFUSE_FIRST, { reverse: true });
    const { progress } = await translate(lib, host);
    expect(progress).toContain('已送出第 1 批（預計共 1 批），含 1 個請求。');
    expect(progress).toContain('已送出第 2 批（預計共 2 批），含 2 個請求。');
  });

  it('numbers no batch whose create was refused, and starts from one again on the next run', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD, { createStatus: 400 });
    const first = await translate(lib, host);
    expect(first.exit).toBe(1);
    expect(first.progress).not.toContain('已送出第');
    provider.batch.createStatus = null;
    const second = await translate(lib, host);
    expect(second.exit).toBe(0);
    expect(batchRows(lib.home)).toHaveLength(2);
    expect(second.progress).toContain('已送出第 1 批（預計共 1 批），含 1 個請求。');
  });

  it('sends nothing for a book that is done', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD);
    await translate(lib, host);
    const { exit, output, progress } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(provider.batches).toHaveLength(1);
    expect(output.data).toMatchObject({ requests: 0, batches: 0, done: 3 });
    expect(progress).toBe('');
  });

  it('needs the estimate confirmed in batch mode', async () => {
    const lib = await library();
    const { io } = lib.session();
    await run(['estimate', 'book', '--realtime', '--budget', '100', '--confirm'], io);
    const { provider, host } = await fake(GOOD);
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(found(output, 'translate.not_confirmed')?.params).toEqual({ book: 'book', flags: '--confirm' });
    expect(provider.requests).toHaveLength(0);
  });
});

describe('the real adapter end to end (ADR-0109 item 13)', () => {
  it('translates the book in a batch through the SDK, and deletes it', async () => {
    const lib = await confirmed();
    const provider = await startFakeProvider(GOOD, { polls: 1, reverse: true });
    const host = adapterHost(provider);
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(host.waits).toEqual([POLL_SECONDS]);
    expect(provider.batches).toHaveLength(1);
    expect(provider.batches[0]?.deleted).toBe(true);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
    expect(output.data).toMatchObject({ mode: 'batch', batches: 1, done: 3 });
  });

  it('downloads the results again when they break off, without sending again (ADR-0109 item 20)', async () => {
    const lib = await confirmed();
    const provider = await startFakeProvider(GOOD, { cutResults: 1 });
    const host = adapterHost(provider);
    const { exit } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(host.waits).toEqual([1]);
    expect(provider.batches).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });

  it('finds the batch again after a create that never answered, and pays once (H-17)', async () => {
    const lib = await confirmed();
    const provider = await startFakeProvider(GOOD, { dropCreate: true });
    const host = adapterHost(provider);
    expect((await translate(lib, host)).exit).toBe(1);
    provider.batch.dropCreate = false;
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(found(output, 'batch.recovered')?.params).toEqual({ id: provider.batches[0]?.id });
    expect(provider.batches).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
  });

  it('stops at the gate of the egress, the last check, through the SDK (ADR-0109 item 1)', async () => {
    const lib = await confirmed();
    const provider = await startFakeProvider(GOOD);
    const host = adapterHost(provider);
    // 工作區的清單沒有命中，只有對外出口的清單有，核心逐一掃描時過得了，對外出口才擋下。
    const rules = { pii: ['warden'], exceptions: [] };
    const strict: FakeHost = {
      ...host,
      connect: (_fetcher, endpoint) =>
        host.connect(guardedFetch({ endpoint: provider.url, provider: 'anthropic', rules, record: () => undefined }), endpoint),
    };
    const { exit, output } = await translate(lib, strict);
    expect(exit).toBe(1);
    expect(found(output, 'translate.blocked')?.level).toBe('fail');
    expect(statesOf(lib.home)).toEqual(['BLOCKED', 'BLOCKED', 'BLOCKED']);
    expect(provider.batches).toHaveLength(0);
    expect(batchRows(lib.home).map(({ state }) => state)).toEqual(['abandoned']);
  });

  it('collects, checks and cancels through the SDK', async () => {
    const lib = await confirmed();
    const provider = await startFakeProvider(GOOD, { polls: 5, pollStatus: 500 });
    const host = adapterHost(provider);
    await translate(lib, host);
    provider.batch.pollStatus = null;
    expect(codes((await tome(lib, host, 'batch', 'status', 'book')).output)).toEqual(['batch.processing']);
    expect(codes((await tome(lib, host, 'batch', 'cancel', 'book')).output)).toEqual(['batch.canceling']);
    provider.batch.polls = 0;
    const { exit } = await tome(lib, host, 'batch', 'collect', 'book');
    expect(exit).toBe(1);
    expect(provider.batches[0]?.deleted).toBe(true);
  });
});

describe('what comes back (ADR-0107 item 13)', () => {
  it('splits a refused request into the next batch, and matches results that come back out of order', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(REFUSE_FIRST, { reverse: true });
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(provider.batches).toHaveLength(2);
    expect(provider.batches[1]?.items).toHaveLength(2);
    expect(output.data).toMatchObject({ requests: 3, batches: 2, done: 3 });
    for (const { translation, source } of rows(lib.home)) expect(translation).toBe(`譯：${source}`);
    // 拒答也記帳，部分類別要付費（ADR-0104 第 14 項）。
    expect(new Set(ledger(lib.home).map(({ request_id }) => request_id)).size).toBe(3);
  });

  it('sends a unit refused on its own to the fallback model in the next batch', async () => {
    const lib = await confirmed({ config: `translator_model: ${MODEL}\nfallback_model: ${FALLBACK}\npii: [x y z]\n` });
    // 第一批整個被拒，拆成兩個。只有一個單位的那個用原模型又被拒，下一批改送回退模型。
    const { provider, host } = await fake((request, index) =>
      index === 0 || (request.model === MODEL && parseUnits(request.user).units.length === 1)
        ? { refusal: true }
        : GOOD(request, index),
    );
    const { exit } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(provider.batches).toHaveLength(3);
    expect(provider.requests.at(-1)?.model).toBe(FALLBACK);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });

  it('splits a cut-off reply into the next batch, and pays for it', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake((request, index) =>
      index === 0 ? { text: '', stop_reason: 'max_tokens' } : GOOD(request, index),
    );
    const { exit } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(provider.batches).toHaveLength(2);
    expect(rows(lib.home).map(({ attempts }) => attempts)).toEqual([2, 2, 2]);
    expect(ledger(lib.home).length).toBeGreaterThan(3);
  });

  // 批次也把 `stop_reason` 與送出時的 `max_tokens` 記進帳本（ADR-0114）。
  it('keeps the stop reason and the max_tokens of each request in the ledger', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake((request, index) =>
      index === 0 ? { text: '', stop_reason: 'max_tokens' } : GOOD(request, index),
    );
    await translate(lib, host);
    const sent = provider.requests.map(({ body }) => body['max_tokens']);
    const stored = withStore(lib.home, (store) =>
      store.all<{ stop_reason: string; max_tokens: number }>(
        'SELECT stop_reason, max_tokens FROM ledger GROUP BY request_id ORDER BY MIN(id)',
      ),
    );
    expect(stored.map(({ stop_reason }) => stop_reason)).toEqual(['max_tokens', 'end_turn', 'end_turn']);
    expect(stored.map(({ max_tokens }) => max_tokens)).toEqual(sent);
  });

  it('stops when a whole batch failed, puts the units back and charges nothing (item 14)', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake((request, index) => (index === 0 ? { errored: 'api_error' } : GOOD(request, index)));
    const first = await translate(lib, host);
    expect(first.exit).toBe(1);
    expect(found(first.output, 'batch.errored')?.params).toEqual({ count: '1', type: 'api_error' });
    expect(statesOf(lib.home)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);
    expect(rows(lib.home).every(({ attempts }) => attempts === 0)).toBe(true);
    expect(ledger(lib.home)).toHaveLength(0);
    expect(provider.batches[0]?.deleted).toBe(true);
    const second = await translate(lib, host);
    expect(second.exit).toBe(0);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });

  it('resends an error that may pass in the next batch, and goes on (item 13)', async () => {
    const lib = await confirmed();
    // 第一批被拒拆成兩個，第二批一個成功、一個 `overloaded_error`，第三批重送它。
    const { provider, host } = await fake((request, index) =>
      index === 0 ? { refusal: true } : index === 1 ? { errored: 'overloaded_error' } : GOOD(request, index),
    );
    const { exit } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(provider.batches).toHaveLength(3);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });

  it('stops after a batch with an error that would fail again, once the rest is in', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake((request, index) =>
      index === 0 ? { refusal: true } : index === 1 ? { errored: 'invalid_request_error' } : GOOD(request, index),
    );
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(found(output, 'batch.errored')?.params).toEqual({ count: '1', type: 'invalid_request_error' });
    expect(provider.batches).toHaveLength(2);
    expect(provider.batches[1]?.deleted).toBe(true);
    expect(statesOf(lib.home).filter((state) => state === 'DONE')).toHaveLength(1);
    expect(statesOf(lib.home).filter((state) => state === 'QUEUED')).toHaveLength(2);
  });

  it('puts expired and canceled requests back, unpaid', async () => {
    for (const reply of [{ expired: true }, { canceled: true }] as const) {
      const lib = await confirmed();
      const { host } = await fake(() => reply);
      const { exit, output } = await translate(lib, host);
      expect(exit).toBe(1);
      expect(found(output, 'batch.errored')?.params['type']).toBe('expired' in reply ? 'expired' : 'canceled');
      expect(statesOf(lib.home)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);
      expect(ledger(lib.home)).toHaveLength(0);
    }
  });
});

describe('budget and gate before a batch (ADR-0107 items 6 and 7)', () => {
  it('checks the whole batch against the budget and sends nothing over it', async () => {
    const lib = await confirmed({ budget: '1' });
    const { provider, host } = await fake((request, index) =>
      index === 0
        ? { refusal: true, usage: { input_tokens: 10_000_000, output_tokens: 0 } }
        : GOOD(request, index),
    );
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(provider.batches).toHaveLength(1);
    expect(found(output, 'batch.budget_exceeded')?.level).toBe('fail');
    expect(found(output, 'batch.budget_exceeded')?.params['book']).toBe('book');
    expect(statesOf(lib.home)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);
  });

  it('blocks the requests that hit and sends no batch at all', async () => {
    const lib = await confirmed({ config: `translator_model: ${MODEL}\npii: [warden]\n` });
    const { provider, host } = await fake(GOOD);
    const { exit, output, text } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(provider.batches).toHaveLength(0);
    expect(found(output, 'translate.blocked')?.level).toBe('fail');
    expect(statesOf(lib.home)).toEqual(['BLOCKED', 'BLOCKED', 'BLOCKED']);
    expect(batchRows(lib.home)).toHaveLength(0);
    expect(text).not.toContain('warden');
  });
});

describe('sending a batch (ADR-0107 item 8, ADR-0108)', () => {
  it('retries a 429 on create, as a 4xx made nothing, then gives the units back', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD, { createStatus: 429 });
    const { exit, output, progress } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(host.waits).toEqual([1, 2, 4, 8, 16]);
    // 每次重試前一行，說幾秒後重試、第幾次（ADR-0111）。
    expect(progress.match(/供應商暫時無法完成請求（狀態碼 429/g)).toHaveLength(5);
    expect(progress).toContain('供應商暫時無法完成請求（狀態碼 429，- 表示沒有收到回應），16 秒後重試（第 5 次，最多 5 次）。\n');
    expect(found(output, 'translate.provider_failed')?.params).toEqual({ status: '429' });
    expect(provider.batches).toHaveLength(0);
    expect(batchRows(lib.home)[0]?.state).toBe('abandoned');
    expect(statesOf(lib.home)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);
  });

  it('does not retry another 4xx on create', async () => {
    const lib = await confirmed();
    const { host } = await fake(GOOD, { createStatus: 400 });
    const { exit } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(host.waits).toEqual([]);
    expect(batchRows(lib.home)[0]?.state).toBe('abandoned');
    expect(statesOf(lib.home)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);
  });

  it('does not retry a 5xx on create, which may have made the batch, and finds it on the next run', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD, { failAfterCreate: 500 });
    const first = await translate(lib, host);
    expect(first.exit).toBe(1);
    expect(found(first.output, 'translate.provider_failed')?.params).toEqual({ status: '500' });
    expect(host.waits).toEqual([]);
    expect(provider.batches).toHaveLength(1);
    expect(batchRows(lib.home)[0]).toMatchObject({ state: 'intent', remote_id: null });
    expect(statesOf(lib.home)).toEqual(['IN_FLIGHT', 'IN_FLIGHT', 'IN_FLIGHT']);
    provider.batch.failAfterCreate = null;
    const second = await translate(lib, host);
    expect(second.exit).toBe(0);
    expect(found(second.output, 'batch.recovered')?.params).toEqual({ id: provider.batches[0]?.id });
    expect(provider.batches).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });

  it('sends the units again on the next run when a 5xx made nothing', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD, { createStatus: 503 });
    const first = await translate(lib, host);
    expect(first.exit).toBe(1);
    expect(host.waits).toEqual([]);
    expect(batchRows(lib.home)[0]).toMatchObject({ state: 'intent', remote_id: null });
    provider.batch.createStatus = null;
    const second = await translate(lib, host);
    expect(second.exit).toBe(0);
    expect(found(second.output, 'batch.not_sent')?.params).toEqual({ requests: '1' });
    expect(batchRows(lib.home).map(({ state }) => state)).toEqual(['abandoned', 'collected']);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });

  it('does not send the batch again when no reply came, and keeps the intent', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD, { dropCreate: true });
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(found(output, 'translate.provider_failed')?.params).toEqual({ status: '-' });
    expect(provider.batches).toHaveLength(1);
    expect(host.waits).toEqual([]);
    expect(batchRows(lib.home)[0]).toMatchObject({ state: 'intent', remote_id: null });
    expect(statesOf(lib.home)).toEqual(['IN_FLIGHT', 'IN_FLIGHT', 'IN_FLIGHT']);
  });
});

describe('recovering a batch after a crash (H-17, ADR-0107 item 9)', () => {
  it('finds the batch that went out, collects it and does not pay for it twice', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD, { dropCreate: true });
    await translate(lib, host);
    provider.batch.dropCreate = false;
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(provider.batches).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
    expect(provider.batches[0]?.deleted).toBe(true);
    expect(found(output, 'batch.recovered')?.params).toEqual({ id: provider.batches[0]?.id });
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });

  it('sends the units again when the batch never reached the provider', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD);
    const crashing = patched(host, () => ({ submitBatch: () => Promise.reject(new Error('crash')) }));
    expect((await translate(lib, crashing)).exit).toBe(2);
    expect(statesOf(lib.home)).toEqual(['IN_FLIGHT', 'IN_FLIGHT', 'IN_FLIGHT']);
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(found(output, 'batch.not_sent')?.params).toEqual({ requests: '1' });
    expect(batchRows(lib.home).map(({ state }) => state)).toEqual(['abandoned', 'collected']);
    expect(provider.batches).toHaveLength(1);
  });

  it('passes over a batch of another book, and neither uses nor deletes it', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD, { dropCreate: true });
    // 別本書剛好在這本書之前送出一批，請求數一樣。
    const other = patched(host, (inner) => ({
      submitBatch: (requests) => {
        provider.addForeignBatch({ requests: 1 });
        return inner.submitBatch(requests);
      },
    }));
    await translate(lib, other);
    provider.batch.dropCreate = false;
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(0);
    const [foreign, ours] = provider.batches;
    expect(foreign?.items[0]?.customId).toMatch(/^foreign-/);
    expect(foreign?.deleted).toBe(false);
    expect(ours?.deleted).toBe(true);
    expect(found(output, 'batch.recovered')?.params).toEqual({ id: ours?.id });
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });

  it('ignores batches made well before the intent, and pages through the list', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD, { pageSize: 1 });
    provider.addForeignBatch({ requests: 1, createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    const crashing = patched(host, () => ({ submitBatch: () => Promise.reject(new Error('crash')) }));
    await translate(lib, crashing);
    provider.addForeignBatch({ requests: 2 });
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(codes(output)).toContain('batch.not_sent');
    expect(provider.batches.slice(0, 2).every(({ deleted }) => !deleted)).toBe(true);
  });
});

describe('a batch left from before (ADR-0107 items 11, 15 and 16)', () => {
  /** 查詢一直失敗，停在送出之後，批次留在紀錄裡。 */
  async function leftOver(script: FakeScript = GOOD): Promise<{ lib: Library; provider: FakeProvider; host: FakeHost }> {
    const lib = await confirmed();
    const { provider, host } = await fake(script, { pollStatus: 500 });
    const { exit } = await translate(lib, host);
    expect(exit).toBe(1);
    provider.batch.pollStatus = null;
    return { lib, provider, host };
  }

  it('collects it before sending anything new', async () => {
    const { lib, provider, host } = await leftOver();
    expect(batchRows(lib.home)[0]?.state).toBe('submitted');
    const { exit } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(provider.batches).toHaveLength(1);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });

  // 上一次送出的批次不是這次執行的第幾批，不給編號（ADR-0132）。
  it('gives no number to the batch from before while it waits for it', async () => {
    const { lib, provider, host } = await leftOver();
    provider.batches.forEach((batch) => (batch.polls = 2));
    const { exit, progress } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(progress).toContain('上次送出的一批處理中，已等待 1 分鐘。');
    expect(progress).toContain('上次送出的一批處理中，已等待 2 分鐘。');
    expect(progress).not.toMatch(/第 \d+ 批處理中/u);
  });

  /** 估價確認之後書的內容改了，`tome batch collect` 照樣收回（第 17 項）。 */
  function changeDocument(home: string, change: (blocks: { text: string }[]) => void): void {
    const path = join(home, 'books', 'book', 'ir', 'document.json');
    const document = JSON.parse(readFileSync(path, 'utf8')) as { blocks: { text: string }[] };
    change(document.blocks);
    writeFileSync(path, JSON.stringify(document));
  }

  it('gives each unit its own reply when a unit in the middle left the plan before the results came', async () => {
    const { lib, provider, host } = await leftOver();
    expect(provider.requests).toHaveLength(1);
    changeDocument(lib.home, (blocks) => blocks.splice(1, 1));
    const { exit } = await tome(lib, host, 'batch', 'collect', 'book');
    expect(exit).toBe(0);
    const left = rows(lib.home);
    expect(left).toHaveLength(2);
    for (const { state, translation, source } of left) {
      expect(state).toBe('DONE');
      expect(translation).toBe(`譯：${source}`);
    }
    // 送出時的上限算不回來，寧可是 NULL 也不記錯的數字（ADR-0114）。
    const stored = withStore(lib.home, (store) => store.all('SELECT DISTINCT stop_reason, max_tokens FROM ledger'));
    expect(stored).toEqual([{ stop_reason: 'end_turn', max_tokens: null }]);
  });

  it('does not give an old reply to a unit whose text changed before the results came', async () => {
    const { lib, host } = await leftOver();
    changeDocument(lib.home, (blocks) => {
      const middle = blocks[1];
      if (middle !== undefined) middle.text = `${middle.text} Changed.`;
    });
    const { exit } = await tome(lib, host, 'batch', 'collect', 'book');
    expect(exit).toBe(0);
    const [first, middle, last] = rows(lib.home);
    expect(middle).toMatchObject({ state: 'PENDING', translation: null });
    for (const unit of [first, last]) expect(unit?.translation).toBe(`譯：${unit?.source}`);
  });

  it('stops --realtime, which would pay for the same units again', async () => {
    const { lib, provider, host } = await leftOver();
    const { io } = lib.session();
    await run(['estimate', 'book', '--realtime', '--confirm'], io);
    const { exit, output } = await tome(lib, host, 'translate', 'book', '--realtime');
    expect(exit).toBe(1);
    expect(found(output, 'batch.pending')?.params).toEqual({ book: 'book' });
    expect(provider.requests).toHaveLength(1);
    expect(statesOf(lib.home)).toEqual(['IN_FLIGHT', 'IN_FLIGHT', 'IN_FLIGHT']);
  });

  it('warns when the results are past the retention, and gives the units back', async () => {
    const { lib, provider, host } = await leftOver();
    provider.batch.archived = true;
    const { exit, output } = await tome(lib, host, 'batch', 'collect', 'book');
    expect(exit).toBe(0);
    expect(found(output, 'batch.archived')?.level).toBe('warn');
    expect(statesOf(lib.home)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);
  });

  it('tries the delete again on the next run when it failed', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD, { deleteStatus: 400 });
    const first = await translate(lib, host);
    expect(first.exit).toBe(0);
    expect(found(first.output, 'batch.delete_failed')?.level).toBe('warn');
    expect(batchRows(lib.home)[0]?.deleted_at).toBeNull();
    provider.batch.deleteStatus = null;
    await translate(lib, host);
    expect(batchRows(lib.home)[0]?.deleted_at).not.toBeNull();
    expect(provider.batches[0]?.deleted).toBe(true);
  });

  it('takes a 404 on delete as deleted, warns once and never sends the delete again (ADR-0109 item 24)', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD, { deleteStatus: 404 });
    const first = await translate(lib, host);
    expect(first.exit).toBe(0);
    expect(found(first.output, 'batch.delete_not_found')).toMatchObject({ level: 'warn', params: { id: provider.batches[0]?.id } });
    expect(codes(first.output)).not.toContain('batch.delete_failed');
    expect(batchRows(lib.home)[0]?.deleted_at).not.toBeNull();
    const deletes = (): number => provider.calls.filter(({ method }) => method === 'DELETE').length;
    const sent = deletes();
    const second = await translate(lib, host);
    expect(deletes()).toBe(sent);
    expect(codes(second.output)).not.toContain('batch.delete_not_found');
    const { output } = await tome(lib, undefined, 'status', 'book');
    expect(codes(output)).not.toContain('status.not_deleted');
  });

  it('still tries again next time for a status other than 404', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD, { deleteStatus: 500 });
    const first = await translate(lib, host);
    expect(found(first.output, 'batch.delete_failed')?.level).toBe('warn');
    expect(batchRows(lib.home)[0]?.deleted_at).toBeNull();
    provider.batch.deleteStatus = null;
    await translate(lib, host);
    expect(batchRows(lib.home)[0]?.deleted_at).not.toBeNull();
  });

  it('requeues units a realtime run left in flight, which no batch holds', async () => {
    const lib = await confirmed();
    withStore(lib.home, (store) => store.run("UPDATE unit SET state = 'IN_FLIGHT'"));
    const { host } = await fake(GOOD);
    expect((await translate(lib, host)).exit).toBe(0);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });
});

describe('tome batch status|collect|cancel (ADR-0107 item 17)', () => {
  async function submitted(polls: number): Promise<{ lib: Library; provider: FakeProvider; host: FakeHost }> {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD, { polls, pollStatus: 500 });
    await translate(lib, host);
    provider.batch.pollStatus = null;
    return { lib, provider, host };
  }

  it('asks for a key before it connects (ADR-0109 item 6)', async () => {
    const lib = await confirmed();
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    for (const command of ['status', 'collect', 'cancel']) {
      // 開發者的機器可能設了金鑰，這裡要拿掉。
      const { io, stdout } = lib.session({ env: { ...lib.env, TOME_ANTHROPIC_API_KEY: undefined } });
      expect(await run(['batch', command, 'book', '--json'], io)).toBe(1);
      expect(codes(JSON.parse(stdout()) as Envelope)).toEqual(['key.missing']);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('says there is no batch', async () => {
    const lib = await confirmed();
    const { host } = await fake(GOOD);
    for (const command of ['status', 'collect', 'cancel']) {
      const { output } = await tome(lib, host, 'batch', command, 'book');
      expect(codes(output)).toContain('batch.none');
    }
  });

  it('shows what the provider says, without waiting or changing anything', async () => {
    const { lib, provider, host } = await submitted(5);
    const waited = host.waits.length;
    const processing = await tome(lib, host, 'batch', 'status', 'book');
    expect(found(processing.output, 'batch.processing')?.params).toEqual({ id: provider.batches[0]?.id });
    expect(processing.progress).toBe('');
    expect(processing.output.data['batches']).toMatchObject([{ status: 'in_progress' }]);
    provider.batches.forEach((batch) => (batch.polls = 0));
    const ended = await tome(lib, host, 'batch', 'status', 'book');
    expect(found(ended.output, 'batch.ended')?.params).toMatchObject({ succeeded: '1', errored: '0', book: 'book' });
    expect(host.waits).toHaveLength(waited);
    expect(statesOf(lib.home)).toEqual(['IN_FLIGHT', 'IN_FLIGHT', 'IN_FLIGHT']);
  });

  it('says before each retry how long it waits, here too (ADR-0111)', async () => {
    const { lib, provider, host } = await submitted(5);
    provider.batch.pollStatus = 503;
    const { exit, progress } = await tome(lib, host, 'batch', 'status', 'book');
    expect(exit).toBe(1);
    expect(progress).toContain('供應商暫時無法完成請求（狀態碼 503，- 表示沒有收到回應），1 秒後重試（第 1 次，最多 5 次）。\n');
    expect(progress.match(/後重試/g)).toHaveLength(5);
  });

  it('collects without sending new batches or a confirmed estimate', async () => {
    const { lib, provider, host } = await submitted(0);
    const path = join(lib.home, 'books', 'book', 'book.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/budget_usd: .*/, 'budget_usd: 200'));
    const { exit, output } = await tome(lib, host, 'batch', 'collect', 'book');
    expect(exit).toBe(0);
    expect(codes(output)).toContain('translate.done');
    expect(output.data).toMatchObject({ mode: 'batch', batches: 0, done: 3 });
    expect(provider.batches).toHaveLength(1);
  });

  it('cancels, and a later collect keeps what was done and gives back the rest', async () => {
    const { lib, provider, host } = await submitted(1);
    const cancel = await tome(lib, host, 'batch', 'cancel', 'book');
    expect(found(cancel.output, 'batch.canceling')?.params).toEqual({ id: provider.batches[0]?.id, book: 'book' });
    expect(provider.batches[0]?.canceled).toBe(true);
    const collected = await tome(lib, host, 'batch', 'collect', 'book');
    expect(found(collected.output, 'batch.errored')?.params['type']).toBe('canceled');
    expect(statesOf(lib.home)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);
  });

  it('leaves a batch it cannot confirm alone (H-17)', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD, { dropCreate: true });
    await translate(lib, host);
    for (const command of ['status', 'cancel']) {
      const { output } = await tome(lib, host, 'batch', command, 'book');
      expect(found(output, 'batch.unconfirmed')?.params).toEqual({ requests: '1' });
    }
    expect(provider.batches[0]?.canceled).toBe(false);
  });

  it('takes the lock of the book (ADR-0054 item 5)', async () => {
    const lib = await confirmed();
    const { host } = await fake(GOOD);
    writeFileSync(join(lib.home, 'books', 'book', 'book.lock'), String(process.pid));
    const { exit } = await tome(lib, host, 'batch', 'collect', 'book');
    expect(exit).toBe(2);
  });
});

describe('tome status (ADR-0107 item 18)', () => {
  it('counts the units kept as they are, from book.db, as translate does (ADR-0111)', async () => {
    const lib = await library();
    addSceneBreak(lib.home);
    await run(['estimate', 'book', '--budget', '100', '--confirm'], lib.session().io);
    const { host } = await fake(GOOD);
    const translated = await translate(lib, host);
    expect(found(translated.output, 'translate.done')?.params).toMatchObject({ total: '4', kept: '1', done: '4' });
    const { output, text } = await tome(lib, undefined, 'status', 'book');
    expect(output.data['kept']).toBe(1);
    expect(found(output, 'status.units')?.params).toMatchObject({ total: '4', kept: '1', done: '4' });
    const { io, stdout } = lib.session();
    await run(['status', 'book'], io);
    expect(stdout()).toContain('共 4 個翻譯單位，其中 1 個不需翻譯、原樣保留：完成 4 個（含原樣保留的）');
    expect(text).not.toContain('* * *');
  });

  it('says to estimate first when there are no units yet', async () => {
    const lib = await library();
    const { exit, output } = await tome(lib, undefined, 'status', 'book');
    expect(exit).toBe(0);
    expect(found(output, 'status.no_units')?.params).toEqual({ book: 'book' });
  });

  /** 第 1 章是前兩個區塊，第 2 章從第三個起。 */
  function twoChapters(home: string): string {
    const path = join(home, 'books', 'book', 'ir', 'document.json');
    const document = JSON.parse(readFileSync(path, 'utf8')) as { blocks: { id: string }[]; sections: unknown[] };
    document.sections = [
      { title: 'One', block_id: document.blocks[0]?.id, children: [] },
      { title: 'Two', block_id: document.blocks[2]?.id, children: [] },
    ];
    writeFileSync(path, JSON.stringify(document));
    return path;
  }

  // 跟 `tome translate` 完成時一樣是範圍內的數字，範圍外沒完成的另印一行（ADR-0114）。
  it('counts within the range set in book.yaml, as translate does, and says apart what is left outside', async () => {
    const lib = await library();
    twoChapters(lib.home);
    addSceneBreak(lib.home);
    await run(['estimate', 'book', '--budget', '100', '--chapters', '1', '--confirm'], lib.session().io);
    const { host } = await fake(GOOD);
    const translated = await translate(lib, host);
    const { exit, output, text } = await tome(lib, undefined, 'status', 'book');
    expect(exit).toBe(0);
    const params = found(output, 'status.units')?.params;
    expect(params).toMatchObject({ total: '2', kept: '0', done: '2', left: '0' });
    expect(found(translated.output, 'translate.done')?.params).toMatchObject({ total: '2', kept: '0', done: '2' });
    expect(found(output, 'scope.outside')?.params).toEqual({ book: 'book', chapters: '1', outside: '1' });
    expect(codes(output).slice(0, 2)).toEqual(['status.units', 'scope.outside']);
    expect(output.data['units']).toMatchObject({ DONE: 3, PENDING: 1 });
    expect(output.data['kept']).toBe(0);
    expect(output.data['scope']).toEqual({
      chapters: '1',
      total: 2,
      kept: 0,
      fielded: 0,
      human: 0,
      done: 2,
      in_flight: 0,
      blocked: 0,
      failed: 0,
      refused: 0,
      left: 0,
      outside: 1,
    });
    expect(text).not.toContain('One');
  });

  // 範圍跟 `--chapters` 一樣依 `chapter_level` 編號（ADR-0115）。
  it('reads the range at the chapter level of the book', async () => {
    const lib = await library();
    const path = join(lib.home, 'books', 'book', 'ir', 'document.json');
    const document = JSON.parse(readFileSync(path, 'utf8')) as { blocks: { id: string }[]; sections: unknown[] };
    document.sections = [
      {
        title: 'Book',
        block_id: document.blocks[0]?.id,
        children: [
          { title: 'One', block_id: document.blocks[1]?.id, children: [] },
          { title: 'Two', block_id: document.blocks[2]?.id, children: [] },
        ],
      },
    ];
    writeFileSync(path, JSON.stringify(document));
    await run(['estimate', 'book', '--budget', '100', '--chapter-level', '2', '--chapters', '2', '--confirm'], lib.session().io);
    const { host } = await fake(GOOD);
    const translated = await translate(lib, host);
    expect(translated.output.data).toMatchObject({ total: 1, done: 1, outside: 2, chapters: '2' });
    const { output } = await tome(lib, undefined, 'status', 'book');
    expect(output.data['scope']).toMatchObject({ chapters: '2', total: 1, done: 1, outside: 2 });
  });

  it('counts the whole book when there is no range', async () => {
    const lib = await confirmed();
    const { host } = await fake(GOOD);
    await translate(lib, host);
    const { output } = await tome(lib, undefined, 'status', 'book');
    expect(output.data['scope']).toMatchObject({ chapters: null, total: 3, done: 3, outside: 0 });
    expect(codes(output)).not.toContain('scope.outside');
  });

  it('counts the whole book when document.json is gone, rather than fail', async () => {
    const lib = await library();
    const path = twoChapters(lib.home);
    await run(['estimate', 'book', '--budget', '100', '--chapters', '1', '--confirm'], lib.session().io);
    rmSync(path);
    const { exit, output } = await tome(lib, undefined, 'status', 'book');
    expect(exit).toBe(0);
    expect(found(output, 'status.units')?.params).toMatchObject({ total: '3', left: '3' });
    expect(output.data['scope']).toMatchObject({ chapters: null, outside: 0 });
    expect(codes(output)).not.toContain('scope.outside');
  });

  it('says the range is wrong when the book has fewer chapters now, as estimate does', async () => {
    const lib = await library();
    const path = twoChapters(lib.home);
    await run(['estimate', 'book', '--budget', '100', '--chapters', '2', '--confirm'], lib.session().io);
    const document = JSON.parse(readFileSync(path, 'utf8')) as { sections: unknown[] };
    document.sections = document.sections.slice(0, 1);
    writeFileSync(path, JSON.stringify(document));
    const { exit, output } = await tome(lib, undefined, 'status', 'book');
    expect(exit).toBe(2);
    expect(codes(output)).toEqual(['chapters.invalid']);
  });

  it('counts the units, the money and the batches, without the network', async () => {
    const spy = vi.fn();
    const lib = await confirmed();
    const { host } = await fake(GOOD, { pollStatus: 500 });
    await translate(lib, host);
    vi.stubGlobal('fetch', spy);
    const { exit, output, text } = await tome(lib, undefined, 'status', 'book');
    expect(exit).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(found(output, 'status.units')?.params).toMatchObject({ total: '3', in_flight: '3', done: '0', left: '0' });
    expect(found(output, 'status.spent')?.params).toMatchObject({ budget: '100.00' });
    const batch = found(output, 'status.batch')?.params;
    expect(batch?.['submitted']).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(batch?.['submitted_zone']).toMatch(/^UTC([+-]\d{1,2}(:\d\d)?)?$/);
    expect(output.data['units']).toMatchObject({ IN_FLIGHT: 3, DONE: 0, PENDING: 0 });
    expect(Object.keys(output.data['units'] as object)).toHaveLength(9);
    expect(output.data['batches']).toMatchObject([{ state: 'submitted', requests: 1, deleted: false }]);
    expect(text).not.toContain('warden');
  });

  it('shows the time of this machine with its offset, and the raw time in --json (item 18)', async () => {
    vi.stubEnv('TZ', 'Asia/Taipei');
    const lib = await confirmed();
    const { host } = await fake(GOOD, { pollStatus: 500 });
    await translate(lib, host);
    const { output, text } = await tome(lib, undefined, 'status', 'book');
    const [batch] = output.data['batches'] as { submitted_at: string; expires_at: string }[];
    const shown = (iso: string): string =>
      new Date(Date.parse(iso) + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
    expect(found(output, 'status.batch')?.params).toMatchObject({
      submitted: shown(batch?.submitted_at ?? ''),
      submitted_zone: 'UTC+8',
      expires: shown(batch?.expires_at ?? ''),
      expires_zone: 'UTC+8',
    });
    expect(batch?.submitted_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
    expect(text).toContain('（UTC+8）送出');
  });

  it('adds the six numbers up to the total, with replies waiting to be verified as left', async () => {
    const lib = await confirmed();
    const { host } = await fake(GOOD);
    await translate(lib, host);
    withStore(lib.home, (store) => {
      store.run("UPDATE unit SET state = 'RECEIVED' WHERE seq = 1");
      store.run("UPDATE unit SET state = 'STALE' WHERE seq = 2");
    });
    const { output } = await tome(lib, undefined, 'status', 'book');
    const params = found(output, 'status.units')?.params ?? {};
    const parts = ['done', 'in_flight', 'blocked', 'failed', 'refused', 'left'].map((name) => Number(params[name]));
    expect(parts.reduce((sum, count) => sum + count, 0)).toBe(Number(params['total']));
    expect(params).toMatchObject({ total: '3', done: '1', left: '2' });
  });

  it('warns about batches still at the provider', async () => {
    const lib = await confirmed();
    const { host } = await fake(GOOD, { deleteStatus: 400 });
    await translate(lib, host);
    const { output } = await tome(lib, undefined, 'status', 'book');
    expect(found(output, 'status.not_deleted')?.params).toEqual({ count: '1' });
  });

  it('works while another command holds the book', async () => {
    const lib = await confirmed();
    writeFileSync(join(lib.home, 'books', 'book', 'book.lock'), String(process.pid));
    const { exit, output } = await tome(lib, undefined, 'status', 'book');
    expect(exit).toBe(0);
    expect(codes(output)).toContain('status.units');
  });

  it('shows the money without a budget', async () => {
    const lib = await library();
    const { io } = lib.session();
    await run(['estimate', 'book'], io);
    const { output } = await tome(lib, undefined, 'status', 'book');
    expect(found(output, 'status.no_budget')?.params).toEqual({ spent: '0.00' });
  });
});
