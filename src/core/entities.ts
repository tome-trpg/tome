import type { TermMatch } from './mask.ts';
import type { Store } from './store.ts';

// 實體卡的數量（ADR-0119 第 12 項），`tome glossary review` 與 `tome status` 共用。只有數字。
// 翻譯要用的卡與全書提要也從這裡讀（ADR-0120）。

/** 翻譯與 S-16 要看的實體卡欄位。哪些能用由 `verify.ts` 的 `bookTerms` 決定。 */
export interface EntityCard {
  readonly id: number;
  readonly source: string;
  readonly target: string | null;
  readonly class: string | null;
  readonly gender: string | null;
  readonly pronoun: string | null;
  readonly register: string | null;
  readonly keep_source: boolean;
  /** NULL 是預設的區分大小寫、全字、不限角色。 */
  readonly match: TermMatch | null;
  readonly status: string;
}

interface CardRow extends Omit<EntityCard, 'keep_source' | 'match'> {
  readonly keep_source: number;
  readonly match: string | null;
}

/** 全部的實體卡，依 id。 */
export function entityCards(store: Store): EntityCard[] {
  const rows = store.all<CardRow>(
    'SELECT id, source, target, class, gender, pronoun, register, keep_source, match, status FROM entity ORDER BY id',
  );
  return rows.map((row) => ({
    ...row,
    keep_source: row.keep_source === 1,
    match: row.match === null ? null : (JSON.parse(row.match) as TermMatch),
  }));
}

export interface BookSummary {
  readonly era: string;
  readonly tone: string;
  readonly factions: string;
}

/** 全書提要（ADR-0118 第 8 項），沒跑過 `tome scan-terms` 是 null。 */
export function bookSummary(store: Store): BookSummary | null {
  return store.get<BookSummary>('SELECT era, tone, factions FROM summary WHERE id = 1') ?? null;
}

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
