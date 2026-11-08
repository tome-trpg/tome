import type { Store } from './store.ts';

// 實體卡的數量（ADR-0119 第 12 項），`tome glossary review` 與 `tome status` 共用。只有數字。

export interface EntityCounts {
  /** 待人審：還沒鎖定的提議，加上沒拿到提議的。 */
  readonly review: number;
  readonly failed: number;
  readonly locked: number;
  readonly human: number;
  readonly auto: number;
  readonly imported: number;
  readonly rejected: number;
  readonly skipped: number;
}

export function countEntities(store: Store): EntityCounts {
  const rows = store.all<{ status: string; decided_by: string | null; count: number }>(
    'SELECT status, decided_by, COUNT(*) AS count FROM entity GROUP BY status, decided_by',
  );
  const of = (status: string, by?: string): number =>
    rows.filter((row) => row.status === status && (by === undefined || row.decided_by === by)).reduce((sum, row) => sum + row.count, 0);
  return {
    review: of('proposed') + of('failed'),
    failed: of('failed'),
    locked: of('locked'),
    human: of('locked', 'human'),
    auto: of('locked', 'auto'),
    imported: of('locked', 'import'),
    rejected: of('rejected'),
    skipped: of('skipped'),
  };
}

/** 沒有實體卡時是 null：還沒跑 Pass 0 也沒匯入的書，`tome status` 不印這一行。 */
export function entityCounts(store: Store): EntityCounts | null {
  const total = store.get<{ count: number }>('SELECT COUNT(*) AS count FROM entity')?.count ?? 0;
  return total === 0 ? null : countEntities(store);
}
