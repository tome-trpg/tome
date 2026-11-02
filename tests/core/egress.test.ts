import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EgressBlocked, egressRecorder, guardedFetch, type EgressEntry } from '../../src/core/egress/client.ts';
import { scanBody, scanText, type PiiRules } from '../../src/core/egress/gate.ts';
import { openBookStore } from '../../src/core/store.ts';
import { startFakeProvider } from '../helpers/fake-provider.ts';
import { tempDir } from '../helpers.ts';

// 姓名與訂單號都是編的。

const NONE: PiiRules = { pii: [], exceptions: [] };

function rules(pii: readonly string[], exceptions: readonly string[] = []): PiiRules {
  return { pii, exceptions };
}

describe('scanText (DC-1)', () => {
  it('finds an entry and counts it', () => {
    expect(scanText('Licensed to Forged Buyer, and Forged Buyer again.', rules(['Forged Buyer']))).toEqual([
      { entry: 0, count: 2 },
    ]);
  });

  it('finds nothing in clean text', () => {
    expect(scanText('The warden counts stones.', rules(['Forged Buyer']))).toEqual([]);
  });

  it('ignores case', () => {
    expect(scanText('LICENSED TO FORGED BUYER', rules(['forged buyer']))).toHaveLength(1);
  });

  it('treats any run of spaces as one space, as a PDF breaks lines anywhere', () => {
    expect(scanText('Forged\n  Buyer', rules(['Forged Buyer']))).toHaveLength(1);
  });

  it('normalizes full-width forms', () => {
    expect(scanText('訂單 ＡＢ１２３', rules(['AB123']))).toHaveLength(1);
  });

  it('says which entry matched, by position, without repeating it', () => {
    expect(scanText('order AB123', rules(['Forged Buyer', 'AB123']))).toEqual([{ entry: 1, count: 1 }]);
  });

  it('skips an exception, such as an NPC with the same name', () => {
    const text = 'Agent Smith arrives. Bill to Smith.';
    expect(scanText(text, rules(['Smith'], ['Agent Smith']))).toEqual([{ entry: 0, count: 1 }]);
  });

  it('compares exceptions the same way', () => {
    expect(scanText('AGENT  SMITH', rules(['Smith'], ['agent smith']))).toEqual([]);
  });

  // 購買者跟 NPC 同名時，使用者會把名字加進例外，浮水印上的全名不能跟著過關（ADR-0104 第 6 項）。
  it('does not let a shorter exception hide a longer entry', () => {
    expect(scanText('Licensed to Forged Buyer.', rules(['Forged Buyer'], ['Forged']))).toEqual([
      { entry: 0, count: 1 },
    ]);
  });

  it('spares the entry the exception covers, and still finds the longer one', () => {
    expect(scanText('Licensed to Forged Buyer.', rules(['Forged', 'Forged Buyer'], ['Forged']))).toEqual([
      { entry: 1, count: 1 },
    ]);
  });

  it('counts what an exception leaves uncovered, next to what it covers', () => {
    const text = 'Forged Hall. Forged Buyer. Forged Hall. Forged Buyer.';
    expect(scanText(text, rules(['Forged Buyer', 'Forged Hall'], ['Forged Hall']))).toEqual([{ entry: 0, count: 2 }]);
    expect(scanText(text, rules(['Forged', 'Forged Buyer'], ['Forged Hall']))).toEqual([
      { entry: 0, count: 2 },
      { entry: 1, count: 2 },
    ]);
    expect(scanText(text, rules(['Forged', 'Forged Buyer'], ['Forged']))).toEqual([{ entry: 1, count: 2 }]);
  });

  it('wants the whole hit covered, not just a part of it', () => {
    expect(scanText('Old Forged Buyer', rules(['Forged Buyer'], ['Old Forged']))).toEqual([{ entry: 0, count: 1 }]);
    expect(scanText('Forged Buyer Hall', rules(['Forged Buyer'], ['Buyer Hall']))).toEqual([{ entry: 0, count: 1 }]);
  });

  it('spares an entry the same as the exception', () => {
    expect(scanText('Forged Buyer', rules(['Forged Buyer'], ['Forged Buyer']))).toEqual([]);
  });

  it('takes any of several exceptions', () => {
    const text = 'Agent Smith and Smith Hall.';
    expect(scanText(text, rules(['Smith'], ['Agent Smith', 'Smith Hall']))).toEqual([]);
  });

  it('finds a hit that overlaps a covered one', () => {
    expect(scanText('xababab', rules(['abab'], ['xabab']))).toEqual([{ entry: 0, count: 1 }]);
  });

  it('holds for a whole request, too', () => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'Licensed to Forged\nBuyer.' }] });
    expect(scanBody(body, rules(['Forged Buyer'], ['Forged']))).toEqual([{ entry: 0, count: 1 }]);
  });

  it('stays linear when entries and exceptions match everywhere', () => {
    const started = performance.now();
    expect(scanText('a'.repeat(300_000), rules(['aaa'], ['aaa']))).toEqual([]);
    expect(scanText('a'.repeat(300_000), rules(['aaaa'], ['aaa']))).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('ignores an empty entry, which would match everywhere', () => {
    expect(scanText('anything', rules(['', '   ']))).toEqual([]);
  });

  it('stays linear on a long run of spaces', () => {
    const started = performance.now();
    scanText(`Forged${' '.repeat(500_000)}Buyer`, rules(['Forged Buyer']));
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('scanBody (ADR-0099 item 25)', () => {
  const body = (content: string): string =>
    JSON.stringify({ model: 'm', system: 'prefix', messages: [{ role: 'user', content }] });

  it('reads every string of the serialized request, not only the units', () => {
    expect(scanBody(JSON.stringify({ system: 'Forged Buyer' }), rules(['Forged Buyer']))).toHaveLength(1);
    expect(scanBody(body('<context>Forged Buyer</context>'), rules(['Forged Buyer']))).toHaveLength(1);
  });

  it('sees through JSON escapes', () => {
    expect(scanBody(body('Forged\nBuyer'), rules(['Forged Buyer']))).toHaveLength(1);
    expect(scanBody(body('Forged "Buyer"'), rules(['Forged "Buyer"']))).toHaveLength(1);
  });

  it('sees through the escaping of the tag protocol', () => {
    expect(scanBody(body('<s id="1">Hart &amp; Sons</s>'), rules(['Hart & Sons']))).toHaveLength(1);
  });

  it('reads a body that is not JSON as plain text', () => {
    expect(scanBody('Forged Buyer', rules(['Forged Buyer']))).toHaveLength(1);
  });
});

describe('guardedFetch (ADR-0039)', () => {
  function recorder(): { entries: EgressEntry[]; record: (entry: EgressEntry) => void } {
    const entries: EgressEntry[] = [];
    return { entries, record: (entry) => entries.push(entry) };
  }

  const post = (body: string): RequestInit => ({ method: 'POST', body });

  it('lets a clean request through to its own endpoint', async () => {
    const server = await startFakeProvider(() => ({ text: 'ok' }));
    const { record } = recorder();
    const client = guardedFetch({ endpoint: server.url, provider: 'anthropic', rules: NONE, record });
    const response = await client(`${server.url}/v1/messages`, post('{"model":"m"}'));
    expect(response.status).toBe(200);
    expect(server.requests).toHaveLength(1);
  });

  it('fails on any other host, and sends nothing (ADR-0099 item 25)', async () => {
    const server = await startFakeProvider(() => ({ text: 'ok' }));
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const { record } = recorder();
    const client = guardedFetch({ endpoint: server.url, provider: 'anthropic', rules: NONE, record });
    await expect(client('https://example.com/v1/messages', post('{}'))).rejects.toMatchObject({
      code: 'egress.denied',
      params: { host: 'example.com' },
    });
    await expect(client('http://127.0.0.1:1/v1/messages', post('{}'))).rejects.toMatchObject({ code: 'egress.denied' });
    expect(spy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('is not fooled by a host that only starts the same', async () => {
    const { record } = recorder();
    const client = guardedFetch({
      endpoint: 'https://api.anthropic.com',
      provider: 'anthropic',
      rules: NONE,
      record,
    });
    await expect(client('https://api.anthropic.com.example.com/v1', post('{}'))).rejects.toMatchObject({
      code: 'egress.denied',
    });
    await expect(client('http://api.anthropic.com/v1', post('{}'))).rejects.toMatchObject({ code: 'egress.denied' });
  });

  it('blocks a request that holds personal data, and sends nothing', async () => {
    const server = await startFakeProvider(() => ({ text: 'ok' }));
    const { entries, record } = recorder();
    const client = guardedFetch({
      endpoint: server.url,
      provider: 'anthropic',
      rules: rules(['Forged Buyer']),
      record,
    });
    const blocked = client(`${server.url}/v1/messages`, post(JSON.stringify({ system: 'Forged Buyer' })));
    await expect(blocked).rejects.toBeInstanceOf(EgressBlocked);
    await expect(blocked).rejects.toMatchObject({ hits: [{ entry: 0, count: 1 }] });
    expect(server.requests).toHaveLength(0);
    expect(entries).toEqual([]);
  });

  it('names the models of a batch, and records a poll with no body (ADR-0107 item 20)', async () => {
    const server = await startFakeProvider(() => ({ text: 'ok' }));
    const { entries, record } = recorder();
    const client = guardedFetch({ endpoint: server.url, provider: 'anthropic', rules: NONE, record });
    const requests = ['a', 'b', 'a'].map((model, index) => ({ custom_id: `c${index}`, params: { model } }));
    await client(`${server.url}/v1/messages/batches`, post(JSON.stringify({ requests })));
    await client(`${server.url}/v1/messages/batches/msgbatch_1`, { method: 'GET' });
    expect(entries.map(({ model, bytes }) => ({ model, bytes: bytes > 0 }))).toEqual([
      { model: 'a,b', bytes: true },
      { model: '', bytes: false },
    ]);
  });

  it('scans the whole batch before it goes out', async () => {
    const server = await startFakeProvider(() => ({ text: 'ok' }));
    const { entries, record } = recorder();
    const client = guardedFetch({ endpoint: server.url, provider: 'anthropic', rules: rules(['Forged Buyer']), record });
    const requests = [{ custom_id: 'c1', params: { model: 'a' } }, { custom_id: 'c2', params: { system: 'Forged Buyer' } }];
    await expect(client(`${server.url}/v1/messages/batches`, post(JSON.stringify({ requests })))).rejects.toBeInstanceOf(
      EgressBlocked,
    );
    expect(server.batches).toHaveLength(0);
    expect(entries).toEqual([]);
  });

  it('refuses a body it cannot read, since it cannot scan it', async () => {
    const server = await startFakeProvider(() => ({ text: 'ok' }));
    const { record } = recorder();
    const client = guardedFetch({ endpoint: server.url, provider: 'anthropic', rules: NONE, record });
    await expect(client(`${server.url}/v1`, { method: 'POST', body: new Uint8Array([1]) })).rejects.toMatchObject({
      code: 'egress.denied',
    });
    expect(server.requests).toHaveLength(0);
  });

  it('refuses a Request object, whose body cannot be read in time', async () => {
    const server = await startFakeProvider(() => ({ text: 'ok' }));
    const { record } = recorder();
    const client = guardedFetch({ endpoint: server.url, provider: 'anthropic', rules: NONE, record });
    await expect(client(new Request(`${server.url}/v1`))).rejects.toMatchObject({ code: 'egress.denied' });
  });

  it('allows a request with no body, such as listing models', async () => {
    const server = await startFakeProvider(() => ({ text: 'ok' }));
    const { record } = recorder();
    const client = guardedFetch({ endpoint: server.url, provider: 'anthropic', rules: NONE, record });
    expect((await client(`${server.url}/v1/models`)).status).toBe(200);
  });

  it('does not follow a redirect to another host', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response('{}');
    });
    const { record } = recorder();
    const client = guardedFetch({ endpoint: 'https://api.anthropic.com', provider: 'anthropic', rules: NONE, record });
    await client('https://api.anthropic.com/v1/messages', post('{}'));
    expect(seen[0]?.redirect).toBe('error');
    vi.unstubAllGlobals();
  });

  it('keeps the headers the caller set, which hold the key', async () => {
    const server = await startFakeProvider(() => ({ text: 'ok' }));
    const { entries, record } = recorder();
    const client = guardedFetch({ endpoint: server.url, provider: 'anthropic', rules: NONE, record });
    await client(`${server.url}/v1/messages`, { ...post('{"model":"m"}'), headers: { 'x-api-key': 'not-a-real-key' } });
    expect(JSON.stringify(entries)).not.toContain('not-a-real-key');
  });

  it('records only the hash, the provider, the model, the size and the time (ADR-0039)', async () => {
    const server = await startFakeProvider(() => ({ text: 'ok' }));
    const { entries, record } = recorder();
    const client = guardedFetch({ endpoint: server.url, provider: 'anthropic', rules: NONE, record });
    const body = JSON.stringify({ model: 'claude-sonnet-5-5', system: 'a secret line of the book' });
    await client(`${server.url}/v1/messages`, post(body));
    expect(entries).toEqual([
      {
        content_hash: createHash('sha256').update(body).digest('hex'),
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        bytes: Buffer.byteLength(body),
      },
    ]);
  });

  it('records before it sends, so a request that dies on the way still shows', async () => {
    const server = await startFakeProvider(() => ({ drop: true }));
    const { entries, record } = recorder();
    const client = guardedFetch({ endpoint: server.url, provider: 'anthropic', rules: NONE, record });
    await expect(client(`${server.url}/v1/messages`, post('{"model":"m"}'))).rejects.toThrow();
    expect(entries).toHaveLength(1);
  });
});

describe('egressRecorder', () => {
  it('writes the entry to book.db with the time', () => {
    const store = openBookStore(join(tempDir(), 'home'), 'book');
    egressRecorder(store)({ content_hash: 'a'.repeat(64), provider: 'anthropic', model: 'm', bytes: 12 });
    const rows = store.all<Record<string, unknown>>('SELECT * FROM egress');
    store.close();
    expect(rows).toEqual([
      {
        id: 1,
        content_hash: 'a'.repeat(64),
        provider: 'anthropic',
        model: 'm',
        bytes: 12,
        created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string,
      },
    ]);
  });
});
