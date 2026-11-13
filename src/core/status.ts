import { readBook, stageFingerprint, type Book } from './book.ts';
import { entityCounts } from './entities.ts';
import { chapterCount, chapterMap, checkedLevel, levelOf, parseChapters } from './chapters.ts';
import { TomeError } from './errors.ts';
import { DOCUMENT_STAGE, readDocument } from './extract.ts';
import { finding, type Finding } from './findings.ts';
import { spentUsd } from './ledger.ts';
import { needsLlm, type Placeholder } from './mask.ts';
import { usd } from './provider.ts';
import { ESTIMATE_STAGE, type PlanOutcome } from './request.ts';
import { SCAN_ESTIMATE_STAGE } from './scan.ts';
import { UNIT_STATES, type UnitState } from './state.ts';
import { openBookStore, type Store } from './store.ts';
import { outstandingBatches } from './translate.ts';

// `tome status`（ADR-0099 第 2 項、ADR-0107 第 18 項）。只讀 `book.db` 與 `book.yaml`，設了範圍時
// 也讀 `document.json` 判斷章節（ADR-0114）。不連網，不拿書的鎖，`tome translate` 在等批次時也能用。
// 只有數字，不含書本文字。

interface BatchRow {
  readonly remote_id: string | null;
  readonly state: string;
  readonly requests: number;
  readonly submitted_at: string | null;
  readonly expires_at: string | null;
  readonly deleted_at: string | null;
}

/** 這台機器在那個時間比 UTC 快幾分鐘。夏令時間依日期而定，所以每個時間各算一次。 */
export type ZoneOffset = (date: Date) => number;

const localOffset: ZoneOffset = (date) => -date.getTimezoneOffset();

/** `UTC+8`、`UTC-5`、有分鐘時 `UTC+5:30`，時差 0 是 `UTC`（ADR-0107）。 */
export function zoneText(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const sign = minutes < 0 ? '-' : '+';
  const hours = Math.floor(Math.abs(minutes) / 60);
  const rest = Math.abs(minutes) % 60;
  return `UTC${sign}${hours}${rest === 0 ? '' : `:${String(rest).padStart(2, '0')}`}`;
}

/** 給人看的本機時間到分鐘，加上時差。`--json` 放 ISO 8601 原值（ADR-0107）。 */
export function localTime(iso: string, offsetOf: ZoneOffset = localOffset): { readonly time: string; readonly zone: string } {
  const date = new Date(iso);
  const minutes = offsetOf(date);
  const time = new Date(date.getTime() + minutes * 60_000).toISOString().slice(0, 16).replace('T', ' ');
  return { time, zone: zoneText(minutes) };
}

function unitCounts(rows: readonly { readonly state: UnitState; readonly count: number }[]): Record<UnitState, number> {
  const counts = Object.fromEntries(UNIT_STATES.map((state) => [state, 0])) as Record<UnitState, number>;
  for (const { state, count } of rows) counts[state] += count;
  return counts;
}

export interface ScopedUnit {
  readonly state: UnitState;
  /** 不需翻譯、原樣保留（ADR-0111）。 */
  readonly kept: boolean;
  /** 本機欄位化，不算原樣保留（ADR-0121）。 */
  readonly fielded: boolean;
  /** 人工譯文，算在完成的裡面（ADR-0125）。 */
  readonly human?: boolean;
  readonly inScope: boolean;
}

export interface ScopeCounts {
  /** 範圍內的單位數。 */
  readonly total: number;
  /** 範圍內不需翻譯、原樣保留的。 */
  readonly kept: number;
  /** 範圍內在本機欄位化的。 */
  readonly fielded: number;
  /** 範圍內的人工譯文。 */
  readonly human: number;
  /** 範圍內各狀態的單位數。 */
  readonly states: Readonly<Record<UnitState, number>>;
  /** 範圍外、還沒完成的。換過範圍之後，舊範圍留下的 `FAILED_QA` 也在這裡。 */
  readonly outside: number;
}

/**
 * 範圍內的數字，跟估價對得起來；範圍外沒送出的不算成「尚未完成」（ADR-0114）。
 * 沒設範圍時每個單位都在範圍內，跟整本書相同。
 */
export function scopeCounts(units: readonly ScopedUnit[]): ScopeCounts {
  const inside = units.filter(({ inScope }) => inScope);
  return {
    total: inside.length,
    kept: inside.filter(({ kept }) => kept).length,
    fielded: inside.filter(({ fielded }) => fielded).length,
    human: inside.filter(({ human }) => human === true).length,
    states: unitCounts(inside.map(({ state }) => ({ state, count: 1 }))),
    outside: units.filter(({ inScope, state }) => !inScope && state !== 'DONE').length,
  };
}

/** 本機欄位化的單位數，有才印，只有數字（ADR-0121）。估價、試算、翻譯完成與 `tome status` 共用。 */
export function fieldedFindings(count: number): Finding[] {
  return count === 0 ? [] : [finding('units.fielded', 'info', { count: String(count) })];
}

/** 設了範圍、範圍外又有沒完成的單位時，接在數字後面說明（ADR-0114）。 */
export function outsideFindings(book: string, chapters: string | null, outside: number): Finding[] {
  if (chapters === null || outside === 0) return [];
  return [finding('scope.outside', 'info', { book, chapters, outside: String(outside) })];
}

function timeParams(name: string, iso: string | null, offsetOf: ZoneOffset): Record<string, string> {
  const { time, zone } = iso === null ? { time: '-', zone: '-' } : localTime(iso, offsetOf);
  return { [name]: time, [`${name}_zone`]: zone };
}

function batchFindings(rows: readonly BatchRow[], offsetOf: ZoneOffset): Finding[] {
  const outstanding = rows.flatMap((row): Finding[] => {
    if (row.state === 'submitted' && row.remote_id !== null) {
      return [
        finding('status.batch', 'info', {
          id: row.remote_id,
          requests: String(row.requests),
          ...timeParams('submitted', row.submitted_at, offsetOf),
          ...timeParams('expires', row.expires_at, offsetOf),
        }),
      ];
    }
    if (row.state === 'intent') return [finding('batch.unconfirmed', 'info', { requests: String(row.requests) })];
    return [];
  });
  const undeleted = rows.filter(({ state, remote_id, deleted_at }) => state === 'collected' && remote_id !== null && deleted_at === null);
  return [
    ...outstanding,
    ...(undeleted.length === 0 ? [] : [finding('status.not_deleted', 'warn', { count: String(undeleted.length) })]),
  ];
}

/**
 * `status.units` 的六個數字各涵蓋哪些狀態，9 種狀態剛好各歸一類，加起來就是全部（ADR-0107）。
 * `left` 是還要再處理的：還沒送、收到還沒驗證、等重新驗證。
 */
export const STATUS_BUCKETS: Readonly<Record<string, readonly UnitState[]>> = {
  done: ['DONE'],
  in_flight: ['IN_FLIGHT'],
  blocked: ['BLOCKED'],
  failed: ['FAILED_QA'],
  refused: ['REFUSED'],
  left: ['PENDING', 'QUEUED', 'RECEIVED', 'STALE'],
};

function bucketCounts(units: Readonly<Record<UnitState, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(STATUS_BUCKETS).map(([name, states]) => [name, states.reduce((sum, state) => sum + units[state], 0)]),
  );
}

function asText(counts: Readonly<Record<string, number>>): Record<string, string> {
  return Object.fromEntries(Object.entries(counts).map(([name, count]) => [name, String(count)]));
}

/**
 * 區塊在不在範圍內，跟 `planBook` 用同一套章節判定與層級（ADR-0114、ADR-0115）。沒設範圍，或
 * `document.json` 不見了，回傳 null，照整本書算。範圍跟現在的章數對不上時照樣回報 `chapters.invalid`。
 */
function scopeOf(home: string, book: Book): ((blockId: string) => boolean) | null {
  const { chapters } = book.config;
  if (chapters === undefined) return null;
  let document;
  try {
    document = readDocument(home, book.slug);
  } catch (error) {
    if (error instanceof TomeError && error.code === 'document.missing') return null;
    throw error;
  }
  const level = checkedLevel(document, levelOf(book));
  const map = chapterMap(document, level);
  const chosen = parseChapters(chapters, chapterCount(document, level));
  return (blockId) => chosen.has(map.get(blockId) ?? 0);
}

interface UnitRow {
  readonly block_id: string;
  readonly state: UnitState;
  readonly source: string;
  readonly placeholders: string;
  readonly fielded: number;
  readonly human: number;
}

/**
 * 不需翻譯、原樣保留的單位，單位表沒有這一欄，用存下的原文與佔位符算，跟遮蔽時的判斷相同（ADR-0111）。
 * 範圍的判定見 `scopeOf`。
 */
function scopedUnits(rows: readonly UnitRow[], inScope: ((blockId: string) => boolean) | null): ScopedUnit[] {
  return rows.map(({ block_id, state, source, placeholders, fielded, human }) => ({
    state,
    kept: !needsLlm(source, JSON.parse(placeholders) as Placeholder[]),
    fielded: fielded === 1,
    human: human === 1,
    inScope: inScope === null || inScope(block_id),
  }));
}

/** `tome status` 看得到的進度，下一步照它算（ADR-0138）。 */
export interface Progress {
  /** 解析乾淨地做完過。 */
  readonly extracted: boolean;
  /** Pass 0 估價過，沒有還沒送的候選詞，也沒有 Pass 0 的批次沒收回。 */
  readonly scanned: boolean;
  /** 待人審的實體卡。 */
  readonly review: number;
  /** 有翻譯單位，也確認過翻譯的估價。確認的是不是現在這份估價，要重新估價才知道，這裡不算。 */
  readonly estimated: boolean;
  /** 翻譯的批次還沒收回的。 */
  readonly outstanding: number;
  /** 範圍內還要送的單位：還沒送、收到還沒驗證、送出去沒有下文的。 */
  readonly left: number;
  /** 範圍內沒翻成的單位：`--retry-failed` 會重送的那些。 */
  readonly unfinished: number;
  /** 最近一次確認的估價是即時模式。 */
  readonly realtime: boolean;
}

export type NextStepName = 'extract' | 'scan' | 'review' | 'estimate' | 'collect' | 'translate' | 'retry' | 'assemble';

export interface NextStep {
  readonly step: NextStepName;
  readonly command: string;
}

/**
 * 下一步，順序跟 `tome run` 的關卡相同（ADR-0127、ADR-0130 第 16 項、ADR-0138）。沒翻成的單位只是提醒，不擋輸出。
 * 模式跟著最近一次確認的估價；批次是預設，不必寫。
 */
export function nextStep(book: string, progress: Progress): NextStep {
  const mode = progress.realtime ? ' --realtime' : '';
  if (!progress.extracted) return { step: 'extract', command: `tome extract ${book}` };
  if (!progress.scanned) return { step: 'scan', command: `tome scan-terms ${book} --confirm${mode}` };
  if (progress.review > 0) return { step: 'review', command: `tome glossary review ${book} --web` };
  if (!progress.estimated) return { step: 'estimate', command: `tome estimate ${book} --confirm${mode}` };
  if (progress.outstanding > 0) return { step: 'collect', command: `tome batch collect ${book}` };
  if (progress.left > 0) return { step: 'translate', command: `tome translate ${book}${mode}` };
  if (progress.unfinished > 0) return { step: 'retry', command: `tome translate ${book}${mode} --retry-failed` };
  return { step: 'assemble', command: `tome assemble ${book}` };
}

function count(store: Store, sql: string): number {
  return store.get<{ count: number }>(sql)?.count ?? 0;
}

function progressOf(store: Store, buckets: Readonly<Record<string, number>>, total: number): Progress {
  const outstanding = outstandingBatches(store, 'translate');
  const scanBatches = outstandingBatches(store, 'scan');
  const last = store.get<{ mode: string }>('SELECT mode FROM estimate ORDER BY id DESC LIMIT 1');
  return {
    extracted: stageFingerprint(store, DOCUMENT_STAGE) !== null,
    scanned:
      stageFingerprint(store, SCAN_ESTIMATE_STAGE) !== null &&
      count(store, "SELECT COUNT(*) AS count FROM entity WHERE status = 'candidate'") === 0 &&
      scanBatches === 0,
    review: count(store, "SELECT COUNT(*) AS count FROM entity WHERE status IN ('proposed', 'failed')"),
    estimated: total > 0 && stageFingerprint(store, ESTIMATE_STAGE) !== null,
    outstanding,
    left: (buckets['left'] ?? 0) + (buckets['in_flight'] ?? 0),
    unfinished: (buckets['blocked'] ?? 0) + (buckets['failed'] ?? 0) + (buckets['refused'] ?? 0),
    realtime: last?.mode === 'realtime' && outstanding + scanBatches === 0,
  };
}

/** 下一步的那一行。輸出之後看交付報告；有沒翻成的，說可以重送，也可以直接輸出。 */
function nextFinding(book: string, next: NextStep, unfinished: number): Finding {
  if (next.step === 'assemble') return finding('status.next_assemble', 'info', { book });
  if (next.step === 'retry') return finding('status.next_failed', 'info', { book, count: String(unfinished), command: next.command });
  return finding('status.next', 'info', { command: next.command });
}

export function bookStatus(home: string, slug: string, offsetOf: ZoneOffset = localOffset): PlanOutcome {
  const book = readBook(home, slug);
  const store = openBookStore(home, slug);
  try {
    const units = unitCounts(store.all('SELECT state, COUNT(*) AS count FROM unit GROUP BY state'));
    const total = Object.values(units).reduce((sum, count) => sum + count, 0);
    const inScope = scopeOf(home, book);
    const chapters = inScope === null ? null : (book.config.chapters ?? null);
    const rows = store.all<UnitRow>('SELECT block_id, state, source, placeholders, fielded, human FROM unit');
    const scoped = scopeCounts(scopedUnits(rows, inScope));
    const buckets = bucketCounts(scoped.states);
    const spent = spentUsd(store);
    const budget = book.config.budget_usd ?? null;
    const batchRows = store.all<BatchRow>(
      'SELECT remote_id, state, requests, submitted_at, expires_at, deleted_at FROM batch ORDER BY id',
    );
    const data = {
      book: slug,
      units,
      kept: scoped.kept,
      fielded: scoped.fielded,
      human: scoped.human,
      // 訊息裡的數字：範圍內，範圍外沒完成的另算（ADR-0114）。`units` 是整本書各狀態的原值。
      scope: { chapters, total: scoped.total, kept: scoped.kept, fielded: scoped.fielded, human: scoped.human, ...buckets, outside: scoped.outside },
      spent_usd: spent,
      budget_usd: budget,
      batches: batchRows.map(({ remote_id, state, requests, submitted_at, expires_at, deleted_at }) => ({
        remote_id,
        state,
        requests,
        submitted_at,
        expires_at,
        deleted: deleted_at !== null,
      })),
    };
    const batches = batchFindings(batchRows, offsetOf);
    // 實體卡只印數量（ADR-0119 第 12 項）。還沒跑 Pass 0 的書沒有這一行。
    const cards = entityCounts(store);
    const entities = cards === null ? [] : [finding('status.entities', 'info', asText({ ...cards }))];
    if (cards !== null) Object.assign(data, { entities: cards });
    const progress = progressOf(store, buckets, total);
    const next = nextStep(slug, progress);
    Object.assign(data, { next });
    const nextLine = nextFinding(slug, next, progress.unfinished);
    if (total === 0) return { data, findings: [finding('status.no_units', 'info', { book: slug }), ...entities, ...batches, nextLine] };
    const params = asText({ total: scoped.total, kept: scoped.kept, ...buckets });
    const money =
      budget === null
        ? finding('status.no_budget', 'info', { spent: usd(spent) })
        : finding('status.spent', 'info', { spent: usd(spent), budget: usd(budget) });
    return {
      data,
      findings: [
        finding('status.units', 'info', params),
        ...fieldedFindings(scoped.fielded),
        ...(scoped.human === 0 ? [] : [finding('units.human', 'info', { count: String(scoped.human) })]),
        ...outsideFindings(slug, chapters, scoped.outside),
        ...entities,
        money,
        ...batches,
        nextLine,
      ],
    };
  } finally {
    store.close();
  }
}
