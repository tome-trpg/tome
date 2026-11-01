import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { TomeError } from './errors.ts';
import { validateLanguage } from './schema.ts';

// 語言設定檔（白皮書 §5.4、ADR-0009）。核心只讀資料，MUST NOT 依語言代碼分支。

export const LANGUAGE_SCHEMA = 'tome-lang/1';

export interface TextQuality {
  readonly letter_frequency: Readonly<Record<string, number>>;
  readonly min_letters: number;
  readonly min_similarity: number;
}

export interface SourceLanguage {
  readonly schema: typeof LANGUAGE_SCHEMA;
  readonly kind: 'source';
  readonly lang: string;
  readonly name: string;
  readonly writing_mode: 'horizontal-tb' | 'vertical-rl';
  readonly normalize: {
    readonly form: 'NFC' | 'NFKC';
    readonly replace: Readonly<Record<string, string>>;
  };
  readonly dehyphenate: {
    readonly hyphens: readonly string[];
    readonly next_starts: 'lower' | 'any';
  };
  readonly join: {
    readonly sentence_end: readonly string[];
    readonly next_starts: 'lower' | 'any';
  };
  readonly text_quality: TextQuality;
}

export interface TargetLanguage {
  readonly schema: typeof LANGUAGE_SCHEMA;
  readonly kind: 'target';
  readonly lang: string;
  readonly name: string;
  readonly punctuation: {
    readonly replace: Readonly<Record<string, string>>;
    readonly quotes: {
      readonly open: string;
      readonly close: string;
      readonly inner_open: string;
      readonly inner_close: string;
    };
    readonly space_around_latin: boolean;
  };
  readonly pronouns: readonly string[];
  readonly min_length_ratio: number;
  readonly max_length_ratio: number;
  readonly style_guide: readonly string[];
  readonly script_check: ScriptCheck;
  readonly opencc?: { readonly from: string; readonly to: string };
  readonly term_checks: readonly { readonly avoid: string; readonly prefer: string }[];
  readonly term_exceptions: readonly string[];
}

/** 混入其他文字系統的判定資料（ADR-0102）。 */
export interface ScriptCheck {
  readonly encoding: string;
  readonly lead_ranges: readonly (readonly [number, number])[];
  readonly trail_ranges: readonly (readonly [number, number])[];
  readonly shared_forms: string;
  readonly allowed_words: readonly string[];
  readonly misused_words: readonly string[];
}

export type Language = SourceLanguage | TargetLanguage;

export interface LoadedLanguage<T extends Language> {
  readonly profile: T;
  /** 內容的雜湊，進內容指紋，規則一改就重算（ADR-0056）。 */
  readonly hash: string;
}

function read(kind: Language['kind'], lang: string): string | null {
  // src 與 dist 到 repo 根目錄的深度相同。
  const url = new URL(`../../languages/${kind}/${lang}.yaml`, import.meta.url);
  try {
    return readFileSync(url, 'utf8');
  } catch {
    return null;
  }
}

function load<T extends Language>(kind: T['kind'], tag: string): LoadedLanguage<T> {
  // en-GB 沒有自己的設定檔時用 en。語言標籤只拿來組檔名，不做判斷。
  const primary = tag.split('-')[0] ?? tag;
  const lang = read(kind, tag) === null ? primary : tag;
  const text = read(kind, lang);
  if (text === null) {
    throw new TomeError(kind === 'target' ? 'language.unknown_target' : 'language.unknown', { lang: tag });
  }
  const checked = validateLanguage(parse(text));
  if (!checked.ok || checked.value.kind !== kind || checked.value.lang !== lang) {
    throw new TomeError('config.bad_schema', {
      path: `languages/${kind}/${lang}.yaml`,
      expected: LANGUAGE_SCHEMA,
    });
  }
  return {
    profile: checked.value as T,
    hash: createHash('sha256').update(text).digest('hex'),
  };
}

export function loadSourceLanguage(tag: string): LoadedLanguage<SourceLanguage> {
  return load<SourceLanguage>('source', tag);
}

export function loadTargetLanguage(tag: string): LoadedLanguage<TargetLanguage> {
  return load<TargetLanguage>('target', tag);
}

const HAN = /\p{Script=Han}/gu;
const SINGLE_HAN = /^\p{Script=Han}$/u;

const encodingCache = new WeakMap<ScriptCheck, ReadonlySet<string>>();

function expand(ranges: ScriptCheck['lead_ranges']): number[] {
  return ranges.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, index) => from + index));
}

/** 編碼的標準字集裡的漢字。要解碼一萬多次，所以一份設定只算一次。 */
function encodingHan(check: ScriptCheck): ReadonlySet<string> {
  const cached = encodingCache.get(check);
  if (cached !== undefined) return cached;
  const decoder = new TextDecoder(check.encoding);
  const trails = expand(check.trail_ranges);
  const characters = new Set<string>();
  for (const lead of expand(check.lead_ranges)) {
    for (const trail of trails) {
      const character = decoder.decode(new Uint8Array([lead, trail]));
      if (SINGLE_HAN.test(character)) characters.add(character);
    }
  }
  encodingCache.set(check, characters);
  return characters;
}

/**
 * 混入其他文字系統的字與詞（ADR-0102）。算到就重送，所以這裡寧可漏，字表以外的不判定。
 * `tests/tools/traditional-chinese.test.ts` 用同一個函式檢查 repo 的文字。
 */
export function scriptViolations(check: ScriptCheck, text: string): string[] {
  const allowed = encodingHan(check);
  // 例外詞裡的字可能不在編碼裡，所以兩項判定都用拿掉例外詞之後的文字。
  let rest = text;
  for (const word of check.allowed_words) rest = rest.replaceAll(word, '');
  const outside = [...rest.matchAll(HAN)].map(([character]) => character).filter((character) => !allowed.has(character));
  const shared = [...rest].filter((character) => check.shared_forms.includes(character));
  const misused = check.misused_words.filter((word) => text.includes(word));
  return [...new Set([...outside, ...shared, ...misused])];
}

/** 語言設定檔的字元正規化。連字與軟連字號的差異在這裡消掉（ADR-0009）。 */
export function normalizeText(language: SourceLanguage, text: string): string {
  const { form, replace } = language.normalize;
  let result = text.normalize(form);
  for (const [from, to] of Object.entries(replace)) result = result.replaceAll(from, to);
  return result;
}
