import { finding, type Finding } from './findings.ts';
import type { DocumentBlock, IrDocument } from './ir.ts';
import { findTerm, maskText, type MaskRange, type Placeholder } from './mask.ts';
import { patternInputs, termsFor, type LocalizedTerm, type ResolvedPack } from './pack.ts';
import { runPatterns } from './patterns.ts';

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
