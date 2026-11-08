import { createHash } from 'node:crypto';
import type { PairedOffset } from './mask.ts';
import type { LocalizedTerm } from './pack.ts';
import type { Store } from './store.ts';
import { escapeText } from './tags.ts';
import {
  hitTerms,
  verifyFragment,
  visibleText,
  type Problem,
  type VerifiableUnit,
  type VerifyContext,
} from './verify.ts';

// 翻譯記憶（白皮書 §5.6、ADR-0026、ADR-0102）。存在 series.db，每本書預設自成一個系列。
// 模型不在鍵裡，換模型不會重翻，存成中繼資料（ADR-0067）。

/** 這麼短的段落要看前一段才選得對它、牠、祂，例如 `It moves.`。 */
const SHORT_PARAGRAPH = 40;

export interface KeyContext {
  /** 這本書適用的詞條，鍵只算這個單位命中的。 */
  readonly terms: readonly LocalizedTerm[];
  readonly targetLang: string;
  /** 這個角色的風格文字。 */
  readonly style: string | undefined;
}

export interface MemoryEntry {
  /** 遮蔽後的 `<s>...</s>` 片段，不同的骰子值也能重用。 */
  readonly fragment: string;
  readonly model: string;
  readonly prompt_hash: string;
  readonly pack_hash: string;
  readonly sdk_version: string;
  readonly book: string;
}

export interface Recalled {
  readonly entry: MemoryEntry;
  readonly translation: string;
  /** `<pc>` 在譯文裡的位置。樣式用目前單位的 `formats`，記憶裡只有編號（ADR-0116）。 */
  readonly paired: readonly PairedOffset[];
  /** 只報告的問題，交付報告要看得到。 */
  readonly problems: readonly Problem[];
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 風格版本用角色風格文字的雜湊，改一個角色的文風，其他段落不用重翻（ADR-0050）。 */
export function styleVersion(style: string | undefined): string {
  return sha256(style ?? '');
}

/**
 * 命中詞條的摘要。實體卡的性別、代名詞、語域改了，同樣的原文要翻成不同的譯文，所以進鍵（ADR-0120）；
 * 只在有屬性時才加，只有規則包詞條的單位，鍵跟以前逐字相同，已存的翻譯記憶照樣命中。
 */
function termDigest(unit: Pick<VerifiableUnit, 'source' | 'role'>, terms: readonly LocalizedTerm[]): string {
  const hits = hitTerms(unit, terms).map(({ text, term, attributes }) =>
    attributes === undefined
      ? [text, term.target]
      : [text, term.target, attributes.gender ?? null, attributes.pronoun ?? null, attributes.register ?? null],
  );
  return sha256(JSON.stringify(hits.sort()));
}

/** `previous` 是閱讀順序上前一個單位的遮蔽後文字，第一個單位是 null。 */
export function memoryKey(
  unit: Pick<VerifiableUnit, 'source' | 'role' | 'masked'>,
  previous: string | null,
  { terms, targetLang, style }: KeyContext,
): string {
  const short = visibleText(unit.masked).length <= SHORT_PARAGRAPH;
  const before = short ? sha256(previous ?? '') : '';
  return sha256(JSON.stringify([unit.masked, termDigest(unit, terms), targetLang, styleVersion(style), before]));
}

/**
 * 只有驗證通過的譯文才進，這裡自己驗，不靠呼叫端（ADR-0102）。回傳有沒有收下。
 * 相同內容不會變，所以已有的不覆蓋。
 */
export function remember(
  store: Store,
  key: string,
  entry: MemoryEntry,
  unit: VerifiableUnit,
  context: VerifyContext,
): boolean {
  if (!verifyFragment(unit, entry.fragment, context).passed) return false;
  store.run(
    `INSERT OR IGNORE INTO memory (key, fragment, model, prompt_hash, pack_hash, sdk_version, book, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    key,
    entry.fragment,
    entry.model,
    entry.prompt_hash,
    entry.pack_hash,
    entry.sdk_version,
    entry.book,
    new Date().toISOString(),
  );
  return true;
}

export interface Replaced {
  readonly fragment: string;
  /** 換了幾處。 */
  readonly count: number;
}

/** `at` 在標籤裡面。書本文字已經跳脫，`<`、`>` 只會是標籤的邊界。 */
function insideTag(fragment: string, at: number): boolean {
  return fragment.lastIndexOf('<', at) > fragment.lastIndexOf('>', at);
}

function rangesOf(fragment: string, needle: string): (readonly [number, number])[] {
  const ranges: (readonly [number, number])[] = [];
  for (let at = fragment.indexOf(needle); at >= 0; at = fragment.indexOf(needle, at + 1)) {
    ranges.push([at, at + needle.length]);
  }
  return ranges;
}

/**
 * S-16：把回應片段裡的舊譯名換成新譯名（白皮書 §5.6、ADR-0026 第 7 項、ADR-0120）。片段是跳脫過的
 * `<s>...</s>`，譯名也先跳脫再找；標籤裡的不換。`longer` 是其他較長的譯名，舊譯名落在它們裡面的那一處
 * 不換，「鹽沼」才不會把「鹽沼守衛」改壞。只掃原本的片段，新譯名含舊譯名時也不會一直換下去。
 */
export function replaceTarget(fragment: string, before: string, after: string, longer: readonly string[]): Replaced {
  const needle = escapeText(before);
  if (needle === '') return { fragment, count: 0 };
  const shielded = longer
    .filter((target) => target !== before && target.includes(before))
    .flatMap((target) => rangesOf(fragment, escapeText(target)));
  let text = '';
  let cursor = 0;
  let count = 0;
  for (let at = fragment.indexOf(needle); at >= 0; at = fragment.indexOf(needle, at + needle.length)) {
    const end = at + needle.length;
    if (insideTag(fragment, at) || shielded.some(([start, stop]) => start <= at && end <= stop)) continue;
    text += fragment.slice(cursor, at) + escapeText(after);
    cursor = end;
    count += 1;
  }
  return { fragment: text + fragment.slice(cursor), count };
}

/** 命中後重跑驗證，規則或譯名可能變了，不過就當沒命中（ADR-0102）。 */
export function recall(
  store: Store,
  key: string,
  unit: VerifiableUnit,
  context: VerifyContext,
): Recalled | null {
  const entry = store.get<MemoryEntry>(
    'SELECT fragment, model, prompt_hash, pack_hash, sdk_version, book FROM memory WHERE key = ?',
    key,
  );
  if (entry === undefined) return null;
  const { translation, paired, problems } = verifyFragment(unit, entry.fragment, context);
  return translation === null ? null : { entry, translation, paired, problems };
}
