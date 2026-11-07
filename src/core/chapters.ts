import type { Book } from './book.ts';
import { TomeError } from './errors.ts';
import { finding, type Finding } from './findings.ts';
import type { IrDocument, Section } from './ir.ts';

// 章節怎麼切：`--chapters`、請求不跨章、`tome preview` 的分檔與範圍內的數字都用這裡（ADR-0103、ADR-0115）。
// 書籤標題是書本文字，這裡只回編號與數量（ADR-0059）。

/**
 * 第 `level` 層以內的書籤，依閱讀順序攤平，每一個都是一章（ADR-0115）。只取第 N 層的話，
 * 沒有子書籤的上層書籤與父書籤到第一個子書籤之間的內容會沒有自己的章。
 */
export function chapterSections(sections: readonly Section[], level: number): Section[] {
  return sections.flatMap((section) => [
    section,
    ...(level > 1 ? chapterSections(section.children, level - 1) : []),
  ]);
}

/** 每一層有幾個書籤，第一個是頂層。沒有書籤、用標題建的章節只有一層（ADR-0092 第 5 項）。 */
export function levelCounts(sections: readonly Section[]): number[] {
  const counts: number[] = [];
  const visit = (nodes: readonly Section[], depth: number): void => {
    if (nodes.length === 0) return;
    counts[depth] = (counts[depth] ?? 0) + nodes.length;
    for (const { children } of nodes) visit(children, depth + 1);
  };
  visit(sections, 0);
  return counts;
}

/** 這本書可以選到第幾層，沒有章節的書也有一層。 */
export function chapterLevels(document: IrDocument): number {
  return Math.max(1, levelCounts(document.sections).length);
}

/** 超過這本書的層數回 `chapter_level.invalid`（ADR-0115）。 */
export function checkedLevel(document: IrDocument, level: number): number {
  const levels = chapterLevels(document);
  if (!Number.isInteger(level) || level < 1 || level > levels) {
    throw new TomeError('chapter_level.invalid', { value: String(level), levels: String(levels) });
  }
  return level;
}

/** 依第幾層分章，`book.yaml` 的 `chapter_level` 沒寫是 1（ADR-0115）。 */
export function levelOf(book: Book): number {
  return book.config.chapter_level ?? 1;
}

/**
 * 區塊屬於哪一章，從 1 起算。第一章之前是 0，沒有章節的書整本算第 1 章（ADR-0103）。
 * `level` 是依第幾層分章（ADR-0115）。
 */
export function chapterMap(document: IrDocument, level = 1): Map<string, number> {
  const starts = new Map(
    chapterSections(document.sections, level).flatMap(({ block_id: id }, index) =>
      id === undefined ? [] : [[id, index + 1] as const],
    ),
  );
  let current = starts.size === 0 ? 1 : 0;
  return new Map(
    document.blocks.map(({ id }) => {
      current = starts.get(id) ?? current;
      return [id, current];
    }),
  );
}

/** 這本書依第 `level` 層分章時的章數，沒有章節的書算 1 章。 */
export function chapterCount(document: IrDocument, level = 1): number {
  return Math.max(1, chapterSections(document.sections, level).length);
}

/** `3`、`1-3`、`1,3,5`。`count` 是這本書的章數。 */
export function parseChapters(spec: string, count: number): ReadonlySet<number> {
  const invalid = new TomeError('chapters.invalid', { spec, count: String(count) });
  const chapters = new Set<number>();
  for (const part of spec.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (match === null) throw invalid;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || from > to || to > count) throw invalid;
    for (let chapter = from; chapter <= to; chapter += 1) chapters.add(chapter);
  }
  return new Set([...chapters].sort((a, b) => a - b));
}

/**
 * 書籤有兩層以上時，說每一層有幾個、目前依第幾層分章、共幾章（ADR-0115）。書籤標題是書本文字，
 * 只給數字（ADR-0059）。
 */
export function levelFindings(book: string, document: IrDocument, level: number): Finding[] {
  const counts = levelCounts(document.sections);
  if (counts.length < 2) return [];
  return [
    finding('chapters.levels', 'info', {
      book,
      levels: String(counts.length),
      counts: counts.join('／'),
      level: String(level),
      chapters: String(chapterCount(document, level)),
    }),
  ];
}
