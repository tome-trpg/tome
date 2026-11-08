import type { Fielded } from './fields.ts';
import { finding, type Finding } from './findings.ts';
import type { DocumentBlock, IrDocument, Run } from './ir.ts';
import { findTerm, maskText, pairedJson, type MaskRange, type Placeholder, type UnitFormats } from './mask.ts';
import { patternInputs, termsFor, type LocalizedTerm, type ResolvedPack } from './pack.ts';
import { runPatterns } from './patterns.ts';
import { nextState, type UnitState } from './state.ts';
import type { Store } from './store.ts';

// document 層轉翻譯單位（白皮書 §5.2、§5.6、ADR-0100）。單位是段落，表格是每個儲存格。

/** 這些角色不翻：頁面雜訊、目錄、索引、版權頁與圖（ADR-0010、ADR-0011、ADR-0099）。 */
export const UNTRANSLATED: ReadonlySet<string> = new Set(['furniture', 'toc', 'index', 'credits', 'figure']);
const KEEP_SOURCE_KIND = 'keep_source';

export interface UnitSource {
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
  /** 行內樣式，沒有時是 null（ADR-0116）。 */
  readonly formats: UnitFormats | null;
  /** 本機欄位化的譯文（ADR-0121）。有的時候 `needs_llm` 是 false。 */
  readonly fielded?: Fielded;
}

interface SourceWithRuns extends UnitSource {
  /** 段落的行內樣式。表格的儲存格不做（ADR-0116）。 */
  readonly runs?: readonly Run[];
}

export interface UnitResult {
  readonly units: readonly TranslationUnit[];
  readonly findings: readonly Finding[];
}

function hasText(text: string): boolean {
  return text.trim() !== '';
}

function sourcesOf(block: DocumentBlock): SourceWithRuns[] {
  const { id, role, group, section, text, table, runs } = block;
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
  return [
    {
      ...base,
      unit_id: id,
      ...(group === undefined ? {} : { group }),
      source: text,
      ...(runs === undefined ? {} : { runs }),
    },
  ];
}

function termRanges(terms: readonly LocalizedTerm[], { source, role }: UnitSource): MaskRange[] {
  return terms.flatMap(({ text, term }) => {
    const { match } = term;
    if (match?.roles !== undefined && !match.roles.includes(role)) return [];
    return findTerm(source, text, match).map(([start, end]) => ({ start, end, kind: KEEP_SOURCE_KIND }));
  });
}

/**
 * 依閱讀順序產生單位。模式逾時就不產生單位，回報是哪個模式（ADR-0049）。`terms` 是這本書的詞條，
 * 含鎖定的實體卡（ADR-0120），`keep_source` 的遮蔽起來；沒給就只用規則包的。
 */
export async function buildUnits(
  document: IrDocument,
  pack: ResolvedPack,
  sourceLang: string,
  terms: readonly LocalizedTerm[] = termsFor(pack, sourceLang),
): Promise<UnitResult> {
  return maskSources(document.blocks.flatMap(sourcesOf), pack, terms);
}

/** 照規則包的模式與 `keep_source` 詞條遮蔽。`tome system test` 也用，跟翻譯時一樣（ADR-0121）。 */
export async function maskSources(
  sources: readonly (UnitSource & { readonly runs?: readonly Run[] })[],
  pack: ResolvedPack,
  terms: readonly LocalizedTerm[],
): Promise<UnitResult> {
  const masks = pack.patterns.filter(({ use }) => use === 'mask');
  const outcome = await runPatterns(
    patternInputs(pack, 'mask'),
    sources.map(({ source }) => source),
  );
  if (outcome.status !== 'ok') {
    return { units: [], findings: [finding('pack.slow_regex', 'fail', { pattern: outcome.pattern })] };
  }
  const kept = terms.filter(({ term }) => term.keep_source === true);
  const units = sources.map(({ runs, ...source }, index) => {
    const patternRanges = masks.flatMap(({ id, kind }) =>
      (outcome.matches[id]?.[index] ?? []).map(([start, end]) => ({ start, end, kind: kind ?? id })),
    );
    return { ...source, ...maskText(source.source, [...patternRanges, ...termRanges(kept, source)], runs) };
  });
  return { units, findings: [] };
}

const INITIAL_STATE: UnitState = 'PENDING';

function formatsJson(unit: TranslationUnit): string | null {
  return unit.formats === null ? null : JSON.stringify(unit.formats);
}

/** 不需要 LLM 的單位譯文就是原文，`<pc>` 的位置也用原文的（ADR-0116）。 */
function keptOffsets(unit: TranslationUnit): string | null {
  return unit.needs_llm ? null : pairedJson(unit.formats?.paired ?? []);
}

/** 欄位化的譯文與 `<pc>` 的位置來自本機產生的譯文（ADR-0121）。 */
function localTranslation(unit: TranslationUnit): string | null {
  if (unit.fielded !== undefined) return unit.fielded.translation;
  return unit.needs_llm ? null : unit.source;
}

function localOffsets(unit: TranslationUnit): string | null {
  return unit.fielded === undefined ? keptOffsets(unit) : pairedJson(unit.fielded.paired);
}

function insertUnit(store: Store, unit: TranslationUnit, seq: number): void {
  // 不需要 LLM 的單位原樣輸出（ADR-0100），欄位化的用本機的譯文（ADR-0121）。
  const state = unit.needs_llm ? INITIAL_STATE : nextState(INITIAL_STATE, 'hit');
  store.run(
    `INSERT OR REPLACE INTO unit
       (unit_id, block_id, role, group_id, section, seq, source, masked, placeholders, state, attempts, translation,
        formats, translation_pc, fielded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
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
    localTranslation(unit),
    formatsJson(unit),
    localOffsets(unit),
    unit.fielded === undefined ? 0 : 1,
  );
}

/** 欄位化的單位每次照最新的譯名改寫；原本送 LLM 翻的也改用本機的譯文，舊的回應留著（ADR-0121）。 */
function fieldUnit(store: Store, unit: TranslationUnit & { readonly fielded: Fielded }): void {
  store.run(
    "UPDATE unit SET state = 'DONE', translation = ?, translation_pc = ?, fielded = 1 WHERE unit_id = ?",
    unit.fielded.translation,
    pairedJson(unit.fielded.paired),
    unit.unit_id,
  );
}

/** 遮蔽後的文字沒變，狀態與譯文留著。樣式照新的寫，譯文的樣式讀的時候從它套上（ADR-0116）。 */
function moveUnit(store: Store, unit: TranslationUnit, seq: number): void {
  store.run(
    'UPDATE unit SET block_id = ?, role = ?, group_id = ?, section = ?, seq = ?, formats = ? WHERE unit_id = ?',
    unit.block_id,
    unit.role,
    unit.group ?? null,
    unit.section === undefined ? null : JSON.stringify(unit.section),
    seq,
    formatsJson(unit),
    unit.unit_id,
  );
  if (!unit.needs_llm && unit.fielded === undefined) {
    store.run('UPDATE unit SET translation_pc = ? WHERE unit_id = ?', keptOffsets(unit), unit.unit_id);
  }
}

interface KnownUnit {
  readonly masked: string;
  readonly state: UnitState;
  readonly fielded: number;
}

/**
 * 把單位寫進 `book.db`（ADR-0102）。同一個 `unit_id` 且遮蔽後文字相同就保留狀態，
 * 文字變了回到起點，`document` 裡沒有的單位刪除，回應保留。有 `<pc>` 的單位遮蔽後的文字含 `<pc>`，
 * 樣式的範圍變了也會回到起點（ADR-0116）。欄位化的單位每次照最新的譯名改寫；原本欄位化、現在對不上的
 * 回到起點；還在批次裡的單位這次不欄位化，收回之後的下一次才換（ADR-0121）。
 */
export function syncUnits(store: Store, units: readonly TranslationUnit[]): void {
  store.transaction(() => {
    const known = new Map(
      store
        .all<KnownUnit & { unit_id: string }>('SELECT unit_id, masked, state, fielded FROM unit')
        .map(({ unit_id, ...row }) => [unit_id, row]),
    );
    const current = new Set(units.map(({ unit_id }) => unit_id));
    for (const id of known.keys()) {
      if (!current.has(id)) store.run('DELETE FROM unit WHERE unit_id = ?', id);
    }
    units.forEach((unit, seq) => {
      const before = known.get(unit.unit_id);
      if (before?.masked !== unit.masked) {
        insertUnit(store, unit, seq);
        return;
      }
      if (unit.fielded === undefined && before.fielded === 1) {
        insertUnit(store, unit, seq);
        return;
      }
      moveUnit(store, unit, seq);
      if (unit.fielded !== undefined && before.state !== 'IN_FLIGHT') fieldUnit(store, { ...unit, fielded: unit.fielded });
    });
  });
}
