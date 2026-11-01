import { unescapeText } from '../tags.ts';

// 個資閘門（DC-1、ADR-0099 第 21、25 項）。比對字串，不編成正規表示式：清單是使用者寫的，
// 寫什麼就比什麼。

export interface PiiRules {
  /** 工作區的個資清單。 */
  readonly pii: readonly string[];
  /** 這本書的誤判例外，例如跟購買者同名的角色。 */
  readonly exceptions: readonly string[];
}

/** 命中清單的第幾項與次數。不放命中的文字：回報與紀錄都不能出現個資。 */
export interface PiiHit {
  readonly entry: number;
  readonly count: number;
}

/** 例外不用空字串蓋掉，否則前後的字會接起來，變成原文沒有的詞。 */
const BLANK = '\u0000';

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

export function scanText(text: string, rules: PiiRules): PiiHit[] {
  const exceptions = rules.exceptions
    .map(normalize)
    .filter((exception) => exception !== '')
    .sort((a, b) => b.length - a.length);
  const rest = exceptions.reduce((value, exception) => value.replaceAll(exception, BLANK), normalize(text));
  return rules.pii.flatMap((item, entry) => {
    const wanted = normalize(item);
    const count = wanted === '' ? 0 : rest.split(wanted).length - 1;
    return count === 0 ? [] : [{ entry, count }];
  });
}

export function hitCount(hits: readonly PiiHit[]): number {
  return hits.reduce((total, { count }) => total + count, 0);
}

function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (typeof value === 'object' && value !== null) return Object.entries(value).flat().flatMap(stringsOf);
  return [];
}

function readableText(body: string): string {
  try {
    return stringsOf(JSON.parse(body)).join('\n');
  } catch {
    return body;
  }
}

/** 掃描序列化後的完整請求。先解開 JSON 與標籤的跳脫，否則換行與 `&amp;` 會讓比對落空。 */
export function scanBody(body: string, rules: PiiRules): PiiHit[] {
  return scanText(unescapeText(readableText(body)), rules);
}
