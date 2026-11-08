import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bookDir, readBook, withBookLock } from './book.ts';
import { chapterMap, checkedLevel, levelOf } from './chapters.ts';
import { readDocument } from './extract.ts';
import { finding } from './findings.ts';
import type { Run } from './ir.ts';
import { unitRuns, type PairedOffset, type UnitFormats } from './mask.ts';
import type { PlanOutcome } from './request.ts';
import { openBookStore } from './store.ts';

// 原文與譯文對照（ADR-0099 第 3 項、ADR-0104 第 22、23 項）。只留在本機，M2 沒有 vault，
// 要看譯文靠它。檔案裡只放狀態代碼，不放說明：核心不放給人看的文字。粗體、斜體用 Markdown 標出（ADR-0116）。

const REVIEW_DIR = 'review';
const UNTRANSLATED = '[!untranslated]';
/** `fileName` 產生的檔名。 */
const OWN_FILE = /^\d{2,}\.md$/;

interface PreviewRow {
  readonly block_id: string;
  readonly source: string;
  readonly state: string;
  readonly translation: string | null;
  readonly formats: string | null;
  readonly translation_pc: string | null;
}

function quoted(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function markerOf({ marks = [] }: Run): string {
  const bold = marks.includes('bold');
  const italic = marks.includes('italic');
  if (bold && italic) return '***';
  if (bold) return '**';
  return italic ? '*' : '';
}

/**
 * 粗體、斜體用 Markdown 標出來，連結只顯示文字（ADR-0116）。樣式兩端的空白移到記號外面，
 * 書裡本來的 `*` 不跳脫：預覽要跟書對得起來。
 */
export function markdownText(text: string, runs: readonly Run[]): string {
  let result = '';
  let cursor = 0;
  for (const run of runs) {
    const marker = markerOf(run);
    const inner = text.slice(run.start, run.end);
    const core = inner.trim();
    if (marker === '' || core === '' || run.start < cursor) continue;
    const lead = inner.slice(0, inner.length - inner.trimStart().length);
    const trail = inner.slice(inner.trimEnd().length);
    result += `${text.slice(cursor, run.start)}${lead}${marker}${core}${marker}${trail}`;
    cursor = run.end;
  }
  return result + text.slice(cursor);
}

function parsed<T>(json: string | null, fallback: T): T {
  return json === null ? fallback : (JSON.parse(json) as T);
}

function paragraph({ block_id, source, state, translation, formats, translation_pc }: PreviewRow): string {
  const mark = `<!-- ${block_id} -->`;
  // 沒處理的 `BLOCKED` 單位不放原文，否則個資會進入輸出（白皮書 §6.2）。
  if (state === 'BLOCKED') return `${mark}\n${quoted(`${UNTRANSLATED} ${state}`)}\n`;
  const styles = parsed<UnitFormats | null>(formats, null);
  const before = markdownText(source, unitRuns(source, styles, styles?.paired ?? []));
  const after =
    state === 'DONE' && translation !== null
      ? markdownText(translation, unitRuns(translation, styles, parsed<PairedOffset[]>(translation_pc, [])))
      : `${UNTRANSLATED} ${state}`;
  return `${mark}\n${before}\n\n${quoted(after)}\n`;
}

function fileName(chapter: number): string {
  return `${String(chapter).padStart(2, '0')}.md`;
}

/** 章節變少時舊檔要清掉，使用者放在裡面的其他檔案與資料夾留著（ADR-0104 第 48 項）。 */
function removeOldFiles(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isFile() && OWN_FILE.test(entry.name)) rmSync(join(path, entry.name));
  }
}

function previewLocked(home: string, slug: string): PlanOutcome {
  // 一章一檔，跟 `--chapters` 用同一個層級（ADR-0115）。
  const document = readDocument(home, slug);
  const chapters = chapterMap(document, checkedLevel(document, levelOf(readBook(home, slug))));
  const store = openBookStore(home, slug);
  let rows: PreviewRow[];
  try {
    rows = store.all<PreviewRow>(
      'SELECT block_id, source, state, translation, formats, translation_pc FROM unit ORDER BY seq',
    );
  } finally {
    store.close();
  }
  const files = new Map<number, string[]>();
  for (const row of rows) {
    const chapter = chapters.get(row.block_id) ?? 0;
    const paragraphs = files.get(chapter) ?? [];
    paragraphs.push(paragraph(row));
    files.set(chapter, paragraphs);
  }
  const path = join(bookDir(home, slug), REVIEW_DIR);
  mkdirSync(path, { recursive: true });
  removeOldFiles(path);
  for (const [chapter, paragraphs] of files) {
    writeFileSync(join(path, fileName(chapter)), paragraphs.join('\n'));
  }
  const count = String(files.size);
  return { data: { book: slug, files: files.size, path }, findings: [finding('preview.done', 'info', { files: count, path })] };
}

/** `tome preview`。不連網，也不花 token。 */
export function previewBook(home: string, slug: string): Promise<PlanOutcome> {
  return withBookLock(home, slug, async () => previewLocked(home, slug));
}
