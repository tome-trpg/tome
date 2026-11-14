import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readInstructions } from '../../src/core/prompt.ts';
import { main } from '../../tools/eval.ts';
import { consistency, renderReport, results, summarize, variantScores } from '../../tools/eval-report.ts';
import { estimateAll, readOutputs, runAll, VARIANTS, type OutputFile, type PassageStatus } from '../../tools/eval-run.ts';
import { buildBlind, complete, readScores, renderScorePage, startScoreServer, type BlindFile } from '../../tools/eval-score.ts';
import { allocate, pick, prng, selectPassages, shuffled, sourceTexts, type BookSpec } from '../../tools/eval-select.ts';
import { fakeHost, startFakeProvider, type FakeScript } from '../helpers/fake-provider.ts';
import { library, type Library } from '../helpers/library.ts';
import { tempDir } from '../helpers.ts';
import { parseUnits } from '../../src/core/tags.ts';

// 盲評的工具（ADR-0139）：只用合成的書與假供應商，不連外、不花錢。文字都是這裡編的。

const ZH = '這是測試用的中文指令。';

function block(id: string, role: string, text: string): Record<string, unknown> {
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

function writeDocument(home: string, slug: string, blocks: readonly Record<string, unknown>[]): void {
  const path = join(home, 'books', slug, 'ir', 'document.json');
  const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...document, sections: [], blocks }));
}

/** 區塊編號照 tome-ir/1：頁碼加六位十六進位。 */
function id(page: number, index: number): string {
  return `p${String(page).padStart(4, '0')}-${index.toString(16).padStart(6, '0')}`;
}

const ORC = [
  ...Array.from({ length: 10 }, (_, index) => block(id(0, index), 'paragraph', `The warden rolls ${index + 2} dice and keeps the highest of them for the gate.`)),
  ...Array.from({ length: 3 }, (_, index) => block(id(1, index), 'heading', `Chapter of Stones ${index + 1}`)),
  ...Array.from({ length: 4 }, (_, index) => block(id(2, index), 'list_item', `Carry ${index + 1} torches into the marsh at night.`)),
  block(id(3, 0), 'sidebar', 'A sidebar about the old ferry and its keeper.'),
];

const TALE = Array.from({ length: 8 }, (_, index) =>
  block(id(0, 16 + index), 'paragraph', `The night was cold, and the ${index + 1} travellers waited by the shore.`),
);

/** 維護者的工作區：兩本合成的書，`orc` 的角色多、`tale` 只有段落。 */
async function workspace(): Promise<Library> {
  const lib = await library();
  // 第二本書：同一份合成 PDF 加不了兩次，照樣複製設定與 document 層。
  const tale = join(lib.home, 'books', 'tale');
  mkdirSync(join(tale, 'ir'), { recursive: true });
  copyFileSync(join(lib.home, 'books', 'book', 'book.yaml'), join(tale, 'book.yaml'));
  copyFileSync(join(lib.home, 'books', 'book', 'ir', 'document.json'), join(tale, 'ir', 'document.json'));
  writeDocument(lib.home, 'book', ORC);
  writeDocument(lib.home, 'tale', TALE);
  return lib;
}

const BOOKS: readonly BookSpec[] = [
  { label: 'orc', slug: 'book', quota: 8 },
  { label: 'cthulhu', slug: 'tale', quota: 4 },
];

/** 依模型給不同的譯文：Haiku 只回一個字（過短，重送後還是不過，淘汰），Sonnet 與 Fable 一樣（合併顯示），Opus 另一種。 */
const SCRIPT: FakeScript = ({ user, model }) => {
  const units = parseUnits(user).units.map(({ id, raw }) => {
    const inner = raw.slice(raw.indexOf('>') + 1, raw.lastIndexOf('</s>'));
    if (model === 'claude-haiku-5-5') return `<s id="${id}">譯</s>`;
    if (model === 'claude-opus-5-5') return `<s id="${id}">譯者：${inner}</s>`;
    return `<s id="${id}">譯：${inner}</s>`;
  });
  return { text: units.join('\n') };
};

describe('choosing passages (ADR-0139 item 3)', () => {
  it('draws the same numbers from the same seed', () => {
    const a = prng(48);
    const b = prng(48);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(prng(49)()).not.toBe(first[0]);
    expect(shuffled([1, 2, 3, 4, 5], prng(1)).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('gives each role a floor, the rest in proportion, and everything when there is not enough', () => {
    expect(Object.fromEntries(allocate(new Map([['paragraph', 100], ['heading', 10], ['table', 1]]), 20))).toEqual({ heading: 3, paragraph: 16, table: 1 });
    expect(Object.fromEntries(allocate(new Map([['paragraph', 3], ['heading', 2]]), 20))).toEqual({ heading: 2, paragraph: 3 });
    // 角色比名額多：數量少的先拿不到保底。
    expect(Object.fromEntries(allocate(new Map([['a', 5], ['b', 4], ['c', 1]]), 3))).toEqual({ a: 2, b: 1, c: 0 });
    const total = [...allocate(new Map([['a', 7], ['b', 7], ['c', 7]]), 10).values()].reduce((sum, value) => sum + value, 0);
    expect(total).toBe(10);
  });

  it('picks by role from a seed, in reading order, and skips what was struck out', () => {
    const candidates = [
      ...Array.from({ length: 6 }, (_, index) => ({ key: `p${index}`, role: 'paragraph' })),
      { key: 'h0', role: 'heading' },
      { key: 'h1', role: 'heading' },
    ];
    const first = pick(candidates, 4, prng(7));
    expect(pick(candidates, 4, prng(7))).toEqual(first);
    expect(first.filter(({ role }) => role === 'heading')).toHaveLength(2);
    expect(first.map(({ key }) => candidates.findIndex((item) => item.key === key))).toEqual([...first.map(({ key }) => candidates.findIndex((item) => item.key === key))].sort((a, b) => a - b));
    const struck = pick(candidates, 4, prng(7), new Set(['h0']));
    expect(struck.map(({ key }) => key)).not.toContain('h0');
    expect(struck).toHaveLength(4);
  });

  it('copies the books out of the workspace, picks the same passages again, and leaves the workspace alone', async () => {
    const lib = await workspace();
    const dir = join(tempDir(), 'eval');
    const before = statSync(join(lib.home, 'books', 'book', 'book.db')).mtimeMs;
    const file = await selectPassages({ dir, home: lib.home, books: BOOKS, seed: 48 });
    expect(file.passages).toHaveLength(12);
    expect(file.passages.filter(({ book }) => book === 'orc').map(({ role }) => role).sort()).toEqual(
      expect.arrayContaining(['heading', 'heading', 'list_item', 'list_item', 'paragraph', 'sidebar']),
    );
    expect(file.books[0]?.document_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.passages.map(({ id }) => id)).toEqual(Array.from({ length: 12 }, (_, index) => `P${String(index + 1).padStart(3, '0')}`));
    const again = await selectPassages({ dir: join(tempDir(), 'again'), home: lib.home, books: BOOKS, seed: 48 });
    expect(again.passages.map(({ key }) => key)).toEqual(file.passages.map(({ key }) => key));
    expect(statSync(join(lib.home, 'books', 'book', 'book.db')).mtimeMs).toBe(before);
    const review = readFileSync(join(dir, 'passages-review.html'), 'utf8');
    expect(review).not.toContain('<script');
    expect(review).toContain('The warden rolls');
    const struck = await selectPassages({ dir, home: lib.home, books: BOOKS, seed: 48, excluded: [file.passages[0]?.key ?? ''] });
    expect(struck.passages.map(({ key }) => key)).not.toContain(file.passages[0]?.key);
    expect(struck.passages).toHaveLength(12);
    expect((await sourceTexts(dir, struck)).get('P001')).toMatch(/[A-Za-z]/);
  });
});

describe('estimating and running (ADR-0139 items 1, 2, 5 and 10)', () => {
  it('estimates each variant the way it will be sent, and refuses beyond the budget', async () => {
    const lib = await workspace();
    const dir = join(tempDir(), 'eval');
    const file = await selectPassages({ dir, home: lib.home, books: BOOKS, seed: 48 });
    const estimate = await estimateAll(dir, file, () => ZH);
    const byCode = Object.fromEntries(estimate.variants.map((item) => [item.code, item]));
    expect(estimate.variants.map(({ code }) => code)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(byCode['B']?.books.map(({ requests }) => requests)).toEqual([8, 4]);
    expect(byCode['C']?.estimate.high_usd).toBeGreaterThan(byCode['B']?.estimate.high_usd ?? 0);
    expect(byCode['D']?.books[0]?.prompt_hash).not.toBe(byCode['B']?.books[0]?.prompt_hash);
    expect(byCode['F']?.estimate.high_usd).toBeGreaterThan(byCode['B']?.estimate.high_usd ?? 0);
    expect(byCode['A']?.estimate.high_usd).toBeLessThan(byCode['B']?.estimate.high_usd ?? 0);
    expect(estimate.over).toBe(false);
    const tight = await estimateAll(dir, file, () => ZH, VARIANTS, 0);
    expect(tight.over).toBe(true);
    const provider = await startFakeProvider(SCRIPT);
    await expect(runAll(dir, file, tight, fakeHost(provider), () => ZH)).rejects.toThrow(/estimate tops/);
    expect(provider.requests).toHaveLength(0);
  });

  it('runs the six variants in batches through the product, one passage per request', async () => {
    const lib = await workspace();
    const dir = join(tempDir(), 'eval');
    const file = await selectPassages({ dir, home: lib.home, books: BOOKS, seed: 48 });
    const estimate = await estimateAll(dir, file, () => ZH);
    const provider = await startFakeProvider(SCRIPT);
    const { outputs, stop } = await runAll(dir, file, estimate, fakeHost(provider), () => ZH);
    expect(stop).toBeNull();
    const golden = new Set(file.passages.flatMap(({ units }) => units));
    for (const sent of provider.requests) {
      const ids = parseUnits(sent.user).units.map(({ id }) => id);
      expect(ids).toHaveLength(1);
      expect(sent.batch).toBeDefined();
    }
    const system = (body: Readonly<Record<string, unknown>>): string => String(body['system']);
    const byModel = (model: string) => provider.requests.filter((sent) => sent.model === model);
    expect(byModel('claude-sonnet-5-5').some(({ body }) => (body['thinking'] as { type: string }).type === 'adaptive')).toBe(true);
    expect(byModel('claude-sonnet-5-5').some(({ body }) => system(body).startsWith(ZH))).toBe(true);
    expect(byModel('claude-sonnet-5-5').some(({ body }) => system(body).startsWith(readInstructions().trim()))).toBe(true);
    expect(byModel('claude-fable-5-2').every(({ body }) => (body['output_config'] as { effort: string }).effort === 'low')).toBe(true);
    // 每組的成功段落各送一次；Haiku 重送到上限才淘汰。
    expect(byModel('claude-opus-5-5')).toHaveLength(12);
    expect(byModel('claude-haiku-5-5').length).toBeGreaterThan(12);
    expect(golden.size).toBeGreaterThanOrEqual(12);
    const statuses = (code: string): string[] => Object.values(outputs[code]?.passages ?? {}).map(({ status }) => status);
    expect(new Set(statuses('A'))).toEqual(new Set(['failed']));
    for (const code of ['B', 'C', 'D', 'E', 'F']) expect(new Set(statuses(code))).toEqual(new Set(['done']));
    expect(outputs['B']?.passages['P001']?.text).toMatch(/^譯：/);
    expect(outputs['E']?.passages['P001']?.text).toMatch(/^譯者：/);
    expect(outputs['B']?.spent_usd).toBeGreaterThan(0);
    expect(outputs['B']?.input_tokens).toBeGreaterThan(0);
    // 跑過的不再送。
    const sent = provider.requests.length;
    await runAll(dir, file, estimate, fakeHost(provider), () => ZH);
    expect(provider.requests).toHaveLength(sent);
    expect(readOutputs(dir)['B']?.passages['P001']?.status).toBe('done');
  });
});

/** 不跑供應商，直接編一份結果：A 全部淘汰，B、C、D、F 一樣，E 不一樣。 */
function fakeOutputs(ids: readonly string[], failed: readonly string[] = []): OutputFile {
  const of = (code: string, text: (id: string) => string | null) => ({
    code,
    spent_usd: 0.01,
    input_tokens: 100,
    output_tokens: 120,
    passages: Object.fromEntries(
      ids.map((id) => {
        const value = text(id);
        const status: PassageStatus = value === null ? 'failed' : 'done';
        return [id, { status, text: value, issues: code === 'E' ? ['too_long'] : [] }];
      }),
    ),
  });
  return {
    A: of('A', () => null),
    B: of('B', (id) => (failed.includes(id) ? null : `譯：${id}`)),
    C: of('C', (id) => `譯：${id}`),
    D: of('D', (id) => `譯：${id}`),
    E: of('E', (id) => `譯者：${id}`),
    F: of('F', (id) => `譯：${id}`),
  };
}

const IDS = Array.from({ length: 30 }, (_, index) => `P${String(index + 1).padStart(3, '0')}`);
const FILE = {
  seed: 48,
  books: [{ label: 'orc', slug: 'book', quota: 30, document_sha256: 'a'.repeat(64) }],
  excluded: [],
  passages: IDS.map((id, index) => ({ id, book: 'orc', key: `u${index}`, role: index % 3 === 0 ? 'heading' : 'paragraph', units: [`u${index}`], blocks: [`b${index}`], chars: 40 })),
};
const CODES = VARIANTS.map(({ code }) => code);

describe('blinding the outputs (ADR-0139 items 5 to 7)', () => {
  it('drops a variant that lost more than a tenth, merges identical outputs, and shuffles every passage', () => {
    const blind = buildBlind(fakeOutputs(IDS), FILE, CODES, prng(3));
    expect(blind.dropped).toEqual(['A']);
    expect(blind.rates).toMatchObject({ A: 1, B: 0 });
    const first = blind.passages[0];
    expect(first?.items.map(({ variants }) => variants)).toEqual([['B', 'C', 'D', 'F'], ['E']]);
    expect(blind.slots).toHaveLength(40);
    expect(blind.slots.map(({ slot }) => slot)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    const orders = new Set(blind.slots.map(({ order }) => order.join()));
    expect(orders.size).toBe(2);
  });

  it('keeps a variant that lost a tenth or less, and repeats ten passages later on, after their first time', () => {
    const blind = buildBlind(fakeOutputs(IDS, ['P001', 'P002', 'P003']), FILE, CODES, prng(5));
    expect(blind.dropped).toEqual(['A']);
    expect(blind.rates['B']).toBeCloseTo(0.1);
    const repeats = blind.slots.filter(({ round }) => round === 2);
    expect(repeats).toHaveLength(10);
    for (const again of repeats) {
      const first = blind.slots.find(({ passage, round }) => passage === again.passage && round === 1);
      expect(first?.slot).toBeLessThan(again.slot);
      expect(again.slot).toBeGreaterThan(15);
    }
    const mixed = blind.passages.find(({ id }) => id === 'P001');
    expect(mixed?.items.map(({ variants }) => variants)).toEqual([['C', 'D', 'F'], ['E']]);
  });

  it('refuses to blind a run that has not finished', () => {
    const outputs = fakeOutputs(IDS);
    const unfinished = { ...outputs, B: { ...outputs['B'], passages: { P001: { status: 'missing', text: null, issues: [] } } } } as OutputFile;
    expect(() => buildBlind(unfinished, FILE, CODES, prng(1))).toThrow(/has not finished/);
  });

  it('shows letters and texts, never the variants or the models', () => {
    const blind = buildBlind(fakeOutputs(IDS), FILE, CODES, prng(3));
    const slot = blind.slots[0];
    if (slot === undefined) throw new Error('no slot');
    const html = renderScorePage({ base: '/t/', slot, total: 40, scored: 0, source: 'The <warden> & co.', shown: ['譯：甲', '譯者：乙'], given: {}, notice: null, missing: false });
    expect(html).toContain('The &lt;warden&gt; &amp; co.');
    expect(html).toContain('譯文 A');
    expect(html).toContain('譯文 B');
    for (const word of ['claude', 'sonnet', 'haiku', 'opus', 'fable']) expect(html.toLowerCase()).not.toContain(word);
    expect(html.match(/type="radio"/g)).toHaveLength(10);
  });
});

function call(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const sent = request(url, { method: options.method ?? 'GET', headers: options.headers ?? {} }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    sent.on('error', reject);
    sent.end(options.body);
  });
}

describe('the scoring page (ADR-0139 item 6)', () => {
  it('saves each passage as it is scored, refuses a half-scored one, and picks up where it stopped', async () => {
    const dir = tempDir();
    const outputs = fakeOutputs(IDS);
    const blind = buildBlind(outputs, FILE, CODES, prng(3));
    const sources = new Map(IDS.map((id) => [id, `Source of ${id}.`]));
    const server = await startScoreServer({ dir, blind, outputs, sources });
    const origin = new URL(server.url).origin;
    const post = (path: string, body: string) =>
      call(new URL(path, server.url).toString(), { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body });
    try {
      const page = await call(server.url);
      expect(page.status).toBe(200);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.body).toContain(`Source of ${blind.slots[0]?.passage}.`);
      const [first, second] = blind.slots;
      if (first === undefined || second === undefined) throw new Error('no slots');
      const half = await post(`slots/${first.slot}`, `i${first.order[0]}=4`);
      expect(half.status).toBe(422);
      expect(half.body).toContain('role="alert"');
      expect(existsSync(join(dir, 'scores.json'))).toBe(false);
      const fields = first.order.map((item, index) => `i${item}=${index + 3}`).join('&');
      const saved = await post(`slots/${first.slot}`, fields);
      expect(saved.status).toBe(303);
      expect(new URL(saved.headers.location ?? '', server.url).searchParams.get('slot')).toBe(String(second.slot));
      expect(readScores(dir)[String(first.slot)]).toEqual(Object.fromEntries(first.order.map((item, index) => [String(item), index + 3])));
      expect((await post(`slots/${first.slot}`, first.order.map((item) => `i${item}=9`).join('&'))).status).toBe(422);
      expect((await post('slots/999', fields)).status).toBe(404);
      expect((await call(new URL('app.js', server.url).toString())).body).not.toMatch(/\b(fetch|localStorage|sessionStorage)\b/);
    } finally {
      await server.close();
    }
    const again = await startScoreServer({ dir, blind, outputs, sources });
    try {
      expect((await call(again.url)).body).toContain(`Source of ${blind.slots[1]?.passage}.`);
    } finally {
      await again.close();
    }
  });

  it('says so when every passage is scored', async () => {
    const dir = tempDir();
    const outputs = fakeOutputs(IDS.slice(0, 2));
    const file = { ...FILE, passages: FILE.passages.slice(0, 2) };
    const blind = buildBlind(outputs, file, CODES, prng(3));
    const scores = Object.fromEntries(blind.slots.map(({ slot, order }) => [String(slot), Object.fromEntries(order.map((item) => [String(item), 4]))]));
    writeFileSync(join(dir, 'scores.json'), JSON.stringify(scores));
    expect(blind.slots.every((slot) => complete(slot, scores))).toBe(true);
    const server = await startScoreServer({ dir, blind, outputs, sources: new Map() });
    try {
      expect((await call(server.url)).body).toContain('都評完了');
    } finally {
      await server.close();
    }
  });
});

describe('the report (ADR-0139 items 7 to 9)', () => {
  /** 每段都打分：B 那一則 4 分，E 那一則 3 分；重複的那一次 B 改成 5 分。 */
  function scored(blind: BlindFile): Record<string, Record<string, number>> {
    return Object.fromEntries(
      blind.slots.map(({ slot, passage, order, round }) => {
        const items = blind.passages.find(({ id }) => id === passage)?.items ?? [];
        return [String(slot), Object.fromEntries(order.map((item) => [String(item), items[item]?.variants.includes('B') ? (round === 2 ? 5 : 4) : 3]))];
      }),
    );
  }

  it('averages what was scored, counts each repeat once, and checks consistency on the repeats', () => {
    expect(summarize([4, 5, 3, 4])).toMatchObject({ n: 4, mean: 4, counts: [0, 0, 1, 2, 1] });
    expect(summarize([4]).half).toBe(0);
    expect(Number.isNaN(summarize([]).mean)).toBe(true);
    const blind = buildBlind(fakeOutputs(IDS), FILE, CODES, prng(3));
    const scores = scored(blind);
    expect(variantScores(blind, scores, 'B')).toHaveLength(30);
    expect(new Set(variantScores(blind, scores, 'B'))).toEqual(new Set([4]));
    expect(new Set(variantScores(blind, scores, 'E'))).toEqual(new Set([3]));
    expect(variantScores(blind, scores, 'A')).toEqual([]);
    const same = consistency(blind, scores);
    expect(same).toMatchObject({ repeats: 10, pairs: 20, exact: 0.5, mad: 0.5, within: 1, stable: true });
  });

  it('writes numbers, settings and the index only, and judges Q-8 on variant B', () => {
    const blind = buildBlind(fakeOutputs(IDS), FILE, CODES, prng(3));
    const found = results(VARIANTS, fakeOutputs(IDS), blind, scored(blind));
    expect(found.q8).toMatchObject({ code: 'B', mean: 4, pass: true });
    expect(found.variants.find(({ code }) => code === 'A')).toMatchObject({ dropped: true, rate: 1 });
    expect(found.variants.find(({ code }) => code === 'E')).toMatchObject({ issues: 30 });
    const estimate = {
      budget_usd: 30,
      over: false,
      estimate: { low_usd: 1, high_usd: 2 },
      variants: VARIANTS.map(({ code, model }) => ({ code, model, estimate: { low_usd: 0.1, high_usd: 0.2 }, books: [{ book: 'orc', requests: 30, units: 30, estimate: { low_usd: 0.1, high_usd: 0.2 }, prompt_hash: 'c'.repeat(64), pack_hash: 'd'.repeat(64) }] })),
    };
    const markdown = renderReport({ date: '2026-11-20', commit: 'abc1234', sdk: '0.137.0', specs: VARIANTS, file: FILE, estimate, results: found });
    expect(markdown).toContain('abc1234');
    expect(markdown).toContain('a'.repeat(64));
    expect(markdown).toContain('| B | 30 | 4.00 |');
    // 分數的定義跟評分頁同一套。
    expect(markdown).toContain('* 4 分：可以直接上桌。');
    expect(markdown).toContain('* 5 分：很好，讀起來像原本就用中文寫的。');
    expect(markdown).toContain('達標');
    expect(markdown).not.toContain('譯：');
    expect(markdown).not.toContain('Source of');
    expect(markdown).toContain('| P030 | orc | paragraph | 40 | `b29` | 1 |');
    const failing = results(VARIANTS, fakeOutputs(IDS), blind, Object.fromEntries(Object.entries(scored(blind)).map(([slot, items]) => [slot, Object.fromEntries(Object.keys(items).map((item) => [item, 2]))])));
    expect(failing.q8.pass).toBe(false);
  });
});

describe('node tools/eval.ts (ADR-0139 item 10)', () => {
  it('walks select, estimate, run, score and report', async () => {
    const lib = await workspace();
    const dir = join(tempDir(), 'eval');
    let said = '';
    const provider = await startFakeProvider(SCRIPT);
    let finish = (): void => undefined;
    const stopped = new Promise<void>((resolve) => (finish = resolve));
    const io = {
      env: lib.env,
      platform: process.platform,
      write: (text: string) => void (said += text),
      host: fakeHost(provider),
      instructions: ZH,
      tool: async () => ({ stdout: '' }),
      stopped: () => stopped,
      today: () => new Date('2026-11-20T00:00:00Z'),
    };
    expect(await main(['estimate'], io)).toBe(2);
    expect(await main(['estimate', '--dir', dir], io)).toBe(1);
    expect(await main(['select', '--dir', dir, '--orc', 'book', '--cthulhu', 'tale', '--seed', '7'], io)).toBe(0);
    // 合成的書段落不夠 60 加 40，全部挑：orc 18 段、tale 8 段。
    expect(said).toContain('挑好 26 段');
    expect(await main(['run', '--dir', dir], io)).toBe(1);
    expect(await main(['estimate', '--dir', dir], io)).toBe(0);
    expect(await main(['run', '--dir', dir], io)).toBe(0);
    expect(said).toContain('6 組都跑完了');
    const scoring = main(['score', '--dir', dir], io);
    await new Promise((resolve) => setTimeout(resolve, 300));
    finish();
    expect(await scoring).toBe(0);
    expect(existsSync(join(dir, 'blind.json'))).toBe(true);
    const out = join(tempDir(), 'evals', 'report.md');
    expect(await main(['report', '--dir', dir, '--commit', 'abc1234', '--out', out], io)).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('2026-11-20');
    expect(said).not.toContain('The warden rolls');
  });
});
