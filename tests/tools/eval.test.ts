import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readInstructions } from '../../src/core/prompt.ts';
import { main } from '../../tools/eval.ts';
import { consistency, renderReport, results, sampleScores, summarize } from '../../tools/eval-report.ts';
import { estimateAll, readOutputs, runAll, VARIANTS, type OutputFile, type PassageStatus } from '../../tools/eval-run.ts';
import { buildSample, previousScores, readSampleScores, renderScorePage, startScoreServer, type BlindFile, type SampleFile } from '../../tools/eval-score.ts';
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

// 每規劃一本書就起一個跑規則包正則的 worker，新開的 `book.db` 還要先建單位；Windows 的 runner 上一次要一秒上下。
// 所以 6 組只在「runs the six variants」走一次、只用一本書，其他測試只跑 B 組（ADR-0140）。
const ONLY_B = VARIANTS.filter(({ code }) => code === 'B');

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
    // 原文換行、表頭固定、前四欄不換行（維護者 2026-11-14 看不到長段落的右半）。
    expect(review).toContain('white-space: pre-wrap');
    expect(review).toContain('position: sticky');
    expect(review).toMatch(/nth-child\(-n\+4\)[^{]*\{[^}]*white-space: nowrap/);
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
    const tight = await estimateAll(dir, file, () => ZH, ONLY_B, 0);
    expect(tight.over).toBe(true);
    const provider = await startFakeProvider(SCRIPT);
    await expect(runAll(dir, file, tight, fakeHost(provider), () => ZH)).rejects.toThrow(/estimate tops/);
    expect(provider.requests).toHaveLength(0);
  });

  it('runs the six variants in batches through the product, one passage per request', async () => {
    const lib = await workspace();
    const dir = join(tempDir(), 'eval');
    // 一本書就看得到每一組的差別；兩本書的流程由試算的測試與 `node tools/eval.ts` 的測試走過。
    const file = await selectPassages({ dir, home: lib.home, books: BOOKS.slice(0, 1), seed: 48 });
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
    expect(file.passages).toHaveLength(8);
    expect(byModel('claude-opus-5-5')).toHaveLength(8);
    expect(byModel('claude-haiku-5-5').length).toBeGreaterThan(8);
    expect(golden.size).toBeGreaterThanOrEqual(8);
    const statuses = (code: string): string[] => Object.values(outputs[code]?.passages ?? {}).map(({ status }) => status);
    expect(new Set(statuses('A'))).toEqual(new Set(['failed']));
    for (const code of ['B', 'C', 'D', 'E', 'F']) expect(new Set(statuses(code))).toEqual(new Set(['done']));
    expect(outputs['B']?.passages['P001']?.text).toMatch(/^譯：/);
    expect(outputs['E']?.passages['P001']?.text).toMatch(/^譯者：/);
    expect(outputs['B']?.spent_usd).toBeGreaterThan(0);
    expect(outputs['B']?.input_tokens).toBeGreaterThan(0);
    // 跑過的不再送：每一組走同一段程式，重跑 B 組就看得出來。
    const sent = provider.requests.length;
    await runAll(dir, file, estimate, fakeHost(provider), () => ZH, {}, ONLY_B);
    expect(provider.requests).toHaveLength(sent);
    expect(readOutputs(dir)['B']?.passages['P001']?.status).toBe('done');
  });
});

/** 不跑供應商，直接編一份結果：A 全部淘汰，B 照 `failed` 少幾段，E 每段都有只報告的問題。 */
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
/** 挑好的 30 段：orc 18 段、cthulhu 12 段，每三段一個標題。 */
const FILE = {
  seed: 48,
  books: [
    { label: 'orc', slug: 'book', quota: 18, document_sha256: 'a'.repeat(64) },
    { label: 'cthulhu', slug: 'tale', quota: 12, document_sha256: 'e'.repeat(64) },
  ],
  excluded: [],
  passages: IDS.map((id, index) => ({ id, book: index < 18 ? 'orc' : 'cthulhu', key: `u${index}`, role: index % 3 === 0 ? 'heading' : 'paragraph', units: [`u${index}`], blocks: [`b${index}`], chars: 40 })),
};
/** 照書的比例抽一半。 */
const HALF = { orc: 9, cthulhu: 6 };

function passageOf(id: string): (typeof FILE.passages)[number] {
  const found = FILE.passages.find((passage) => passage.id === id);
  if (found === undefined) throw new Error(`no passage ${id}`);
  return found;
}

describe('drawing the passages to score (ADR-0139 item 16)', () => {
  it("draws each book's share from the seed, by role, whatever the order of scoring", () => {
    const sample = buildSample(fakeOutputs(IDS), FILE, HALF, new Map(), prng(3));
    expect(sample).toMatchObject({ code: 'B', seed: 48, rate: 0, dropped: false, failed: [], reused: {} });
    expect(sample.passages.filter((id) => passageOf(id).book === 'orc')).toHaveLength(9);
    expect(sample.passages.filter((id) => passageOf(id).book === 'cthulhu')).toHaveLength(6);
    // 書裡照角色分層，跟挑段落同一套：每個角色至少 2 段。
    for (const book of ['orc', 'cthulhu']) {
      expect(sample.passages.filter((id) => passageOf(id).book === book && passageOf(id).role === 'heading').length).toBeGreaterThanOrEqual(2);
    }
    expect(sample.passages).toEqual([...sample.passages].sort());
    expect(buildSample(fakeOutputs(IDS), FILE, HALF, new Map(), prng(99)).passages).toEqual(sample.passages);
    expect(buildSample(fakeOutputs(IDS), { ...FILE, seed: 7 }, HALF, new Map(), prng(3)).passages).not.toEqual(sample.passages);
  });

  it('scores each passage once and repeats five of them later on, after their first time', () => {
    const sample = buildSample(fakeOutputs(IDS), FILE, HALF, new Map(), prng(3));
    expect(sample.slots.map(({ slot }) => slot)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    const first = sample.slots.filter(({ round }) => round === 1);
    expect(first.map(({ passage }) => passage).sort()).toEqual([...sample.passages].sort());
    const repeats = sample.slots.filter(({ round }) => round === 2);
    expect(repeats).toHaveLength(5);
    expect(new Set(repeats.map(({ passage }) => passage)).size).toBe(5);
    for (const again of repeats) {
      expect(first.find(({ passage }) => passage === again.passage)?.slot).toBeLessThan(again.slot);
      expect(again.slot).toBeGreaterThan(8);
    }
  });

  it('carries over the scores B already had in the blind round, and repeats passages scored now', () => {
    const base = buildSample(fakeOutputs(IDS), FILE, HALF, new Map(), prng(3));
    const [one, two] = base.passages;
    if (one === undefined || two === undefined) throw new Error('no passages');
    const sample = buildSample(fakeOutputs(IDS), FILE, HALF, new Map([[one, 5], [two, 3], ['P999', 4]]), prng(3));
    expect(sample.passages).toEqual(base.passages);
    expect(sample.reused).toEqual({ [one]: 5, [two]: 3 });
    expect(sample.slots.filter(({ round }) => round === 1)).toHaveLength(13);
    expect(sample.slots.some(({ passage }) => passage === one || passage === two)).toBe(false);
    // 全部都評過了：重複題只好從沿用的段落挑。
    const all = buildSample(fakeOutputs(IDS), FILE, HALF, new Map(base.passages.map((id) => [id, 4])), prng(3));
    expect(all.slots).toHaveLength(5);
    expect(all.slots.every(({ round }) => round === 2)).toBe(true);
  });

  it('reads the score B had in the blind round from the first time each passage was shown', () => {
    const blind: BlindFile = {
      dropped: ['A'],
      rates: {},
      passages: [
        { id: 'P001', items: [{ hash: 'h1', variants: ['E'] }, { hash: 'h2', variants: ['B', 'C'] }] },
        { id: 'P002', items: [{ hash: 'h3', variants: ['B'] }] },
        { id: 'P003', items: [{ hash: 'h4', variants: ['B'] }] },
        { id: 'P004', items: [{ hash: 'h5', variants: ['E'] }] },
      ],
      slots: [
        { slot: 1, passage: 'P001', round: 1, order: [1, 0] },
        { slot: 2, passage: 'P002', round: 1, order: [0] },
        { slot: 3, passage: 'P002', round: 2, order: [0] },
        { slot: 4, passage: 'P003', round: 1, order: [0] },
        { slot: 5, passage: 'P004', round: 1, order: [0] },
      ],
    };
    const scores = { '1': { '0': 2, '1': 5 }, '2': { '0': 3 }, '3': { '0': 1 }, '5': { '0': 4 } };
    expect(previousScores(blind, scores, 'B')).toEqual(new Map([['P001', 5], ['P002', 3]]));
  });

  it('leaves out what B did not translate, and scores nothing when B lost more than a tenth', () => {
    const base = buildSample(fakeOutputs(IDS), FILE, HALF, new Map(), prng(3));
    const lost = base.passages.slice(0, 3);
    const sample = buildSample(fakeOutputs(IDS, lost), FILE, HALF, new Map(), prng(3));
    expect(sample.rate).toBeCloseTo(0.1);
    expect(sample.dropped).toBe(false);
    expect(sample.passages).toEqual(base.passages);
    expect(sample.failed).toEqual(lost);
    expect(sample.slots.some(({ passage }) => lost.includes(passage))).toBe(false);
    const extra = IDS.find((id) => !lost.includes(id)) ?? '';
    const dropped = buildSample(fakeOutputs(IDS, [...lost, extra]), FILE, HALF, new Map([[base.passages[5] ?? '', 4]]), prng(3));
    expect(dropped).toMatchObject({ dropped: true, reused: {}, slots: [] });
  });

  it('refuses before B has finished', () => {
    const outputs = fakeOutputs(IDS);
    const unfinished = { ...outputs, B: { ...outputs['B'], passages: { P001: { status: 'missing', text: null, issues: [] } } } } as OutputFile;
    expect(() => buildSample(unfinished, FILE, HALF, new Map(), prng(1))).toThrow(/has not finished/);
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

describe('the scoring page (ADR-0139 items 8 and 16)', () => {
  it("shows the source and B's translation, and says the maintainer knows which model it is", () => {
    const model = { base: '/t/', slot: { slot: 1, passage: 'P001', round: 1 as const }, total: 20, scored: 0, code: 'B', model: 'claude-sonnet-5-5', source: 'The <warden> & co.', text: '譯：甲', given: undefined, notice: null, missing: false };
    const html = renderScorePage(model);
    expect(html).toContain('The &lt;warden&gt; &amp; co.');
    expect(html).toContain('譯：甲');
    expect(html).toContain('B 組的譯文');
    expect(html).toContain('claude-sonnet-5-5');
    expect(html).toContain('不是盲評');
    expect(html.match(/type="radio"/g)).toHaveLength(5);
    expect(html).not.toContain(' checked');
    expect(renderScorePage({ ...model, given: 4 }).match(/ checked/g)).toHaveLength(1);
  });

  it('saves each passage as it is scored, refuses one without a score, and picks up where it stopped', async () => {
    const dir = tempDir();
    const outputs = fakeOutputs(IDS);
    const sample = buildSample(outputs, FILE, HALF, new Map(), prng(3));
    const sources = new Map(IDS.map((id) => [id, `Source of ${id}.`]));
    const options = { dir, sample, outputs, sources, model: 'claude-sonnet-5-5' };
    const [first, second] = sample.slots;
    if (first === undefined || second === undefined) throw new Error('no slots');
    const server = await startScoreServer(options);
    const origin = new URL(server.url).origin;
    const post = (path: string, body: string) =>
      call(new URL(path, server.url).toString(), { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body });
    try {
      const page = await call(server.url);
      expect(page.status).toBe(200);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.body).toContain(`Source of ${first.passage}.`);
      expect(page.body).toContain(`譯：${first.passage}`);
      const none = await post(`slots/${first.slot}`, '');
      expect(none.status).toBe(422);
      expect(none.body).toContain('role="alert"');
      expect(existsSync(join(dir, 'sample-scores.json'))).toBe(false);
      const saved = await post(`slots/${first.slot}`, 'score=4');
      expect(saved.status).toBe(303);
      expect(new URL(saved.headers.location ?? '', server.url).searchParams.get('slot')).toBe(String(second.slot));
      expect(readSampleScores(dir)).toEqual({ [String(first.slot)]: 4 });
      expect((await post(`slots/${first.slot}`, 'score=9')).status).toBe(422);
      expect((await post('slots/999', 'score=4')).status).toBe(404);
      expect((await call(new URL('app.js', server.url).toString())).body).not.toMatch(/\b(fetch|localStorage|sessionStorage)\b/);
    } finally {
      await server.close();
    }
    const again = await startScoreServer(options);
    try {
      expect((await call(again.url)).body).toContain(`Source of ${second.passage}.`);
    } finally {
      await again.close();
    }
  });

  it('says so when every passage is scored', async () => {
    const dir = tempDir();
    const outputs = fakeOutputs(IDS);
    const sample = buildSample(outputs, FILE, HALF, new Map(), prng(3));
    writeFileSync(join(dir, 'sample-scores.json'), JSON.stringify(Object.fromEntries(sample.slots.map(({ slot }) => [String(slot), 4]))));
    const server = await startScoreServer({ dir, sample, outputs, sources: new Map(), model: 'claude-sonnet-5-5' });
    try {
      expect((await call(server.url)).body).toContain('都評完了');
    } finally {
      await server.close();
    }
  });
});

describe('the report (ADR-0139 items 9, 10, 12 and 16)', () => {
  /** 這次評的每段給 `first` 分，重複的那一次給 `again` 分。 */
  function scored(sample: SampleFile, first = 4, again = 5): Record<string, number> {
    return Object.fromEntries(sample.slots.map(({ slot, round }) => [String(slot), round === 2 ? again : first]));
  }

  /** 抽中的前兩段在盲評時評過：5 分與 3 分。 */
  function carried(): SampleFile {
    const base = buildSample(fakeOutputs(IDS), FILE, HALF, new Map(), prng(3));
    return buildSample(fakeOutputs(IDS), FILE, HALF, new Map([[base.passages[0] ?? '', 5], [base.passages[1] ?? '', 3]]), prng(3));
  }

  it('averages each passage once, keeps carried-over scores apart from new ones, and checks the repeats', () => {
    expect(summarize([4, 5, 3, 4])).toMatchObject({ n: 4, mean: 4, counts: [0, 0, 1, 2, 1] });
    expect(summarize([4]).half).toBe(0);
    expect(Number.isNaN(summarize([]).mean)).toBe(true);
    const sample = carried();
    const scores = scored(sample);
    const split = sampleScores(sample, scores);
    expect(split.all).toHaveLength(15);
    expect([...split.reused].sort()).toEqual([3, 5]);
    expect(split.fresh).toEqual(Array.from({ length: 13 }, () => 4));
    expect(sampleScores(sample, {}).fresh).toEqual([]);
    expect(consistency(sample, scores)).toMatchObject({ repeats: 5, pairs: 5, exact: 0, mad: 1, within: 1, stable: true });
    // 重複題的第一次是沿用的分數時，拿它來比。
    const all = buildSample(fakeOutputs(IDS), FILE, HALF, new Map(sample.passages.map((id) => [id, 2])), prng(3));
    expect(consistency(all, scored(all))).toMatchObject({ repeats: 5, pairs: 5, exact: 0, mad: 3, within: 0, stable: false });
  });

  it('writes numbers, settings and the index only, marks the other variants unscored, and judges Q-8 on B', () => {
    const sample = carried();
    const found = results(VARIANTS, fakeOutputs(IDS), sample, scored(sample));
    expect(found.q8).toMatchObject({ code: 'B', rate: 0, pass: true });
    expect(found.q8.mean).toBeCloseTo(4);
    expect(found.summary.n).toBe(15);
    expect(found.reused).toMatchObject({ n: 2, mean: 4 });
    expect(found.fresh).toMatchObject({ n: 13, mean: 4 });
    expect(found.variants.find(({ code }) => code === 'A')).toMatchObject({ scored: false, dropped: true, rate: 1 });
    expect(found.variants.find(({ code }) => code === 'B')).toMatchObject({ scored: true, dropped: false, rate: 0 });
    expect(found.variants.find(({ code }) => code === 'E')).toMatchObject({ scored: false, issues: 30 });
    const estimate = {
      budget_usd: 30,
      over: false,
      estimate: { low_usd: 1, high_usd: 2 },
      variants: VARIANTS.map(({ code, model }) => ({ code, model, estimate: { low_usd: 0.1, high_usd: 0.2 }, books: [{ book: 'orc', requests: 30, units: 30, estimate: { low_usd: 0.1, high_usd: 0.2 }, prompt_hash: 'c'.repeat(64), pack_hash: 'd'.repeat(64) }] })),
    };
    const markdown = renderReport({ date: '2026-11-21', commit: 'abc1234', sdk: '0.137.0', specs: VARIANTS, file: FILE, sample, estimate, results: found });
    expect(markdown).toContain('abc1234');
    expect(markdown).toContain('a'.repeat(64));
    expect(markdown).toContain('| 15 | 4.00 |');
    // 分數的定義跟評分頁同一套。
    expect(markdown).toContain('* 4 分：可以直接上桌。');
    expect(markdown).toContain('* 5 分：很好，讀起來像原本就用中文寫的。');
    expect(markdown).toContain('不是盲評');
    expect(markdown).toContain('沿用');
    expect(markdown.match(/\| 未經人評 \|/g)).toHaveLength(5);
    expect(markdown).toContain('| B | 15 段 |');
    expect(markdown).toContain('達標');
    expect(markdown).not.toContain('譯：');
    expect(markdown).not.toContain('Source of');
    const chosen = passageOf(sample.passages[0] ?? '');
    expect(markdown).toContain(`| ${chosen.id} | ${chosen.book} | ${chosen.role} | 40 | \`${chosen.blocks[0]}\` | 1 | 是 |`);
    const skipped = passageOf(IDS.find((id) => !sample.passages.includes(id)) ?? '');
    expect(markdown).toContain(`| ${skipped.id} | ${skipped.book} | ${skipped.role} | 40 | \`${skipped.blocks[0]}\` | 1 |  |`);
    expect(results(VARIANTS, fakeOutputs(IDS), sample, scored(sample, 2, 2)).q8.pass).toBe(false);
  });
});

describe('node tools/eval.ts (ADR-0139 items 13 and 16)', () => {
  it('walks select, estimate, run, score and report, and carries over a score from the blind round', async () => {
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
      // 指令的接線只要一組就看得到；6 組由「runs the six variants」走過（ADR-0140）。
      variants: ONLY_B,
    };
    expect(await main(['estimate'], io)).toBe(2);
    expect(await main(['estimate', '--dir', dir], io)).toBe(1);
    expect(await main(['select', '--dir', dir, '--orc', 'book', '--cthulhu', 'tale', '--seed', '7'], io)).toBe(0);
    // 合成的書段落不夠 60 加 40，全部挑：orc 18 段、tale 8 段。
    expect(said).toContain('挑好 26 段');
    expect(await main(['run', '--dir', dir], io)).toBe(1);
    expect(await main(['estimate', '--dir', dir], io)).toBe(0);
    expect(said).toContain('B claude-sonnet-5-5：26 個請求');
    expect(said).not.toContain('claude-haiku-5-5');
    expect(await main(['run', '--dir', dir], io)).toBe(0);
    expect(said).toContain('都跑完了');
    expect(await main(['report', '--dir', dir, '--commit', 'abc1234', '--out', join(tempDir(), 'early.md')], io)).toBe(1);
    // 之前的盲評評過 P001：B 跟 C、D、F 一樣的那一則給了 5 分。
    const blind: BlindFile = { dropped: [], rates: {}, passages: [{ id: 'P001', items: [{ hash: 'h', variants: ['B', 'C', 'D', 'F'] }] }], slots: [{ slot: 1, passage: 'P001', round: 1, order: [0] }] };
    writeFileSync(join(dir, 'blind.json'), JSON.stringify(blind));
    writeFileSync(join(dir, 'scores.json'), JSON.stringify({ '1': { '0': 5 } }));
    const scoring = main(['score', '--dir', dir], io);
    await new Promise((resolve) => setTimeout(resolve, 300));
    finish();
    expect(await scoring).toBe(0);
    // 合成的書不夠 30 加 20，全部抽：26 段，P001 沿用盲評的分數。
    const sample = JSON.parse(readFileSync(join(dir, 'sample.json'), 'utf8')) as SampleFile;
    expect(sample.passages).toHaveLength(26);
    expect(sample.reused).toEqual({ P001: 5 });
    expect(sample.slots).toHaveLength(30);
    expect(said).toContain('沿用');
    const out = join(tempDir(), 'evals', 'report.md');
    expect(await main(['report', '--dir', dir, '--commit', 'abc1234', '--out', out], io)).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('2026-11-20');
    expect(said).not.toContain('The warden rolls');
  });
});
