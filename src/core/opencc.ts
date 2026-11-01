import type { DictGroup, DictLike } from 'opencc-js';
import type { TargetLanguage } from './language.ts';

// 只有這個檔案碰 opencc-js（ADR-0102）。字典約 6 MB，用到時才載入，`tome --help` 不用多等。
// 這裡只回報疑似用語，不影響要不要重送：片語表有誤報，重送要花錢（ADR-0060）。

export interface SuspectTerm {
  readonly term: string;
  readonly prefer: string;
}

export type PhraseCheck = (text: string) => SuspectTerm[];

const NO_PHRASES: PhraseCheck = () => [];

/** `to` 比 `from` 多出來的片語表。 */
export async function loadPhraseCheck(language: TargetLanguage): Promise<PhraseCheck> {
  const setting = language.opencc;
  if (setting === undefined) return NO_PHRASES;
  const { Locale, Trie } = await import('opencc-js');
  const base: readonly DictGroup[] = Locale.to[setting.from] ?? [];
  const added: readonly DictGroup[] = Locale.to[setting.to] ?? [];
  const known = new Set<DictLike>(base.flat());
  const trie = new Trie();
  for (const group of added) {
    if (!group.some((dictionary: DictLike) => known.has(dictionary))) trie.loadDictGroup(group);
  }
  return (text) => {
    const found: SuspectTerm[] = [];
    let offset = 0;
    while (offset < text.length) {
      const match = trie.matchPrefix(text, offset);
      if (match === null) {
        offset += 1;
        continue;
      }
      const term = text.slice(offset, match.end);
      if (match.value !== term) found.push({ term, prefer: match.value });
      offset = match.end;
    }
    return found;
  };
}
