import { normalizeText, type SourceLanguage } from './language.ts';

// 字元守恆（S-14）：原生文字層的字都要有去處。規則是用七份商業 PDF 量過才定的（ADR-0092）：
// 引擎會換掉標點，所以只比字母與數字。字元計數會被疊印的文字騙，逐行比對會被跨儲存格的
// 行騙，兩邊都說不見才算缺字。閱讀順序錯了不會被算成缺字。

/** 缺字同時超過這兩個門檻才算失敗。 */
export const MISSING_SHARE = 0.01;
export const MISSING_MIN = 5;

/** 比這短的文字段到處都找得到，逐行比對沒有意義。 */
const LINE_MIN = 3;

export interface Conservation {
  /** 文字層的字母與數字數。 */
  readonly total: number;
  /** 文字層有、區塊裡沒有的字母與數字數，看不見的字已經扣掉。 */
  readonly missing: number;
  readonly passed: boolean;
}

function foldText(language: SourceLanguage, text: string): string {
  return normalizeText(language, text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function countChars(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  return counts;
}

/** 引擎多出來的字不算失敗，這裡只抓不見的字。 */
export function checkConservation(
  language: SourceLanguage,
  pageTexts: readonly string[],
  blockTexts: readonly string[],
  invisibleGlyphs: number,
): Conservation {
  const lines = pageTexts.map((text) => foldText(language, text));
  const blocks = blockTexts.map((text) => foldText(language, text)).join('');
  const inBlocks = countChars(blocks);
  let total = 0;
  let byCount = 0;
  for (const [char, count] of countChars(lines.join(''))) {
    total += count;
    byCount += Math.max(0, count - (inBlocks.get(char) ?? 0));
  }
  const byLine = lines
    .filter((line) => line.length >= LINE_MIN && !blocks.includes(line))
    .reduce((sum, line) => sum + line.length, 0);
  const missing = Math.max(0, Math.min(byCount, byLine) - invisibleGlyphs);
  return { total, missing, passed: missing <= Math.max(MISSING_MIN, total * MISSING_SHARE) };
}
