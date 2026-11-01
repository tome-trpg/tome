import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TargetLanguage } from './language.ts';
import type { ResolvedPack } from './pack.ts';

// 靜態前綴（白皮書 §5.7、ADR-0103）。指令是英文，風格指南與範例是繁體中文（ADR-0099）。
// 這段同一本書位元組一致，不放任何會變的東西（ADR-0036）。文字都是資料檔，由維護者審過。

const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
const PERSONA_FILE = 'persona_and_tone.md';
const FEW_SHOTS_FILE = 'few_shots.md';

export function readInstructions(): string {
  // src 與 dist 到 repo 根目錄的深度相同。
  return readFileSync(new URL('../../prompts/translate.md', import.meta.url), 'utf8');
}

/** 範本的說明寫在註解裡，不該送給模型。用 indexOf 掃，規則包是不受信任的資料。 */
function withoutComments(text: string): string {
  let result = '';
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf(COMMENT_OPEN, index);
    const close = open < 0 ? -1 : text.indexOf(COMMENT_CLOSE, open + COMMENT_OPEN.length);
    if (close < 0) return result + text.slice(index);
    result += text.slice(index, open);
    index = close + COMMENT_CLOSE.length;
  }
  return result;
}

/** 繼承鏈由子到父，第一個有內容的檔案算數（ADR-0045）。 */
function packText(pack: ResolvedPack, file: string): string {
  for (const { location } of pack.chain) {
    const path = join(location.dir, file);
    const text = existsSync(path) ? withoutComments(readFileSync(path, 'utf8')).trim() : '';
    if (text !== '') return text;
  }
  return '';
}

export function staticPrefix(language: TargetLanguage, pack: ResolvedPack): string {
  const styleGuide = language.style_guide.map((line) => `- ${line}`).join('\n');
  const parts = [readInstructions().trim(), styleGuide, packText(pack, PERSONA_FILE), packText(pack, FEW_SHOTS_FILE)];
  return parts.filter((part) => part !== '').join('\n\n');
}
