import { readBook } from './book.ts';
import { finding, type Finding } from './findings.ts';
import { spentUsd } from './ledger.ts';
import { usd } from './provider.ts';
import type { PlanOutcome } from './request.ts';
import { UNIT_STATES, type UnitState } from './state.ts';
import { openBookStore } from './store.ts';

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

/** 給人看的時間一律用 UTC，在哪個時區看都一樣。`--json` 放原值。 */
export function utcMinute(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ');
}

function unitCounts(rows: readonly { readonly state: UnitState; readonly count: number }[]): Record<UnitState, number> {
  const counts = Object.fromEntries(UNIT_STATES.map((state) => [state, 0])) as Record<UnitState, number>;
  for (const { state, count } of rows) counts[state] = count;
  return counts;
}

function batchFindings(rows: readonly BatchRow[]): Finding[] {
  const outstanding = rows.flatMap((row): Finding[] => {
    if (row.state === 'submitted' && row.remote_id !== null) {
      return [
        finding('status.batch', 'info', {
          id: row.remote_id,
          submitted: row.submitted_at === null ? '-' : utcMinute(row.submitted_at),
          requests: String(row.requests),
          expires: row.expires_at === null ? '-' : utcMinute(row.expires_at),
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

export function bookStatus(home: string, slug: string): PlanOutcome {
  const book = readBook(home, slug);
  const store = openBookStore(home, slug);
  try {
    const units = unitCounts(store.all('SELECT state, COUNT(*) AS count FROM unit GROUP BY state'));
    const total = Object.values(units).reduce((sum, count) => sum + count, 0);
    const spent = spentUsd(store);
    const budget = book.config.budget_usd ?? null;
    const rows = store.all<BatchRow>(
      'SELECT remote_id, state, requests, submitted_at, expires_at, deleted_at FROM batch ORDER BY id',
    );
    const data = {
      book: slug,
      units,
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
    if (total === 0) return { data, findings: [finding('status.no_units', 'info', { book: slug }), ...batchFindings(rows)] };
    const stuck = units.BLOCKED + units.FAILED_QA + units.REFUSED;
    const inFlight = units.IN_FLIGHT;
    const params = {
      total: String(total),
      done: String(units.DONE),
      in_flight: String(inFlight),
      blocked: String(units.BLOCKED),
      failed: String(units.FAILED_QA),
      refused: String(units.REFUSED),
      left: String(total - units.DONE - stuck - inFlight),
    };
    const money =
      budget === null
        ? finding('status.no_budget', 'info', { spent: usd(spent) })
        : finding('status.spent', 'info', { spent: usd(spent), budget: usd(budget) });
    return { data, findings: [finding('status.units', 'info', params), money, ...batchFindings(rows)] };
  } finally {
    store.close();
  }
}
