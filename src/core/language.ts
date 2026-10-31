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
  readonly style_guide: readonly string[];
  readonly term_checks: readonly { readonly avoid: string; readonly prefer: string }[];
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
  if (text === null) throw new TomeError('language.unknown', { lang: tag });
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
