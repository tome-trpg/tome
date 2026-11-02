import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bookDir, withBookLock } from './book.ts';
import { readDocument } from './extract.ts';
import { finding } from './findings.ts';
import { chapterMap, type PlanOutcome } from './request.ts';
import { openBookStore } from './store.ts';

// 原文與譯文對照（ADR-0099 第 3 項、ADR-0104 第 22、23 項）。只留在本機，M2 沒有 vault，
// 要看譯文靠它。檔案裡只放狀態代碼，不放說明：核心不放給人看的文字。

const REVIEW_DIR = 'review';
const UNTRANSLATED = '[!untranslated]';
/** `fileName` 產生的檔名。 */
const OWN_FILE = /^\d{2,}\.md$/;

interface PreviewRow {
  readonly block_id: string;
  readonly source: string;
  readonly state: string;
  readonly translation: string | null;
}

function quoted(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function paragraph({ block_id, source, state, translation }: PreviewRow): string {
  const mark = `<!-- ${block_id} -->`;
  // 沒處理的 `BLOCKED` 單位不放原文，否則個資會進入輸出（白皮書 §6.2）。
  if (state === 'BLOCKED') return `${mark}\n${quoted(`${UNTRANSLATED} ${state}`)}\n`;
  const after = state === 'DONE' && translation !== null ? translation : `${UNTRANSLATED} ${state}`;
  return `${mark}\n${source}\n\n${quoted(after)}\n`;
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
  const chapters = chapterMap(readDocument(home, slug));
  const store = openBookStore(home, slug);
  let rows: PreviewRow[];
  try {
    rows = store.all<PreviewRow>('SELECT block_id, source, state, translation FROM unit ORDER BY seq');
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
