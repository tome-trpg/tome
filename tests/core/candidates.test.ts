import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_MAX_WORDS,
  CONTEXT_CHARS,
  capitalizedPhrases,
  cleanCandidate,
  mineCandidates,
} from '../../src/core/candidates.ts';
import type { DocumentBlock, IrDocument } from '../../src/core/ir.ts';
import { loadSourceLanguage, type Pass0Rules } from '../../src/core/language.ts';

// 文字都是這裡編的（ADR-0118）。

const { profile: en } = loadSourceLanguage('en');
const RULES = en.pass0 as Pass0Rules;

function block(id: string, text: string, extra: Partial<DocumentBlock> = {}): DocumentBlock {
  return {
    id,
    content_hash: 'a'.repeat(64),
    role: 'paragraph',
    flow: 'main',
    spans: [{ page: 0, bbox: [0, 0, 1, 1] }],
    text,
    raw: text,
    lang: 'en',
    writing_mode: 'horizontal-tb',
    provenance: { engine: 'fake', version: '1', config_hash: 'b'.repeat(64) },
    ...extra,
  };
}

function documentOf(blocks: readonly DocumentBlock[]): IrDocument {
  return { schema: 'tome-ir/1', layer: 'document', pdf_sha256: 'c'.repeat(64), pages: [], page_map: [], sections: [], blocks };
}

function sources(blocks: readonly DocumentBlock[], known: readonly string[] = []): string[] {
  return mineCandidates(documentOf(blocks), en, new Set(known)).map(({ source }) => source);
}

describe('capitalizedPhrases', () => {
  it('joins capitalized words, with a connector between them', () => {
    expect(capitalizedPhrases('We rode to the Salt Marsh of Old Harrow today.', RULES)).toEqual(['Salt Marsh of Old Harrow']);
  });

  it('drops a leading stopword and a lone word at the start of a sentence', () => {
    expect(capitalizedPhrases('The Salt Marsh waits. Rain falls on Harrow.', RULES)).toEqual(['Salt Marsh', 'Harrow']);
    expect(capitalizedPhrases('Rain falls. “Rain” again.', RULES)).toEqual([]);
  });

  it('keeps a lone capitalized word in the middle of a sentence', () => {
    expect(capitalizedPhrases('the warden of Harrow sleeps', RULES)).toEqual(['Harrow']);
  });

  it('does not join across punctuation or two names, or keep a connector at the end', () => {
    expect(capitalizedPhrases('we met Ada, Bram and Cole of the', RULES)).toEqual(['Ada', 'Bram', 'Cole']);
  });
});

describe('cleanCandidate', () => {
  it('trims punctuation and spaces, and refuses what cannot be a name', () => {
    expect(cleanCandidate('  “Salt   Marsh,” ')).toBe('Salt Marsh');
    expect(cleanCandidate('— 12 —')).toBeNull();
    expect(cleanCandidate('A')).toBeNull();
    expect(cleanCandidate(Array.from({ length: CANDIDATE_MAX_WORDS + 1 }, () => 'Word').join(' '))).toBeNull();
  });
});

describe('mineCandidates', () => {
  it('takes headings, bold words, index entries and phrases seen twice, in reading order', () => {
    const blocks = [
      block('b1', 'Tide Lore', { role: 'heading' }),
      block('b2', 'Cast Fire Bolt at the Grey Warden, then the Grey Warden falls. Once Lucky Ann waved.', {
        runs: [{ start: 5, end: 14, marks: ['bold'] }],
      }),
      block('b3', 'Armor, light 12, 14\nFerry Toll 30', { role: 'index' }),
    ];
    const mined = mineCandidates(documentOf(blocks), en, new Set());
    expect(mined.map(({ source, sources: from }) => [source, from])).toEqual([
      ['Tide Lore', ['heading', 'caps']],
      ['Fire Bolt', ['bold']],
      ['Grey Warden', ['caps']],
      ['Armor, light', ['index']],
      ['Ferry Toll', ['index']],
    ]);
  });

  it('counts whole, case-sensitive occurrences and notes the first block', () => {
    const blocks = [block('b1', 'The Grey Warden waits.'), block('b2', 'grey warden, Grey Wardens and the Grey Warden.')];
    const [warden] = mineCandidates(documentOf(blocks), en, new Set());
    expect(warden).toMatchObject({ source: 'Grey Warden', occurrences: 2, firstBlock: 'b1' });
  });

  it('leaves out what the pack already translates, and what no one will translate', () => {
    const blocks = [
      block('b1', 'Spot Hidden and Spot Hidden again, then Grey Warden and Grey Warden.'),
      block('b2', 'Licensed to Forged Reader and Forged Reader', { role: 'furniture' }),
    ];
    expect(sources(blocks, ['Spot Hidden'])).toEqual(['Grey Warden']);
  });

  it('takes the first sentence and the first one with a pronoun, each one short', () => {
    const long = `${'rain on the reeds and more rain on the reeds, '.repeat(6)}until the Grey Warden came.`;
    const blocks = [
      block('b1', 'The Grey Warden waits. The ferry leaves.'),
      block('b2', `${long} The Grey Warden counts stones. Then she sleeps.`),
    ];
    const [warden] = mineCandidates(documentOf(blocks), en, new Set());
    expect(warden?.contexts).toEqual(['The Grey Warden waits.', 'Then she sleeps.']);
    const [late] = mineCandidates(documentOf([block('b1', `${long} The Grey Warden nods.`), block('b2', 'Grey Warden.')]), en, new Set());
    expect(late?.contexts[0]?.length).toBeLessThanOrEqual(CONTEXT_CHARS);
    expect(late?.contexts[0]).toContain('Grey Warden');
  });

  it('keeps an index entry the text never uses, with no context', () => {
    const [entry] = mineCandidates(documentOf([block('b1', 'Armor, light 12', { role: 'index' })]), en, new Set());
    expect(entry).toEqual({ source: 'Armor, light', sources: ['index'], occurrences: 0, firstBlock: null, contexts: [] });
  });

  it('finds no capitalized phrases in a language without pass0 rules', () => {
    const { pass0: _unused, ...bare } = en;
    const blocks = [block('b1', 'Grey Warden and Grey Warden.'), block('b2', 'Tide Lore', { role: 'heading' })];
    expect(mineCandidates(documentOf(blocks), bare, new Set()).map(({ source }) => source)).toEqual(['Tide Lore']);
  });

  it('reads a long book in a reasonable time', () => {
    const text = 'The Grey Warden of Old Harrow met Lucky Ann at the Salt Marsh. She smiled. ';
    const blocks = Array.from({ length: 2000 }, (_, index) => block(`b${index}`, text));
    const started = performance.now();
    mineCandidates(documentOf(blocks), en, new Set());
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
