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

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** 每個出現的位置，重疊的也算：漏掉一次就可能漏掉例外沒蓋住的那一次。 */
function occurrences(text: string, wanted: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(wanted); at >= 0; at = text.indexOf(wanted, at + 1)) found.push(at);
  return found;
}

/** 從每個位置算起，例外最遠蓋到哪裡。 */
function coverage(text: string, exceptions: readonly string[]): Int32Array {
  const reach = new Int32Array(text.length);
  for (const exception of exceptions) {
    for (const at of occurrences(text, exception)) reach[at] = Math.max(reach[at] ?? 0, at + exception.length);
  }
  for (let at = 1; at < reach.length; at += 1) reach[at] = Math.max(reach[at] ?? 0, reach[at - 1] ?? 0);
  return reach;
}

/**
 * 例外只免除它完整蓋住的命中，比例外長的項目照樣命中。購買者跟 NPC 同名時，
 * 使用者會把名字加進例外，浮水印上的全名不能跟著過關（ADR-0104 第 6 項）。
 */
export function scanText(text: string, rules: PiiRules): PiiHit[] {
  const normalized = normalize(text);
  const exceptions = rules.exceptions.map(normalize).filter((exception) => exception !== '');
  const reach = coverage(normalized, exceptions);
  return rules.pii.flatMap((item, entry) => {
    const wanted = normalize(item);
    if (wanted === '') return [];
    const hits = occurrences(normalized, wanted).filter((at) => (reach[at] ?? 0) < at + wanted.length);
    return hits.length === 0 ? [] : [{ entry, count: hits.length }];
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
