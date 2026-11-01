import { readBook, systemOf, withBookLock, type Book } from './book.ts';
import { TomeError } from './errors.ts';
import { finding, type Finding } from './findings.ts';
import { formatSegments } from './format.ts';
import { loadTargetLanguage, scriptViolations, type TargetLanguage } from './language.ts';
import { findTerm, restoreSegments, type Placeholder } from './mask.ts';
import { loadPhraseCheck, type PhraseCheck } from './opencc.ts';
import { findPack, resolvePack, termsFor, type LocalizedTerm, type ResolvedPack } from './pack.ts';
import { failureEvent, nextState, type UnitState } from './state.ts';
import { openBookStore, type Store } from './store.ts';
import { parseUnits, unitTag, type ParsedReply, type ParsedUnit, type Segment } from './tags.ts';
import { workspaceTargetLang } from './workspace.ts';

// 零 token 驗證（白皮書 §5.6、ADR-0060、ADR-0102）。確定是錯誤的才重送，重送要花錢，
// 用語與長度過長只列報告。每一項判定都要小心誤判：正確的譯文重送三次後會變成 FAILED_QA。

/** 原文少於這麼多字母不查長度，`Yes` 譯成「是」不該重送。是提案，等試翻量過。 */
const MIN_CHECKED_LETTERS = 20;
const LETTER = /\p{L}/gu;
/** 逗號後面剛好三位數才算千分位，`1,2,3` 是三個數字（ADR-0102）。 */
const NUMBER = /\d{1,3}(?:,\d{3})+(?!\d)|\d+(?:\.\d+)?/g;
/** 拿掉例外詞時留一個字元，兩邊的字才不會接成新的詞。 */
const REMOVED = '￼';

export type IssueCode =
  | 'tag_error'
  | 'unit_missing'
  | 'placeholder_mismatch'
  | 'number_missing'
  | 'term_missing'
  | 'script_mixed'
  | 'too_short'
  | 'number_extra'
  | 'too_long'
  | 'term_suspect'
  | 'new_term'
  | 'untranslatable';

export interface Problem {
  readonly code: IssueCode;
  readonly level: 'resend' | 'report';
  /** 可能含書本文字，只留在工作區，不進訊息與 `--json`（ADR-0059）。 */
  readonly detail?: Readonly<Record<string, string>>;
}

export interface Verdict {
  readonly passed: boolean;
  readonly problems: readonly Problem[];
  /** 排版並還原後的譯文。沒通過時是 null。 */
  readonly translation: string | null;
}

export interface VerifiableUnit {
  readonly source: string;
  readonly masked: string;
  readonly placeholders: readonly Placeholder[];
  readonly role: string;
}

export interface VerifyContext {
  readonly language: TargetLanguage;
  /** 這本書適用的詞條，`termsFor` 的結果。 */
  readonly terms: readonly LocalizedTerm[];
  readonly phraseCheck: PhraseCheck;
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** 看得到的文字：佔位符拿掉，只帶註記的標籤留內文。 */
function visible(segments: readonly Segment[]): string {
  return segments
    .map((item) => {
      if (item.type === 'text') return item.text;
      return item.type === 'ph' ? '' : visible(item.children);
    })
    .join('');
}

function maskedSegments(masked: string): readonly Segment[] {
  return parseUnits(unitTag('0', '', masked)).units[0]?.segments ?? [];
}

/** 遮蔽後看得到的文字。 */
export function visibleText(masked: string): string {
  return visible(maskedSegments(masked));
}

function numbersOf(text: string): string[] {
  return (text.normalize('NFKC').match(NUMBER) ?? []).map((number) => number.replaceAll(',', ''));
}

function tally(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** `left` 比 `right` 多出來的值。 */
function surplus(left: readonly string[], right: readonly string[]): string[] {
  const available = tally(right);
  return [...tally(left)].flatMap(([value, wanted]) =>
    wanted > (available.get(value) ?? 0) ? [value] : [],
  );
}

function numberProblems(source: string, translation: string): Problem[] {
  const before = numbersOf(source);
  const after = numbersOf(translation);
  const missing = surplus(before, after);
  const added = surplus(after, before);
  return [
    ...(missing.length > 0
      ? [{ code: 'number_missing', level: 'resend', detail: { numbers: missing.join(', ') } } as const]
      : []),
    ...(added.length > 0
      ? [{ code: 'number_extra', level: 'report', detail: { numbers: added.join(', ') } } as const]
      : []),
  ];
}

function inlineMarks(segments: readonly Segment[]): string[] {
  return segments.flatMap((item) => {
    if (item.type === 'text') return [];
    if (item.type === 'ph') return [`ph:${item.id}`];
    const own = item.type === 'pc' ? [`pc:${item.id}`] : [];
    return [...own, ...inlineMarks(item.children)];
  });
}

function sameMarks(left: readonly string[], right: readonly string[]): boolean {
  return surplus(left, right).length === 0 && surplus(right, left).length === 0;
}

/** 原文命中、譯文要用鎖定譯名的詞條。`keep_source` 的已經遮蔽，不查。 */
export function hitTerms(
  unit: Pick<VerifiableUnit, 'source' | 'role'>,
  terms: readonly LocalizedTerm[],
): LocalizedTerm[] {
  return terms.filter(({ text, term }) => {
    if (term.keep_source === true) return false;
    if (term.match?.roles !== undefined && !term.match.roles.includes(unit.role)) return false;
    return findTerm(unit.source, text, term.match).length > 0;
  });
}

function scriptProblems(translation: string, hits: readonly LocalizedTerm[], language: TargetLanguage): Problem[] {
  // 鎖定譯名裡的字不算混入，否則重送也修不好（ADR-0102）。
  const checked = hits.reduce((text, { term }) => text.replaceAll(term.target, REMOVED), translation);
  const found = scriptViolations(language.script_check, checked);
  return found.length === 0 ? [] : [{ code: 'script_mixed', level: 'resend', detail: { found: found.join(' ') } }];
}

function lengthProblems(source: string, translation: string, language: TargetLanguage): Problem[] {
  const before = count(source, LETTER);
  if (before < MIN_CHECKED_LETTERS) return [];
  const ratio = count(translation, LETTER) / before;
  if (ratio < language.min_length_ratio) return [{ code: 'too_short', level: 'resend' }];
  return ratio > language.max_length_ratio ? [{ code: 'too_long', level: 'report' }] : [];
}

function wordingProblems(translation: string, context: VerifyContext): Problem[] {
  const { term_checks: checks, term_exceptions: exceptions } = context.language;
  const checked = exceptions.reduce((text, word) => text.replaceAll(word, REMOVED), translation);
  const listed = checks
    .filter(({ avoid }) => checked.includes(avoid))
    .map(({ avoid, prefer }) => ({ term: avoid, prefer }));
  const found = new Map([...context.phraseCheck(checked), ...listed].map((item) => [item.term, item]));
  return [...found.values()].map(({ term, prefer }) => ({
    code: 'term_suspect',
    level: 'report',
    detail: { term, prefer },
  }));
}

function notes(segments: readonly Segment[]): Problem[] {
  return segments.flatMap((item): Problem[] => {
    if (item.type === 'text' || item.type === 'ph') return [];
    const inner = notes(item.children);
    if (item.type === 'pc') return inner;
    const text = visible(item.children);
    const note: Problem =
      item.type === 'new-term'
        ? { code: 'new_term', level: 'report', detail: { source: item.source, target: text } }
        : { code: 'untranslatable', level: 'report', detail: { reason: item.reason, text } };
    return [note, ...inner];
  });
}

function checkSegments(
  unit: VerifiableUnit,
  segments: readonly Segment[],
  context: VerifyContext,
): Problem[] {
  const original = maskedSegments(unit.masked);
  const source = visible(original);
  const translation = visible(segments);
  const hits = hitTerms(unit, context.terms);
  const lost = hits.filter(({ term }) => !translation.includes(term.target));
  return [
    ...(sameMarks(inlineMarks(original), inlineMarks(segments))
      ? []
      : [{ code: 'placeholder_mismatch', level: 'resend' } as const]),
    ...numberProblems(source, translation),
    ...lost.map(({ text, term }): Problem => ({
      code: 'term_missing',
      level: 'resend',
      detail: { term: text, target: term.target },
    })),
    ...scriptProblems(translation, hits, context.language),
    ...lengthProblems(source, translation, context.language),
    ...wordingProblems(translation, context),
    ...notes(segments),
  ];
}

function rejected(problem: Problem): Verdict {
  return { passed: false, problems: [problem], translation: null };
}

/** 驗證回應裡一個單位的片段。通過才排版並還原。 */
export function verifyFragment(unit: VerifiableUnit, fragment: string, context: VerifyContext): Verdict {
  const { units, issues } = parseUnits(fragment);
  if (issues.length > 0) return rejected({ code: 'tag_error', level: 'resend' });
  const [parsed] = units;
  if (parsed === undefined || units.length > 1) return rejected({ code: 'unit_missing', level: 'resend' });
  const problems = checkSegments(unit, parsed.segments, context);
  const passed = !problems.some(({ level }) => level === 'resend');
  if (!passed) return { passed, problems, translation: null };
  const formatted = formatSegments(parsed.segments, context.language);
  return { passed, problems, translation: restoreSegments(formatted, unit.placeholders) };
}

export interface UnitMatch {
  readonly matched: ReadonlyMap<string, ParsedUnit>;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
}

/** 段落編號一對一。回應裡多寫的不算數，第二次出現的編號也是。 */
export function matchUnits(reply: ParsedReply, ids: readonly string[]): UnitMatch {
  const wanted = new Set(ids);
  const matched = new Map<string, ParsedUnit>();
  const extra: string[] = [];
  for (const unit of reply.units) {
    if (wanted.has(unit.id) && !matched.has(unit.id)) matched.set(unit.id, unit);
    else extra.push(unit.id);
  }
  return { matched, missing: ids.filter((id) => !matched.has(id)), extra };
}

interface VerifyRow {
  readonly unit_id: string;
  readonly role: string;
  readonly source: string;
  readonly masked: string;
  readonly placeholders: string;
  readonly state: UnitState;
  readonly attempts: number;
  readonly text: string;
}

function recordProblems(store: Store, unitId: string, problems: readonly Problem[]): void {
  store.run('DELETE FROM issue WHERE unit_id = ?', unitId);
  const now = new Date().toISOString();
  for (const { code, level, detail } of problems) {
    store.run(
      'INSERT INTO issue (unit_id, code, level, detail, created_at) VALUES (?, ?, ?, ?, ?)',
      unitId,
      code,
      level,
      detail === undefined ? null : JSON.stringify(detail),
      now,
    );
  }
}

/** 重跑一律先進 `STALE`（ADR-0102）。`attempts` 不動：重跑不花錢，不該吃掉重試額度。 */
function settle(store: Store, row: VerifyRow, verdict: Verdict): UnitState {
  const start = row.state === 'RECEIVED' ? row.state : nextState(row.state, 'stale');
  const state = nextState(start, verdict.passed ? 'pass' : failureEvent(row.attempts));
  store.run('UPDATE unit SET state = ?, translation = ? WHERE unit_id = ?', state, verdict.translation, row.unit_id);
  recordProblems(store, row.unit_id, verdict.problems);
  return state;
}

const LATEST_RESPONSES = `
  SELECT u.unit_id, u.role, u.source, u.masked, u.placeholders, u.state, u.attempts, r.text
  FROM unit u
  JOIN response r ON r.id = (SELECT MAX(id) FROM response WHERE unit_id = u.unit_id)
  WHERE u.state IN ('RECEIVED', 'DONE', 'FAILED_QA')
  ORDER BY u.seq
`;

export interface VerifyContextOptions {
  readonly home: string;
  readonly slug: string;
}

export interface BookPack {
  /** 規則包讀不全時是 null，理由在 `findings`。 */
  readonly pack: ResolvedPack | null;
  readonly terms: readonly LocalizedTerm[];
  readonly findings: readonly Finding[];
}

/**
 * 這本書的規則包與詞條。規則包讀不全時詞條會少掉，譯名驗證就默默不做了，
 * 所以不給規則包，由呼叫端停下來（ADR-0102）。
 */
export function loadBookPack(home: string, book: Book): BookPack {
  const id = systemOf(book);
  const location = findPack(home, id);
  if (location === null) throw new TomeError('pack.not_found', { id });
  const { pack, findings } = resolvePack(home, location);
  if (pack === null || findings.some(({ level }) => level === 'fail')) return { pack: null, terms: [], findings };
  return { pack, terms: termsFor(pack, book.config.source_lang), findings };
}

export interface BookVerifyContext {
  /** 規則包讀不全時是 null，理由在 `findings`。 */
  readonly context: VerifyContext | null;
  readonly findings: readonly Finding[];
}

/** 這本書驗證要用的語言、詞條與片語表。 */
export async function bookVerifyContext({ home, slug }: VerifyContextOptions): Promise<BookVerifyContext> {
  const { pack, terms, findings } = loadBookPack(home, readBook(home, slug));
  if (pack === null) return { context: null, findings };
  const { profile: language } = loadTargetLanguage(workspaceTargetLang(home));
  return { context: { language, terms, phraseCheck: await loadPhraseCheck(language) }, findings };
}

export interface VerifyBookResult {
  readonly data: Readonly<Record<string, unknown>>;
  readonly findings: readonly Finding[];
}

const EMPTY_RUN = { checked: 0, passed: 0, failed: 0, gave_up: 0 };

async function verifyLocked(home: string, slug: string): Promise<VerifyBookResult> {
  const store = openBookStore(home, slug);
  try {
    const rows = store.all<VerifyRow>(LATEST_RESPONSES);
    if (rows.length === 0) return { data: EMPTY_RUN, findings: [finding('verify.nothing', 'info')] };
    // 片語表約 6 MB，有東西要驗證才載入。
    const { context, findings } = await bookVerifyContext({ home, slug });
    if (context === null) return { data: EMPTY_RUN, findings };
    const states = store.transaction(() =>
      rows.map((row) => {
        const placeholders = JSON.parse(row.placeholders) as Placeholder[];
        return settle(store, row, verifyFragment({ ...row, placeholders }, row.text, context));
      }),
    );
    const passed = states.filter((state) => state === 'DONE').length;
    const gaveUp = states.filter((state) => state === 'FAILED_QA').length;
    const failed = rows.length - passed;
    const params = {
      checked: String(rows.length),
      passed: String(passed),
      failed: String(failed),
      gave_up: String(gaveUp),
    };
    return {
      data: { checked: rows.length, passed, failed, gave_up: gaveUp },
      findings: [failed === 0 ? finding('verify.done', 'info', params) : finding('verify.failed', 'fail', params)],
    };
  } finally {
    store.close();
  }
}

/** `tome verify`：用存下來的回應重跑驗證，不花 token（ADR-0081）。一本書同時只跑一個流程。 */
export function verifyBook(home: string, slug: string): Promise<VerifyBookResult> {
  return withBookLock(home, slug, () => verifyLocked(home, slug));
}
