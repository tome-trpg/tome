import type { TargetLanguage } from './language.ts';
import { findTerm, type PairedOffset, type TermMatch } from './mask.ts';
import type { LocalizedTerm, ResolvedPack } from './pack.ts';
import { escapeText, PAIRED_END, pairedTag, parseUnits, unitTag, type Segment } from './tags.ts';
import type { TranslationUnit } from './units.ts';
import { verifyFragment, type VerifyContext } from './verify.ts';

// 數值塊欄位化（白皮書 §5.8、ADR-0051、ADR-0121）。規則包的角色宣告欄位標籤，標籤的譯名從詞條來；
// 一個單位扣掉標籤、鎖定的實體卡、數字、佔位符與標點後一個字母都不剩，就在本機換成譯名，
// 走跟模型回覆同一條驗證，不送 LLM。只有一部分對得上的照常送。

const LETTER = /\p{L}/u;

/** 本機換成譯名的一個詞：有譯名的欄位標籤，或鎖定的實體卡。 */
export interface FieldWord {
  readonly text: string;
  readonly target: string;
  readonly match?: TermMatch;
}

/** 一個角色的欄位標籤，照來源語言；地區標籤沒有寫法時用主要語言，跟詞條一樣。沒有 `fields` 是空的。 */
export function fieldLabels(pack: ResolvedPack, role: string, lang: string): string[] {
  const primary = lang.split('-')[0] ?? lang;
  const declared = pack.roles.find(({ pack: owner, name }) => `${owner}:${name}` === role)?.fields ?? [];
  return declared.flatMap((label) => {
    const text = label[lang] ?? label[primary];
    return text === undefined ? [] : [text];
  });
}

function wordOf({ text, term }: LocalizedTerm): FieldWord {
  return { text, target: term.target, ...(term.match === undefined ? {} : { match: term.match }) };
}

/**
 * 能在本機換掉的詞（ADR-0121）：在這本書的詞條（`bookTerms` 的結果，實體卡優先）裡有譯名的欄位標籤，
 * 加上鎖定的實體卡（`names`）。`keep_source` 的已經遮蔽，不算。
 */
export function fieldWords(
  labels: readonly string[],
  terms: readonly LocalizedTerm[],
  names: readonly LocalizedTerm[],
): FieldWord[] {
  const translated = new Map(terms.filter(({ term }) => term.keep_source !== true).map((item) => [item.text, item]));
  const words = labels.flatMap((label) => {
    const found = translated.get(label);
    return found === undefined ? [] : [wordOf(found)];
  });
  const taken = new Set(words.map(({ text }) => text));
  for (const name of names) {
    if (name.term.keep_source === true || taken.has(name.text)) continue;
    taken.add(name.text);
    words.push(wordOf(name));
  }
  return words;
}

interface Placement {
  readonly start: number;
  readonly end: number;
  readonly target: string;
}

/** 詞的位置：起點前的優先，同起點取長的，不重疊。比對條件照詞條（預設區分大小寫、全字）。 */
function placements(text: string, words: readonly FieldWord[], role: string): Placement[] {
  const found = words.flatMap(({ text: word, target, match }) => {
    if (match?.roles !== undefined && !match.roles.includes(role)) return [];
    return findTerm(text, word, match).map(([start, end]) => ({ start, end, target }));
  });
  found.sort((left, right) => left.start - right.start || right.end - left.end);
  const chosen: Placement[] = [];
  let cursor = 0;
  for (const placement of found) {
    if (placement.start < cursor) continue;
    chosen.push(placement);
    cursor = placement.end;
  }
  return chosen;
}

interface Swapped {
  readonly text: string;
  readonly count: number;
  /** 一開頭就是換掉的詞，前面一段結尾的空白就算詞與詞之間。 */
  readonly lead: boolean;
}

const PUNCTUATION_SPACE = /[ \t]*([,;:.!?()[\]])[ \t]*/gu;
const DIGIT = /\d/u;
const TRAILING_SPACE = /[ \t]+$/u;
/** 全形空白。排版只拿掉半形空白與 tab（ADR-0102 第 15 項），這個會留下來。 */
const IDEOGRAPHIC_SPACE = '　';

/**
 * 詞與詞之間的文字（ADR-0121）：標點前後的空白拿掉，排版會把標點換成全形；兩個詞之間只隔著空白的，
 * 換成一個全形空白，「韌性12　機智9」才不會黏成「韌性12機智9」。標籤與數字之間照排版的規則。
 */
function tidyGap(gap: string, between: boolean): string {
  const tidied = gap.replace(PUNCTUATION_SPACE, (whole: string, mark: string, at: number) => {
    // 「2, 4」的逗號兩邊都是數字，拿掉空白會變成像一個數字的「2,4」。
    const digits = DIGIT.test(gap[at - 1] ?? '') && DIGIT.test(gap[at + whole.length] ?? '');
    return digits && (mark === ',' || mark === '.') ? whole : mark;
  });
  return between ? tidied.replace(TRAILING_SPACE, IDEOGRAPHIC_SPACE) : tidied;
}

/**
 * 一段文字換成譯名。詞以外還有字母就不是對得上的數值塊，回傳 null。`before` 是這段之前（例如前面的 `<pc>`）
 * 已經換掉的詞數，這段開頭的空白才知道是不是在兩個詞之間。
 */
function swapText(text: string, words: readonly FieldWord[], role: string, before: number): Swapped | null {
  const found = placements(text, words, role);
  let out = '';
  let cursor = 0;
  let count = 0;
  for (const { start, end, target } of found) {
    const gap = text.slice(cursor, start);
    if (LETTER.test(gap)) return null;
    out += escapeText(tidyGap(gap, before + count > 0)) + escapeText(target);
    cursor = end;
    count += 1;
  }
  const tail = text.slice(cursor);
  if (LETTER.test(tail)) return null;
  return { text: out + escapeText(tidyGap(tail, false)), count, lead: found[0]?.start === 0 };
}

/** 把遮蔽後的片段組回回覆的格式：佔位符只留編號，`<pc>` 照樣包住。 */
function rebuild(segments: readonly Segment[], words: readonly FieldWord[], role: string, before = 0): Swapped | null {
  let text = '';
  let count = 0;
  let lead = false;
  for (const [index, item] of segments.entries()) {
    if (item.type === 'ph') {
      text += `<ph id="${item.id}"/>`;
      continue;
    }
    const done = before + count;
    const part = item.type === 'text' ? swapText(item.text, words, role, done) : item.type === 'pc' ? rebuild(item.children, words, role, done) : null;
    if (part === null) return null;
    // 下一個詞在 `<pc>` 裡：前面一段結尾的空白也是詞與詞之間（ADR-0121）。
    if (item.type === 'pc' && part.lead && done > 0) text = text.replace(TRAILING_SPACE, IDEOGRAPHIC_SPACE);
    text += item.type === 'pc' ? `${pairedTag(Number(item.id))}${part.text}${PAIRED_END}` : part.text;
    if (index === 0) lead = part.lead;
    count += part.count;
  }
  return { text, count, lead };
}

/**
 * 整個單位對得上時，回傳換好譯名的 `<s>` 片段，跟模型的回覆同一種格式；沒對上、或一個詞都沒換到時是 null
 * （沒有字母的單位本來就不送，ADR-0100）。
 */
export function fieldFragment(masked: string, role: string, words: readonly FieldWord[]): string | null {
  const segments = parseUnits(unitTag('1', role, masked)).units[0]?.segments ?? [];
  const built = rebuild(segments, words, role);
  return built === null || built.count === 0 ? null : `<s id="1">${built.text}</s>`;
}

/** 本機欄位化的譯文與 `<pc>` 的位置。 */
export interface Fielded {
  readonly translation: string;
  readonly paired: readonly PairedOffset[];
}

export interface FieldOptions {
  readonly pack: ResolvedPack;
  readonly sourceLang: string;
  /** 這本書的詞條，`bookTerms` 的結果。 */
  readonly terms: readonly LocalizedTerm[];
  /** 鎖定實體卡自己的詞條。 */
  readonly names: readonly LocalizedTerm[];
  readonly language: TargetLanguage;
}

/**
 * 每個能欄位化的單位的譯文，依 `unit_id`（ADR-0121）。片段走跟模型回覆同一條驗證、排版與還原，
 * 沒過就照常送 LLM；只報告的用語檢查用不到，不載入片語表。
 */
export function fieldUnits(units: readonly TranslationUnit[], options: FieldOptions): Map<string, Fielded> {
  const { pack, sourceLang, terms, names, language } = options;
  const context: VerifyContext = { language, terms, phraseCheck: () => [] };
  const fielded = new Map<string, Fielded>();
  for (const unit of units) {
    if (!unit.needs_llm) continue;
    const labels = fieldLabels(pack, unit.role, sourceLang);
    if (labels.length === 0) continue;
    const fragment = fieldFragment(unit.masked, unit.role, fieldWords(labels, terms, names));
    if (fragment === null) continue;
    const { translation, paired } = verifyFragment(unit, fragment, context);
    if (translation !== null) fielded.set(unit.unit_id, { translation, paired });
  }
  return fielded;
}
