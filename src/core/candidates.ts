import { pageListStart } from './assemble.ts';
import type { DocumentBlock, IrDocument } from './ir.ts';
import type { Pass0Rules, SourceLanguage } from './language.ts';
import { findTerm } from './mask.ts';
import { UNTRANSLATED } from './units.ts';

// Pass 0 的第一步：在本機挖候選詞（白皮書 §5.6、ADR-0118）。不連網。候選詞與上下文都是書本文字，
// 只送給 `scanner_model`，MUST NOT 進訊息或紀錄（ADR-0059）。語言規則都在來源語言設定檔的 `pass0`。

export type CandidateSource = 'index' | 'heading' | 'bold' | 'caps';

/** 超過這麼多個詞的不算名字。是提案（ADR-0118）。 */
export const CANDIDATE_MAX_WORDS = 6;
/** 只靠大寫挖到的要出現這麼多次以上：只出現一次的多半是句首或標題的普通詞。 */
export const CAPS_MIN_OCCURRENCES = 2;
/** 每個候選詞最多帶幾句上下文、每句最多幾個字元（ADR-0118 第 5 項）。 */
export const CONTEXT_SENTENCES = 2;
export const CONTEXT_CHARS = 200;
/** 上下文太長時，從詞前面這麼多個字元開始取。 */
const CONTEXT_LEAD = 80;

const LETTER = /\p{L}/u;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const CAPITAL = /^\p{Lu}/u;
const OPENERS = new Set(['"', '“', '‘', "'", '(', '[']);

export interface Candidate {
  readonly source: string;
  readonly sources: readonly CandidateSource[];
  /** 會翻譯的文字裡出現幾次，全字、區分大小寫。 */
  readonly occurrences: number;
  /** 第一次出現的區塊，沒出現過是 null。 */
  readonly firstBlock: string | null;
  /** 第一次出現的句子，加上第一個帶代名詞的句子。 */
  readonly contexts: readonly string[];
}

interface Passage {
  readonly blockId: string;
  readonly text: string;
}

interface Sentence {
  readonly passage: number;
  readonly start: number;
  readonly end: number;
}

function wordCount(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

/** 頭尾的標點拿掉、空白縮成一個。太短、太長或沒有字母的不算。 */
export function cleanCandidate(text: string): string | null {
  const clean = text.replace(/\s+/gu, ' ').replace(EDGE, '');
  if (clean.length < 2 || !LETTER.test(clean)) return null;
  return wordCount(clean) > CANDIDATE_MAX_WORDS ? null : clean;
}

/** 會翻譯的文字，依閱讀順序。表格每一格一段。 */
function passagesOf(blocks: readonly DocumentBlock[]): Passage[] {
  return blocks
    .filter(({ role }) => !UNTRANSLATED.has(role))
    .flatMap(({ id, text, table }) =>
      (table === undefined ? [text] : table.cells.map((cell) => cell.text))
        .filter((value) => value.trim() !== '')
        .map((value) => ({ blockId: id, text: value })),
    );
}

/** 索引每行頁碼清單前面的詞（沿用 026 判斷索引的掃法）。 */
function indexTerms(block: DocumentBlock): string[] {
  const lines = block.table === undefined ? block.raw.split(/\r?\n/u) : block.table.cells.map(({ text }) => text);
  return lines.flatMap((line) => {
    const start = pageListStart(line.trim());
    return start > 0 ? [line.trim().slice(0, start)] : [];
  });
}

function isSentenceStart(text: string, at: number, rules: Pass0Rules): boolean {
  let end = at;
  while (end > 0 && (/\s/u.test(text[end - 1] ?? '') || OPENERS.has(text[end - 1] ?? ''))) end -= 1;
  if (end === 0) return true;
  const before = text.slice(0, end);
  return rules.sentence_end.some((mark) => before.endsWith(mark));
}

function onlySpaces(text: string, from: number, to: number): boolean {
  return /^[ \t]+$/u.test(text.slice(from, to));
}

/**
 * 大寫片語：連續的大寫開頭詞，中間可以夾 `connectors`，只隔空白。開頭的 `stopwords` 拿掉；
 * 句首只有一個詞的不算（ADR-0118）。用固定的正規表示式切詞再逐一判斷，語言設定檔的詞不編成正規表示式。
 */
export function capitalizedPhrases(text: string, rules: Pass0Rules): string[] {
  const tokens = [...text.matchAll(WORD)].map((match) => ({
    word: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const connectors = new Set(rules.connectors);
  const stopwords = new Set(rules.stopwords);
  const capital = (index: number): boolean => CAPITAL.test(tokens[index]?.word ?? '');
  const adjacent = (left: number, right: number): boolean =>
    onlySpaces(text, tokens[left]?.end ?? 0, tokens[right]?.start ?? 0);
  const phrases: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    if (!capital(index)) {
      index += 1;
      continue;
    }
    let end = index;
    for (;;) {
      const next = end + 1;
      if (next < tokens.length && adjacent(end, next) && capital(next)) {
        end = next;
      } else if (
        next + 1 < tokens.length &&
        connectors.has(tokens[next]?.word ?? '') &&
        adjacent(end, next) &&
        adjacent(next, next + 1) &&
        capital(next + 1)
      ) {
        end = next + 1;
      } else {
        break;
      }
    }
    let first = index;
    while (first <= end && stopwords.has(tokens[first]?.word ?? '')) first += 1;
    const lone = first === end && first === index && isSentenceStart(text, tokens[index]?.start ?? 0, rules);
    if (first <= end && !lone) phrases.push(text.slice(tokens[first]?.start ?? 0, tokens[end]?.end ?? 0));
    index = end + 1;
  }
  return phrases;
}

/** 依 `sentence_end` 切句，記號後面要接空白。 */
function sentencesOf(passage: Passage, index: number, rules: Pass0Rules): Sentence[] {
  const { text } = passage;
  const sentences: Sentence[] = [];
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    const mark = rules.sentence_end.find((value) => text.startsWith(value, at));
    if (mark === undefined) continue;
    const end = at + mark.length;
    if (end < text.length && !/\s/u.test(text[end] ?? '')) continue;
    sentences.push({ passage: index, start, end });
    start = end;
    at = end - 1;
  }
  if (start < text.length) sentences.push({ passage: index, start, end: text.length });
  return sentences.filter(({ start: from, end }) => text.slice(from, end).trim() !== '');
}

/** 一句太長時，從詞前面一點開始取，切在詞的邊界。 */
function clip(text: string, focus: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= CONTEXT_CHARS) return trimmed;
  let start = Math.max(0, Math.min(focus - CONTEXT_LEAD, text.length - CONTEXT_CHARS));
  while (start > 0 && start < focus && !/\s/u.test(text[start - 1] ?? '')) start += 1;
  let end = Math.min(text.length, start + CONTEXT_CHARS);
  while (end < text.length && end > start && !/\s/u.test(text[end] ?? '')) end -= 1;
  return text.slice(start, end).trim();
}

function hasPronoun(text: string, pronouns: ReadonlySet<string>): boolean {
  return (text.match(WORD) ?? []).some((word) => pronouns.has(word.toLowerCase()));
}

interface Hit {
  readonly passage: number;
  readonly start: number;
}

class Corpus {
  readonly #passages: readonly Passage[];
  readonly #rules: Pass0Rules | undefined;
  readonly #sentences = new Map<number, readonly Sentence[]>();
  readonly #pronouns: ReadonlySet<string>;

  constructor(passages: readonly Passage[], rules: Pass0Rules | undefined) {
    this.#passages = passages;
    this.#rules = rules;
    this.#pronouns = new Set((rules?.pronouns ?? []).map((word) => word.toLowerCase()));
  }

  hits(term: string): Hit[] {
    return this.#passages.flatMap(({ text }, passage) => findTerm(text, term).map(([start]) => ({ passage, start })));
  }

  blockOf(hit: Hit): string {
    return this.#passages[hit.passage]?.blockId ?? '';
  }

  #sentencesIn(passage: number): readonly Sentence[] {
    const cached = this.#sentences.get(passage);
    if (cached !== undefined) return cached;
    const found = this.#rules === undefined ? [] : sentencesOf(this.#passages[passage] ?? { blockId: '', text: '' }, passage, this.#rules);
    const sentences = found.length > 0 ? found : [{ passage, start: 0, end: this.#passages[passage]?.text.length ?? 0 }];
    this.#sentences.set(passage, sentences);
    return sentences;
  }

  #textOf({ passage, start, end }: Sentence): string {
    return (this.#passages[passage]?.text ?? '').slice(start, end);
  }

  /** 第一次出現的句子，加上第一個在出現的那句或下一句、帶代名詞的句子（ADR-0118 第 5 項）。 */
  contexts(hits: readonly Hit[]): string[] {
    const [first] = hits;
    if (first === undefined) return [];
    const sentenceAt = (hit: Hit): { sentence: Sentence; index: number } => {
      const list = this.#sentencesIn(hit.passage);
      const index = Math.max(0, list.findIndex(({ start, end }) => hit.start >= start && hit.start < end));
      return { sentence: list[index] ?? { passage: hit.passage, start: 0, end: 0 }, index };
    };
    const opening = sentenceAt(first).sentence;
    const chosen = [clip(this.#textOf(opening), first.start - opening.start)];
    const same = (a: Sentence, b: Sentence): boolean => a.passage === b.passage && a.start === b.start;
    for (const hit of hits) {
      if (chosen.length >= CONTEXT_SENTENCES) break;
      const { sentence, index } = sentenceAt(hit);
      const following = this.#sentencesIn(hit.passage)[index + 1];
      const options: [Sentence, number][] = [[sentence, hit.start - sentence.start]];
      if (following !== undefined) options.push([following, 0]);
      const found = options.find(([candidate]) => !same(candidate, opening) && hasPronoun(this.#textOf(candidate), this.#pronouns));
      if (found !== undefined) chosen.push(clip(this.#textOf(found[0]), found[1]));
    }
    return chosen.filter((text) => text !== '');
  }
}

/**
 * 從索引、標題、粗體與大寫片語挖候選詞（白皮書 §5.6 第 1 步、ADR-0118）。`known` 是規則包已有譯名的詞，
 * 翻譯本來就用它，不當候選詞。依第一次出現的順序排，沒出現過的排最後。
 */
export function mineCandidates(document: IrDocument, language: SourceLanguage, known: ReadonlySet<string>): Candidate[] {
  const rules = language.pass0;
  const passages = passagesOf(document.blocks);
  const found = new Map<string, Set<CandidateSource>>();
  const add = (text: string, source: CandidateSource): void => {
    const clean = cleanCandidate(text);
    if (clean === null || known.has(clean) || (rules?.stopwords.includes(clean) ?? false)) return;
    found.set(clean, (found.get(clean) ?? new Set()).add(source));
  };
  for (const block of document.blocks) {
    if (block.role === 'index') for (const term of indexTerms(block)) add(term, 'index');
    if (UNTRANSLATED.has(block.role)) continue;
    if (block.role === 'heading' || block.role === 'title') add(block.text, 'heading');
    for (const run of block.runs ?? []) {
      if (run.marks?.includes('bold') === true) add(block.text.slice(run.start, run.end), 'bold');
    }
  }
  if (rules !== undefined) {
    for (const { text } of passages) for (const phrase of capitalizedPhrases(text, rules)) add(phrase, 'caps');
  }
  const corpus = new Corpus(passages, rules);
  const order = ['index', 'heading', 'bold', 'caps'] as const;
  const mined = [...found].flatMap(([source, kinds]) => {
    const hits = corpus.hits(source);
    const onlyCaps = kinds.size === 1 && kinds.has('caps');
    if (onlyCaps && hits.length < CAPS_MIN_OCCURRENCES) return [];
    const [first] = hits;
    return [
      {
        candidate: {
          source,
          sources: order.filter((kind) => kinds.has(kind)),
          occurrences: hits.length,
          firstBlock: first === undefined ? null : corpus.blockOf(first),
          contexts: corpus.contexts(hits),
        },
        position: first === undefined ? [Number.POSITIVE_INFINITY, 0] : [first.passage, first.start],
      },
    ];
  });
  return mined
    .sort(
      (left, right) =>
        (left.position[0] ?? 0) - (right.position[0] ?? 0) ||
        (left.position[1] ?? 0) - (right.position[1] ?? 0) ||
        left.candidate.source.localeCompare(right.candidate.source),
    )
    .map(({ candidate }) => candidate);
}
