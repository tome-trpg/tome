import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { openBookStore, openSeriesStore, type Store } from '../../src/core/store.ts';
import { fakeHost, startFakeProvider, translated, type FakeProvider } from '../helpers/fake-provider.ts';
import { library, type Library } from '../helpers/library.ts';
import { tempDir } from '../helpers.ts';

// 鎖定的實體卡進翻譯與 S-16（ADR-0120）。文字都是這裡編的，模型的回覆是假供應商照腳本給的。

function block(id: string, text: string): Record<string, unknown> {
  return {
    id,
    content_hash: createHash('sha256').update(text).digest('hex'),
    role: 'paragraph',
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
  block('p0000-aaaaa1', 'The Grey Warden keeps the Salt Marsh, and she counts the tide stones every single night.'),
  block('p0000-aaaaa2', 'Travellers speak Old Tongue to the Grey Warden when they reach the Old Ferry at dusk.'),
  block('p0000-aaaaa3', 'It rains on the marsh all winter long, and the ferry waits for the tide to turn again.'),
];

function withStore<T>(home: string, action: (store: Store) => T): T {
  const store = openBookStore(home, 'book');
  try {
    return action(store);
  } finally {
    store.close();
  }
}

interface Card {
  readonly source: string;
  readonly target: string;
  readonly status?: string;
  readonly gender?: string;
  readonly pronoun?: string;
  readonly keep?: boolean;
}

function addCards(home: string, cards: readonly Card[]): void {
  withStore(home, (store) => {
    for (const card of cards) {
      store.run(
        `INSERT INTO entity (source, target, class, gender, pronoun, keep_source, status, origin, sources, occurrences, created_at, updated_at)
         VALUES (?, ?, 'person', ?, ?, ?, ?, 'pass0', '[]', 2, 't', 't')`,
        card.source,
        card.target,
        card.gender ?? null,
        card.pronoun ?? null,
        card.keep === true ? 1 : 0,
        card.status ?? 'locked',
      );
    }
  });
}

const WARDEN: Card = { source: 'Grey Warden', target: '灰色守望者', gender: 'female', pronoun: '她' };
const TONGUE: Card = { source: 'Old Tongue', target: 'Old Tongue', keep: true };

/** 一本解析過的書，換成這裡的文字，再放實體卡與提要。 */
async function book(cards: readonly Card[] = [WARDEN, TONGUE]): Promise<Library> {
  const lib = await library();
  const path = join(lib.home, 'books', 'book', 'ir', 'document.json');
  const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...document, sections: [], blocks: BLOCKS }));
  addCards(lib.home, cards);
  withStore(lib.home, (store) =>
    store.run(
      "INSERT INTO summary (id, era, tone, factions, input_hash, model, created_at) VALUES (1, 'A river kingdom.', 'Grim.', 'The Wardens.', 'h', 'm', 't')",
    ),
  );
  return lib;
}

async function tome(lib: Library, provider: FakeProvider | null, ...args: string[]): Promise<{ exit: number; output: Envelope; text: string }> {
  const { io, stdout } = lib.session(provider === null ? {} : { llm: fakeHost(provider) });
  const exit = await run([...args, '--json'], io);
  return { exit, output: JSON.parse(stdout()) as Envelope, text: stdout() };
}

/** 翻譯時把原文的名字換成譯名，驗證才會通過。 */
async function fake(pairs: readonly (readonly [string, string])[] = [[WARDEN.source, WARDEN.target]]): Promise<FakeProvider> {
  return startFakeProvider(({ user }) => ({
    text: pairs.reduce((text, [from, to]) => text.replaceAll(from, to), translated(user)),
  }));
}

async function translatedBook(cards?: readonly Card[]): Promise<{ lib: Library; provider: FakeProvider }> {
  const lib = await book(cards);
  const provider = await fake();
  await tome(lib, null, 'estimate', 'book', '--realtime', '--budget', '100', '--confirm');
  const { exit } = await tome(lib, provider, 'translate', 'book', '--realtime');
  expect(exit).toBe(0);
  return { lib, provider };
}

function csv(text: string): string {
  const path = join(tempDir(), 'terms.csv');
  writeFileSync(path, text);
  return path;
}

interface UnitRow {
  readonly unit_id: string;
  readonly state: string;
  readonly translation: string | null;
}

function units(home: string): UnitRow[] {
  return withStore(home, (store) => store.all<UnitRow>('SELECT unit_id, state, translation FROM unit ORDER BY seq'));
}

function count(home: string, table: 'response' | 'memory'): number {
  const read = (store: Store): number => store.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)?.count ?? 0;
  if (table === 'response') return withStore(home, read);
  const series = openSeriesStore(home, 'book');
  try {
    return read(series);
  } finally {
    series.close();
  }
}

function codes(output: Envelope): string[] {
  return output.findings.map(({ code }) => code);
}

describe('locked entity cards in the translation (ADR-0120)', () => {
  it('sends a locked card with its attributes, hides a keep_source card, and ends the system prompt with the summary', async () => {
    const { provider } = await translatedBook([WARDEN, TONGUE, { source: 'Salt Marsh', target: '鹽沼', status: 'proposed' }]);
    const [first] = provider.requests;
    expect(first?.user).toContain('<term source="Grey Warden" target="灰色守望者" gender="female" pronoun="她"/>');
    expect(first?.user).toContain('<ph id="1" kind="keep_source"/>');
    expect(first?.user).not.toContain('鹽沼');
    expect(String(first?.body['system'])).toMatch(/<book>\n<era>A river kingdom\.<\/era>\n<tone>Grim\.<\/tone>\n<factions>The Wardens\.<\/factions>\n<\/book>$/u);
  });

  it('says how many cards still wait for review, and translates anyway', async () => {
    const lib = await book([WARDEN, { source: 'Salt Marsh', target: '鹽沼', status: 'proposed' }, { source: 'Tide Stones', target: '潮石', status: 'failed' }]);
    const { exit, output, text } = await tome(lib, null, 'estimate', 'book', '--realtime', '--budget', '100');
    expect(exit).toBe(0);
    expect(output.findings.find(({ code }) => code === 'glossary.pending')).toMatchObject({ level: 'warn', params: { count: '2' } });
    expect(text).not.toContain('Salt Marsh');
  });

  it('asks for the estimate again once a locked card changes', async () => {
    const { lib, provider } = await translatedBook();
    await tome(lib, null, 'glossary', 'import', 'book', csv('source,target\nOld Ferry,老渡口\n'));
    const again = await tome(lib, provider, 'translate', 'book', '--realtime');
    expect(codes(again.output)).toContain('translate.not_confirmed');
  });
});

describe('S-16 leaves a human translation alone (ADR-0081 item 6, ADR-0125)', () => {
  it.each([
    ['translation', 'Grey Warden,灰袍守望者,person,female,她', { replaced: '1', reset: '0' }],
    ['pronoun', 'Grey Warden,灰色守望者,person,female,他', { replaced: '0', reset: '1' }],
  ])('neither replaces nor resets it when the %s changes', async (_what, row, counts) => {
    const { lib } = await translatedBook();
    const [one] = units(lib.home);
    const human = '人工譯文：灰色守望者在鹽沼數潮石。';
    withStore(lib.home, (store) => store.run('UPDATE unit SET translation = ?, human = 1 WHERE unit_id = ?', human, one?.unit_id ?? ''));
    const { output } = await tome(lib, null, 'glossary', 'import', 'book', csv(`source,target,class,gender,pronoun\n${row}\n`));
    expect(output.findings.find(({ code }) => code === 'glossary.renamed')?.params).toMatchObject(counts);
    expect(units(lib.home)[0]).toEqual({ unit_id: one?.unit_id, state: 'DONE', translation: human });
  });
});

describe('S-16: changing a locked card (ADR-0120)', () => {
  it('puts the new translation into the translated units and the memory, without sending anything', async () => {
    const { lib, provider } = await translatedBook();
    const sent = provider.requests.length;
    const responses = count(lib.home, 'response');
    const memories = count(lib.home, 'memory');
    const { exit, output, text } = await tome(
      lib,
      null,
      'glossary',
      'import',
      'book',
      csv('source,target,class,gender,pronoun\nGrey Warden,灰袍守望者,person,female,她\n'),
    );
    expect(exit).toBe(0);
    expect(output.findings.find(({ code }) => code === 'glossary.renamed')?.params).toMatchObject({
      replaced: '2',
      resend: '0',
      reset: '0',
      in_flight: '0',
    });
    const [one, two, three] = units(lib.home);
    for (const unit of [one, two]) {
      expect(unit?.state).toBe('DONE');
      expect(unit?.translation).toContain('灰袍守望者');
      expect(unit?.translation).not.toContain('灰色守望者');
    }
    expect(three?.translation).not.toContain('守望者');
    expect(count(lib.home, 'response')).toBe(responses + 2);
    expect(count(lib.home, 'memory')).toBe(memories + 2);
    expect(provider.requests).toHaveLength(sent);
    for (const word of ['灰袍守望者', 'Grey Warden']) expect(text).not.toContain(word);
  });

  it.each([
    ['pronoun', 'Grey Warden,灰色守望者,person,female,他,'],
    ['gender', 'Grey Warden,灰色守望者,person,male,她,'],
    ['register', 'Grey Warden,灰色守望者,person,female,她,formal'],
    ['translation and pronoun together', 'Grey Warden,灰袍守望者,person,female,祂,'],
  ])('sends the units again when the %s changes, after a new estimate', async (_what, row) => {
    const { lib } = await translatedBook();
    const { output } = await tome(lib, null, 'glossary', 'import', 'book', csv(`source,target,class,gender,pronoun,register\n${row}\n`));
    expect(output.findings.find(({ code }) => code === 'glossary.renamed')?.params).toMatchObject({ replaced: '0', reset: '2' });
    expect(units(lib.home).map(({ state, translation }) => [state, translation === null])).toEqual([
      ['PENDING', true],
      ['PENDING', true],
      ['DONE', false],
    ]);
    const estimate = await tome(lib, null, 'estimate', 'book', '--realtime');
    expect(estimate.output.data).toMatchObject({ units: 2 });
  });

  it('sends again a unit whose translation lacks the old name, and leaves a unit still in a batch alone', async () => {
    const { lib } = await translatedBook();
    const [one, two] = units(lib.home);
    withStore(lib.home, (store) => {
      store.run("UPDATE response SET text = replace(text, '灰色守望者', '守衛') WHERE unit_id = ?", one?.unit_id ?? '');
      store.run("UPDATE unit SET state = 'IN_FLIGHT' WHERE unit_id = ?", two?.unit_id ?? '');
    });
    const { output } = await tome(lib, null, 'glossary', 'import', 'book', csv('source,target,class,gender,pronoun\nGrey Warden,灰袍守望者,person,female,她\n'));
    expect(output.findings.find(({ code }) => code === 'glossary.renamed')?.params).toMatchObject({
      replaced: '0',
      resend: '1',
      in_flight: '1',
    });
    expect(units(lib.home).map(({ state }) => state)).toEqual(['QUEUED', 'IN_FLIGHT', 'DONE']);
  });

  // 一次改兩張卡時，單位只換它命中的那張；另一張的舊譯名剛好出現在譯文裡也不換（ADR-0133）。
  it('replaces in a unit only the names it hits, when two cards change at once', async () => {
    const wanderer: Card = { source: 'Wanderer', target: 'Travellers' };
    const { lib } = await translatedBook([WARDEN, TONGUE, wanderer]);
    const rows = 'source,target,class,gender,pronoun\nGrey Warden,灰袍守望者,person,female,她\nWanderer,旅人,person,,\n';
    const { output } = await tome(lib, null, 'glossary', 'import', 'book', csv(rows));
    expect(output.findings.find(({ code }) => code === 'glossary.renamed')?.params).toMatchObject({ replaced: '2', resend: '0' });
    const [, two] = units(lib.home);
    expect(two?.translation).toContain('灰袍守望者');
    expect(two?.translation).toContain('Travellers');
    expect(two?.translation).not.toContain('旅人');
  });

  // 短卡只出現在長卡裡時，那些單位照長卡翻，沒有短卡的譯名可換：改短卡的譯名或屬性都不該動到它們（ADR-0133）。
  it('leaves alone the units where a changed card only sits inside a longer one', async () => {
    const { lib, provider } = await translatedBook();
    const sent = provider.requests.length;
    await tome(lib, null, 'glossary', 'import', 'book', csv('source,target,class,gender,pronoun\nWarden,守衛,person,,\n'));
    const renamed = await tome(lib, null, 'glossary', 'import', 'book', csv('source,target,class,gender,pronoun\nWarden,看守人,person,,\n'));
    expect(renamed.output.findings.find(({ code }) => code === 'glossary.renamed')?.params).toMatchObject({ replaced: '0', resend: '0', reset: '0' });
    const reworded = await tome(lib, null, 'glossary', 'import', 'book', csv('source,target,class,gender,pronoun\nWarden,看守人,person,male,他\n'));
    expect(reworded.output.findings.find(({ code }) => code === 'glossary.renamed')?.params).toMatchObject({ replaced: '0', resend: '0', reset: '0' });
    expect(units(lib.home).map(({ state }) => state)).toEqual(['DONE', 'DONE', 'DONE']);
    expect(provider.requests).toHaveLength(sent);
  });

  it('does the same when the review file changes a locked translation', async () => {
    const { lib } = await translatedBook();
    await tome(lib, null, 'glossary', 'review', 'book');
    const path = join(lib.home, 'books', 'book', 'glossary-review.yaml');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(/target: 灰色守望者([\s\S]*?)decision:/u, 'target: 灰袍守望者$1decision: lock'),
    );
    const { output } = await tome(lib, null, 'glossary', 'review', 'book');
    expect(output.findings.find(({ code }) => code === 'glossary.renamed')?.params).toMatchObject({ replaced: '2' });
  });

  it('does nothing when no locked card changed', async () => {
    const { lib } = await translatedBook();
    const { output } = await tome(lib, null, 'glossary', 'import', 'book', csv('source,target\nOld Ferry,老渡口\n'));
    expect(codes(output)).not.toContain('glossary.renamed');
  });
});

describe('a batch whose cards change before it comes back (ADR-0123)', () => {
  /** 送出一批，查詢一直失敗，停在送出之後；之後的查詢會成功。 */
  async function sentBatch(cards?: readonly Card[]): Promise<{ lib: Library; provider: FakeProvider }> {
    const lib = await book(cards);
    const provider = await startFakeProvider(
      ({ user }) => ({ text: translated(user).replaceAll(WARDEN.source, WARDEN.target) }),
      { pollStatus: 500 },
    );
    await tome(lib, null, 'estimate', 'book', '--budget', '100', '--confirm');
    const { exit } = await tome(lib, provider, 'translate', 'book');
    expect(exit).toBe(1);
    expect(units(lib.home).map(({ state }) => state)).toEqual(['IN_FLIGHT', 'IN_FLIGHT', 'IN_FLIGHT']);
    provider.batch.pollStatus = null;
    return { lib, provider };
  }

  it('keeps out of memory, and sends again, the units whose locked card changed its pronoun after they went out', async () => {
    const { lib, provider } = await sentBatch();
    await tome(lib, null, 'glossary', 'import', 'book', csv('source,target,class,gender,pronoun\nGrey Warden,灰色守望者,person,female,他\n'));
    const { exit, output } = await tome(lib, provider, 'batch', 'collect', 'book');
    expect(exit).toBe(0);
    expect(output.findings.find(({ code }) => code === 'batch.cards_changed')).toMatchObject({ level: 'info', params: { count: '2', book: 'book' } });
    expect(output.data).toMatchObject({ cards_changed: 2 });
    expect(units(lib.home).map(({ state, translation }) => [state, translation === null])).toEqual([
      ['PENDING', true],
      ['PENDING', true],
      ['DONE', false],
    ]);
    expect(count(lib.home, 'memory')).toBe(1);
    // 回應付過錢，照樣留著。
    expect(count(lib.home, 'response')).toBe(3);
  });

  it('does the same for a card locked after the batch went out', async () => {
    const { lib, provider } = await sentBatch([{ ...WARDEN, status: 'proposed' }, TONGUE]);
    await tome(lib, null, 'glossary', 'import', 'book', csv('source,target,class,gender,pronoun\nGrey Warden,灰色守望者,person,female,她\n'));
    const { output } = await tome(lib, provider, 'batch', 'collect', 'book');
    expect(output.findings.find(({ code }) => code === 'batch.cards_changed')?.params).toMatchObject({ count: '2' });
    expect(units(lib.home).map(({ state }) => state)).toEqual(['PENDING', 'PENDING', 'DONE']);
  });

  it('says nothing of batches or changed cards in real time', async () => {
    const lib = await book();
    const provider = await fake();
    await tome(lib, null, 'estimate', 'book', '--realtime', '--budget', '100', '--confirm');
    const { output } = await tome(lib, provider, 'translate', 'book', '--realtime');
    expect(output.data).not.toHaveProperty('cards_changed');
    expect(output.data).not.toHaveProperty('batches');
  });

  it('keeps every unit when no card changed', async () => {
    const { lib, provider } = await sentBatch();
    const { output } = await tome(lib, provider, 'batch', 'collect', 'book');
    expect(codes(output)).not.toContain('batch.cards_changed');
    expect(output.data).toMatchObject({ cards_changed: 0 });
    expect(units(lib.home).map(({ state }) => state)).toEqual(['DONE', 'DONE', 'DONE']);
    expect(count(lib.home, 'memory')).toBe(3);
  });
});
