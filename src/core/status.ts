import { readBook } from './book.ts';
import { finding, type Finding } from './findings.ts';
import { spentUsd } from './ledger.ts';
import { needsLlm, type Placeholder } from './mask.ts';
import { usd } from './provider.ts';
import type { PlanOutcome } from './request.ts';
import { UNIT_STATES, type UnitState } from './state.ts';
import { openBookStore, type Store } from './store.ts';

// `tome status`（ADR-0099 第 2 項、ADR-0107 第 18 項）。只讀 `book.db` 與 `book.yaml`，不連網，
// 不拿書的鎖，`tome translate` 在等批次時也能用。只有數字，不含書本文字。

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
  for (const { state, count } of rows) counts[state] = count;
  return counts;
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

function bucketParams(units: Readonly<Record<UnitState, number>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(STATUS_BUCKETS).map(([name, states]) => [name, String(states.reduce((sum, state) => sum + units[state], 0))]),
  );
}

/** 不需翻譯、原樣保留的單位。單位表沒有這一欄，用存下的原文與佔位符算，跟遮蔽時的判斷相同（ADR-0111）。 */
function keptUnits(store: Store): number {
  const rows = store.all<{ source: string; placeholders: string }>('SELECT source, placeholders FROM unit');
  return rows.filter(({ source, placeholders }) => !needsLlm(source, JSON.parse(placeholders) as Placeholder[])).length;
}

export function bookStatus(home: string, slug: string, offsetOf: ZoneOffset = localOffset): PlanOutcome {
  const book = readBook(home, slug);
  const store = openBookStore(home, slug);
  try {
    const units = unitCounts(store.all('SELECT state, COUNT(*) AS count FROM unit GROUP BY state'));
    const total = Object.values(units).reduce((sum, count) => sum + count, 0);
    const kept = keptUnits(store);
    const spent = spentUsd(store);
    const budget = book.config.budget_usd ?? null;
    const rows = store.all<BatchRow>(
      'SELECT remote_id, state, requests, submitted_at, expires_at, deleted_at FROM batch ORDER BY id',
    );
    const data = {
      book: slug,
      units,
      kept,
      spent_usd: spent,
      budget_usd: budget,
      batches: rows.map(({ remote_id, state, requests, submitted_at, expires_at, deleted_at }) => ({
        remote_id,
        state,
        requests,
        submitted_at,
        expires_at,
        deleted: deleted_at !== null,
      })),
    };
    const batches = batchFindings(rows, offsetOf);
    if (total === 0) return { data, findings: [finding('status.no_units', 'info', { book: slug }), ...batches] };
    const params = { total: String(total), kept: String(kept), ...bucketParams(units) };
    const money =
      budget === null
        ? finding('status.no_budget', 'info', { spent: usd(spent) })
        : finding('status.spent', 'info', { spent: usd(spent), budget: usd(budget) });
    return { data, findings: [finding('status.units', 'info', params), money, ...batches] };
  } finally {
    store.close();
  }
}
