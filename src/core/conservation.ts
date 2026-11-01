import { normalizeText, type SourceLanguage } from './language.ts';

// 字元守恆（S-14）：原生文字層的字都要有去處。比的是每頁的字元計數，不管順序，
// 所以閱讀順序錯了不會被算成缺字。引擎的 raw 已經去掉斷字，連字號不算（ADR-0092）。

/** 缺字同時超過這兩個門檻才算失敗。是提案，H-8 量過才定案。 */
export const MISSING_SHARE = 0.01;
export const MISSING_MIN = 5;

export interface Conservation {
  /** 文字層的字元數，不含空白與連字號。 */
  readonly total: number;
  /** 文字層有、區塊裡沒有的字元數，看不見的字已經扣掉。 */
  readonly missing: number;
  readonly passed: boolean;
}

function countChars(language: SourceLanguage, texts: readonly string[]): Map<string, number> {
  const ignored = new Set(language.dehyphenate.hyphens);
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const char of normalizeText(language, text)) {
      if (ignored.has(char) || /\s/u.test(char)) continue;
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }
  }
  return counts;
}

/** 引擎多出來的字不算失敗：疊印的文字會被算兩次，這裡只抓不見的字。 */
export function checkConservation(
  language: SourceLanguage,
  pageTexts: readonly string[],
  blockTexts: readonly string[],
  invisibleGlyphs: number,
): Conservation {
  const page = countChars(language, pageTexts);
  const blocks = countChars(language, blockTexts);
  let total = 0;
  let lost = 0;
  for (const [char, count] of page) {
    total += count;
    lost += Math.max(0, count - (blocks.get(char) ?? 0));
  }
  const missing = Math.max(0, lost - invisibleGlyphs);
  return { total, missing, passed: missing <= Math.max(MISSING_MIN, total * MISSING_SHARE) };
}
