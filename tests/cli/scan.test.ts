import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { openBookStore, type Store } from '../../src/core/store.ts';
import {
  FAKE_BRIEF,
  fakeHost,
  scanned,
  startFakeProvider,
  translated,
  type FakeBatchOptions,
  type FakeHost,
  type FakeProvider,
  type FakeScript,
} from '../helpers/fake-provider.ts';
import { library, MODEL, setWorkspace, type Library } from '../helpers/library.ts';

// 文字都是這裡編的（ADR-0118）。

const SCANNER = 'claude-sonnet-5-5';
const CONFIG = `scanner_model: ${SCANNER}\ntranslator_model: ${MODEL}\npii: [Forged Buyer]\n`;
const GOOD: FakeScript = ({ user }) => ({ text: scanned(user) });

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

/** 三個候選詞：Salt Marsh（出現 3 次）、Salt Marsh Wardens（標題）、Grey Warden（出現 2 次）。 */
const BLOCKS = [
  block('p0000-aaaaa1', 'Salt Marsh Wardens', 'heading'),
  block('p0000-aaaaa2', 'The Grey Warden keeps the Salt Marsh. She counts the tide stones each night.'),
  block('p0000-aaaaa3', 'Travellers meet the Grey Warden at the ferry of Old Harrow, near the Salt Marsh.'),
  block('p0000-aaaaa4', 'Salt Marsh Wardens 3', 'toc'),
];

function setDocument(home: string, blocks: readonly Record<string, unknown>[]): void {
  const path = join(home, 'books', 'book', 'ir', 'document.json');
  const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...document, sections: [], blocks }));
}

async function book(blocks: readonly Record<string, unknown>[] = BLOCKS, config = CONFIG): Promise<Library> {
  const lib = await library({ config });
  setDocument(lib.home, blocks);
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

function scan(lib: Library, host: FakeHost | undefined, ...args: string[]): Promise<Ran> {
  return tome(lib, host, 'scan-terms', 'book', ...args);
}

async function fake(script: FakeScript, options: Partial<FakeBatchOptions> = {}): Promise<{ provider: FakeProvider; host: FakeHost }> {
  const provider = await startFakeProvider(script, options);
  return { provider, host: fakeHost(provider) };
}

function codes(output: Envelope): string[] {
  return output.findings.map((item) => item.code);
}

function withStore<T>(home: string, action: (store: Store) => T): T {
  const store = openBookStore(home, 'book');
  try {
    return action(store);
  } finally {
    store.close();
  }
}

interface EntityRow {
  readonly source: string;
  readonly target: string | null;
  readonly class: string | null;
  readonly status: string;
  readonly attempts: number;
  readonly occurrences: number;
}

function entities(home: string): EntityRow[] {
  return withStore(home, (store) => store.all<EntityRow>('SELECT source, target, class, status, attempts, occurrences FROM entity ORDER BY id'));
}

/** 估價（記下指紋）之後確認。 */
async function confirmed(lib: Library, host: FakeHost, ...mode: string[]): Promise<Ran> {
  await scan(lib, undefined, '--budget', '5', ...mode);
  return scan(lib, host, '--confirm', ...mode);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tome scan-terms without --confirm (ADR-0118)', () => {
  it('estimates on this machine, sends nothing and keeps the candidates', async () => {
    const lib = await book();
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const { exit, output, text } = await scan(lib, undefined);
    expect(exit).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(codes(output)).toEqual(['scan.estimate', 'scan.not_confirmed']);
    expect(output.data).toMatchObject({ candidates: 3, terms: 3, summary: true, requests: 2, confirmed: false });
    expect(entities(lib.home).map(({ source, status, occurrences }) => [source, status, occurrences])).toEqual([
      ['Salt Marsh', 'candidate', 3],
      ['Salt Marsh Wardens', 'candidate', 1],
      ['Grey Warden', 'candidate', 2],
    ]);
    // 候選詞與上下文都是書本文字，訊息裡只有數字（ADR-0059）。
    for (const word of ['Salt Marsh', 'Grey Warden', 'tide stones']) expect(text).not.toContain(word);
  });

  it('asks for scanner_model, as TOME has no default model', async () => {
    const lib = await book(BLOCKS, `translator_model: ${MODEL}\n`);
    const { exit, output } = await scan(lib, undefined);
    expect(exit).toBe(2);
    expect(codes(output)).toEqual(['scanner_model.missing']);
  });

  it('leaves out the terms the pack already translates', async () => {
    const lib = await book();
    const dir = join(lib.home, 'systems', 'child');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pack.yaml'), 'schema: tome-pack/1\nid: child\nversion: 0.1.0\nlicense: UNLICENSED\nsource_langs: [en]\n');
    writeFileSync(join(dir, 'glossary.yaml'), 'terms:\n  - source: { en: Grey Warden }\n    target: 灰色守望者\n');
    const path = join(lib.home, 'books', 'book', 'book.yaml');
    writeFileSync(path, `${readFileSync(path, 'utf8')}system: child\n`);
    await scan(lib, undefined);
    expect(entities(lib.home).map(({ source }) => source)).toEqual(['Salt Marsh', 'Salt Marsh Wardens']);
  });
});

describe('tome scan-terms --confirm (ADR-0118)', () => {
  it('shows the estimate first when nothing was estimated, and sends nothing', async () => {
    const lib = await book();
    const { provider, host } = await fake(GOOD);
    const { exit, output } = await scan(lib, host, '--budget', '5', '--confirm');
    expect(exit).toBe(1);
    expect(codes(output)).toContain('scan.changed');
    expect(provider.requests).toHaveLength(0);
    const again = await scan(lib, host, '--confirm');
    expect(again.exit).toBe(0);
    expect(provider.requests.length).toBeGreaterThan(0);
  });

  it('asks for a budget', async () => {
    const lib = await book();
    const { host } = await fake(GOOD);
    await scan(lib, undefined);
    const { exit, output } = await scan(lib, host, '--confirm');
    expect(exit).toBe(1);
    expect(codes(output)).toContain('scan.no_budget');
  });

  it('proposes a card for every candidate and writes the brief, in real time', async () => {
    const lib = await book();
    const { provider, host } = await fake(GOOD);
    const { exit, output, progress } = await confirmed(lib, host, '--realtime');
    expect(exit).toBe(0);
    expect(codes(output)).toEqual(['scan.done']);
    expect(output.data).toMatchObject({ candidates: 3, proposed: 3, skipped: 0, failed: 0, left: 0, summary: true });
    expect(entities(lib.home).map(({ source, target, class: kind, status }) => [source, target, kind, status])).toEqual([
      ['Salt Marsh', '譯：Salt Marsh', 'place', 'proposed'],
      ['Salt Marsh Wardens', '譯：Salt Marsh Wardens', 'place', 'proposed'],
      ['Grey Warden', '譯：Grey Warden', 'place', 'proposed'],
    ]);
    expect(withStore(lib.home, (store) => store.get('SELECT era, tone, factions FROM summary'))).toEqual({
      era: 'Synthetic era.',
      tone: 'Plain.',
      factions: 'None.',
    });
    expect(progress).toContain('即時模式');
    const [terms, summary] = provider.requests;
    expect(terms?.model).toBe(SCANNER);
    expect(terms?.user).toContain('<classes>');
    expect(terms?.user).toContain('<term id="1" count="3">Salt Marsh</term>');
    // 第一次出現的句子，加上第一個帶代名詞的句子；同一個請求裡重複的句子只送一次。
    expect(terms?.user).toContain('<q id="1">Salt Marsh Wardens</q>\n<q id="1">She counts the tide stones each night.</q>');
    expect(terms?.user).toContain('<q id="3">The Grey Warden keeps the Salt Marsh.</q>');
    expect(terms?.user.match(/She counts/g)).toHaveLength(1);
    expect(summary?.user).toContain('<toc>');
    expect(summary?.user).toContain('<opening>');
  });

  it('pays for Pass 0 from the same budget and records every request', async () => {
    const lib = await book();
    const { host } = await fake(GOOD);
    await confirmed(lib, host, '--realtime');
    const ledger = withStore(lib.home, (store) => store.all<{ unit_id: string; mode: string }>('SELECT unit_id, mode FROM ledger'));
    expect(ledger.map(({ unit_id }) => unit_id).sort()).toEqual(['summary', 'term:1', 'term:2', 'term:3']);
    expect(withStore(lib.home, (store) => store.get<{ count: number }>('SELECT COUNT(*) AS count FROM egress'))?.count).toBe(2);
    const { output } = await tome(lib, undefined, 'estimate', 'book');
    expect(Number(output.data['spent_usd'])).toBeGreaterThan(0);
  });

  it('sends nothing the second time, and reports there is nothing to do', async () => {
    const lib = await book();
    const { provider, host } = await fake(GOOD);
    await confirmed(lib, host, '--realtime');
    const sent = provider.requests.length;
    const { output } = await scan(lib, host, '--realtime', '--confirm');
    expect(codes(output)).toEqual(['scan.nothing', 'estimate.budget']);
    expect(provider.requests).toHaveLength(sent);
  });

  it('marks a candidate the model skips, and sends again one it left out, giving up after three tries', async () => {
    const lib = await book();
    const script: FakeScript = ({ user }) => {
      if (!user.includes('<term ')) return { text: FAKE_BRIEF };
      return { text: '<skip id="2"/><card id="3" class="place" pronoun="伊">灰色守望者</card>' };
    };
    const { provider, host } = await fake(script);
    const { exit, output } = await confirmed(lib, host, '--realtime');
    expect(exit).toBe(0);
    expect(output.findings.find(({ code }) => code === 'scan.done')?.level).toBe('warn');
    expect(entities(lib.home).map(({ status, attempts }) => [status, attempts])).toEqual([
      ['failed', 3],
      ['skipped', 1],
      ['proposed', 1],
    ]);
    // 第一個請求三個詞，之後只重送沒回的那一個，一共三次。
    expect(provider.requests.filter(({ user }) => user.includes('<term ')).map(({ user }) => user.match(/<term /g)?.length)).toEqual([3, 1, 1]);
    const issues = withStore(lib.home, (store) => store.all('SELECT unit_id, code, detail FROM issue ORDER BY id'));
    expect(issues).toEqual([
      { unit_id: 'term:3', code: 'card_attribute', detail: '{"attribute":"pronoun"}' },
      { unit_id: 'term:1', code: 'card_missing', detail: null },
    ]);
  });

  it('splits a refused request and gives up on a candidate refused on its own', async () => {
    const lib = await book();
    const script: FakeScript = ({ user }) => {
      if (!user.includes('<term ')) return { text: FAKE_BRIEF };
      return user.includes('Grey Warden') ? { refusal: true } : { text: scanned(user) };
    };
    const { host } = await fake(script);
    await confirmed(lib, host, '--realtime');
    expect(entities(lib.home).map(({ source, status }) => [source, status])).toEqual([
      ['Salt Marsh', 'proposed'],
      ['Salt Marsh Wardens', 'proposed'],
      ['Grey Warden', 'failed'],
    ]);
  });

  it('stops at the personal data gate and sends nothing', async () => {
    const [heading, ...rest] = BLOCKS;
    const lib = await book([heading ?? {}, block('p0000-aaaaa6', 'The Grey Warden met Forged Buyer today.'), ...rest]);
    const { provider, host } = await fake(GOOD);
    const { exit, output } = await confirmed(lib, host, '--realtime');
    expect(exit).toBe(1);
    expect(codes(output)).toContain('scan.blocked');
    expect(provider.requests).toHaveLength(0);
    expect(entities(lib.home).every(({ status }) => status === 'candidate')).toBe(true);
  });

  it('checks every request of a batch at the gate before sending any', async () => {
    const lib = await book([...BLOCKS, block('p0000-aaaaa7', 'Licensed to Forged Buyer.')]);
    const { provider, host } = await fake(GOOD);
    const { exit, output } = await confirmed(lib, host);
    expect(exit).toBe(1);
    expect(codes(output)).toContain('scan.blocked');
    expect(provider.batches).toHaveLength(0);
  });

  it('stops over the budget and keeps what is left for next time', async () => {
    const lib = await book();
    const { provider, host } = await fake(GOOD);
    await scan(lib, undefined, '--budget', '0.000001', '--realtime');
    const { exit, output } = await scan(lib, host, '--realtime', '--confirm');
    expect(exit).toBe(1);
    expect(codes(output)).toContain('scan.over_budget');
    expect(provider.requests).toHaveLength(0);
    expect(entities(lib.home).every(({ status }) => status === 'candidate')).toBe(true);
  });
});

describe('tome scan-terms in batches (ADR-0118)', () => {
  it('sends one batch, waits for it, and writes the cards and the brief', async () => {
    const lib = await book();
    const { provider, host } = await fake(GOOD, { polls: 1 });
    const { exit, output, progress } = await confirmed(lib, host);
    expect(exit).toBe(0);
    expect(output.data).toMatchObject({ mode: 'batch', batches: 1, proposed: 3, summary: true });
    expect(provider.batches).toHaveLength(1);
    expect(provider.batches[0]?.deleted).toBe(true);
    expect(progress).toContain('批次模式');
    const rows = withStore(lib.home, (store) => store.all<{ stage: string; state: string }>('SELECT stage, state FROM batch'));
    expect(rows).toEqual([{ stage: 'scan', state: 'collected' }]);
  });

  it('is collected by tome batch collect after a run that broke off, and translation batches are left alone', async () => {
    const lib = await book();
    const { provider, host } = await fake(GOOD, { polls: 5, pollStatus: 500 });
    const broken = await confirmed(lib, host);
    expect(broken.exit).toBe(1);
    expect(entities(lib.home).every(({ status }) => status === 'candidate')).toBe(true);
    provider.batch.pollStatus = null;
    provider.batch.polls = 0;
    const { exit, output } = await tome(lib, host, 'batch', 'collect', 'book');
    expect(exit).toBe(0);
    expect(codes(output)).toContain('scan.done');
    expect(entities(lib.home).every(({ status }) => status === 'proposed')).toBe(true);
  });

  it('leaves a Pass 0 batch to Pass 0 when translating in batches, so its results are not lost', async () => {
    const lib = await book();
    // 一個假供應商同時回 Pass 0 與翻譯，批次 ID 才不會重複，跟真的 API 一樣。
    const both: FakeScript = ({ user }) => ({ text: user.includes('<s id=') ? translated(user) : scanned(user) });
    const { provider, host } = await fake(both, { polls: 5, pollStatus: 500 });
    await confirmed(lib, host);
    provider.batch.pollStatus = null;
    provider.batch.polls = 0;
    await tome(lib, undefined, 'estimate', 'book', '--budget', '5', '--confirm');
    const { exit, output } = await tome(lib, host, 'translate', 'book');
    expect([exit, codes(output)]).toEqual([0, ['translate.done']]);
    const batches = withStore(lib.home, (store) => store.all<{ stage: string; state: string }>('SELECT stage, state FROM batch ORDER BY id'));
    expect(batches).toEqual([
      { stage: 'scan', state: 'submitted' },
      { stage: 'translate', state: 'collected' },
    ]);
    const collected = await tome(lib, host, 'batch', 'collect', 'book');
    expect(codes(collected.output)).toContain('scan.done');
    expect(entities(lib.home).every(({ status }) => status === 'proposed')).toBe(true);
  });

  it('still collects translation batches as before when there is no Pass 0 batch', async () => {
    const lib = await book();
    setWorkspace(lib.home, CONFIG);
    const { host } = await fake(({ user }) => ({ text: translated(user) }));
    const { output } = await tome(lib, host, 'batch', 'collect', 'book');
    expect(codes(output)).toContain('batch.none');
  });

  it('stops --realtime while a Pass 0 batch is out', async () => {
    const lib = await book();
    const { provider, host } = await fake(GOOD, { polls: 5, pollStatus: 500 });
    await confirmed(lib, host);
    provider.batch.pollStatus = null;
    const { exit, output } = await scan(lib, host, '--realtime', '--confirm');
    expect(exit).toBe(1);
    expect(codes(output)).toEqual(['batch.pending']);
  });
});
