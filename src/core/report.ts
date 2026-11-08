import { readBook } from './book.ts';
import { entityCards, type EntityCard } from './entities.ts';
import { readDocument } from './extract.ts';
import { finding } from './findings.ts';
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

export interface BookReport {
  readonly coverage: Readonly<Record<string, number>>;
  readonly spent: { readonly translate: number; readonly scan: number; readonly budget: number | null };
  readonly estimates: readonly EstimateItem[];
  readonly pending_cards: number;
  readonly untranslated: readonly UntranslatedUnit[];
  readonly pages: readonly PageProblem[];
  readonly figures: readonly FigureItem[];
  readonly flags: readonly ReportedItem[];
  readonly checks: readonly ReportedItem[];
  readonly variants: readonly Variant[];
  readonly unused: readonly UnusedTarget[];
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
}

interface IssueRow {
  readonly unit_id: string;
  readonly block_id: string;
  readonly state: UnitState;
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
    units.map(({ state, source, placeholders, fielded }) => ({
      state,
      kept: !needsLlm(source, JSON.parse(placeholders) as Placeholder[]),
      fielded: fielded === 1,
      inScope: true,
    })),
  );
  const buckets = Object.fromEntries(
    Object.entries(STATUS_BUCKETS).map(([name, states]) => [name, states.reduce((sum, state) => sum + counts.states[state], 0)]),
  );
  return { total: counts.total, kept: counts.kept, fielded: counts.fielded, ...buckets };
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

/** 鎖定的卡，命中它、翻好的單位譯文裡沒有它的譯名，多半是鎖定前翻的（ADR-0123）。 */
function unusedOf(units: readonly UnitRow[], cards: readonly EntityCard[]): UnusedTarget[] {
  const done = units.filter(({ state, translation }) => state === 'DONE' && translation !== null);
  return cards.flatMap((card): UnusedTarget[] => {
    const [term] = bookTerms([], [card]);
    if (term === undefined || card.target === null) return [];
    const target = card.target;
    const blocks = done
      .filter((unit) => hitTerms(unit, [term]).length > 0 && !(unit.translation ?? '').includes(target))
      .map(({ block_id }) => block_id);
    return blocks.length === 0 ? [] : [{ source: card.source, target, blocks: [...new Set(blocks)] }];
  });
}

/** 一本書的交付報告資料。`budget` 是 `book.yaml` 的預算。 */
export function collectReport(store: Store, document: IrDocument, cards: readonly EntityCard[], budget: number | null): BookReport {
  const units = store.all<UnitRow>(
    'SELECT unit_id, block_id, role, source, placeholders, state, translation, fielded FROM unit ORDER BY seq',
  );
  const issues = store.all<IssueRow>(
    `SELECT u.unit_id, u.block_id, u.state, i.code, i.level, i.detail FROM issue i JOIN unit u ON u.unit_id = i.unit_id
     ORDER BY u.seq, i.id`,
  );
  const spentOf = (scope: string): number =>
    store.get<{ spent: number | null }>(`SELECT SUM(cost_usd) AS spent FROM ledger WHERE ${scope}`)?.spent ?? 0;
  // 依單位記：表格的格子同一個區塊，`BLOCKED` 的格子不能拿到旁邊 `FAILED_QA` 格子的原因。
  const resend = new Map<string, string[]>();
  for (const { unit_id, state, code, level } of issues) {
    if (state === 'FAILED_QA' && level === 'resend') resend.set(unit_id, [...new Set([...(resend.get(unit_id) ?? []), code])]);
  }
  const reported = (codes: readonly string[]): ReportedItem[] =>
    issues
      .filter(({ state, code, level }) => state === 'DONE' && level === 'report' && codes.includes(code))
      .map(({ block_id, code, detail }) => ({ block_id, code, detail: detailOf(detail) }));
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
    flags: reported(['untranslatable']),
    checks: reported(REPORTED_CHECKS),
    variants: variantsOf(issues, cards),
    unused: unusedOf(units, cards),
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
  readonly sections: Readonly<Record<'coverage' | 'untranslated' | 'pages' | 'figures' | 'flags' | 'checks' | 'consistency', string>>;
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
  };
  readonly states: Readonly<Record<string, string>>;
  readonly codes: Readonly<Record<string, string>>;
  readonly reasons: Readonly<Record<string, string>>;
  readonly untranslated: string;
  readonly page: string;
  readonly figure: string;
  readonly figure_page: string;
  readonly flag: string;
  readonly checks: Readonly<Record<ReportedCheck, string>>;
  readonly variants: string;
  readonly variant: string;
  readonly variant_target: string;
  readonly unused_title: string;
  readonly unused: string;
  readonly advice: string;
  readonly joiner: string;
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
      lines.push(
        fill(texts.estimates.row, {
          time: item.created_at.slice(0, 16).replace('T', ' '),
          stage: named(texts.estimates.stages, item.stage),
          mode: named(texts.estimates.modes, item.mode),
          low: money(item.low_usd),
          high: money(item.high_usd),
          spent: money(item.spent_usd),
          position: item.position === null ? '-' : `${item.position}%`,
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
  section(
    'checks',
    report.checks.map(({ block_id, code, detail }) => {
      const template = texts.checks[code as ReportedCheck];
      const slots = Object.fromEntries(Object.entries(detail).map(([name, value]) => [name, inline(value)]));
      return `- ${fill(template, { ...slots, place: place(block_id) })}`;
    }),
  );

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
  return `${lines.join('\n')}\n`;
}

/** 報告提到的區塊，章節檔要在這些區塊加 `^區塊 ID`，連結才連得到（ADR-0122 第 9 項、ADR-0123）。 */
export function reportedBlocks(report: BookReport): Set<string> {
  return new Set([
    ...report.untranslated.map(({ block_id }) => block_id),
    ...report.figures.flatMap(({ block_id }) => (block_id === null ? [] : [block_id])),
    ...report.flags.map(({ block_id }) => block_id),
    ...report.checks.map(({ block_id }) => block_id),
    ...report.unused.flatMap(({ blocks }) => blocks),
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
    variants: report.variants.length,
    unused: report.unused.length,
    pending_cards: report.pending_cards,
  };
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
    const estimate =
      latest === undefined
        ? []
        : [
            finding('report.estimate', 'info', {
              low: usd(latest.low_usd),
              high: usd(latest.high_usd),
              spent: usd(latest.spent_usd),
              position: latest.position === null ? '-' : String(latest.position),
            }),
          ];
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
