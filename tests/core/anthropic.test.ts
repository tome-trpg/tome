import { afterEach, describe, expect, it, vi } from 'vitest';
import { EgressBlocked, guardedFetch, type EgressEntry } from '../../src/core/egress/client.ts';
import { TomeError } from '../../src/core/errors.ts';
import { isApiError, type BatchItem, type LLMProvider, type RemoteBatch } from '../../src/core/llm.ts';
import type { MessagesBody } from '../../src/core/request.ts';
import { adapterHost, startFakeProvider, SYNTHETIC_KEY, type FakeProvider, type FakeScript } from '../helpers/fake-provider.ts';

// 真的轉接層與 SDK 0.137.0，連到本機的假供應商（ADR-0109）。金鑰是合成的，
// 請求不會離開這台機器：白名單只放假供應商，連到別的主機時對外出口會擋下來。

const PRODUCTION = 'https://api.anthropic.com';
const GOOD: FakeScript = () => ({ text: '<s id="1">譯文</s>' });

function body(user = '<s id="1">synthetic warden text</s>'): MessagesBody {
  return { model: 'claude-haiku-5-5', max_tokens: 1024, system: 'prefix', messages: [{ role: 'user', content: user }] };
}

interface Connected {
  readonly fake: FakeProvider;
  readonly llm: LLMProvider;
  readonly sent: EgressEntry[];
}

/** 白名單預設是假供應商。`allowed` 給正式的端點時，SDK 仍連到假供應商，會被擋下。 */
async function connect(script: FakeScript = GOOD, options: { allowed?: string; pii?: string[] } = {}): Promise<Connected> {
  const fake = await startFakeProvider(script);
  const sent: EgressEntry[] = [];
  const fetcher = guardedFetch({
    endpoint: options.allowed ?? fake.url,
    provider: 'anthropic',
    rules: { pii: options.pii ?? [], exceptions: [] },
    record: (entry) => sent.push(entry),
  });
  return { fake, llm: adapterHost(fake).connect(fetcher, fake.url), sent };
}

function batchOf(result: RemoteBatch | { outcome: 'error' }): RemoteBatch {
  if ('outcome' in result) throw new Error(`expected a batch, got ${JSON.stringify(result)}`);
  return result;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the Anthropic adapter (ADR-0109)', () => {
  it('sends a request through the injected fetch, and reads the reply in the core', async () => {
    const { fake, llm, sent } = await connect();
    const result = await llm.send(body());
    expect(result).toMatchObject({ outcome: 'ok', text: '<s id="1">譯文</s>' });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 1024, system: 'prefix' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.model).toBe('claude-haiku-5-5');
  });

  it('names the SDK version it was built with', async () => {
    const { llm } = await connect();
    expect(llm.sdkVersion).toBe('0.137.0');
  });

  it('reads a refusal and a cut-off reply the same way as the fake adapter', async () => {
    const { llm } = await connect((_request, index) =>
      index === 0 ? { refusal: true, category: 'cyber' } : { text: '<s id="1">半', stop_reason: 'max_tokens' },
    );
    expect(await llm.send(body())).toMatchObject({ outcome: 'refused', category: 'cyber' });
    expect(await llm.send(body())).toMatchObject({ outcome: 'truncated' });
  });

  it('leaves retrying to TOME: one request for a 500, with the status (ADR-0099 item 23)', async () => {
    const { fake, llm } = await connect(() => ({ status: 500 }));
    expect(await llm.send(body())).toEqual({ outcome: 'error', status: 500, retryAfter: null });
    expect(fake.requests).toHaveLength(1);
  });

  it('passes on retry-after', async () => {
    const { llm } = await connect(() => ({ status: 429, retryAfter: 7 }));
    expect(await llm.send(body())).toEqual({ outcome: 'error', status: 429, retryAfter: 7 });
  });

  it('says nothing came back when the connection drops', async () => {
    const { llm } = await connect(() => ({ drop: true }));
    expect(await llm.send(body())).toEqual({ outcome: 'error', status: null, retryAfter: null });
  });

  it('says nothing came back when the body breaks off after the headers (ADR-0109 item 20)', async () => {
    const { fake, llm } = await connect(() => ({ cut: true }));
    expect(await llm.send(body())).toEqual({ outcome: 'error', status: null, retryAfter: null });
    expect(fake.requests).toHaveLength(1);
  });

  it('keeps the message ID of the body as the request ID for the ledger', async () => {
    const { llm } = await connect();
    const result = await llm.send(body());
    expect(result.outcome === 'error' ? null : result.requestId).toMatch(/^msg_\d+$/);
  });

  it('does not refuse a large max_tokens before sending, as the timeout is set (ADR-0109 item 4)', async () => {
    const { fake, llm } = await connect();
    expect(await llm.send({ ...body(), max_tokens: 64_000 })).toMatchObject({ outcome: 'ok' });
    expect(fake.requests).toHaveLength(1);
  });
});

describe('errors the SDK wraps (ADR-0109 item 1)', () => {
  it('throws the block of the gate, not a connection error, and sends nothing', async () => {
    const { fake, llm, sent } = await connect(GOOD, { pii: ['warden'] });
    const error = await llm.send(body()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EgressBlocked);
    expect(fake.requests).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('throws the refusal of the list for a host outside it', async () => {
    const { fake, llm } = await connect(GOOD, { allowed: PRODUCTION });
    const error = await llm.send(body()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TomeError);
    expect((error as TomeError).code).toBe('egress.denied');
    expect(fake.calls).toHaveLength(0);
  });

  it('throws the block for a whole batch too', async () => {
    const { fake, llm } = await connect(GOOD, { pii: ['warden'] });
    const error = await llm.submitBatch([{ customId: 'tome-0-1', body: body() }]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EgressBlocked);
    expect(fake.batches).toHaveLength(0);
  });
});

describe('the Batches API through the SDK (ADR-0109 item 8)', () => {
  it('creates, polls, collects, lists and deletes', async () => {
    const { fake, llm } = await connect((_request, index) => (index === 0 ? { text: '<s id="1">一</s>' } : { errored: 'api_error' }));
    fake.batch.reverse = true;
    const requests = [
      { customId: 'tome-0-1', body: body() },
      { customId: 'tome-0-2', body: body() },
    ];
    const created = batchOf(await llm.submitBatch(requests));
    expect(created).toMatchObject({ id: 'msgbatch_1', status: 'ended' });
    expect(batchOf(await llm.pollBatch(created.id)).counts).toMatchObject({ succeeded: 1, errored: 1 });
    const items = (await llm.collectBatch(created.id)) as readonly BatchItem[];
    expect(items.map(({ customId }) => customId)).toEqual(['tome-0-2', 'tome-0-1']);
    expect(items[0]?.result).toEqual({ outcome: 'errored', type: 'api_error' });
    expect(items[1]?.result).toMatchObject({ outcome: 'ok', text: '<s id="1">一</s>' });
    const page = await llm.listBatches(null);
    expect(isApiError(page) ? page : page.batches.map(({ id }) => id)).toEqual(['msgbatch_1']);
    expect(await llm.deleteRemote(created.id)).toBeNull();
    expect(fake.batches[0]?.deleted).toBe(true);
  });

  it('cancels a batch that is still running', async () => {
    const { fake, llm } = await connect();
    fake.batch.polls = 3;
    const created = batchOf(await llm.submitBatch([{ customId: 'tome-0-1', body: body() }]));
    expect(batchOf(await llm.cancelBatch(created.id)).status).toBe('canceling');
  });

  it('turns the pages with after_id until has_more is false', async () => {
    const { fake, llm } = await connect();
    fake.batch.pageSize = 1;
    fake.addForeignBatch({ requests: 1 });
    fake.addForeignBatch({ requests: 1 });
    const first = await llm.listBatches(null);
    if (isApiError(first)) throw new Error('list failed');
    expect(first).toMatchObject({ batches: [{ id: 'msgbatch_2' }], next: 'msgbatch_2' });
    const second = await llm.listBatches(first.next);
    expect(second).toMatchObject({ batches: [{ id: 'msgbatch_1' }], next: null });
  });

  it('keeps the status of a failed create, so that the core can tell 4xx from 5xx (ADR-0108)', async () => {
    const { fake, llm } = await connect();
    fake.batch.failAfterCreate = 503;
    expect(await llm.submitBatch([{ customId: 'tome-0-1', body: body() }])).toEqual({ outcome: 'error', status: 503, retryAfter: null });
  });

  it('says nothing came back when the results break off, and gets them all the next time (ADR-0109 item 20)', async () => {
    const { fake, llm } = await connect();
    fake.batch.cutResults = 1;
    const created = batchOf(await llm.submitBatch([{ customId: 'tome-0-1', body: body() }]));
    expect(await llm.collectBatch(created.id)).toEqual({ outcome: 'error', status: null, retryAfter: null });
    const items = (await llm.collectBatch(created.id)) as readonly BatchItem[];
    expect(items.map(({ customId }) => customId)).toEqual(['tome-0-1']);
  });

  it('throws what is not a broken connection, such as a results file that is not JSON', async () => {
    const { fake, llm } = await connect();
    const created = batchOf(await llm.submitBatch([{ customId: 'tome-0-1', body: body() }]));
    const found = fake.batches[0];
    if (found === undefined) throw new Error('no batch');
    found.lines = ['not json'];
    await expect(llm.collectBatch(created.id)).rejects.toBeInstanceOf(SyntaxError);
  });

  it('downloads from results_url, and refuses it on a host outside the list', async () => {
    const { fake, llm } = await connect();
    const created = batchOf(await llm.submitBatch([{ customId: 'tome-0-1', body: body() }]));
    fake.resultsBase = fake.url.replace('127.0.0.1', 'localhost');
    const error = await llm.collectBatch(created.id).catch((caught: unknown) => caught);
    expect((error as TomeError).code).toBe('egress.denied');
    expect(fake.calls.filter(({ path }) => path.endsWith('/results'))).toHaveLength(0);
  });
});

describe('the Models API (ADR-0109 item 9)', () => {
  it('reads what the provider says about a model, with the beta header for fallback', async () => {
    const { fake, llm } = await connect();
    fake.models.set('claude-opus-5-5', {
      id: 'claude-opus-5-5',
      allowed_fallback_models: ['claude-opus-5'],
      deprecated_at: null,
      capabilities: { batch: { supported: true }, thinking: { types: { disabled: { supported: false }, between_tools: { supported: false } } } },
    });
    expect(await llm.describeModel('claude-opus-5-5')).toEqual({
      id: 'claude-opus-5-5',
      batch: true,
      thinking: { disabled: false, between_tools: false },
      fallback: true,
      deprecatedAt: null,
    });
    expect(fake.calls.at(-1)?.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
  });

  it('gives the status for a model the account cannot use', async () => {
    const { llm } = await connect();
    expect(await llm.describeModel('claude-haiku-5-5')).toEqual({ outcome: 'error', status: 404, retryAfter: null });
  });
});

describe('the ANTHROPIC_ variables change neither key, endpoint, version nor betas (ADR-0099 item 24, ADR-0109 item 2)', () => {
  it('sends only the key of TOME, to the endpoint of TOME', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-from-env');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'token-from-env');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:9');
    const { fake, llm } = await connect();
    expect(await llm.send(body())).toMatchObject({ outcome: 'ok' });
    const headers = fake.calls[0]?.headers ?? {};
    expect(headers['x-api-key']).toBe(SYNTHETIC_KEY);
    expect(headers['authorization']).toBeUndefined();
  });

  it.each([
    ['x-api-key: sk-ant-from-env\nx-tome-extra: 1\nanthropic-version: 1999-01-01'],
    ['X-API-KEY: sk-ant-from-env\nX-Tome-Extra: 1\nAnthropic-Version: 1999-01-01'],
  ])('keeps the key and the version of TOME, and drops other headers, from %j', async (custom) => {
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', custom);
    const { fake, llm } = await connect();
    expect(await llm.send(body())).toMatchObject({ outcome: 'ok' });
    const headers = fake.calls[0]?.headers ?? {};
    expect(headers['x-api-key']).toBe(SYNTHETIC_KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['x-tome-extra']).toBeUndefined();
  });

  it.each([['anthropic-beta: some-beta'], ['Anthropic-Beta: some-beta']])(
    'turns on no beta that TOME did not choose, from %j',
    async (custom) => {
      vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', custom);
      const { fake, llm } = await connect();
      fake.models.set('claude-haiku-5-5', { id: 'claude-haiku-5-5' });
      await llm.send(body());
      await llm.submitBatch([{ customId: 'tome-0-1', body: body() }]);
      await llm.describeModel('claude-haiku-5-5');
      const betas = fake.calls.map(({ path, headers }) => [path, headers['anthropic-beta']]);
      expect(betas).toEqual([
        ['/v1/messages', undefined],
        ['/v1/messages/batches', undefined],
        ['/v1/models/claude-haiku-5-5', 'server-side-fallback-2026-07-01'],
      ]);
    },
  );

  it('prints nothing, book text least of all, with ANTHROPIC_LOG=debug', async () => {
    vi.stubEnv('ANTHROPIC_LOG', 'debug');
    const spies = (['debug', 'info', 'log', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
    const { llm } = await connect(() => ({ status: 500 }));
    await llm.send(body());
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('sends the platform headers of the SDK, and nothing of the book in them (ADR-0109 item 3)', async () => {
    const { fake, llm } = await connect();
    await llm.send(body());
    const headers = fake.calls[0]?.headers ?? {};
    expect(headers['x-stainless-lang']).toBe('js');
    expect(headers['user-agent']).toContain('Anthropic/JS 0.137.0');
    expect(JSON.stringify(headers)).not.toContain('warden');
  });
});
