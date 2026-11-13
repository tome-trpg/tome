import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { openBookStore, type Store } from '../../src/core/store.ts';
import { library, MODEL, type Library } from '../helpers/library.ts';
import { tempDir } from '../helpers.ts';

// 文字都是這裡編的（ADR-0119）。

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
  block('p0000-aaaaa1', 'The Grey Warden keeps the Salt Marsh. She counts the tide stones each night.'),
  block('p0000-aaaaa2', 'Travellers meet the Grey Warden at the Old Ferry, near the Salt Marsh.'),
];

interface Card {
  readonly source: string;
  readonly target?: string | null;
  readonly status: string;
  readonly origin?: string;
  readonly occurrences?: number;
  readonly class?: string | null;
  readonly gender?: string | null;
  readonly pronoun?: string | null;
  readonly keep_source?: number;
}

function withStore<T>(home: string, action: (store: Store) => T): T {
  const store = openBookStore(home, 'book');
  try {
    return action(store);
  } finally {
    store.close();
  }
}

function addCards(home: string, cards: readonly Card[]): void {
  withStore(home, (store) => {
    for (const card of cards) {
      store.run(
        `INSERT INTO entity (source, target, status, origin, sources, occurrences, class, gender, pronoun, keep_source, created_at, updated_at)
         VALUES (?, ?, ?, ?, '["caps"]', ?, ?, ?, ?, ?, 't', 't')`,
        card.source,
        card.target ?? null,
        card.status,
        card.origin ?? 'pass0',
        card.occurrences ?? 1,
        card.class ?? null,
        card.gender ?? null,
        card.pronoun ?? null,
        card.keep_source ?? 0,
      );
    }
  });
}

/** 一本解析過的書，換成這裡的文字，再放幾張 Pass 0 的提議。 */
async function book(cards: readonly Card[] = CARDS): Promise<Library> {
  const lib = await library({ config: `scanner_model: ${MODEL}\ntranslator_model: ${MODEL}\n` });
  const path = join(lib.home, 'books', 'book', 'ir', 'document.json');
  const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...document, sections: [], blocks: BLOCKS }));
  await run(['status', 'book'], lib.session().io);
  addCards(lib.home, cards);
  return lib;
}

/** 要人審：出現多、有代名詞、保留原文、沒提議。自動鎖定：Old Ferry。略過：Each Night。 */
const CARDS: readonly Card[] = [
  { source: 'Salt Marsh', target: '鹽沼', status: 'proposed', occurrences: 6, class: 'place' },
  { source: 'Grey Warden', target: '灰色守望者', status: 'proposed', occurrences: 2, class: 'person', gender: 'female', pronoun: '她' },
  { source: 'Old Ferry', target: '老渡口', status: 'proposed', occurrences: 1, class: 'place' },
  { source: 'Tide Stones', target: 'Tide Stones', status: 'proposed', occurrences: 1, keep_source: 1 },
  { source: 'Harrow Gate', status: 'failed', occurrences: 3 },
  { source: 'Each Night', status: 'skipped', occurrences: 1 },
];

interface Ran {
  readonly exit: number;
  readonly output: Envelope;
  readonly text: string;
}

async function tome(lib: Library, ...args: string[]): Promise<Ran> {
  const { io, stdout } = lib.session();
  const exit = await run([...args, '--json'], io);
  return { exit, output: JSON.parse(stdout()) as Envelope, text: stdout() };
}

function review(lib: Library): Promise<Ran> {
  return tome(lib, 'glossary', 'review', 'book');
}

function reviewPath(home: string): string {
  return join(home, 'books', 'book', 'glossary-review.yaml');
}

type Entry = Record<string, unknown> & { id: number; source: string };

function readReview(home: string): Record<'review' | 'locked' | 'skipped', Entry[]> {
  const value = parse(readFileSync(reviewPath(home), 'utf8')) as Record<string, Entry[] | null>;
  return { review: value['review'] ?? [], locked: value['locked'] ?? [], skipped: value['skipped'] ?? [] };
}

/** 改審定檔：依原文找到那一列，改欄位。 */
function edit(home: string, changes: Readonly<Record<string, Readonly<Record<string, unknown>>>>): void {
  const path = reviewPath(home);
  const value = parse(readFileSync(path, 'utf8')) as Record<string, Entry[] | null>;
  for (const list of Object.values(value)) {
    for (const entry of list ?? []) Object.assign(entry, changes[entry.source] ?? {});
  }
  writeFileSync(path, JSON.stringify(value));
}

function cards(home: string): Record<string, Record<string, unknown>> {
  const rows = withStore(home, (store) =>
    store.all<Record<string, unknown> & { source: string }>(
      'SELECT source, target, class, gender, pronoun, status, origin, decided_by, previous_target FROM entity ORDER BY id',
    ),
  );
  return Object.fromEntries(rows.map((row) => [row.source, row]));
}

function codes(output: Envelope): string[] {
  return output.findings.map(({ code }) => code);
}

function csvFile(text: string): string {
  const path = join(tempDir(), 'terms.csv');
  writeFileSync(path, text);
  return path;
}

describe('tome glossary review (ADR-0119)', () => {
  it('writes the review file, locks the low-impact proposals on its own, and prints counts only', async () => {
    const lib = await book();
    const { exit, output, text } = await review(lib);
    expect(exit).toBe(0);
    expect(codes(output)).toEqual(['glossary.reviewed']);
    expect(output.data).toMatchObject({ auto: 1, entities: { review: 4, locked: 1, auto: 1, skipped: 1 } });
    const file = readReview(lib.home);
    expect(file.review.map(({ source }) => source)).toEqual(['Salt Marsh', 'Harrow Gate', 'Grey Warden', 'Tide Stones']);
    expect(file.locked.map(({ source, decided_by: by }) => [source, by])).toEqual([['Old Ferry', 'auto']]);
    expect(file.skipped.map(({ source }) => source)).toEqual(['Each Night']);
    expect(cards(lib.home)['Old Ferry']).toMatchObject({ status: 'locked', decided_by: 'auto' });
    for (const word of ['Salt Marsh', '鹽沼', 'tide stones']) expect(text).not.toContain(word);
  });

  it('shows the sentences a term appears in, and explains the file in comments', async () => {
    const lib = await book();
    await review(lib);
    const [marsh] = readReview(lib.home).review;
    expect(marsh?.['seen_in']).toEqual(['The Grey Warden keeps the Salt Marsh.', 'She counts the tide stones each night.']);
    expect(marsh).toMatchObject({ target: '鹽沼', class: 'place', count: 6, origin: 'pass0', decision: null });
    expect(readFileSync(reviewPath(lib.home), 'utf8')).toMatch(/^# 實體卡審定檔/u);
  });

  it('applies only the entries with a decision, and moves them out of review', async () => {
    const lib = await book();
    await review(lib);
    edit(lib.home, {
      'Salt Marsh': { target: '鹽澤', decision: 'lock' },
      'Tide Stones': { decision: 'reject' },
      'Harrow Gate': { target: '哈洛門' },
    });
    const { output } = await review(lib);
    expect(output.data).toMatchObject({ applied: { locked: 1, rejected: 1 } });
    const after = cards(lib.home);
    expect(after['Salt Marsh']).toMatchObject({ target: '鹽澤', status: 'locked', decided_by: 'human' });
    expect(after['Tide Stones']).toMatchObject({ status: 'rejected', decided_by: 'human' });
    expect(after['Harrow Gate']).toMatchObject({ target: null, status: 'failed' });
    const file = readReview(lib.home);
    expect(file.review.map(({ source }) => source)).toEqual(['Harrow Gate', 'Grey Warden']);
    expect(file.locked.map(({ source }) => source)).toContain('Salt Marsh');
  });

  it('lets a person fill in a term with no proposal, and bring back a skipped one', async () => {
    const lib = await book();
    await review(lib);
    edit(lib.home, {
      'Harrow Gate': { target: '哈洛門', class: 'place', decision: 'LOCK' },
      'Each Night': { target: '每晚', decision: 'lock' },
    });
    await review(lib);
    expect(cards(lib.home)['Harrow Gate']).toMatchObject({ target: '哈洛門', class: 'place', status: 'locked' });
    expect(cards(lib.home)['Each Night']).toMatchObject({ target: '每晚', status: 'locked' });
  });

  it('keeps the previous translation when a locked one changes, for S-16 in round 037', async () => {
    const lib = await book();
    await review(lib);
    edit(lib.home, { 'Old Ferry': { target: '舊渡口', decision: 'lock' } });
    await review(lib);
    expect(cards(lib.home)['Old Ferry']).toMatchObject({ target: '舊渡口', previous_target: '老渡口', decided_by: 'human' });
  });

  it('refuses what a person got wrong, names the entry and field, and applies the rest', async () => {
    const lib = await book();
    await review(lib);
    const ids = Object.fromEntries(readReview(lib.home).review.map(({ id, source }) => [source, id]));
    edit(lib.home, {
      'Salt Marsh': { class: 'swamp', decision: 'lock' },
      'Grey Warden': { pronoun: '伊', decision: 'lock' },
      'Harrow Gate': { target: `${String.fromCodePoint(0x95e8)}`, decision: 'lock' },
      'Tide Stones': { decision: 'maybe' },
      'Old Ferry': { decision: 'reject' },
    });
    const { exit, output, text } = await review(lib);
    expect(exit).toBe(1);
    const problem = output.findings.find(({ code }) => code === 'glossary.bad_entries');
    expect(problem?.params['count']).toBe('4');
    for (const [source, field] of [['Salt Marsh', 'class'], ['Grey Warden', 'pronoun'], ['Harrow Gate', 'target'], ['Tide Stones', 'decision']]) {
      expect(problem?.params['entries']).toContain(`${ids[source ?? '']}:${field}`);
    }
    expect(cards(lib.home)['Old Ferry']).toMatchObject({ status: 'rejected' });
    expect(cards(lib.home)['Salt Marsh']).toMatchObject({ status: 'proposed' });
    expect(text).not.toContain('swamp');
  });

  it('writes back what a person typed in the entries it refused, so only the named field needs fixing', async () => {
    const lib = await book();
    await review(lib);
    edit(lib.home, { 'Salt Marsh': { target: '鹽澤', class: 'swamp', decision: 'lock' } });
    const path = reviewPath(lib.home);
    const value = JSON.parse(JSON.stringify(parse(readFileSync(path, 'utf8')))) as Record<string, Entry[]>;
    value['review']?.push({ id: 999, source: 'Nowhere Pier', target: '無處碼頭', decision: 'lock' });
    writeFileSync(path, JSON.stringify(value));
    const { output } = await review(lib);
    expect(output.findings.find(({ code }) => code === 'glossary.bad_entries')?.params['entries']).toContain('999:id');
    const [orphan, marsh] = readReview(lib.home).review;
    expect(orphan).toMatchObject({ id: 999, target: '無處碼頭', decision: 'lock' });
    expect(marsh).toMatchObject({ source: 'Salt Marsh', target: '鹽澤', class: 'swamp', decision: 'lock' });
    edit(lib.home, { 'Salt Marsh': { class: 'place' }, 'Nowhere Pier': { decision: null } });
    const fixed = await review(lib);
    expect(fixed.exit).toBe(0);
    expect(cards(lib.home)['Salt Marsh']).toMatchObject({ target: '鹽澤', class: 'place', status: 'locked' });
    // 沒填 decision 的列照樣留著，人自己刪掉才會不見。
    expect(readReview(lib.home).review[0]).toMatchObject({ id: 999, source: 'Nowhere Pier', decision: null });
    const after = parse(readFileSync(path, 'utf8')) as Record<string, Entry[]>;
    after['review'] = (after['review'] ?? []).filter(({ id }) => id !== 999);
    writeFileSync(path, JSON.stringify(after));
    await review(lib);
    expect(readReview(lib.home).review.map(({ source }) => source)).not.toContain('Nowhere Pier');
    expect(cards(lib.home)['Nowhere Pier']).toBeUndefined();
  });

  it('keeps what a person changed in an entry without a decision, and applies none of it', async () => {
    const lib = await book();
    await review(lib);
    edit(lib.home, {
      'Grey Warden': { target: '灰衣守望者', pronoun: '他' },
      'Salt Marsh': { decision: 'reject' },
    });
    const { exit } = await review(lib);
    expect(exit).toBe(0);
    const warden = readReview(lib.home).review.find(({ source }) => source === 'Grey Warden');
    expect(warden).toMatchObject({ target: '灰衣守望者', pronoun: '他' });
    expect(cards(lib.home)['Grey Warden']).toMatchObject({ target: '灰色守望者', pronoun: '她', status: 'proposed' });
    // 再跑一次也還在。
    await review(lib);
    expect(readReview(lib.home).review.find(({ source }) => source === 'Grey Warden')).toMatchObject({ target: '灰衣守望者' });
    edit(lib.home, { 'Grey Warden': { decision: 'lock' } });
    await review(lib);
    expect(cards(lib.home)['Grey Warden']).toMatchObject({ target: '灰衣守望者', pronoun: '他', status: 'locked' });
  });

  it('rewrites from book.db the entries nobody changed, however YAML reads their empty values back', async () => {
    const lib = await book();
    await review(lib);
    const first = readFileSync(reviewPath(lib.home), 'utf8');
    await review(lib);
    expect(readFileSync(reviewPath(lib.home), 'utf8')).toBe(first);
    // 同樣的內容換一種寫法：空字串、預設的比對條件寫出來、角色是空清單，都跟 book.db 的 NULL 相同。
    edit(lib.home, { 'Salt Marsh': { gender: '', register: '  ', keep_source: false, match: { case_sensitive: true, whole_word: true, roles: [] } } });
    withStore(lib.home, (store) => store.run("UPDATE entity SET occurrences = 9 WHERE source = 'Salt Marsh'"));
    await review(lib);
    const marsh = readReview(lib.home).review.find(({ source }) => source === 'Salt Marsh');
    expect(marsh).toMatchObject({ count: 9, gender: null, register: null });
  });

  it('shows what an import changed in an entry nobody touched in the file', async () => {
    const lib = await book();
    await review(lib);
    await tome(lib, 'glossary', 'import', 'book', csvFile('source,target,class\nSalt Marsh,鹽澤,place\n'));
    const { exit, output } = await review(lib);
    expect(exit).toBe(0);
    expect(codes(output)).toEqual(['glossary.reviewed']);
    const marsh = readReview(lib.home).locked.find(({ source }) => source === 'Salt Marsh');
    expect(marsh).toMatchObject({ target: '鹽澤', decided_by: 'import' });
  });

  it('keeps what a person typed when an import changed the same entry, and says which entries differ', async () => {
    const lib = await book();
    await review(lib);
    const id = readReview(lib.home).review.find(({ source }) => source === 'Grey Warden')?.id;
    edit(lib.home, { 'Grey Warden': { target: '灰衣守望者' } });
    await tome(lib, 'glossary', 'import', 'book', csvFile('source,target,class,gender,pronoun\nGrey Warden,灰袍守望者,person,female,她\n'));
    const { exit, output, text } = await review(lib);
    expect(exit).toBe(0);
    const warning = output.findings.find(({ code }) => code === 'glossary.diverged');
    expect(warning).toMatchObject({ level: 'warn', params: { count: '1', entries: String(id) } });
    expect(readReview(lib.home).locked.find(({ source }) => source === 'Grey Warden')).toMatchObject({ target: '灰衣守望者' });
    expect(cards(lib.home)['Grey Warden']).toMatchObject({ target: '灰袍守望者', status: 'locked' });
    for (const word of ['灰衣守望者', '灰袍守望者', 'Grey Warden']) expect(text).not.toContain(word);
    // 人確認之前每次都提醒：照人填的樣子寫回的列，不記成上次寫出的內容。
    const again = await review(lib);
    expect(codes(again.output)).toContain('glossary.diverged');
  });

  it('changes nothing and keeps the file when it cannot read it', async () => {
    const lib = await book();
    await review(lib);
    writeFileSync(reviewPath(lib.home), 'review: [unclosed\n');
    const { exit, output } = await review(lib);
    expect(exit).toBe(1);
    expect(codes(output)).toEqual(['glossary.file_invalid']);
    expect(readFileSync(reviewPath(lib.home), 'utf8')).toBe('review: [unclosed\n');
  });

  it('takes the new terms translation reported into the queue, once, for a person to review', async () => {
    const lib = await book();
    withStore(lib.home, (store) => {
      for (const unit of ['u1', 'u2']) {
        store.run(
          "INSERT INTO issue (unit_id, code, level, detail, created_at) VALUES (?, 'new_term', 'report', ?, 't')",
          unit,
          JSON.stringify({ source: 'Tide Stones Cove', target: '潮石灣' }),
        );
      }
      store.run(
        "INSERT INTO issue (unit_id, code, level, detail, created_at) VALUES ('u3', 'new_term', 'report', ?, 't')",
        JSON.stringify({ source: 'Salt Marsh', target: '鹽之沼' }),
      );
    });
    const first = await review(lib);
    expect(first.output.data).toMatchObject({ new_terms: 1 });
    expect(cards(lib.home)['Tide Stones Cove']).toMatchObject({ target: '潮石灣', status: 'proposed', origin: 'new_term' });
    expect(cards(lib.home)['Salt Marsh']).toMatchObject({ target: '鹽沼' });
    expect(readReview(lib.home).review.map(({ source }) => source)).toContain('Tide Stones Cove');
    const second = await review(lib);
    expect(second.output.data).toMatchObject({ new_terms: 0 });
  });

  /** 工作區裡繼承 generic 的規則包，類別照 `entities`，書改用它。 */
  function childEntities(lib: Library, entities: string): void {
    const dir = join(lib.home, 'systems', 'child');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pack.yaml'), 'schema: tome-pack/1\nid: child\nversion: 0.1.0\nlicense: UNLICENSED\nsource_langs: [en]\n');
    writeFileSync(join(dir, 'entities.yaml'), entities);
    const bookYaml = join(lib.home, 'books', 'book', 'book.yaml');
    const text = readFileSync(bookYaml, 'utf8');
    if (!text.includes('system: child')) writeFileSync(bookYaml, `${text}system: child\n`);
  }

  /** `place` 的審定權重是 `weight`。 */
  function childPack(lib: Library, weight: number): void {
    childEntities(lib, `classes:\n  place:\n    review_weight: ${weight}\n`);
  }

  const FERRY: readonly Card[] = [{ source: 'Old Ferry', target: '老渡口', status: 'proposed', occurrences: 1, class: 'place' }];

  it('weighs a class by the review_weight of the pack', async () => {
    const lib = await book(FERRY);
    childPack(lib, 5);
    const { output } = await review(lib);
    expect(output.data).toMatchObject({ auto: 0, entities: { review: 1 } });
  });

  // ADR-0130 第 6 項、ADR-0138：`gender: none` 與跟類別預設相同的代名詞不算要人審。
  it('locks on its own a card whose gender is none or whose pronoun is the default of its class', async () => {
    const lib = await book([
      { source: 'Mire Hound', target: '沼地獵犬', status: 'proposed', class: 'creature', gender: 'none', pronoun: '牠' },
      { source: 'Brass Lantern', target: '黃銅提燈', status: 'proposed', class: 'item', pronoun: '它' },
      { source: 'Old Ferry', target: '老渡口', status: 'proposed', class: 'place', gender: 'none' },
      { source: 'Sky Father', target: '天父', status: 'proposed', class: 'deity', gender: 'none', pronoun: '祂' },
    ]);
    const { output } = await review(lib);
    expect(output.data).toMatchObject({ auto: 4, entities: { review: 0 } });
    for (const source of ['Mire Hound', 'Brass Lantern', 'Old Ferry', 'Sky Father']) {
      expect(cards(lib.home)[source]).toMatchObject({ status: 'locked', decided_by: 'auto' });
    }
  });

  it('still asks a person about a gender, a pronoun that differs from the default, and a class with none', async () => {
    const lib = await book([
      { source: 'Grey Warden', target: '灰色守望者', status: 'proposed', class: 'person', pronoun: '她' },
      { source: 'Tide Hound', target: '潮汐獵犬', status: 'proposed', class: 'creature', pronoun: '它' },
      { source: 'Salt Wyrm', target: '鹽龍', status: 'proposed', class: 'creature', gender: 'female', pronoun: '牠' },
      { source: 'Harrow Gate', target: '哈洛門', status: 'proposed', pronoun: '它' },
      { source: 'Old Ferry', target: '老渡口', status: 'proposed', class: 'place', pronoun: '它' },
    ]);
    const { output } = await review(lib);
    expect(output.data).toMatchObject({ auto: 0, entities: { review: 5 } });
  });

  it('leaves the cards already locked or rejected as they were', async () => {
    const lib = await book([
      { source: 'Mire Hound', target: '沼地獵犬', status: 'rejected', class: 'creature', pronoun: '牠' },
      { source: 'Brass Lantern', target: '黃銅提燈', status: 'locked', class: 'item', pronoun: '它' },
    ]);
    const { output } = await review(lib);
    expect(output.data).toMatchObject({ auto: 0 });
    expect(cards(lib.home)['Mire Hound']).toMatchObject({ status: 'rejected', decided_by: null });
    expect(cards(lib.home)['Brass Lantern']).toMatchObject({ status: 'locked', decided_by: null });
  });

  it('looks up the default pronoun along the chain of packs, the child first', async () => {
    const lib = await book([
      { source: 'Mire Hound', target: '沼地獵犬', status: 'proposed', class: 'creature', pronoun: '牠' },
      { source: 'Tide Hound', target: '潮汐獵犬', status: 'proposed', class: 'creature', pronoun: '它' },
    ]);
    childEntities(lib, 'classes:\n  creature:\n    default_pronoun: 它\n');
    const { output } = await review(lib);
    expect(output.data).toMatchObject({ auto: 1 });
    expect(cards(lib.home)['Tide Hound']).toMatchObject({ status: 'locked', decided_by: 'auto' });
    expect(cards(lib.home)['Mire Hound']).toMatchObject({ status: 'proposed' });
  });

  it('does not lock on its own a card a person tried to change and got wrong', async () => {
    const lib = await book(FERRY);
    childPack(lib, 5);
    await review(lib);
    edit(lib.home, { 'Old Ferry': { class: 'swamp', decision: 'lock' } });
    childPack(lib, 1);
    const { output } = await review(lib);
    expect(output.data).toMatchObject({ auto: 0 });
    expect(cards(lib.home)['Old Ferry']).toMatchObject({ status: 'proposed', decided_by: null });
  });

  it('does not lock on its own a card a person changed without deciding yet', async () => {
    const lib = await book(FERRY);
    childPack(lib, 5);
    await review(lib);
    edit(lib.home, { 'Old Ferry': { target: '舊渡頭' } });
    childPack(lib, 1);
    const { output } = await review(lib);
    expect(output.data).toMatchObject({ auto: 0 });
    expect(cards(lib.home)['Old Ferry']).toMatchObject({ target: '老渡口', status: 'proposed' });
    expect(readReview(lib.home).review[0]).toMatchObject({ source: 'Old Ferry', target: '舊渡頭' });
  });

  it('shows the counts in tome status', async () => {
    const lib = await book();
    await review(lib);
    const { output } = await tome(lib, 'status', 'book');
    const line = output.findings.find(({ code }) => code === 'status.entities');
    expect(line?.params).toMatchObject({ review: '4', failed: '1', locked: '1', auto: '1', human: '0', imported: '0', rejected: '0' });
  });
});

describe('tome glossary import (ADR-0119)', () => {
  it('locks the terms of a CSV, updating the ones already there', async () => {
    const lib = await book();
    const path = csvFile(
      '﻿source,target,class,keep_source,case_sensitive\r\n' +
        'Salt Marsh,鹽澤,place,,\r\n' +
        '"Old Ferry, North",北老渡口,place,no,false\r\n' +
        'Tide Stones,Tide Stones,,yes,\r\n',
    );
    const { exit, output, text } = await tome(lib, 'glossary', 'import', 'book', path);
    expect(exit).toBe(0);
    expect(output.data).toMatchObject({ added: 1, updated: 2, unchanged: 0, problems: 0 });
    const after = cards(lib.home);
    expect(after['Salt Marsh']).toMatchObject({ target: '鹽澤', status: 'locked', origin: 'import', decided_by: 'import' });
    expect(after['Old Ferry, North']).toMatchObject({ target: '北老渡口', status: 'locked', origin: 'import' });
    expect(after['Tide Stones']).toMatchObject({ status: 'locked' });
    expect(text).not.toContain('鹽澤');
    const again = await tome(lib, 'glossary', 'import', 'book', path);
    expect(again.output.data).toMatchObject({ added: 0, updated: 0, unchanged: 3 });
  });

  it('skips the rows that are wrong, names them by their spreadsheet row and field, and imports the rest', async () => {
    const lib = await book();
    const path = csvFile('source,target,gender,keep_source\nA Gate,甲門,,\n,,,\n,乙,,\nB Gate,,,\nC Gate,丙門,maybe,\nD Gate,丁門,,perhaps\n');
    const { exit, output } = await tome(lib, 'glossary', 'import', 'book', path);
    expect(exit).toBe(1);
    expect(output.data).toMatchObject({ added: 1, problems: 4 });
    const problem = output.findings.find(({ code }) => code === 'glossary.bad_rows');
    expect(problem?.params['rows']).toBe('4:source, 5:target, 6:gender, 7:keep_source');
  });

  it('refuses a file with unknown columns or a quote that never closes, importing nothing', async () => {
    const lib = await book();
    const columns = await tome(lib, 'glossary', 'import', 'book', csvFile('source,target,colour\nA Gate,甲門,red\n'));
    expect(codes(columns.output)).toEqual(['glossary.csv_columns']);
    expect(columns.output.findings[0]?.params['columns']).toBe('colour');
    const quote = await tome(lib, 'glossary', 'import', 'book', csvFile('source,target\n"A Gate,甲門\n'));
    expect(codes(quote.output)).toEqual(['glossary.csv_invalid']);
    expect(cards(lib.home)['A Gate']).toBeUndefined();
  });

  it('says when the CSV is not there', async () => {
    const lib = await book();
    const { exit, output } = await tome(lib, 'glossary', 'import', 'book', join(tempDir(), 'missing.csv'));
    expect(exit).toBe(2);
    expect(codes(output)).toEqual(['glossary.csv_missing']);
  });
});
