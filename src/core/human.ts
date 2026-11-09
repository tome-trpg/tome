import { createHash } from 'node:crypto';
import { openSeriesStore, type Store } from './store.ts';

// 人工譯文（ADR-0012、ADR-0125）。`tome sync` 從 vault 讀回，內容以 `series.db` 為主，
// `book.db` 的單位只記標記：`syncUnits` 會重寫單位，每次重寫後從這裡套回。
// 譯文是書本文字，只存在這兩個資料庫，不進訊息與紀錄。

export interface HumanText {
  readonly unit_id: string;
  readonly source: string;
  /** 使用者在 vault 寫的樣子：粗體、斜體照 Markdown 存，頁碼參照的連結換回顯示的字。 */
  readonly text: string;
}

export interface HumanApplied {
  /** 這次改成人工譯文的單位數（已經是同一份人工譯文的不算）。 */
  readonly applied: number;
  /** 對不到的人工譯文：單位不在了，或原文變了。 */
  readonly orphaned: number;
}

/** 送出中的單位收回時會被模型的譯文蓋掉，不套（ADR-0125）。 */
export const BUSY_STATES: ReadonlySet<string> = new Set(['IN_FLIGHT', 'RECEIVED']);

export function withSeries<T>(home: string, slug: string, work: (series: Store) => T): T {
  const series = openSeriesStore(home, slug);
  try {
    return work(series);
  } finally {
    series.close();
  }
}

export function sourceHash(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

/** 同一個單位再回收就覆蓋。 */
export function saveHuman(series: Store, book: string, texts: readonly HumanText[]): void {
  const now = new Date().toISOString();
  series.transaction(() => {
    for (const { unit_id, source, text } of texts) {
      series.run(
        `INSERT INTO human (book, unit_id, source_sha256, text, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (book, unit_id) DO UPDATE SET
           source_sha256 = excluded.source_sha256, text = excluded.text, created_at = excluded.created_at`,
        book,
        unit_id,
        sourceHash(source),
        text,
        now,
      );
    }
  });
}

interface HumanRow {
  readonly unit_id: string;
  readonly source_sha256: string;
  readonly text: string;
}

interface UnitRow {
  readonly unit_id: string;
  readonly source: string;
  readonly state: string;
  readonly translation: string | null;
  readonly human: number;
}

/**
 * 把人工譯文套到單位上：`DONE`、`human = 1`，`attempts` 不動。狀態用 SQL 直接設，跟 `resetUnit` 一樣
 * 不經過狀態機（ADR-0125）。已經是同一份人工譯文的不動。問題不碰：`syncUnits` 重寫單位後套回時分不出
 * 文字有沒有變，換掉問題交給知道這次存了哪些的 `tome sync` 與查全部的 `tome verify`（ADR-0126）。
 */
export function applyHuman(store: Store, series: Store, book: string): HumanApplied {
  const rows = series.all<HumanRow>('SELECT unit_id, source_sha256, text FROM human WHERE book = ?', book);
  const units = new Map(
    store
      .all<UnitRow>('SELECT unit_id, source, state, translation, human FROM unit')
      .map((unit) => [unit.unit_id, unit]),
  );
  let applied = 0;
  let orphaned = 0;
  store.transaction(() => {
    for (const { unit_id, source_sha256, text } of rows) {
      const unit = units.get(unit_id);
      if (unit === undefined || sourceHash(unit.source) !== source_sha256) {
        orphaned += 1;
        continue;
      }
      if (unit.human === 1 && unit.translation === text) continue;
      if (BUSY_STATES.has(unit.state)) continue;
      store.run(
        "UPDATE unit SET state = 'DONE', translation = ?, translation_pc = NULL, human = 1 WHERE unit_id = ?",
        text,
        unit_id,
      );
      applied += 1;
    }
  });
  return { applied, orphaned };
}
