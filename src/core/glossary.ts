import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document, isMap, isScalar, parse, type Pair, type Scalar } from 'yaml';
import { bookDir, readBook, withBookLock, type Book } from './book.ts';
import { sightings, type Sighting } from './candidates.ts';
import { countEntities, entityCards } from './entities.ts';
import { TomeError } from './errors.ts';
import { readDocument } from './extract.ts';
import { finding, type Finding } from './findings.ts';
import { CORE_ROLES, type IrDocument } from './ir.ts';
import { loadSourceLanguage, loadTargetLanguage, scriptViolations, type ScriptCheck } from './language.ts';
import { parseCsv } from './csv.ts';
import type { ResolvedPack } from './pack.ts';
import { applyRenames, type RenameCounts } from './rename.ts';
import type { PlanOutcome } from './request.ts';
import { openBookStore, type Store } from './store.ts';
import { loadBookPack } from './verify.ts';
import { workspaceTargetLang } from './workspace.ts';

// 審定與詞庫（白皮書 §5.6、ADR-0119）。審定的介面是工作區裡的 YAML 檔（ADR-0113 第 16 項）：
// `tome glossary review` 寫出要審的詞，改完再跑一次讀回來，只套用 `decision` 填了的列。
// 檔案裡有書本文字，只留在工作區；訊息只印數量、編號與欄位名（ADR-0059）。

export const REVIEW_FILE = 'glossary-review.yaml';
/** 出現次數乘上類別的 `review_weight` 達到這個數字就要人審。是提案（ADR-0119 第 5 項）。 */
export const REVIEW_THRESHOLD = 5;
/** 訊息裡最多列出幾個有問題的編號。 */
const LISTED = 20;
const GENDERS: ReadonlySet<string> = new Set(['female', 'male', 'none']);
const SECTIONS = ['review', 'locked', 'skipped'] as const;
type Section = (typeof SECTIONS)[number];

/** 審定檔裡給人看的說明與段落標題，由 CLI 從訊息檔帶進來，核心不放給人看的文字。 */
export interface ReviewTexts {
  readonly header: string;
  readonly sections: Readonly<Record<Section, string>>;
}

interface EntityRow {
  readonly id: number;
  readonly source: string;
  readonly target: string | null;
  readonly class: string | null;
  readonly gender: string | null;
  readonly pronoun: string | null;
  readonly register: string | null;
  readonly keep_source: number;
  readonly match: string | null;
  readonly status: string;
  readonly origin: string;
  readonly occurrences: number;
  readonly decided_by: string | null;
  /** 上次寫進審定檔時，可修改欄位正規化後的 JSON（`stored()`）。 */
  readonly review_written: string | null;
}

interface Match {
  readonly case_sensitive?: boolean;
  readonly whole_word?: boolean;
  readonly roles?: readonly string[];
}

/** 鎖定時要寫進 `entity` 的內容。 */
interface Card {
  readonly target: string;
  readonly class: string | null;
  readonly gender: string | null;
  readonly pronoun: string | null;
  readonly register: string | null;
  readonly keep_source: boolean;
  /** 預設的比對條件（區分大小寫、全字、不限角色）存 NULL。 */
  readonly match: string | null;
}

interface Rules {
  readonly classes: ReadonlySet<string>;
  readonly pronouns: ReadonlySet<string>;
  readonly roles: ReadonlySet<string>;
  readonly script: ScriptCheck;
}

type Checked = { readonly ok: true; readonly card: Card } | { readonly ok: false; readonly field: string };

function rulesOf(pack: ResolvedPack, home: string): Rules {
  const { profile } = loadTargetLanguage(workspaceTargetLang(home));
  return {
    classes: pack.classes,
    pronouns: new Set(profile.pronouns),
    roles: new Set([...CORE_ROLES, ...pack.roles.map(({ pack: id, name }) => `${id}:${name}`)]),
    script: profile.script_check,
  };
}

/** 空字串、只有空白與 null 都當成沒填。 */
function blank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function optionalIn(value: unknown, allowed: ReadonlySet<string> | null): string | null | false {
  if (blank(value)) return null;
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return allowed === null || allowed.has(text) ? text : false;
}

function optionalFlag(value: unknown, fallback: boolean): boolean | null {
  if (blank(value)) return fallback;
  return typeof value === 'boolean' ? value : null;
}

/**
 * 人填的內容（ADR-0119 第 13 項）：譯名不能是空的、不能混入簡體字；類別在規則包裡、代名詞在目標語言的清單裡、
 * 性別只收 female、male、none、角色要存在。不合的回第一個有問題的欄位名，不套用。
 */
function checkCard(input: Readonly<Record<string, unknown>>, rules: Rules): Checked {
  const target = input['target'];
  if (typeof target !== 'string' || target.trim() === '') return { ok: false, field: 'target' };
  if (scriptViolations(rules.script, target).length > 0) return { ok: false, field: 'target' };
  const kind = optionalIn(input['class'], rules.classes);
  if (kind === false) return { ok: false, field: 'class' };
  const gender = optionalIn(input['gender'], GENDERS);
  if (gender === false) return { ok: false, field: 'gender' };
  const pronoun = optionalIn(input['pronoun'], rules.pronouns);
  if (pronoun === false) return { ok: false, field: 'pronoun' };
  const register = optionalIn(input['register'], null);
  if (register === false) return { ok: false, field: 'register' };
  const keep = optionalFlag(input['keep_source'], false);
  if (keep === null) return { ok: false, field: 'keep_source' };
  const caseSensitive = optionalFlag(input['case_sensitive'], true);
  if (caseSensitive === null) return { ok: false, field: 'case_sensitive' };
  const wholeWord = optionalFlag(input['whole_word'], true);
  if (wholeWord === null) return { ok: false, field: 'whole_word' };
  const roles = input['roles'];
  if (!blank(roles) && (!Array.isArray(roles) || roles.some((role) => typeof role !== 'string' || !rules.roles.has(role)))) {
    return { ok: false, field: 'roles' };
  }
  const roleList = Array.isArray(roles) ? (roles as string[]) : [];
  const match: Match = {
    ...(caseSensitive ? {} : { case_sensitive: false }),
    ...(wholeWord ? {} : { whole_word: false }),
    ...(roleList.length === 0 ? {} : { roles: roleList }),
  };
  return {
    ok: true,
    card: {
      target: target.trim(),
      class: kind,
      gender,
      pronoun,
      register,
      keep_source: keep,
      match: Object.keys(match).length === 0 ? null : JSON.stringify(match),
    },
  };
}

function entityById(store: Store, id: number): EntityRow | undefined {
  return store.get<EntityRow>('SELECT * FROM entity WHERE id = ?', id);
}

function entityBySource(store: Store, source: string): EntityRow | undefined {
  return store.get<EntityRow>('SELECT * FROM entity WHERE source = ?', source);
}

/** 鎖定。已鎖定的改了譯名，記下上一個（037 的 S-16 要用，ADR-0119 第 9 項）。 */
function lock(store: Store, row: EntityRow, card: Card, by: 'human' | 'import', origin?: string): void {
  const previous = row.status === 'locked' && row.target !== null && row.target !== card.target ? row.target : null;
  store.run(
    `UPDATE entity SET status = 'locked', target = ?, class = ?, gender = ?, pronoun = ?, register = ?, keep_source = ?,
       match = ?, decided_by = ?, decided_at = ?, previous_target = COALESCE(?, previous_target), origin = ?, updated_at = ?
     WHERE id = ?`,
    card.target,
    card.class,
    card.gender,
    card.pronoun,
    card.register,
    card.keep_source ? 1 : 0,
    card.match,
    by,
    new Date().toISOString(),
    previous,
    origin ?? row.origin,
    new Date().toISOString(),
    row.id,
  );
}

function reject(store: Store, row: EntityRow): void {
  const now = new Date().toISOString();
  store.run("UPDATE entity SET status = 'rejected', decided_by = 'human', decided_at = ?, updated_at = ? WHERE id = ?", now, now, row.id);
}

/** 審定檔裡的一列，比對條件攤開成平的欄位跟 CSV 一樣驗證。 */
function flatten(entry: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const match = entry['match'];
  const fields = match !== null && typeof match === 'object' && !Array.isArray(match) ? (match as Record<string, unknown>) : {};
  return { ...entry, case_sensitive: fields['case_sensitive'], whole_word: fields['whole_word'], roles: fields['roles'] };
}

type Entry = Readonly<Record<string, unknown>>;

interface Applied {
  readonly locked: number;
  readonly rejected: number;
  /** `id:欄位`，id 不是整數時寫第幾筆。 */
  readonly problems: readonly string[];
  /**
   * 照人填的樣子寫回去的列，鍵是 id（ADR-0119）：有問題沒套用的（只要改點名的欄位），以及改了內容、還沒填
   * decision 的。這些卡這次不自動鎖定。
   */
  readonly kept: ReadonlyMap<number, Entry>;
  /** id 不對、找不到卡的列，也照原樣寫回去。 */
  readonly orphans: readonly Entry[];
  /** 人改了、資料庫在上次寫出審定檔之後也被改了的卡（例如匯入），保留人填的，要人確認。 */
  readonly diverged: readonly number[];
}

const NOTHING_APPLIED: Applied = { locked: 0, rejected: 0, problems: [], kept: new Map(), orphans: [], diverged: [] };

/** 讀回審定檔，只套用 `decision` 填了 `lock` 或 `reject` 的列（ADR-0119 第 4 項）。檔案壞了回 null，什麼都不改。 */
function readDecisions(path: string): Entry[] | null {
  let value: unknown;
  try {
    value = parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries: Entry[] = [];
  for (const section of SECTIONS) {
    const list = (value as Record<string, unknown>)[section];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) return null;
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
      entries.push(entry as Record<string, unknown>);
    }
  }
  return entries;
}

/** 空白、null 與預設值換成同一個樣子，YAML 讀回來的 `false`、寫出來的預設比對條件才不會被當成有改。 */
function plain(value: unknown): unknown {
  if (blank(value)) return null;
  return typeof value === 'string' ? value.trim() : value;
}

/** 可修改的欄位：人填的（`entry`）與 `book.db` 的（`row`）正規化成同一種寫法再比。 */
function editable(entry: Entry): string {
  const flat = flatten(entry);
  const flag = (value: unknown, fallback: boolean): unknown => (blank(value) ? fallback : value);
  return JSON.stringify([
    plain(flat['target']),
    plain(flat['class']),
    plain(flat['gender']),
    plain(flat['pronoun']),
    plain(flat['register']),
    flag(flat['keep_source'], false),
    flag(flat['case_sensitive'], true),
    flag(flat['whole_word'], true),
    blank(flat['roles']) ? [] : flat['roles'],
  ]);
}

function stored(row: EntityRow): string {
  const match = matchOf(row);
  return JSON.stringify([
    plain(row.target),
    plain(row.class),
    plain(row.gender),
    plain(row.pronoun),
    plain(row.register),
    row.keep_source === 1,
    match.case_sensitive,
    match.whole_word,
    match.roles ?? [],
  ]);
}

type Change = 'none' | 'database' | 'person' | 'both';

/**
 * 沒填 decision 的列是誰改的（ADR-0119，維護者選的）：人填的（`mine`）、`book.db` 的（`theirs`）各跟上次寫進審定檔的
 * （`written`）比。`none` 與 `database` 照 `book.db` 重寫，匯入改的譯名才會出現在檔案裡；`person` 與 `both` 保留人填的。
 * 舊版寫的檔或人自己加的列沒有 `written`，就跟 `book.db` 比。人填的跟 `book.db` 一樣時重寫也不會少東西。
 */
function whatChanged(mine: string, theirs: string, written: string | null): Change {
  if (mine === theirs) return 'none';
  if (written === null) return 'person';
  if (mine === written) return 'database';
  return theirs === written ? 'person' : 'both';
}

function applyDecisions(store: Store, entries: readonly Entry[], rules: Rules): Applied {
  let locked = 0;
  let rejected = 0;
  const problems: string[] = [];
  const kept = new Map<number, Entry>();
  const orphans: Entry[] = [];
  const diverged: number[] = [];
  store.transaction(() => {
    entries.forEach((entry, index) => {
      const decision = typeof entry['decision'] === 'string' ? entry['decision'].trim().toLowerCase() : entry['decision'];
      const id = entry['id'];
      const label = typeof id === 'number' && Number.isInteger(id) ? String(id) : `#${index + 1}`;
      const row = typeof id === 'number' && Number.isInteger(id) ? entityById(store, id) : undefined;
      if (blank(decision)) {
        // 沒填 decision 的修改不套用，但照人填的樣子留在檔案裡（Manager 審 PR 68 時找到，維護者選的，ADR-0119）。
        if (row === undefined) {
          orphans.push(entry);
          return;
        }
        const change = whatChanged(editable(entry), stored(row), row.review_written);
        if (change === 'none' || change === 'database') return;
        kept.set(row.id, entry);
        if (change === 'both') diverged.push(row.id);
        return;
      }
      if (row === undefined) {
        problems.push(`${label}:id`);
        orphans.push(entry);
        return;
      }
      if (decision === 'reject') {
        reject(store, row);
        rejected += 1;
        return;
      }
      if (decision !== 'lock') {
        problems.push(`${label}:decision`);
        kept.set(row.id, entry);
        return;
      }
      const checked = checkCard(flatten(entry), rules);
      if (!checked.ok) {
        problems.push(`${label}:${checked.field}`);
        kept.set(row.id, entry);
        return;
      }
      lock(store, row, checked.card, 'human');
      locked += 1;
    });
  });
  return { locked, rejected, problems, kept, orphans, diverged };
}

/** 類別的審定權重，繼承鏈由子到父，子包的優先，沒設是 1（ADR-0119 第 5 項）。 */
function weights(pack: ResolvedPack): (kind: string | null) => number {
  const found = new Map<string, number>();
  for (const { content } of pack.chain) {
    for (const [name, definition] of Object.entries(content.classes)) {
      const weight = (definition as { review_weight?: number }).review_weight;
      if (!found.has(name) && weight !== undefined) found.set(name, weight);
    }
  }
  return (kind) => (kind === null ? 1 : (found.get(kind) ?? 1));
}

/**
 * 要人審的條件（ADR-0119 第 5 項）：出現次數乘權重達 5、有性別或代名詞的提議、`keep_source`、來自
 * `<new-term>`。其餘的提議自動鎖定。
 */
export function needsHuman(row: Pick<EntityRow, 'origin' | 'gender' | 'pronoun' | 'keep_source' | 'occurrences' | 'class'>, weightOf: (kind: string | null) => number): boolean {
  return (
    row.origin === 'new_term' ||
    row.gender !== null ||
    row.pronoun !== null ||
    row.keep_source === 1 ||
    row.occurrences * weightOf(row.class) >= REVIEW_THRESHOLD
  );
}

/** 人這次改過但沒套用成功的卡不自動鎖定，等人修正。 */
function autoLock(store: Store, weightOf: (kind: string | null) => number, touched: ReadonlyMap<number, Entry>): number {
  const rows = store.all<EntityRow>("SELECT * FROM entity WHERE status = 'proposed'");
  const now = new Date().toISOString();
  let count = 0;
  store.transaction(() => {
    for (const row of rows) {
      if (needsHuman(row, weightOf) || row.target === null || touched.has(row.id)) continue;
      store.run("UPDATE entity SET status = 'locked', decided_by = 'auto', decided_at = ?, updated_at = ? WHERE id = ?", now, now, row.id);
      count += 1;
    }
  });
  return count;
}

/**
 * 翻譯回報的 `<new-term>` 收進同一個佇列（白皮書 §5.6、ADR-0119 第 8 項）。`issue` 表的 `detail` 是原文與模型的譯名。
 * 已有同一個原文的不新增；出現次數照全書重算。
 */
function collectNewTerms(store: Store, document: IrDocument, book: Book): number {
  const rows = store.all<{ detail: string | null }>("SELECT DISTINCT detail FROM issue WHERE code = 'new_term'");
  const found = new Map<string, string | null>();
  for (const { detail } of rows) {
    if (detail === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(detail);
    } catch {
      continue;
    }
    const { source, target } = (parsed ?? {}) as { source?: unknown; target?: unknown };
    if (typeof source !== 'string' || source.trim() === '') continue;
    const text = source.trim();
    if (found.has(text) || entityBySource(store, text) !== undefined) continue;
    found.set(text, typeof target === 'string' && target.trim() !== '' ? target.trim() : null);
  }
  if (found.size === 0) return 0;
  const { profile } = loadSourceLanguage(book.config.source_lang);
  const seen = sightings(document, profile, [...found.keys()]);
  const now = new Date().toISOString();
  store.transaction(() => {
    for (const [source, target] of found) {
      const sighting = seen.get(source);
      store.run(
        `INSERT INTO entity (source, target, status, origin, sources, occurrences, first_block, created_at, updated_at)
         VALUES (?, ?, 'proposed', 'new_term', '[]', ?, ?, ?, ?)`,
        source,
        target,
        sighting?.occurrences ?? 0,
        sighting?.firstBlock ?? null,
        now,
        now,
      );
    }
  });
  return found.size;
}

function matchOf(row: EntityRow): { case_sensitive: boolean; whole_word: boolean; roles?: readonly string[] } {
  const stored = row.match === null ? {} : (JSON.parse(row.match) as Match);
  return {
    case_sensitive: stored.case_sensitive ?? true,
    whole_word: stored.whole_word ?? true,
    ...(stored.roles === undefined ? {} : { roles: stored.roles }),
  };
}

function entryOf(row: EntityRow, section: Section, seen: ReadonlyMap<string, Sighting>): Record<string, unknown> {
  return {
    id: row.id,
    source: row.source,
    target: row.target,
    class: row.class,
    gender: row.gender,
    pronoun: row.pronoun,
    register: row.register,
    keep_source: row.keep_source === 1,
    match: matchOf(row),
    count: row.occurrences,
    origin: row.origin,
    ...(section === 'locked' ? { decided_by: row.decided_by } : { seen_in: seen.get(row.source)?.contexts ?? [] }),
    decision: null,
  };
}

/** 要人審的排前面：影響大的先審。 */
function sections(store: Store, weightOf: (kind: string | null) => number): Record<Section, EntityRow[]> {
  const all = store.all<EntityRow>('SELECT * FROM entity ORDER BY id');
  const impact = (row: EntityRow): number => row.occurrences * weightOf(row.class);
  return {
    review: all.filter(({ status }) => status === 'proposed' || status === 'failed').sort((a, b) => impact(b) - impact(a) || a.id - b.id),
    locked: all.filter(({ status }) => status === 'locked'),
    skipped: all.filter(({ status }) => status === 'skipped').sort((a, b) => b.occurrences - a.occurrences || a.id - b.id),
  };
}

/**
 * 寫出審定檔。從 `book.db` 寫出的列記下寫了什麼（`review_written`），下次讀回才分得出誰改的；照人填的樣子寫回的列
 * 不記，下次還是看得出人改過。
 *
 * 先寫暫存檔、改名，**改名成功才記**。Windows 上檔案被編輯器、防毒或同步軟體鎖住時改名會失敗；先記的話，
 * `book.db` 記成新的內容而檔案還是舊的，下次人沒動、資料庫改過的列會被當成人改的，舊譯名又留下來。反過來，
 * 改名成功、記錄失敗時，檔案是剛從 `book.db` 寫出的，下次讀回跟 `book.db` 相同，不會判錯。
 */
function writeReview(
  store: Store,
  path: string,
  groups: Record<Section, EntityRow[]>,
  seen: ReadonlyMap<string, Sighting>,
  texts: ReviewTexts,
  applied: Applied,
): void {
  // 沒套用的列照人填的樣子放回原來的段落；卡不在任何一段的（例如已拒絕），跟 id 不對的一起放在要審的最前面。
  const shown = new Set(SECTIONS.flatMap((section) => groups[section].map(({ id }) => id)));
  const homeless = [...applied.orphans, ...[...applied.kept].filter(([id]) => !shown.has(id)).map(([, entry]) => entry)];
  const data = Object.fromEntries(
    SECTIONS.map((section) => [
      section,
      [
        ...(section === 'review' ? homeless : []),
        ...groups[section].map((row) => applied.kept.get(row.id) ?? entryOf(row, section, seen)),
      ],
    ]),
  );
  const document = new Document(data);
  document.commentBefore = texts.header;
  const contents = document.contents;
  if (isMap(contents)) {
    for (const item of contents.items as Pair<Scalar, unknown>[]) {
      const key = item.key;
      if (isScalar(key) && typeof key.value === 'string' && (SECTIONS as readonly string[]).includes(key.value)) {
        key.commentBefore = texts.sections[key.value as Section];
        key.spaceBefore = true;
      }
    }
  }
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, document.toString({ nullStr: '', lineWidth: 0 }));
  renameSync(temporary, path);
  store.transaction(() => {
    for (const row of SECTIONS.flatMap((section) => groups[section])) {
      if (!applied.kept.has(row.id)) store.run('UPDATE entity SET review_written = ? WHERE id = ?', stored(row), row.id);
    }
  });
}

function listed(problems: readonly string[]): string {
  return `${problems.slice(0, LISTED).join(', ')}${problems.length > LISTED ? ', …' : ''}`;
}

export interface ReviewOptions {
  readonly home: string;
  readonly slug: string;
  readonly texts: ReviewTexts;
}

async function reviewLocked({ home, slug, texts }: ReviewOptions): Promise<PlanOutcome> {
  const book = readBook(home, slug);
  const document = readDocument(home, slug);
  const { pack, findings } = loadBookPack(home, book);
  if (pack === null) return { data: { book: slug }, findings };
  const rules = rulesOf(pack, home);
  const weightOf = weights(pack);
  const path = join(bookDir(home, slug), REVIEW_FILE);
  const store = openBookStore(home, slug);
  try {
    let applied = NOTHING_APPLIED;
    const before = entityCards(store);
    if (existsSync(path)) {
      const entries = readDecisions(path);
      // 檔案讀不懂時什麼都不改，也不覆蓋，改到一半的內容才不會不見。
      if (entries === null) return { data: { book: slug, path }, findings: [finding('glossary.file_invalid', 'fail', { path })] };
      applied = applyDecisions(store, entries, rules);
    }
    // 改了已鎖定的卡，當下做 S-16（ADR-0120）。
    const renamed = await applyRenames({ home, book, store, pack, before });
    const added = collectNewTerms(store, document, book);
    const auto = autoLock(store, weightOf, applied.kept);
    const groups = sections(store, weightOf);
    const { profile } = loadSourceLanguage(book.config.source_lang);
    const seen = sightings(document, profile, [...groups.review, ...groups.skipped].map(({ source }) => source));
    writeReview(store, path, groups, seen, texts, applied);
    const totals = countEntities(store);
    const params = {
      book: slug,
      path,
      applied: String(applied.locked + applied.rejected),
      new_terms: String(added),
      auto: String(auto),
      review: String(totals.review),
      locked: String(totals.locked),
      rejected: String(totals.rejected),
      skipped: String(totals.skipped),
    };
    const problems = applied.problems.length === 0
      ? []
      : [finding('glossary.bad_entries', 'fail', { count: String(applied.problems.length), entries: listed(applied.problems) })];
    // 人改了、資料庫也改了：保留人填的，只印筆數與編號，提醒確認後再填 decision（ADR-0119）。
    const diverged = applied.diverged.length === 0
      ? []
      : [finding('glossary.diverged', 'warn', { count: String(applied.diverged.length), entries: listed(applied.diverged.map(String)) })];
    return {
      data: {
        book: slug,
        path,
        applied: { locked: applied.locked, rejected: applied.rejected },
        new_terms: added,
        auto,
        entities: totals,
        problems: applied.problems.length,
        diverged: applied.diverged.length,
        ...(renamed === null ? {} : { renamed }),
      },
      findings: [finding('glossary.reviewed', 'info', params), ...renamedFindings(slug, renamed), ...problems, ...diverged, ...findings],
    };
  } finally {
    store.close();
  }
}

/** `tome glossary review`。一本書同時只跑一個流程（ADR-0054）。 */
export function reviewGlossary(options: ReviewOptions): Promise<PlanOutcome> {
  return withBookLock(options.home, options.slug, () => reviewLocked(options));
}

const CSV_COLUMNS: ReadonlySet<string> = new Set([
  'source',
  'target',
  'class',
  'gender',
  'pronoun',
  'register',
  'keep_source',
  'case_sensitive',
  'whole_word',
]);
const TRUE_WORDS: ReadonlySet<string> = new Set(['true', 'yes', '1']);
const FALSE_WORDS: ReadonlySet<string> = new Set(['false', 'no', '0']);

/** CSV 的格子都是文字，是非欄位先換成布林；看不懂的照原樣留著，驗證時回報。 */
function csvFlag(value: string | undefined): unknown {
  if (value === undefined || value.trim() === '') return null;
  const word = value.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return value;
}

function readDocumentOrNull(home: string, slug: string): IrDocument | null {
  try {
    return readDocument(home, slug);
  } catch {
    return null;
  }
}

export interface ImportOptions {
  readonly home: string;
  readonly slug: string;
  readonly csv: string;
}

/**
 * `tome glossary import`：使用者自己的譯名直接鎖定，`origin` 是 `import`，同一個原文已有的就覆蓋（ADR-0119 第 7 項）。
 * 有問題的列不匯入，其他照樣匯入，訊息只印列號與欄位名。
 */
async function importLocked({ home, slug, csv }: ImportOptions): Promise<PlanOutcome> {
  const book = readBook(home, slug);
  let text: string;
  try {
    text = readFileSync(csv, 'utf8');
  } catch {
    throw new TomeError('glossary.csv_missing', { path: csv });
  }
  const parsed = parseCsv(text);
  if (!parsed.ok) return { data: { book: slug }, findings: [finding('glossary.csv_invalid', 'fail', { row: String(parsed.row) })] };
  const [header, ...records] = parsed.rows;
  const columns = (header?.fields ?? []).map((name) => name.trim().toLowerCase());
  const unknown = columns.filter((name) => !CSV_COLUMNS.has(name));
  if (unknown.length > 0 || !columns.includes('source') || !columns.includes('target')) {
    return { data: { book: slug }, findings: [finding('glossary.csv_columns', 'fail', { columns: unknown.join(', ') || '-' })] };
  }
  const { pack, findings } = loadBookPack(home, book);
  if (pack === null) return { data: { book: slug }, findings };
  const rules = rulesOf(pack, home);
  // 試算表存出來的空白列是一排逗號，跟空行一樣跳過。
  const rows = records
    .filter(({ fields }) => fields.some((value) => value.trim() !== ''))
    .map(({ row, fields }) => ({ row, cells: Object.fromEntries(columns.map((name, index) => [name, fields[index]])) }));
  const document = readDocumentOrNull(home, slug);
  const { profile } = loadSourceLanguage(book.config.source_lang);
  const sources = rows.map(({ cells }) => cells['source']?.trim() ?? '').filter((source) => source !== '');
  const seen = document === null ? new Map<string, Sighting>() : sightings(document, profile, sources);
  const problems: string[] = [];
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let renamed: RenameCounts | null = null;
  const store = openBookStore(home, slug);
  try {
    const before = entityCards(store);
    store.transaction(() => {
      for (const { row, cells } of rows) {
        // 列號跟試算表一樣，第一列是欄名。
        const label = String(row);
        const source = cells['source']?.trim() ?? '';
        if (source === '') {
          problems.push(`${label}:source`);
          continue;
        }
        const input = {
          ...cells,
          keep_source: csvFlag(cells['keep_source']),
          case_sensitive: csvFlag(cells['case_sensitive']),
          whole_word: csvFlag(cells['whole_word']),
        };
        const checked = checkCard(input, rules);
        if (!checked.ok) {
          problems.push(`${label}:${checked.field}`);
          continue;
        }
        const existing = entityBySource(store, source);
        if (existing === undefined) {
          const now = new Date().toISOString();
          const sighting = seen.get(source);
          store.run(
            `INSERT INTO entity (source, status, origin, sources, occurrences, first_block, created_at, updated_at)
             VALUES (?, 'candidate', 'import', '[]', ?, ?, ?, ?)`,
            source,
            sighting?.occurrences ?? 0,
            sighting?.firstBlock ?? null,
            now,
            now,
          );
          const created = entityBySource(store, source);
          if (created !== undefined) lock(store, created, checked.card, 'import', 'import');
          added += 1;
          continue;
        }
        const card = checked.card;
        const same =
          existing.status === 'locked' &&
          existing.target === card.target &&
          existing.class === card.class &&
          existing.gender === card.gender &&
          existing.pronoun === card.pronoun &&
          existing.register === card.register &&
          existing.keep_source === (card.keep_source ? 1 : 0) &&
          existing.match === card.match;
        if (same) {
          unchanged += 1;
          continue;
        }
        lock(store, existing, card, 'import', 'import');
        updated += 1;
      }
    });
    // 覆蓋了已鎖定的卡，當下做 S-16（ADR-0120）。
    renamed = await applyRenames({ home, book, store, pack, before });
  } finally {
    store.close();
  }
  const params = { book: slug, added: String(added), updated: String(updated), unchanged: String(unchanged) };
  return {
    data: { book: slug, added, updated, unchanged, problems: problems.length, ...(renamed === null ? {} : { renamed }) },
    findings: [
      finding('glossary.imported', 'info', params),
      ...renamedFindings(slug, renamed),
      ...(problems.length === 0 ? [] : [finding('glossary.bad_rows', 'fail', { count: String(problems.length), rows: listed(problems) })]),
      ...findings,
    ],
  };
}

/** S-16 的結果，只印數量（ADR-0059、ADR-0120）。沒有鎖定卡改動時不印。 */
function renamedFindings(slug: string, renamed: RenameCounts | null): Finding[] {
  if (renamed === null) return [];
  const params = {
    book: slug,
    replaced: String(renamed.replaced),
    resend: String(renamed.resend),
    reset: String(renamed.reset),
    in_flight: String(renamed.in_flight),
  };
  return [finding('glossary.renamed', 'info', params)];
}

/** `tome glossary import`。 */
export function importGlossary(options: ImportOptions): Promise<PlanOutcome> {
  return withBookLock(options.home, options.slug, () => importLocked(options));
}
