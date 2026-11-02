import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { openBookStore, openSeriesStore, type Store } from '../../src/core/store.ts';
import { parseUnits } from '../../src/core/tags.ts';
import {
  fakeHost,
  startFakeProvider,
  translated,
  type FakeHost,
  type FakeProvider,
  type FakeReply,
  type FakeRequest,
  type FakeScript,
} from '../helpers/fake-provider.ts';
import { library, MODEL, setWorkspace, type Library } from '../helpers/library.ts';

// 文字都是合成 PDF 的假文字，模型的回覆都是這裡寫的。請求只到本機的假供應商，
// 連到別的主機時對外出口會擋下來，這一輪沒有金鑰，也沒有連到本機以外的地方（ADR-0104）。

const FALLBACK = 'claude-opus-5-5';
const GOOD: FakeScript = ({ user }) => ({ text: translated(user) });

interface UnitRow {
  readonly unit_id: string;
  readonly state: string;
  readonly attempts: number;
  readonly translation: string | null;
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
    store.all<UnitRow>('SELECT unit_id, state, attempts, translation FROM unit ORDER BY seq'),
  );
}

function statesOf(home: string): string[] {
  return rows(home).map(({ state }) => state);
}

function setState(home: string, state: string, seq?: number): void {
  withStore(home, (store) => {
    if (seq === undefined) store.run('UPDATE unit SET state = ?', state);
    else store.run('UPDATE unit SET state = ? WHERE seq = ?', state, seq);
  });
}

function countRows(home: string, table: 'egress' | 'ledger' | 'response'): number {
  return withStore(home, (store) => store.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)?.count ?? 0);
}

function issues(home: string, code: string): { unit_id: string; level: string; detail: string | null }[] {
  return withStore(home, (store) =>
    store.all('SELECT unit_id, level, detail FROM issue WHERE code = ? ORDER BY unit_id', code),
  );
}

async function estimate(lib: Library, ...args: string[]): Promise<Envelope> {
  const { io, stdout } = lib.session();
  await run(['estimate', 'book', '--json', ...args], io);
  return JSON.parse(stdout()) as Envelope;
}

async function confirmed(options: { config?: string; budget?: string } = {}): Promise<Library> {
  const lib = await library(options.config === undefined ? {} : { config: options.config });
  await estimate(lib, '--realtime', '--budget', options.budget ?? '100', '--confirm');
  return lib;
}

interface Translated {
  readonly exit: number;
  readonly output: Envelope;
  readonly text: string;
  readonly progress: string;
}

async function translate(lib: Library, host: FakeHost, ...args: string[]): Promise<Translated> {
  const { io, stdout, stderr } = lib.session({ llm: host });
  const exit = await run(['translate', 'book', '--realtime', '--json', ...args], io);
  return { exit, output: JSON.parse(stdout()) as Envelope, text: stdout(), progress: stderr() };
}

async function fake(script: FakeScript): Promise<{ provider: FakeProvider; host: FakeHost }> {
  const provider = await startFakeProvider(script);
  return { provider, host: fakeHost(provider) };
}

function codes(output: Envelope): string[] {
  return output.findings.map((item) => item.code);
}

function found(output: Envelope, code: string): Envelope['findings'][number] | undefined {
  return output.findings.find((item) => item.code === code);
}

/** 請求送了幾個單位。 */
function unitsIn({ user }: FakeRequest): number {
  return parseUnits(user).units.length;
}

/** 第一個單位留空，驗證判定太短，其他單位翻好。 */
function failFirst(user: string): string {
  return translated(user).replace(/^<s id="1">[^\n]*/, '<s id="1">短</s>');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tome translate --realtime (ADR-0104)', () => {
  it('translates the whole book through the fake provider', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD);
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.model).toBe(MODEL);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
    expect(rows(lib.home).every(({ translation }) => translation?.startsWith('譯：'))).toBe(true);
    expect(rows(lib.home).every(({ attempts }) => attempts === 1)).toBe(true);
    expect(output.data).toMatchObject({ book: 'book', mode: 'realtime', requests: 1, done: 3, left: 0 });
    expect(found(output, 'translate.done')?.level).toBe('info');
  });

  it('records what went out, what came back and what it cost', async () => {
    const lib = await confirmed();
    const { host } = await fake(GOOD);
    await translate(lib, host);
    expect(countRows(lib.home, 'egress')).toBe(1);
    expect(countRows(lib.home, 'response')).toBe(3);
    expect(countRows(lib.home, 'ledger')).toBe(3);
    const { output } = await translate(lib, host);
    expect(output.data['spent_usd']).toBeGreaterThan(0);
  });

  it('keeps book text out of what it reports', async () => {
    const lib = await confirmed();
    const { host } = await fake(GOOD);
    const { text, progress } = await translate(lib, host);
    expect(text).not.toContain('warden');
    expect(progress).not.toContain('warden');
  });

  it('says how far it got on stderr, so that --json stays clean', async () => {
    const lib = await confirmed();
    const { host } = await fake(GOOD);
    const { progress } = await translate(lib, host);
    expect(progress).toContain('3');
  });

  it('sends nothing for a book that is done', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(GOOD);
    await translate(lib, host);
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(provider.requests).toHaveLength(1);
    expect(output.data).toMatchObject({ requests: 0, done: 3 });
  });

  it('stays quiet about the feature without a provider', async () => {
    const lib = await confirmed();
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const { io, stdout } = lib.session();
    expect(await run(['translate', 'book', '--realtime'], io)).toBe(1);
    expect(stdout()).toContain('翻譯功能尚未完成');
    expect(spy).not.toHaveBeenCalled();
  });

  it('leaves batch to brief 019', async () => {
    const lib = await confirmed();
    const { host } = await fake(GOOD);
    const { io, stdout } = lib.session({ llm: host });
    expect(await run(['translate', 'book'], io)).toBe(1);
    expect(stdout()).toContain('翻譯功能尚未完成');
  });

  it('refuses a host outside the list, and sends nothing (ADR-0099 item 25)', async () => {
    const lib = await confirmed();
    const provider = await startFakeProvider(GOOD);
    const { exit, output } = await translate(lib, fakeHost(provider, null));
    expect(exit).toBe(2);
    expect(output.ok).toBe(false);
    expect(provider.requests).toHaveLength(0);
    expect(countRows(lib.home, 'egress')).toBe(0);
  });

  it('sends the same static prefix every time', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake((request, index) =>
      index === 0 ? { text: failFirst(request.user) } : GOOD(request, index),
    );
    await translate(lib, host);
    const systems = new Set(provider.requests.map(({ body }) => body['system']));
    expect(provider.requests).toHaveLength(2);
    expect(systems.size).toBe(1);
  });
});

describe('the estimate comes first (ADR-0104 item 21)', () => {
  it('asks for a confirmation, and sends nothing', async () => {
    const lib = await library();
    const { provider, host } = await fake(GOOD);
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(found(output, 'translate.not_confirmed')?.level).toBe('fail');
    expect(provider.requests).toHaveLength(0);
  });

  it('names the flag when the estimate was made for the other mode', async () => {
    const lib = await library();
    await estimate(lib, '--budget', '100', '--confirm');
    const { provider, host } = await fake(GOOD);
    const { io, stdout } = lib.session({ llm: host });
    expect(await run(['translate', 'book', '--realtime'], io)).toBe(1);
    expect(stdout()).toContain('tome estimate book --realtime --confirm');
    expect(provider.requests).toHaveLength(0);
  });

  it('asks again when the budget changed after the confirmation', async () => {
    const lib = await confirmed();
    await estimate(lib, '--realtime', '--budget', '200');
    const { provider, host } = await fake(GOOD);
    const { output } = await translate(lib, host);
    expect(codes(output)).toContain('translate.not_confirmed');
    expect(provider.requests).toHaveLength(0);
  });
});

describe('the gate (ADR-0104 items 6 to 10)', () => {
  const PII = `translator_model: ${MODEL}\npii: [warden]\n`;

  it('sends nothing, blocks the units and names neither the entry nor the text', async () => {
    const lib = await confirmed({ config: PII });
    const { provider, host } = await fake(GOOD);
    const { exit, output, text } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(provider.requests).toHaveLength(0);
    expect(statesOf(lib.home)).toEqual(['BLOCKED', 'BLOCKED', 'BLOCKED']);
    expect(found(output, 'translate.blocked')?.level).toBe('fail');
    expect(text).not.toContain('warden');
    expect(countRows(lib.home, 'egress')).toBe(0);
  });

  it('keeps where it hit in the workspace, and not what', async () => {
    const lib = await confirmed({ config: PII });
    const { host } = await fake(GOOD);
    await translate(lib, host);
    const [issue] = issues(lib.home, 'pii_hit');
    expect(issue?.level).toBe('report');
    expect(JSON.parse(issue?.detail ?? '{}')).toEqual({ entries: '1' });
  });

  it('goes on with --retry-failed once the entry is an exception', async () => {
    const lib = await confirmed({ config: PII });
    const { provider, host } = await fake(GOOD);
    await translate(lib, host);
    const path = join(lib.home, 'books', 'book', 'book.yaml');
    writeFileSync(path, `${readFileSync(path, 'utf8')}pii_exceptions: [warden]\n`);
    expect((await translate(lib, host)).output.data).toMatchObject({ requests: 0, blocked: 3 });
    expect(provider.requests).toHaveLength(0);
    const { exit } = await translate(lib, host, '--retry-failed');
    expect(exit).toBe(0);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });

  it('blocks again when --retry-failed changes nothing', async () => {
    const lib = await confirmed({ config: PII });
    const { provider, host } = await fake(GOOD);
    await translate(lib, host);
    const { exit } = await translate(lib, host, '--retry-failed');
    expect(exit).toBe(1);
    expect(statesOf(lib.home)).toEqual(['BLOCKED', 'BLOCKED', 'BLOCKED']);
    expect(provider.requests).toHaveLength(0);
  });
});

describe('retries (ADR-0104 item 11)', () => {
  it.each<[string, FakeReply]>([
    ['429', { status: 429 }],
    ['503', { status: 503 }],
    ['a dropped connection', { drop: true }],
  ])('backs off after %s, and goes on', async (_name, failure) => {
    const lib = await confirmed();
    const { provider, host } = await fake((request, index) => (index < 2 ? failure : GOOD(request, index)));
    const { exit } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(provider.requests).toHaveLength(3);
    expect(host.waits).toEqual([1, 2]);
    expect(rows(lib.home).every(({ attempts }) => attempts === 1)).toBe(true);
  });

  it('takes retry-after', async () => {
    const lib = await confirmed();
    const { host } = await fake((request, index) =>
      index === 0 ? { status: 429, retryAfter: 7 } : GOOD(request, index),
    );
    await translate(lib, host);
    expect(host.waits).toEqual([7]);
  });

  it('stops after five retries, keeps the progress and goes on next time', async () => {
    const lib = await confirmed();
    let failing = true;
    const { provider, host } = await fake((request, index) => (failing ? { status: 500 } : GOOD(request, index)));
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(provider.requests).toHaveLength(6);
    expect(found(output, 'translate.provider_failed')).toMatchObject({ level: 'fail', params: { status: '500' } });
    expect(statesOf(lib.home)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);
    failing = false;
    expect((await translate(lib, host)).exit).toBe(0);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });

  it.each([400, 401, 403])('does not retry a %s', async (status) => {
    const lib = await confirmed();
    const { provider, host } = await fake(() => ({ status }));
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(provider.requests).toHaveLength(1);
    expect(found(output, 'translate.provider_failed')?.params).toEqual({ status: String(status) });
  });

  it('says when nothing answered at all', async () => {
    const lib = await confirmed();
    const { host } = await fake(() => ({ drop: true }));
    const { output } = await translate(lib, host);
    expect(found(output, 'translate.provider_failed')?.params).toEqual({ status: '-' });
  });
});

describe('refusals (ADR-0104 items 12 to 14)', () => {
  const refuseUnit = (id: string): FakeScript => (request, index) =>
    request.user.includes(id) ? { refusal: true, category: 'general_harms' } : GOOD(request, index);

  /** 只有第二個單位會被拒。 */
  async function refusedSecond(lib: Library): Promise<string> {
    const source = withStore(lib.home, (store) =>
      store.get<{ masked: string }>('SELECT masked FROM unit WHERE seq = 1'),
    );
    return source?.masked ?? '';
  }

  it('halves the request to find the unit, and finishes the others', async () => {
    const lib = await confirmed();
    const marker = await refusedSecond(lib);
    const { provider, host } = await fake(refuseUnit(`>${marker}</s>`));
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(provider.requests.map(unitsIn)).toEqual([3, 2, 1, 1, 1]);
    expect(statesOf(lib.home)).toEqual(['DONE', 'REFUSED', 'DONE']);
    expect(found(output, 'translate.done')?.level).toBe('fail');
    expect(output.data).toMatchObject({ done: 2, refused: 1 });
  });

  it('keeps the category, and pays for the refusal in the ledger', async () => {
    const lib = await confirmed();
    const marker = await refusedSecond(lib);
    const { host } = await fake(refuseUnit(`>${marker}</s>`));
    await translate(lib, host);
    const [issue] = issues(lib.home, 'refused');
    expect(JSON.parse(issue?.detail ?? '{}')).toEqual({ category: 'general_harms' });
    expect(issue?.level).toBe('report');
    const refused = withStore(lib.home, (store) =>
      store.all('SELECT DISTINCT request_id FROM ledger WHERE unit_id = ?', issue?.unit_id ?? ''),
    );
    expect(refused).toHaveLength(3);
  });

  it('does not count a refusal against the attempts', async () => {
    const lib = await confirmed();
    const marker = await refusedSecond(lib);
    const { host } = await fake(refuseUnit(`>${marker}</s>`));
    await translate(lib, host);
    expect(rows(lib.home)[1]?.attempts).toBe(0);
  });

  it('sends a refused unit to the fallback model, with the same prefix', async () => {
    const lib = await confirmed({ config: `translator_model: ${MODEL}\nfallback_model: ${FALLBACK}\npii: [x y z]\n` });
    const marker = await refusedSecond(lib);
    const { provider, host } = await fake((request, index) =>
      request.model === MODEL && request.user.includes(`>${marker}</s>`) ? { refusal: true } : GOOD(request, index),
    );
    const { exit } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
    const onFallback = provider.requests.filter(({ model }) => model === FALLBACK);
    expect(onFallback.map(unitsIn)).toEqual([1]);
    expect(new Set(provider.requests.map(({ body }) => body['system'])).size).toBe(1);
    const models = withStore(lib.home, (store) => store.all<{ model: string }>('SELECT DISTINCT model FROM response'));
    expect(models.map(({ model }) => model).sort()).toEqual([FALLBACK, MODEL].sort());
  });

  it('stays refused when the fallback refuses too', async () => {
    const lib = await confirmed({ config: `translator_model: ${MODEL}\nfallback_model: ${FALLBACK}\npii: [x y z]\n` });
    const marker = await refusedSecond(lib);
    const { host } = await fake(refuseUnit(`>${marker}</s>`));
    await translate(lib, host);
    expect(statesOf(lib.home)).toEqual(['DONE', 'REFUSED', 'DONE']);
  });

  it('gets a second chance with --retry-failed', async () => {
    const lib = await confirmed();
    const marker = await refusedSecond(lib);
    let refusing = true;
    const { host } = await fake((request, index) =>
      refusing && request.user.includes(`>${marker}</s>`) ? { refusal: true } : GOOD(request, index),
    );
    await translate(lib, host);
    refusing = false;
    await translate(lib, host, '--retry-failed');
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });
});

describe('a reply that was cut off (ADR-0104 item 15)', () => {
  it('halves the request instead of sending the same size again', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake((request, index) =>
      unitsIn(request) > 1 ? { text: '<s id="1">', stop_reason: 'max_tokens' } : GOOD(request, index),
    );
    const { exit } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(provider.requests.map(unitsIn)).toEqual([3, 2, 1, 1, 1]);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });

  it('counts an attempt, since the model did answer', async () => {
    const lib = await confirmed();
    const { host } = await fake((request, index) =>
      index === 0 ? { text: '<s id="1">', stop_reason: 'max_tokens' } : GOOD(request, index),
    );
    await translate(lib, host);
    expect(rows(lib.home)[2]?.attempts).toBe(2);
  });

  it('gives up on a single unit that cannot be split', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(() => ({ text: '', stop_reason: 'max_tokens' }));
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(provider.requests.map(unitsIn)).toEqual([3, 2, 1, 1, 1]);
    expect(statesOf(lib.home)).toEqual(['FAILED_QA', 'FAILED_QA', 'FAILED_QA']);
    expect(issues(lib.home, 'truncated')).toHaveLength(3);
    expect(output.data).toMatchObject({ failed: 3 });
  });

  it('keeps nothing from the part that came back', async () => {
    const lib = await confirmed();
    const { host } = await fake(({ user }) => ({ text: translated(user), stop_reason: 'max_tokens' }));
    await translate(lib, host);
    expect(countRows(lib.home, 'response')).toBe(0);
  });

  it('pays for the cut-off reply', async () => {
    const lib = await confirmed();
    const { host } = await fake(() => ({ text: '', stop_reason: 'max_tokens' }));
    await translate(lib, host);
    expect(countRows(lib.home, 'ledger')).toBeGreaterThan(0);
  });

  it('counts what it paid against the budget (ADR-0104 item 43)', async () => {
    const lib = await confirmed({ budget: '1' });
    const { provider, host } = await fake(() => ({
      text: '',
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10_000_000, output_tokens: 0 },
    }));
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(provider.requests).toHaveLength(1);
    expect(codes(output)).toContain('translate.budget_exceeded');
    expect(output.data['spent_usd']).toBeGreaterThan(1);
  });

  it('never leaves a unit in RECEIVED, which has no reply to read (ADR-0104 item 44)', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake((request, index) =>
      index === 0 ? { text: '', stop_reason: 'max_tokens' } : GOOD(request, index),
    );
    const killed: FakeHost = {
      ...host,
      connect: (fetcher) => {
        const adapter = host.connect(fetcher);
        let calls = 0;
        return {
          ...adapter,
          send: (body) => {
            calls += 1;
            return calls === 2 ? Promise.reject(new Error('killed')) : adapter.send(body);
          },
        };
      },
    };
    expect((await translate(lib, killed)).exit).toBe(2);
    expect(statesOf(lib.home)).not.toContain('RECEIVED');
    expect((await translate(lib, host)).exit).toBe(0);
    expect(provider.requests.map(unitsIn)).toEqual([3, 3]);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });
});

describe('a translation that fails the checks (ADR-0104 items 16 and 27)', () => {
  it('resends only the units that failed, and says why', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake((request, index) =>
      index === 0 ? { text: failFirst(request.user) } : GOOD(request, index),
    );
    const { exit } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(provider.requests.map(unitsIn)).toEqual([3, 1]);
    expect(provider.requests[1]?.user).toContain(
      '<feedback>\n<problem id="1">The translation is too short. Translate everything.</problem>\n</feedback>',
    );
    expect(rows(lib.home).map(({ attempts }) => attempts)).toEqual([2, 1, 1]);
  });

  it('gives up after three tries, and keeps the others', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(({ user }) => ({ text: failFirst(user) }));
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(provider.requests.map(unitsIn)).toEqual([3, 1, 1]);
    expect(statesOf(lib.home)).toEqual(['FAILED_QA', 'DONE', 'DONE']);
    expect(rows(lib.home)[0]?.attempts).toBe(3);
    expect(output.data).toMatchObject({ done: 2, failed: 1 });
  });

  it('asks again for a unit the reply left out', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake((request, index) =>
      index === 0
        ? { text: translated(request.user).split('\n').slice(1).join('\n') }
        : GOOD(request, index),
    );
    await translate(lib, host);
    expect(provider.requests[1]?.user).toContain('This unit was missing from your reply.');
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
    expect(rows(lib.home)[0]?.attempts).toBe(2);
  });

  it('gives up on a unit the model keeps leaving out', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake(({ user }) => ({
      text: translated(user).split('\n').slice(1).join('\n'),
    }));
    await translate(lib, host);
    expect(provider.requests.map(unitsIn)).toEqual([3, 1, 1]);
    expect(statesOf(lib.home)).toEqual(['FAILED_QA', 'DONE', 'DONE']);
  });

  it('does not take the text of the failed attempt along', async () => {
    const lib = await confirmed();
    const { provider, host } = await fake((request, index) =>
      index === 0 ? { text: failFirst(request.user).replace('短', '獨一無二的壞譯文') } : GOOD(request, index),
    );
    await translate(lib, host);
    expect(provider.requests[1]?.user).not.toContain('獨一無二的壞譯文');
  });

  it('remembers the reasons across an interruption', async () => {
    const lib = await confirmed();
    const first = await fake((request, index) => (index === 0 ? { text: failFirst(request.user) } : { status: 400 }));
    await translate(lib, first.host);
    const { provider, host } = await fake(GOOD);
    await translate(lib, host);
    expect(provider.requests.map(unitsIn)).toEqual([1]);
    expect(provider.requests[0]?.user).toContain('The translation is too short.');
  });
});

describe('the rest of a group (ADR-0104 item 29)', () => {
  function groupAll(home: string): void {
    const path = join(home, 'books', 'book', 'ir', 'document.json');
    const document = JSON.parse(readFileSync(path, 'utf8')) as { blocks: { group?: string }[] };
    for (const block of document.blocks) block.group = 'g1';
    writeFileSync(path, JSON.stringify(document));
  }

  it('goes along as context when part of a group is sent again', async () => {
    const lib = await library();
    groupAll(lib.home);
    await estimate(lib, '--realtime', '--budget', '100', '--confirm');
    const { provider, host } = await fake((request, index) =>
      index === 0 ? { text: failFirst(request.user) } : GOOD(request, index),
    );
    await translate(lib, host);
    const [first, second] = provider.requests;
    expect(unitsIn(second as FakeRequest)).toBe(1);
    const [, sibling] = parseUnits(first?.user ?? '').units;
    const body = sibling?.raw.slice(sibling.raw.indexOf('>') + 1, sibling.raw.lastIndexOf('</s>')) ?? '';
    expect(body).not.toBe('');
    const context = second?.user.split('</context>')[0] ?? '';
    expect(context).toContain(body.slice(0, 40));
  });
});

describe('the budget (ADR-0104 item 18)', () => {
  const COSTLY: FakeScript = ({ user }) => ({
    text: failFirst(user),
    usage: { input_tokens: 10_000_000, output_tokens: 0 },
  });

  it('stops before the request that would go over, and keeps the progress', async () => {
    const lib = await confirmed({ budget: '1' });
    const { provider, host } = await fake(COSTLY);
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(provider.requests).toHaveLength(1);
    expect(found(output, 'translate.budget_exceeded')?.level).toBe('fail');
    expect(statesOf(lib.home)).toEqual(['QUEUED', 'DONE', 'DONE']);
    expect(output.data).toMatchObject({ done: 2, left: 1 });
  });

  it('goes on after a higher budget, without paying for what is done', async () => {
    const lib = await confirmed({ budget: '1' });
    const costly = await fake(COSTLY);
    await translate(lib, costly.host);
    await estimate(lib, '--realtime', '--budget', '100', '--confirm');
    const { provider, host } = await fake(GOOD);
    expect((await translate(lib, host)).exit).toBe(0);
    expect(provider.requests.map(unitsIn)).toEqual([1]);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });

  it('checks the budget for a refused request sent again', async () => {
    const lib = await confirmed({ budget: '1' });
    const { provider, host } = await fake(() => ({
      refusal: true,
      usage: { input_tokens: 10_000_000, output_tokens: 0 },
    }));
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(provider.requests).toHaveLength(1);
    expect(codes(output)).toContain('translate.budget_exceeded');
    expect(statesOf(lib.home)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);
  });
});

describe('an interrupted run (ADR-0104 item 28)', () => {
  it('sends a unit that was in flight again', async () => {
    const lib = await confirmed();
    setState(lib.home, 'IN_FLIGHT');
    const { provider, host } = await fake(GOOD);
    expect((await translate(lib, host)).exit).toBe(0);
    expect(provider.requests.map(unitsIn)).toEqual([3]);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });

  it('checks a reply that was saved, and sends nothing', async () => {
    const lib = await confirmed();
    const first = await fake(GOOD);
    await translate(lib, first.host);
    setState(lib.home, 'RECEIVED');
    withStore(lib.home, (store) => store.run('UPDATE unit SET translation = NULL'));
    const { provider, host } = await fake(GOOD);
    expect((await translate(lib, host)).exit).toBe(0);
    expect(provider.requests).toHaveLength(0);
    expect(rows(lib.home).every(({ translation }) => translation?.startsWith('譯：'))).toBe(true);
    expect(rows(lib.home).every(({ attempts }) => attempts === 1)).toBe(true);
  });

  it('sends a unit again when no reply was saved for it, instead of getting stuck', async () => {
    const lib = await confirmed();
    setState(lib.home, 'RECEIVED');
    const { provider, host } = await fake(GOOD);
    expect((await translate(lib, host)).exit).toBe(0);
    expect(provider.requests.map(unitsIn)).toEqual([3]);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });

  it('queues a saved reply that fails, without using up an attempt', async () => {
    const lib = await confirmed();
    const first = await fake(({ user }) => ({ text: failFirst(user) }));
    await translate(lib, first.host);
    withStore(lib.home, (store) => store.run("UPDATE unit SET state = 'RECEIVED', attempts = 1 WHERE seq = 0"));
    const { provider, host } = await fake(GOOD);
    await translate(lib, host);
    expect(rows(lib.home)[0]?.attempts).toBe(2);
    expect(provider.requests.map(unitsIn)).toEqual([1]);
  });

  it('does not pay again for a unit that passed', async () => {
    const lib = await confirmed();
    setState(lib.home, 'DONE', 0);
    const { provider, host } = await fake(GOOD);
    await translate(lib, host);
    expect(provider.requests.map(unitsIn)).toEqual([2]);
  });

  it('checks a stored STALE unit again, and sends nothing (ADR-0104)', async () => {
    const lib = await confirmed();
    const first = await fake(GOOD);
    await translate(lib, first.host);
    setState(lib.home, 'STALE');
    const { provider, host } = await fake(GOOD);
    expect((await translate(lib, host)).exit).toBe(0);
    expect(provider.requests).toHaveLength(0);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });
});

describe('translation memory (ADR-0104 item 18)', () => {
  it('keeps what passed, and sends nothing for it next time', async () => {
    const lib = await confirmed();
    const first = await fake(GOOD);
    await translate(lib, first.host);
    withStore(lib.home, (store) => store.run("UPDATE unit SET state = 'PENDING', translation = NULL, attempts = 0"));
    const { provider, host } = await fake(GOOD);
    const { exit } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(provider.requests).toHaveLength(0);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
    expect(rows(lib.home).every(({ translation }) => translation?.startsWith('譯：'))).toBe(true);
  });

  it('notes what it was made with', async () => {
    const lib = await confirmed();
    const { host } = await fake(GOOD);
    await translate(lib, host);
    const series = openSeriesStore(lib.home, 'book');
    const [entry] = series.all<Record<string, string>>('SELECT * FROM memory');
    series.close();
    expect(entry).toMatchObject({ model: MODEL, sdk_version: '0.0.0-fake', book: 'book' });
    expect(entry?.['prompt_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(entry?.['pack_hash']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps no failed translation', async () => {
    const lib = await confirmed();
    const { host } = await fake(({ user }) => ({ text: failFirst(user) }));
    await translate(lib, host);
    const series = openSeriesStore(lib.home, 'book');
    const entries = series.all('SELECT key FROM memory');
    series.close();
    expect(entries).toHaveLength(2);
  });

  it('leaves a response for tome verify to read', async () => {
    const lib = await confirmed();
    const first = await fake(GOOD);
    await translate(lib, first.host);
    withStore(lib.home, (store) => store.run("UPDATE unit SET state = 'PENDING', translation = NULL, attempts = 0"));
    const { host } = await fake(GOOD);
    await translate(lib, host);
    const attempts = withStore(lib.home, (store) =>
      store.all<{ attempt: number }>('SELECT attempt FROM response WHERE id > 3'),
    );
    expect(attempts.map(({ attempt }) => attempt)).toEqual([0, 0, 0]);
    expect(await run(['verify', 'book'], lib.session().io)).toBe(0);
  });

  it('reuses a paragraph from earlier in the same run', async () => {
    const lib = await library();
    const path = join(lib.home, 'books', 'book', 'ir', 'document.json');
    const document = JSON.parse(readFileSync(path, 'utf8')) as {
      blocks: { id: string; text: string }[];
      sections: unknown[];
    };
    const [first, second] = document.blocks;
    if (first === undefined || second === undefined) throw new Error('the book is too short');
    second.text = first.text;
    document.sections = [
      { title: 'One', block_id: first.id, children: [] },
      { title: 'Two', block_id: second.id, children: [] },
    ];
    writeFileSync(path, JSON.stringify(document));
    await estimate(lib, '--realtime', '--budget', '100', '--confirm');
    const { provider, host } = await fake(GOOD);
    await translate(lib, host);
    expect(provider.requests.map(unitsIn)).toEqual([1, 1]);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });
});

describe('--retry-failed (ADR-0104 item 26)', () => {
  it('gives a unit that gave up three more tries', async () => {
    const lib = await confirmed();
    const { host: failing } = await fake(({ user }) => ({ text: failFirst(user) }));
    await translate(lib, failing);
    expect(rows(lib.home)[0]?.state).toBe('FAILED_QA');
    const { provider, host } = await fake(({ user }) => ({ text: failFirst(user) }));
    await translate(lib, host, '--retry-failed');
    expect(provider.requests.map(unitsIn)).toEqual([1, 1, 1]);
    expect(provider.requests[0]?.user).toContain('<feedback>');
    expect(rows(lib.home)[0]).toMatchObject({ state: 'FAILED_QA', attempts: 3 });
  });

  it('touches only the chosen chapters', async () => {
    const lib = await library();
    const path = join(lib.home, 'books', 'book', 'ir', 'document.json');
    const document = JSON.parse(readFileSync(path, 'utf8')) as { blocks: { id: string }[]; sections: unknown[] };
    document.sections = [
      { title: 'One', block_id: document.blocks[0]?.id, children: [] },
      { title: 'Two', block_id: document.blocks[2]?.id, children: [] },
    ];
    writeFileSync(path, JSON.stringify(document));
    await estimate(lib, '--realtime', '--budget', '100', '--confirm');
    const { host: failing } = await fake(() => ({ refusal: true }));
    await translate(lib, failing);
    expect(statesOf(lib.home)).toEqual(['REFUSED', 'REFUSED', 'REFUSED']);
    await estimate(lib, '--realtime', '--chapters', '1', '--confirm');
    const { provider, host } = await fake(GOOD);
    await translate(lib, host, '--retry-failed');
    expect(provider.requests.map(unitsIn)).toEqual([2]);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'REFUSED']);
  });

  it('leaves them alone without the flag', async () => {
    const lib = await confirmed();
    const { host: failing } = await fake(({ user }) => ({ text: failFirst(user) }));
    await translate(lib, failing);
    const { provider, host } = await fake(GOOD);
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(1);
    expect(provider.requests).toHaveLength(0);
    expect(found(output, 'translate.done')?.level).toBe('fail');
  });

  it('still needs the confirmation', async () => {
    const lib = await library();
    const { provider, host } = await fake(GOOD);
    const { exit, output } = await translate(lib, host, '--retry-failed');
    expect(exit).toBe(1);
    expect(codes(output)).toContain('translate.not_confirmed');
    expect(provider.requests).toHaveLength(0);
  });

  it('needs --realtime for now', async () => {
    const lib = await confirmed();
    const { host } = await fake(GOOD);
    const { io, stdout } = lib.session({ llm: host });
    expect(await run(['translate', 'book', '--retry-failed'], io)).toBe(1);
    expect(stdout()).toContain('翻譯功能尚未完成');
  });

  it('does not go with --dry-run, whose numbers would leave those units out', async () => {
    const lib = await confirmed();
    expect(await run(['translate', 'book', '--dry-run', '--retry-failed'], lib.session().io)).toBe(2);
  });
});

describe('--chapters', () => {
  it('sends only the chosen chapters, and finishes there', async () => {
    const lib = await library();
    const path = join(lib.home, 'books', 'book', 'ir', 'document.json');
    const document = JSON.parse(readFileSync(path, 'utf8')) as { blocks: { id: string }[]; sections: unknown[] };
    document.sections = [
      { title: 'One', block_id: document.blocks[0]?.id, children: [] },
      { title: 'Two', block_id: document.blocks[2]?.id, children: [] },
    ];
    writeFileSync(path, JSON.stringify(document));
    await estimate(lib, '--realtime', '--budget', '100', '--chapters', '1', '--confirm');
    const { provider, host } = await fake(GOOD);
    const { exit, output } = await translate(lib, host);
    expect(exit).toBe(0);
    expect(provider.requests.map(unitsIn)).toEqual([2]);
    expect(statesOf(lib.home)).toEqual(['DONE', 'DONE', 'PENDING']);
    expect(output.data).toMatchObject({ done: 2, left: 1 });
  });
});

describe('fallback_model in the confirmation (ADR-0104)', () => {
  it('asks again when it changes', async () => {
    const lib = await confirmed();
    setWorkspace(lib.home, `translator_model: ${MODEL}\nfallback_model: ${FALLBACK}\npii: [Forged Buyer]\n`);
    expect((await estimate(lib, '--realtime')).data['confirmed']).toBe(false);
  });

  it('refuses a model that is not on the list before anything goes out', async () => {
    const lib = await library({ config: `translator_model: ${MODEL}\nfallback_model: claude-nonexistent\n` });
    const { io, stderr } = lib.session();
    expect(await run(['estimate', 'book'], io)).toBe(2);
    expect(stderr()).toContain('claude-nonexistent');
  });
});
