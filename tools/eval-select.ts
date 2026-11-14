import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { bookDir, readBook } from '../src/core/book.ts';
import { planBook, type PlannedRequest } from '../src/core/request.ts';
import { openBookStore } from '../src/core/store.ts';
import { workspacePii } from '../src/core/workspace.ts';

// 盲評的黃金段落（ADR-0139 第 3 項）：從維護者工作區的公開書照角色分層隨機挑，種子固定，不手挑。
// 一段是一組單位（表格、清單的一組，或單獨一段），跟產品一樣只挑會送到模型的；不需翻譯與在本機欄位化的不挑。
// 維護者的工作區只讀：書的 `book.yaml` 與 document 層複製到評測資料夾，`book.db` 在那裡另開。

export const PASSAGE_FILE = 'passages.json';
export const REVIEW_FILE = 'passages-review.html';
/** 每個角色至少挑這麼多段（那個角色的段落夠的話），少見的角色才挑得到。 */
export const ROLE_FLOOR = 2;
/** 給規劃用的模型，挑段落不送出任何請求。 */
const PLANNING_MODEL = 'claude-sonnet-5-5';

export interface BookSpec {
  /** 評測裡的代號，例如 `orc`、`cthulhu`。 */
  readonly label: string;
  /** 維護者工作區裡的書。 */
  readonly slug: string;
  readonly quota: number;
}

export interface Passage {
  readonly id: string;
  readonly book: string;
  /** 第一個單位的編號，重新挑時用它認段落。 */
  readonly key: string;
  readonly role: string;
  readonly units: readonly string[];
  readonly blocks: readonly string[];
  readonly chars: number;
}

export interface PassageFile {
  readonly seed: number;
  readonly books: readonly (BookSpec & { readonly document_sha256: string })[];
  /** 維護者剔除的段落（`key`），重新挑時跳過、補別的。 */
  readonly excluded: readonly string[];
  readonly passages: readonly Passage[];
}

/** mulberry32：同一個種子挑出同樣的段落。 */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const list = [...items];
  for (let index = list.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [list[index], list[other]] = [list[other] as T, list[index] as T];
  }
  return list;
}

/**
 * 每個角色挑幾段：先給每個角色至少 `ROLE_FLOOR` 段，剩下的照各角色還能挑的數量比例分，零頭給餘數大的
 * （同分照角色名）。段落不夠時全部挑。角色比名額還多時，數量少的角色先拿不到保底。
 */
export function allocate(counts: ReadonlyMap<string, number>, total: number, floor: number = ROLE_FLOOR): Map<string, number> {
  const roles = [...counts.keys()].sort();
  const available = roles.reduce((sum, role) => sum + (counts.get(role) ?? 0), 0);
  if (available <= total) return new Map(roles.map((role) => [role, counts.get(role) ?? 0]));
  // 保底照數量由多到少給，名額不夠時少的先沒有。
  const byCount = [...roles].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
  const base = new Map<string, number>(roles.map((role) => [role, 0]));
  let left = total;
  for (const role of byCount) {
    const given = Math.min(floor, counts.get(role) ?? 0, left);
    base.set(role, given);
    left -= given;
  }
  const capacity = new Map(roles.map((role) => [role, (counts.get(role) ?? 0) - (base.get(role) ?? 0)]));
  const room = [...capacity.values()].reduce((sum, value) => sum + value, 0);
  const shares = roles.map((role) => {
    const exact = room === 0 ? 0 : (left * (capacity.get(role) ?? 0)) / room;
    return { role, whole: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let extra = left - shares.reduce((sum, { whole }) => sum + whole, 0);
  for (const { role } of [...shares].sort((a, b) => b.rest - a.rest || a.role.localeCompare(b.role))) {
    if (extra === 0) break;
    const share = shares.find((item) => item.role === role);
    if (share !== undefined && share.whole < (capacity.get(role) ?? 0)) {
      share.whole += 1;
      extra -= 1;
    }
  }
  return new Map(roles.map((role) => [role, (base.get(role) ?? 0) + (shares.find((item) => item.role === role)?.whole ?? 0)]));
}

/** 一個請求是一段：一段一個請求時，計畫裡的每個請求剛好是一組（ADR-0139）。 */
export function passagesOf(requests: readonly PlannedRequest[]): Omit<Passage, 'id' | 'book'>[] {
  return requests.flatMap(({ units }) => {
    const [first] = units;
    if (first === undefined) return [];
    return [
      {
        key: first.unit_id,
        role: first.role,
        units: units.map(({ unit_id }) => unit_id),
        blocks: [...new Set(units.map(({ block_id }) => block_id))],
        chars: units.reduce((sum, { source }) => sum + source.length, 0),
      },
    ];
  });
}

/** 照角色分層，每層隨機挑，挑中的照書裡的順序排。 */
export function pick<T extends { readonly key: string; readonly role: string }>(
  candidates: readonly T[],
  quota: number,
  random: () => number,
  excluded: ReadonlySet<string> = new Set(),
): T[] {
  const usable = candidates.filter(({ key }) => !excluded.has(key));
  const byRole = new Map<string, T[]>();
  for (const candidate of usable) byRole.set(candidate.role, [...(byRole.get(candidate.role) ?? []), candidate]);
  const quotas = allocate(new Map([...byRole].map(([role, list]) => [role, list.length])), quota);
  const chosen = new Set<string>();
  for (const role of [...byRole.keys()].sort()) {
    for (const candidate of shuffled(byRole.get(role) ?? [], random).slice(0, quotas.get(role) ?? 0)) chosen.add(candidate.key);
  }
  return usable.filter(({ key }) => chosen.has(key));
}

/** 種子跟書的代號混在一起，兩本書各用自己的亂數。 */
export function seedOf(seed: number, label: string): number {
  return createHash('sha256').update(`${seed}:${label}`).digest().readUInt32LE(0);
}

/** 評測用的工作區：只有目標語言、規劃用的模型與維護者的個資清單，不放金鑰。 */
export function writeWorkspace(home: string, model: string, pii: readonly string[]): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'tome.yaml'), stringify({ schema: 'tome-workspace/1', target_lang: 'zh-TW', translator_model: model, pii: [...pii] }));
}

/** 書的設定與 document 層複製過去，`book.db` 不複製：實體卡、提要與翻譯記憶都不帶（ADR-0139 第 3 項）。 */
export function copyBook(fromHome: string, toHome: string, slug: string): void {
  const from = bookDir(fromHome, slug);
  const to = bookDir(toHome, slug);
  mkdirSync(join(to, 'ir'), { recursive: true });
  copyFileSync(join(from, 'book.yaml'), join(to, 'book.yaml'));
  copyFileSync(join(from, 'ir', 'document.json'), join(to, 'ir', 'document.json'));
}

export function sourceHome(dir: string): string {
  return join(dir, 'source');
}

export function readPassages(dir: string): PassageFile | null {
  const path = join(dir, PASSAGE_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as PassageFile) : null;
}

export interface SelectOptions {
  readonly dir: string;
  /** 維護者的工作區，只讀。 */
  readonly home: string;
  readonly books: readonly BookSpec[];
  readonly seed: number;
  readonly excluded?: readonly string[];
}

/** 挑段落，寫 `passages.json` 與給維護者看的 `passages-review.html`（有書本文字，只在評測資料夾）。 */
export async function selectPassages({ dir, home, books, seed, excluded = [] }: SelectOptions): Promise<PassageFile> {
  const source = sourceHome(dir);
  writeWorkspace(source, PLANNING_MODEL, workspacePii(home));
  const skip = new Set(excluded);
  const passages: Passage[] = [];
  const specs: (BookSpec & { readonly document_sha256: string })[] = [];
  const texts = new Map<string, string>();
  for (const spec of books) {
    copyBook(home, source, spec.slug);
    const document = readFileSync(join(bookDir(source, spec.slug), 'ir', 'document.json'));
    specs.push({ ...spec, document_sha256: createHash('sha256').update(document).digest('hex') });
    const store = openBookStore(source, spec.slug);
    try {
      const { plan, findings } = await planBook(source, readBook(source, spec.slug), store, 'batch', { cache: null, variant: { separate: true } });
      if (plan === null) throw new Error(`cannot plan ${spec.slug}: ${findings.map(({ code }) => code).join(', ')}`);
      const byId = new Map(plan.units.map((unit) => [unit.unit_id, unit.source]));
      for (const passage of pick(passagesOf(plan.requests), spec.quota, prng(seedOf(seed, spec.label)), skip)) {
        const id = `P${String(passages.length + 1).padStart(3, '0')}`;
        passages.push({ ...passage, id, book: spec.label });
        texts.set(id, passage.units.map((unit) => byId.get(unit) ?? '').join('\n'));
      }
    } finally {
      store.close();
    }
  }
  const file: PassageFile = { seed, books: specs, excluded: [...skip], passages };
  writeFileSync(join(dir, PASSAGE_FILE), `${JSON.stringify(file, null, 2)}\n`);
  writeFileSync(join(dir, REVIEW_FILE), reviewHtml(file, texts));
  return file;
}

/** 段落的原文，一組多個單位時一行一個；評分頁要顯示。從評測資料夾裡的副本算，不讀維護者的工作區。 */
export async function sourceTexts(dir: string, file: PassageFile): Promise<Map<string, string>> {
  const home = sourceHome(dir);
  const texts = new Map<string, string>();
  for (const { label, slug } of file.books) {
    const store = openBookStore(home, slug);
    try {
      const { plan } = await planBook(home, readBook(home, slug), store, 'batch', { cache: null, variant: { separate: true } });
      const byId = new Map((plan?.units ?? []).map((unit) => [unit.unit_id, unit.source]));
      for (const passage of file.passages.filter(({ book }) => book === label)) {
        texts.set(passage.id, passage.units.map((unit) => byId.get(unit) ?? '').join('\n'));
      }
    } finally {
      store.close();
    }
  }
  return texts;
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/** 給維護者看挑出來的段落，只用來剔除解析壞掉的；本機的檔案，不連網、沒有腳本。 */
export function reviewHtml(file: PassageFile, texts: ReadonlyMap<string, string>): string {
  const rows = file.passages
    .map(({ id, book, role, chars }) => `<tr><td>${id}</td><td>${escapeHtml(book)}</td><td>${escapeHtml(role)}</td><td>${chars}</td><td><pre>${escapeHtml(texts.get(id) ?? '')}</pre></td></tr>`)
    .join('\n');
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>passages</title></head><body>',
    '<table>',
    '<tr><th>id</th><th>book</th><th>role</th><th>chars</th><th>text</th></tr>',
    rows,
    '</table>',
    '</body></html>',
    '',
  ].join('\n');
}
