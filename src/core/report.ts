import { readBook } from './book.ts';
import { entityCards, type EntityCard } from './entities.ts';
import { readDocument } from './extract.ts';
import { finding, type Finding } from './findings.ts';
import type { IrDocument } from './ir.ts';
import { needsLlm, type Placeholder } from './mask.ts';
import { usd } from './provider.ts';
import type { PlanOutcome } from './request.ts';
import type { UnitState } from './state.ts';
import { scopeCounts, STATUS_BUCKETS } from './status.ts';
import { openBookStore, type Store } from './store.ts';
import { bookTerms, hitTerms } from './verify.ts';

// 交付報告（白皮書 §5.6、ADR-0123）。`tome assemble` 寫成 vault 裡的 `00-交付報告.md`，可以含書本文字；
// `tome report` 只印各項的數字（ADR-0059）。只讀 `book.db` 與 `document.json`，不連網、不拿書的鎖。

/** 只報告的檢查，交付報告列出來，不重送（白皮書 §5.6）。 */
export const REPORTED_CHECKS = ['term_suspect', 'translationese', 'too_long', 'number_extra', 'pronoun_mismatch'] as const;
export type ReportedCheck = (typeof REPORTED_CHECKS)[number];
/** 人工譯文的檢查：平常會重送的也只報告（ADR-0126）。 */
export const HUMAN_CHECKS = ['placeholder_mismatch', 'number_missing', 'term_missing', 'script_mixed', 'too_short', ...REPORTED_CHECKS] as const;
export type HumanCheck = (typeof HUMAN_CHECKS)[number];

const UNTRANSLATED: readonly UnitState[] = ['FAILED_QA', 'REFUSED', 'BLOCKED'];
/** 整頁是圖的頁，也列在沒翻的圖片裡。 */
const IMAGE_PAGES: ReadonlySet<string> = new Set(['full_image', 'image_only']);
const PASS0 = "(unit_id LIKE 'term:%' OR unit_id = 'summary')";

export interface UntranslatedUnit {
  readonly block_id: string;
  readonly state: UnitState;
  /** `FAILED_QA` 最後一次驗證的重送原因。 */
  readonly codes: readonly string[];
}

export interface PageProblem {
  readonly label: string;
  readonly status: string;
  readonly reason: string;
}

export interface FigureItem {
  /** `figure` 區塊；整頁是圖的頁是 null。 */
  readonly block_id: string | null;
  readonly label: string;
}

export interface ReportedItem {
  readonly block_id: string;
  readonly code: string;
  /** 可能含書本文字，只寫進 vault。 */
  readonly detail: Readonly<Record<string, string>>;
}

export interface Variant {
  readonly source: string;
  readonly targets: readonly { readonly target: string; readonly units: number }[];
}

export interface UnusedTarget {
  readonly source: string;
  readonly target: string;
  readonly blocks: readonly string[];
}

export interface EstimateItem {
  readonly stage: string;
  readonly mode: string;
  readonly created_at: string;
  readonly low_usd: number;
  readonly high_usd: number;
  /** 這次確認之後、同一個階段下一次確認之前的實際花費。 */
  readonly spent_usd: number;
  /** 花費落在估價區間的哪裡，0 是下限、100 是上限；區間寬度是 0 時是 null。 */
  readonly position: number | null;
}

/**
 * 花費跟估價比的情況（ADR-0132）。超出上限與低於下限的百分比對上限或下限算，四捨五入到整數，
 * 不到 1% 另成一類；在區間內用 `position`。區間寬度是 0 時照舊是 `unknown`。
 */
export type EstimateComparison = 'over' | 'over_small' | 'within' | 'under' | 'under_small' | 'none' | 'unknown';

export function compareEstimate(item: EstimateItem): { readonly comparison: EstimateComparison; readonly percent: number | null } {
  const { low_usd: low, high_usd: high, spent_usd: spent, position } = item;
  if (spent === 0) return { comparison: 'none', percent: null };
  if (high > 0 && spent > high) {
    const over = (spent / high - 1) * 100;
    return over < 1 ? { comparison: 'over_small', percent: null } : { comparison: 'over', percent: Math.round(over) };
  }
  if (spent < low) {
    const under = (1 - spent / low) * 100;
    return under < 1 ? { comparison: 'under_small', percent: null } : { comparison: 'under', percent: Math.round(under) };
  }
  return position === null ? { comparison: 'unknown', percent: null } : { comparison: 'within', percent: position };
}

/** 鎖定的卡改了譯名，命中它的人工譯文還用上一個譯名（ADR-0126）。 */
export interface OldName {
  readonly source: string;
  readonly before: string;
  readonly target: string;
  readonly blocks: readonly string[];
}

/** `tome sync` 回收不了、這次輸出覆蓋掉的修改（ADR-0125）。只有位置與類型。 */
export interface SyncItem {
  readonly path: string;
  readonly kind: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface BookReport {
  readonly coverage: Readonly<Record<string, number>>;
  readonly spent: { readonly translate: number; readonly scan: number; readonly budget: number | null };
  readonly estimates: readonly EstimateItem[];
  readonly pending_cards: number;
  readonly untranslated: readonly UntranslatedUnit[];
  readonly pages: readonly PageProblem[];
  readonly figures: readonly FigureItem[];
  readonly flags: readonly ReportedItem[];
  /** 模型譯文的只報告檢查。 */
  readonly checks: readonly ReportedItem[];
  /** 人工譯文的檢查（ADR-0126）。 */
  readonly human: readonly ReportedItem[];
  readonly variants: readonly Variant[];
  readonly unused: readonly UnusedTarget[];
  readonly old_names: readonly OldName[];
  /**
   * `tome sync` 記下、還沒處理的回收不了的修改。`tome assemble` 先只留這次要覆蓋的檔，
   * 交付報告列出的就是被覆蓋的（ADR-0125）。
   */
  readonly sync: readonly SyncItem[];
}

interface UnitRow {
  readonly unit_id: string;
  readonly block_id: string;
  readonly role: string;
  readonly source: string;
  readonly placeholders: string;
  readonly state: UnitState;
  readonly translation: string | null;
  readonly fielded: number;
  readonly human: number;
}

interface IssueRow {
  readonly unit_id: string;
  readonly block_id: string;
  readonly state: UnitState;
  readonly human: number;
  readonly code: string;
  readonly level: string;
  readonly detail: string | null;
}

function detailOf(json: string | null): Record<string, string> {
  if (json === null) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

/** 原書印的頁碼，沒有就用 PDF 的頁次。 */
export function pageLabel(document: IrDocument, page: number): string {
  return document.page_map.find((item) => item.page === page)?.label ?? String(page + 1);
}

function coverageOf(units: readonly UnitRow[]): Record<string, number> {
  const counts = scopeCounts(
    units.map(({ state, source, placeholders, fielded, human }) => ({
      state,
      kept: !needsLlm(source, JSON.parse(placeholders) as Placeholder[]),
      fielded: fielded === 1,
      human: human === 1,
      inScope: true,
    })),
  );
  const buckets = Object.fromEntries(
    Object.entries(STATUS_BUCKETS).map(([name, states]) => [name, states.reduce((sum, state) => sum + counts.states[state], 0)]),
  );
  return { total: counts.total, kept: counts.kept, fielded: counts.fielded, human: counts.human, ...buckets };
}

function estimatesOf(store: Store): EstimateItem[] {
  const rows = store.all<{ stage: string; mode: string; created_at: string; low_usd: number; high_usd: number }>(
    'SELECT stage, mode, created_at, low_usd, high_usd FROM estimate ORDER BY id',
  );
  return rows.map((row, index) => {
    const next = rows.slice(index + 1).find(({ stage }) => stage === row.stage);
    const scope = row.stage === 'scan' ? PASS0 : `NOT ${PASS0}`;
    const spent =
      store.get<{ spent: number | null }>(
        `SELECT SUM(cost_usd) AS spent FROM ledger WHERE ${scope} AND created_at >= ? AND created_at < ?`,
        row.created_at,
        next?.created_at ?? '9999',
      )?.spent ?? 0;
    const width = row.high_usd - row.low_usd;
    return { ...row, spent_usd: spent, position: width > 0 ? Math.round(((spent - row.low_usd) / width) * 100) : null };
  });
}

/** 同一個原文、還沒鎖定卡，各單位回報了兩種以上的譯名（ADR-0123）。 */
function variantsOf(issues: readonly IssueRow[], cards: readonly EntityCard[]): Variant[] {
  const locked = new Set(cards.filter(({ status }) => status === 'locked').map(({ source }) => source));
  const found = new Map<string, Map<string, number>>();
  for (const { code, detail } of issues) {
    if (code !== 'new_term') continue;
    const { source, target } = detailOf(detail);
    const text = source?.trim() ?? '';
    const translated = target?.trim() ?? '';
    if (text === '' || translated === '' || locked.has(text)) continue;
    const targets = found.get(text) ?? new Map<string, number>();
    targets.set(translated, (targets.get(translated) ?? 0) + 1);
    found.set(text, targets);
  }
  return [...found]
    .filter(([, targets]) => targets.size > 1)
    .map(([source, targets]) => ({ source, targets: [...targets].map(([target, units]) => ({ target, units })) }));
}

/**
 * 每個單位命中哪些鎖定的卡。用全部的卡一起比，長的卡包住短的時只算長的（ADR-0133）；一次只拿一張卡比，
 * 看不到包住它的長卡。報告拿不到規則包的詞條，只比實體卡。
 */
function cardHits(units: readonly UnitRow[], cards: readonly EntityCard[]): ReadonlyMap<string, ReadonlySet<string>> {
  const terms = bookTerms([], cards);
  return new Map(units.map((unit) => [unit.unit_id, new Set(hitTerms(unit, terms).map(({ text }) => text))]));
}

/** 鎖定的卡，命中它、翻好的單位譯文裡沒有它的譯名，多半是鎖定前翻的（ADR-0123）。舊譯名一節列了的人工譯文不重複列。 */
function unusedOf(units: readonly UnitRow[], cards: readonly EntityCard[], stale: Stale): UnusedTarget[] {
  const done = units.filter(({ state, translation }) => state === 'DONE' && translation !== null);
  const hits = cardHits(done, cards);
  return cards.flatMap((card): UnusedTarget[] => {
    const [term] = bookTerms([], [card]);
    if (term === undefined || card.target === null) return [];
    const target = card.target;
    const blocks = done
      .filter((unit) => hits.get(unit.unit_id)?.has(term.text) === true && !(unit.translation ?? '').includes(target) && !stale(unit, card))
      .map(({ block_id }) => block_id);
    return blocks.length === 0 ? [] : [{ source: card.source, target, blocks: [...new Set(blocks)] }];
  });
}

/** 這個單位是人工譯文，還用著這張卡的上一個譯名。 */
type Stale = (unit: UnitRow, card: EntityCard) => boolean;

/** `text` 裡 `needle` 出現的範圍。 */
function rangesIn(text: string, needle: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) ranges.push([at, at + needle.length]);
  return ranges;
}

/**
 * `text` 裡有一處 `before` 不在 `longer` 的較長譯名裡。規則跟 S-16 的 `replaceTarget` 一樣，只是比純文字：
 * 「鹽沼」改成「鹽沼地」時，「鹽沼地」不算含舊譯名（ADR-0126）。
 */
function holdsOld(text: string, before: string, longer: readonly string[]): boolean {
  const shielded = longer.filter((target) => target !== before && target.includes(before)).flatMap((target) => rangesIn(text, target));
  return rangesIn(text, before).some(([at, end]) => !shielded.some(([start, stop]) => start <= at && end <= stop));
}

/** 舊譯名一節列了的單位與那張卡目前的譯名，用來在「人工譯文的檢查」不再列一次。 */
function listedKey(unitId: string, target: string): string {
  return `${unitId}\u0000${target}`;
}

/**
 * 鎖定的卡改過譯名，命中它、翻好的人工譯文還有上一個譯名（ADR-0081 第 6 項、ADR-0126）。舊譯名是實體卡的
 * `previous_target`，只記最近一次；較長譯名只看鎖定的實體卡。`listed` 是列出的單位與卡目前的譯名。
 */
function oldNamesOf(
  units: readonly UnitRow[],
  cards: readonly EntityCard[],
  previous: ReadonlyMap<number, string>,
  stale: Stale,
): { readonly names: OldName[]; readonly listed: ReadonlySet<string> } {
  const humans = units.filter(({ state, human }) => state === 'DONE' && human === 1);
  const hits = cardHits(humans, cards);
  const listed = new Set<string>();
  const names = cards.flatMap((card): OldName[] => {
    const [term] = bookTerms([], [card]);
    const before = previous.get(card.id);
    if (term === undefined || card.target === null || before === undefined) return [];
    const target = card.target;
    const found = humans.filter((unit) => hits.get(unit.unit_id)?.has(term.text) === true && stale(unit, card));
    for (const { unit_id } of found) listed.add(listedKey(unit_id, target));
    const blocks = found.map(({ block_id }) => block_id);
    return blocks.length === 0 ? [] : [{ source: card.source, before, target, blocks: [...new Set(blocks)] }];
  });
  return { names, listed };
}

/** 一本書的交付報告資料。`budget` 是 `book.yaml` 的預算。 */
export function collectReport(store: Store, document: IrDocument, cards: readonly EntityCard[], budget: number | null): BookReport {
  const units = store.all<UnitRow>(
    'SELECT unit_id, block_id, role, source, placeholders, state, translation, fielded, human FROM unit ORDER BY seq',
  );
  const changes = store.all<SyncItem>('SELECT path, kind, before_block AS before, after_block AS after FROM sync_change ORDER BY id');
  const issues = store.all<IssueRow>(
    `SELECT u.unit_id, u.block_id, u.state, u.human, i.code, i.level, i.detail FROM issue i JOIN unit u ON u.unit_id = i.unit_id
     ORDER BY u.seq, i.id`,
  );
  // 改過譯名的卡的上一個譯名（ADR-0119 第 10 項）；跟目前的譯名一樣、或是空的不算。
  const previous = new Map(
    store
      .all<{ id: number; previous_target: string }>("SELECT id, previous_target FROM entity WHERE previous_target IS NOT NULL AND previous_target <> ''")
      .flatMap(({ id, previous_target: before }) => (cards.some((card) => card.id === id && card.target !== before) ? [[id, before] as const] : [])),
  );
  const longer = cards.flatMap(({ status, target }) => (status === 'locked' && target !== null ? [target] : []));
  const stale: Stale = (unit, card) => {
    const before = previous.get(card.id);
    return unit.human === 1 && before !== undefined && holdsOld(unit.translation ?? '', before, longer);
  };
  const spentOf = (scope: string): number =>
    store.get<{ spent: number | null }>(`SELECT SUM(cost_usd) AS spent FROM ledger WHERE ${scope}`)?.spent ?? 0;
  // 依單位記：表格的格子同一個區塊，`BLOCKED` 的格子不能拿到旁邊 `FAILED_QA` 格子的原因。
  const resend = new Map<string, string[]>();
  for (const { unit_id, state, code, level } of issues) {
    if (state === 'FAILED_QA' && level === 'resend') resend.set(unit_id, [...new Set([...(resend.get(unit_id) ?? []), code])]);
  }
  // 模型譯文與人工譯文分開列：人工譯文的修法是在 vault 裡改（ADR-0126）。
  const reported = (codes: readonly string[], human: number, skip?: (issue: IssueRow) => boolean): ReportedItem[] =>
    issues
      .filter((issue) => issue.state === 'DONE' && issue.human === human && issue.level === 'report' && codes.includes(issue.code) && skip?.(issue) !== true)
      .map(({ block_id, code, detail }) => ({ block_id, code, detail: detailOf(detail) }));
  // 舊譯名一節列了的人工譯文，同一張卡的「沒有用鎖定的譯名」不再列一次：同一處列兩次只會讓人以為有兩個問題。
  const old = oldNamesOf(units, cards, previous, stale);
  const listedOld = (issue: IssueRow): boolean =>
    issue.code === 'term_missing' && old.listed.has(listedKey(issue.unit_id, detailOf(issue.detail)['target'] ?? ''));
  const skipped = document.pages.filter(({ status }) => status !== 'ok');
  return {
    coverage: coverageOf(units),
    spent: { translate: spentOf(`NOT ${PASS0}`), scan: spentOf(PASS0), budget },
    estimates: estimatesOf(store),
    pending_cards: cards.filter(({ status }) => status === 'proposed' || status === 'failed').length,
    untranslated: units
      .filter(({ state }) => UNTRANSLATED.includes(state))
      .map(({ unit_id, block_id, state }) => ({ block_id, state, codes: resend.get(unit_id) ?? [] })),
    pages: skipped.map(({ page, status, reason }) => ({ label: pageLabel(document, page), status, reason: reason ?? status })),
    figures: [
      ...document.blocks
        .filter(({ role }) => role === 'figure')
        .map((block) => ({ block_id: block.id, label: pageLabel(document, block.spans[0]?.page ?? 0) })),
      ...skipped
        .filter(({ reason }) => reason !== undefined && IMAGE_PAGES.has(reason))
        .map(({ page }) => ({ block_id: null, label: pageLabel(document, page) })),
    ],
    flags: reported(['untranslatable'], 0),
    checks: reported(REPORTED_CHECKS, 0),
    human: reported(HUMAN_CHECKS, 1, listedOld),
    variants: variantsOf(issues, cards),
    unused: unusedOf(units, cards, stale),
    old_names: old.names,
    sync: changes,
  };
}

/** 交付報告的固定文字，放在訊息檔（ADR-0113 第 17 項）。`{name}` 由程式填。 */
export interface ReportTexts {
  readonly file: string;
  readonly title: string;
  readonly notice: string;
  readonly none: string;
  /** 連到章節的位置的文字，`{file}` 是章節檔，`{page}` 是原書頁碼。 */
  readonly place: string;
  readonly sections: Readonly<
    Record<'coverage' | 'untranslated' | 'pages' | 'figures' | 'flags' | 'checks' | 'human' | 'consistency' | 'old_names' | 'sync', string>
  >;
  readonly coverage: string;
  readonly spent: string;
  readonly budget: string;
  readonly pending: string;
  readonly estimates: {
    readonly title: string;
    readonly header: string;
    readonly row: string;
    readonly stages: Readonly<Record<string, string>>;
    readonly modes: Readonly<Record<string, string>>;
    /** 「與估價相比」那一欄，依 `compareEstimate` 的情況選，`{percent}` 是百分比（ADR-0132）。 */
    readonly compare: Readonly<Record<EstimateComparison, string>>;
  };
  readonly states: Readonly<Record<string, string>>;
  readonly codes: Readonly<Record<string, string>>;
  readonly reasons: Readonly<Record<string, string>>;
  readonly untranslated: string;
  readonly page: string;
  readonly figure: string;
  readonly figure_page: string;
  readonly flag: string;
  /** 各項檢查的寫法；人工譯文也用，平常會重送的五項只有人工譯文用得到（ADR-0126）。 */
  readonly checks: Readonly<Record<HumanCheck, string>>;
  readonly human_advice: string;
  /** 內含舊譯名的人工譯文，`{before}` 是上一個譯名（ADR-0126）。 */
  readonly old_name: string;
  readonly old_name_advice: string;
  readonly variants: string;
  readonly variant: string;
  readonly variant_target: string;
  readonly unused_title: string;
  readonly unused: string;
  readonly advice: string;
  readonly joiner: string;
  /** 回收不了的修改的位置，`{file}` 是 vault 裡的檔，`{before}`、`{after}` 是前後對上的區塊（ADR-0125）。 */
  readonly sync_between: string;
  readonly sync_after: string;
  readonly sync_before: string;
  readonly sync_file: string;
  readonly sync_kinds: Readonly<Record<string, string>>;
  readonly sync_advice: string;
}

export function fill(template: string, slots: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) => slots[name] ?? whole);
}

/** 書本文字放進清單的一行：換行換成空白。 */
function inline(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * 交付報告的 Markdown（白皮書 §5.6）。`place` 把區塊寫成連到章節的位置；書本文字只在這份 vault 裡的
 * 檔案，`BLOCKED` 的單位只寫狀態與位置（ADR-0122 第 8 項）。
 */
export function renderReport(report: BookReport, texts: ReportTexts, place: (blockId: string) => string): string {
  const lines: string[] = [`# ${texts.title}`, '', `> ${texts.notice}`];
  const section = (name: keyof ReportTexts['sections'], items: readonly string[], count = items.length): void => {
    lines.push('', `## ${texts.sections[name]}（${count}）`, '');
    lines.push(...(items.length === 0 ? [texts.none] : items));
  };
  const named = (table: Readonly<Record<string, string>>, code: string): string => table[code] ?? code;
  const money = (value: number): string => usd(value);

  const { coverage, spent } = report;
  const counts = Object.fromEntries(Object.entries(coverage).map(([name, value]) => [name, String(value)]));
  lines.push('', `## ${texts.sections.coverage}`, '', `- ${fill(texts.coverage, counts)}`);
  const total = spent.translate + spent.scan;
  const budget = spent.budget === null ? '' : fill(texts.budget, { budget: money(spent.budget) });
  lines.push(`- ${fill(texts.spent, { translate: money(spent.translate), scan: money(spent.scan), spent: money(total) })}${budget}`);
  lines.push(`- ${fill(texts.pending, { count: String(report.pending_cards) })}`);
  if (report.estimates.length > 0) {
    lines.push('', `### ${texts.estimates.title}`, '', texts.estimates.header, `|${' --- |'.repeat(texts.estimates.header.split('|').length - 2)}`);
    for (const item of report.estimates) {
      const { comparison, percent } = compareEstimate(item);
      lines.push(
        fill(texts.estimates.row, {
          time: item.created_at.slice(0, 16).replace('T', ' '),
          stage: named(texts.estimates.stages, item.stage),
          mode: named(texts.estimates.modes, item.mode),
          low: money(item.low_usd),
          high: money(item.high_usd),
          spent: money(item.spent_usd),
          // 沒有百分比的寫法（不到 1%、尚無花費、`-`）不用 `{percent}`。
          compare: fill(texts.estimates.compare[comparison], { percent: String(percent) }),
        }),
      );
    }
  }

  section(
    'untranslated',
    report.untranslated.map(({ block_id, state, codes }) => {
      const reasons = codes.length === 0 ? '' : `（${codes.map((code) => named(texts.codes, code)).join(texts.joiner)}）`;
      return `- ${fill(texts.untranslated, { place: place(block_id), state: named(texts.states, state) })}${reasons}`;
    }),
  );
  section(
    'pages',
    report.pages.map(({ label, reason }) => `- ${fill(texts.page, { page: label, reason: named(texts.reasons, reason) })}`),
  );
  section(
    'figures',
    report.figures.map(({ block_id, label }) =>
      block_id === null
        ? `- ${fill(texts.figure_page, { page: label })}`
        : `- ${fill(texts.figure, { place: place(block_id), page: label })}`,
    ),
  );
  section(
    'flags',
    report.flags.map(({ block_id, detail }) => `- ${fill(texts.flag, { place: place(block_id), reason: inline(detail['reason'] ?? ''), text: inline(detail['text'] ?? '') })}`),
  );
  const checked = ({ block_id, code, detail }: ReportedItem): string => {
    const slots = Object.fromEntries(Object.entries(detail).map(([name, value]) => [name, inline(value)]));
    return `- ${fill(texts.checks[code as HumanCheck], { ...slots, place: place(block_id) })}`;
  };
  section('checks', report.checks.map(checked));
  // 有人工譯文的問題才有這一節（ADR-0126）。
  if (report.human.length > 0) {
    section('human', report.human.map(checked));
    lines.push('', `> ${texts.human_advice}`);
  }

  const variants = report.variants.map(({ source, targets }) => {
    const listed = targets.map(({ target, units }) => fill(texts.variant_target, { target: inline(target), units: String(units) }));
    return `- ${fill(texts.variant, { source: inline(source), targets: listed.join(texts.joiner) })}`;
  });
  const unused = report.unused.map(({ source, target, blocks }) =>
    `- ${fill(texts.unused, { source: inline(source), target: inline(target), count: String(blocks.length), places: blocks.map(place).join(texts.joiner) })}`,
  );
  lines.push('', `## ${texts.sections.consistency}（${variants.length + unused.length}）`, '');
  if (variants.length + unused.length === 0) {
    lines.push(texts.none);
  } else {
    lines.push(`### ${texts.variants}`, '', ...(variants.length === 0 ? [texts.none] : variants));
    lines.push('', `### ${texts.unused_title}`, '', ...(unused.length === 0 ? [texts.none] : unused));
    lines.push('', `> ${texts.advice}`);
  }

  // 有人工譯文還用著改名前的譯名才有這一節（ADR-0126）。
  if (report.old_names.length > 0) {
    section(
      'old_names',
      report.old_names.map(({ source, before, target, blocks }) =>
        `- ${fill(texts.old_name, { source: inline(source), before: inline(before), target: inline(target), count: String(blocks.length), places: blocks.map(place).join(texts.joiner) })}`,
      ),
    );
    lines.push('', `> ${texts.old_name_advice}`);
  }

  // 只有 `tome assemble --force` 覆蓋了 `tome sync` 回收不了的修改時才有這一節（ADR-0125）。
  if (report.sync.length > 0) {
    section(
      'sync',
      report.sync.map(({ path, kind, before, after }) => {
        const slots = { file: path, kind: named(texts.sync_kinds, kind), before: before === null ? '' : place(before), after: after === null ? '' : place(after) };
        const template =
          before !== null && after !== null ? texts.sync_between : before !== null ? texts.sync_after : after !== null ? texts.sync_before : texts.sync_file;
        return `- ${fill(template, slots)}`;
      }),
    );
    lines.push('', `> ${texts.sync_advice}`);
  }
  return `${lines.join('\n')}\n`;
}

/** 報告提到的區塊，章節檔要在這些區塊加 `^區塊 ID`，連結才連得到（ADR-0122 第 9 項、ADR-0123）。 */
export function reportedBlocks(report: BookReport): Set<string> {
  return new Set([
    ...report.untranslated.map(({ block_id }) => block_id),
    ...report.figures.flatMap(({ block_id }) => (block_id === null ? [] : [block_id])),
    ...report.flags.map(({ block_id }) => block_id),
    ...report.checks.map(({ block_id }) => block_id),
    ...report.human.map(({ block_id }) => block_id),
    ...report.unused.flatMap(({ blocks }) => blocks),
    ...report.old_names.flatMap(({ blocks }) => blocks),
    ...report.sync.flatMap(({ before, after }) => [before, after].filter((id): id is string => id !== null)),
  ]);
}

/** 各項的數字，`tome report` 與 `--json` 用。不含書本文字。 */
export function reportCounts(report: BookReport): Record<string, number> {
  const checks = Object.fromEntries(
    REPORTED_CHECKS.map((code) => [code, report.checks.filter((item) => item.code === code).length]),
  );
  return {
    untranslated: report.untranslated.length,
    pages: report.pages.length,
    figures: report.figures.length,
    flags: report.flags.length,
    ...checks,
    human_checks: report.human.length,
    variants: report.variants.length,
    unused: report.unused.length,
    human_old_names: report.old_names.reduce((sum, { blocks }) => sum + blocks.length, 0),
    pending_cards: report.pending_cards,
    sync_unrecovered: report.sync.length,
  };
}

/** 最近一次確認的估價跟之後的花費，依情況各一個代碼，只帶數字（ADR-0132）。 */
function estimateFinding(item: EstimateItem): Finding {
  const money = { low: usd(item.low_usd), high: usd(item.high_usd), spent: usd(item.spent_usd) };
  const { comparison, percent } = compareEstimate(item);
  switch (comparison) {
    case 'over':
      return finding('report.estimate_over', 'info', { ...money, percent: String(percent) });
    case 'over_small':
      return finding('report.estimate_over_small', 'info', money);
    case 'under':
      return finding('report.estimate_under', 'info', { ...money, percent: String(percent) });
    case 'under_small':
      return finding('report.estimate_under_small', 'info', money);
    case 'none':
      return finding('report.estimate_none', 'info', { low: money.low, high: money.high });
    // 區間寬度是 0、花費剛好等於它：說不出落在哪裡，只說估價與花費（ADR-0133）。
    case 'unknown':
      return finding('report.estimate_unknown', 'info', money);
    default:
      return finding('report.estimate', 'info', { ...money, position: String(percent) });
  }
}

/** `tome report`。只印數字，不寫檔、不拿書的鎖，等批次時也能用（ADR-0123）。 */
export function reportBook(home: string, slug: string): PlanOutcome {
  const book = readBook(home, slug);
  const document = readDocument(home, slug);
  const store = openBookStore(home, slug);
  try {
    const report = collectReport(store, document, entityCards(store), book.config.budget_usd ?? null);
    const counts = reportCounts(report);
    const spent = report.spent.translate + report.spent.scan;
    const text = (values: Readonly<Record<string, number>>): Record<string, string> =>
      Object.fromEntries(Object.entries(values).map(([name, value]) => [name, String(value)]));
    const latest = report.estimates.at(-1);
    const estimate = latest === undefined ? [] : [estimateFinding(latest)];
    return {
      data: { book: slug, coverage: report.coverage, spent_usd: spent, spent: report.spent, estimates: report.estimates, counts },
      findings: [
        finding('report.coverage', 'info', {
          book: slug,
          ...text(report.coverage),
          spent: usd(spent),
          translate: usd(report.spent.translate),
          scan: usd(report.spent.scan),
        }),
        ...estimate,
        finding('report.issues', 'info', text(counts)),
      ],
    };
  } finally {
    store.close();
  }
}
