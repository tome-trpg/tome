import { finding, type Finding } from './findings.ts';
import type { DocumentBlock, IrDocument } from './ir.ts';
import { findTerm, maskText, type MaskRange, type Placeholder } from './mask.ts';
import { patternInputs, termsFor, type LocalizedTerm, type ResolvedPack } from './pack.ts';
import { runPatterns } from './patterns.ts';
import { nextState, type UnitState } from './state.ts';
import type { Store } from './store.ts';

// document 層轉翻譯單位（白皮書 §5.2、§5.6、ADR-0100）。單位是段落，表格是每個儲存格。

/** 這些角色不翻：頁面雜訊、目錄、索引、版權頁與圖（ADR-0010、ADR-0011、ADR-0099）。 */
const UNTRANSLATED = new Set(['furniture', 'toc', 'index', 'credits', 'figure']);
const KEEP_SOURCE_KIND = 'keep_source';

interface UnitSource {
  readonly unit_id: string;
  readonly block_id: string;
  readonly role: string;
  readonly group?: string;
  readonly section?: readonly string[];
  readonly source: string;
}

export interface TranslationUnit extends UnitSource {
  readonly masked: string;
  readonly placeholders: readonly Placeholder[];
  readonly needs_llm: boolean;
}

export interface UnitResult {
  readonly units: readonly TranslationUnit[];
  readonly findings: readonly Finding[];
}

function hasText(text: string): boolean {
  return text.trim() !== '';
}

function sourcesOf(block: DocumentBlock): UnitSource[] {
  const { id, role, group, section, text, table } = block;
  if (UNTRANSLATED.has(role)) return [];
  const base = { block_id: id, role, ...(section === undefined ? {} : { section }) };
  if (table !== undefined) {
    // 同一張表的單位要在同一個請求，表頭才帶得到（ADR-0029）。
    return table.cells
      .filter((cell) => hasText(cell.text))
      .map((cell) => ({
        ...base,
        unit_id: `${id}-r${cell.row}c${cell.col}`,
        group: id,
        source: cell.text,
      }));
  }
  if (!hasText(text)) return [];
  return [{ ...base, unit_id: id, ...(group === undefined ? {} : { group }), source: text }];
}

function termRanges(terms: readonly LocalizedTerm[], { source, role }: UnitSource): MaskRange[] {
  return terms.flatMap(({ text, term }) => {
    const { match } = term;
    if (match?.roles !== undefined && !match.roles.includes(role)) return [];
    return findTerm(source, text, match).map(([start, end]) => ({ start, end, kind: KEEP_SOURCE_KIND }));
  });
}

/** 依閱讀順序產生單位。模式逾時就不產生單位，回報是哪個模式（ADR-0049）。 */
export async function buildUnits(
  document: IrDocument,
  pack: ResolvedPack,
  sourceLang: string,
): Promise<UnitResult> {
  const sources = document.blocks.flatMap(sourcesOf);
  const masks = pack.patterns.filter(({ use }) => use === 'mask');
  const outcome = await runPatterns(
    patternInputs(pack, 'mask'),
    sources.map(({ source }) => source),
  );
  if (outcome.status !== 'ok') {
    return { units: [], findings: [finding('pack.slow_regex', 'fail', { pattern: outcome.pattern })] };
  }
  const terms = termsFor(pack, sourceLang).filter(({ term }) => term.keep_source === true);
  const units = sources.map((source, index) => {
    const patternRanges = masks.flatMap(({ id, kind }) =>
      (outcome.matches[id]?.[index] ?? []).map(([start, end]) => ({ start, end, kind: kind ?? id })),
    );
    return { ...source, ...maskText(source.source, [...patternRanges, ...termRanges(terms, source)]) };
  });
  return { units, findings: [] };
}

const INITIAL_STATE: UnitState = 'PENDING';

function insertUnit(store: Store, unit: TranslationUnit, seq: number): void {
  // 不需要 LLM 的單位原樣輸出（ADR-0100）。
  const state = unit.needs_llm ? INITIAL_STATE : nextState(INITIAL_STATE, 'hit');
  store.run(
    `INSERT OR REPLACE INTO unit
       (unit_id, block_id, role, group_id, section, seq, source, masked, placeholders, state, attempts, translation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    unit.unit_id,
    unit.block_id,
    unit.role,
    unit.group ?? null,
    unit.section === undefined ? null : JSON.stringify(unit.section),
    seq,
    unit.source,
    unit.masked,
    JSON.stringify(unit.placeholders),
    state,
    unit.needs_llm ? null : unit.source,
  );
}

function moveUnit(store: Store, unit: TranslationUnit, seq: number): void {
  store.run(
    'UPDATE unit SET block_id = ?, role = ?, group_id = ?, section = ?, seq = ? WHERE unit_id = ?',
    unit.block_id,
    unit.role,
    unit.group ?? null,
    unit.section === undefined ? null : JSON.stringify(unit.section),
    seq,
    unit.unit_id,
  );
}

/**
 * 把單位寫進 `book.db`（ADR-0102）。同一個 `unit_id` 且遮蔽後文字相同就保留狀態，
 * 文字變了回到起點，`document` 裡沒有的單位刪除，回應保留。
 */
export function syncUnits(store: Store, units: readonly TranslationUnit[]): void {
  store.transaction(() => {
    const known = new Map(
      store
        .all<{ unit_id: string; masked: string }>('SELECT unit_id, masked FROM unit')
        .map(({ unit_id, masked }) => [unit_id, masked]),
    );
    const current = new Set(units.map(({ unit_id }) => unit_id));
    for (const id of known.keys()) {
      if (!current.has(id)) store.run('DELETE FROM unit WHERE unit_id = ?', id);
    }
    units.forEach((unit, seq) => {
      if (known.get(unit.unit_id) === unit.masked) moveUnit(store, unit, seq);
      else insertUnit(store, unit, seq);
    });
  });
}
