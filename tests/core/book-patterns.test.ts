import { describe, expect, it } from 'vitest';
import type { BookPattern } from '../../src/core/book.ts';
import { checkBookPatterns, withBookPatterns } from '../../src/core/book-patterns.ts';
import type { PatternDefinition, ResolvedPack } from '../../src/core/pack.ts';
import { maskSources } from '../../src/core/units.ts';

// 模式與文字都是這裡編的（ADR-0124）。

function mask(id: string, regex: string, extra: Partial<BookPattern> = {}): BookPattern {
  return { id, use: 'mask', regex, ...extra };
}

function packWith(patterns: readonly PatternDefinition[]): ResolvedPack {
  return { id: 'child', chain: [], roles: [], patterns, classes: new Set(), terms: [] };
}

async function masked(pack: ResolvedPack, source: string): Promise<string> {
  const { units, findings } = await maskSources([{ unit_id: 'u1', block_id: 'b1', role: 'paragraph', source }], pack, []);
  expect(findings).toEqual([]);
  return units[0]?.masked ?? '';
}

describe('checkBookPatterns (ADR-0124)', () => {
  it('passes patterns that compile, with no finding', () => {
    expect(checkBookPatterns([mask('tide-code', 'TC-\\d{3}'), mask('rune', 'R\\d', { flags: 'i' })])).toEqual([]);
  });

  it('passes no patterns at all', () => {
    expect(checkBookPatterns([])).toEqual([]);
  });

  it('refuses a pattern that does not compile, by id alone', () => {
    const findings = checkBookPatterns([mask('broken', '(unclosed')]);
    expect(findings).toEqual([
      { code: 'book.bad_pattern', level: 'fail', params: { pattern: 'broken', reason: 'invalid_regex' } },
    ]);
    expect(JSON.stringify(findings)).not.toContain('unclosed');
  });

  it('compiles with the flags it runs with, so a repeated flag is refused', () => {
    expect(checkBookPatterns([mask('twice', 'a', { flags: 'ii' })])).toEqual([
      { code: 'book.bad_pattern', level: 'fail', params: { pattern: 'twice', reason: 'invalid_regex' } },
    ]);
  });

  it('compiles with u on, so an escape only u refuses is refused', () => {
    expect(new RegExp('\\q').test('q')).toBe(true);
    expect(checkBookPatterns([mask('dot', '\\.')])).toEqual([]);
    expect(checkBookPatterns([mask('strict', '\\q')])).toEqual([
      { code: 'book.bad_pattern', level: 'fail', params: { pattern: 'strict', reason: 'invalid_regex' } },
    ]);
  });

  it('refuses each repeat of an id, and still checks the repeat', () => {
    const findings = checkBookPatterns([mask('code', 'A'), mask('code', 'B'), mask('code', '(')]);
    expect(findings).toEqual([
      { code: 'book.bad_pattern', level: 'fail', params: { pattern: 'code', reason: 'duplicate_id' } },
      { code: 'book.bad_pattern', level: 'fail', params: { pattern: 'code', reason: 'duplicate_id' } },
      { code: 'book.bad_pattern', level: 'fail', params: { pattern: 'code', reason: 'invalid_regex' } },
    ]);
  });

  it('does not also warn about a pattern that does not compile', () => {
    expect(checkBookPatterns([mask('nested', '(a+)+(')])).toEqual([
      { code: 'book.bad_pattern', level: 'fail', params: { pattern: 'nested', reason: 'invalid_regex' } },
    ]);
  });

  it('warns about a risky pattern that compiles, and goes on to the next', () => {
    const findings = checkBookPatterns([mask('nested', '(a+)+'), mask('broken', '['), mask('fine', 'b')]);
    expect(findings).toEqual([
      { code: 'pack.risky_regex', level: 'warn', params: { pattern: 'nested', risk: 'nested_quantifier' } },
      { code: 'book.bad_pattern', level: 'fail', params: { pattern: 'broken', reason: 'invalid_regex' } },
    ]);
  });
});

describe('withBookPatterns (ADR-0124)', () => {
  const dice: PatternDefinition = { id: 'dice', use: 'mask', kind: 'dice', regex: '\\d+d\\d+' };
  const marker: PatternDefinition = { id: 'marker', use: 'detect', regex: '^GM' };

  it('keeps the pack as it is when the book has none', () => {
    const pack = packWith([dice, marker]);
    expect(withBookPatterns(pack, [])).toEqual(pack);
  });

  it('puts the book patterns first, in their order, before the pack', () => {
    const merged = withBookPatterns(packWith([dice, marker]), [mask('b', 'B'), mask('a', 'A')]);
    expect(merged.patterns.map(({ id }) => id)).toEqual(['b', 'a', 'dice', 'marker']);
  });

  it('replaces a pack pattern with the same id, and moves it to the front', () => {
    const own = mask('dice', 'NEVER-MATCHES', { kind: 'code' });
    const merged = withBookPatterns(packWith([marker, dice]), [mask('a', 'A'), own]);
    expect(merged.patterns).toEqual([mask('a', 'A'), own, marker]);
  });

  it('replaces a detect pattern with the same id too', () => {
    const merged = withBookPatterns(packWith([dice, marker]), [mask('marker', 'M')]);
    expect(merged.patterns.map(({ id, use }) => [id, use])).toEqual([
      ['marker', 'mask'],
      ['dice', 'mask'],
    ]);
  });

  it('keeps everything else of the pack, so its hash does not change', () => {
    const pack = { ...packWith([dice]), id: 'other', roles: [{ name: 'gm_note', pack: 'other' }] };
    const merged = withBookPatterns(pack, [mask('a', 'A')]);
    expect({ ...merged, patterns: [] }).toEqual({ ...pack, patterns: [] });
    expect(merged.chain).toBe(pack.chain);
  });

  it('lets the book win a tie, where the ranges start and end alike', async () => {
    const merged = withBookPatterns(packWith([dice]), [mask('roll', '\\d+d\\d+', { kind: 'roll' })]);
    expect(await masked(merged, 'Throw 2d6 now.')).toBe('Throw <ph id="1" kind="roll"/> now.');
    expect(await masked(packWith([dice]), 'Throw 2d6 now.')).toBe('Throw <ph id="1" kind="dice"/> now.');
  });

  it('still lets an earlier or a longer range win over a book pattern', async () => {
    const merged = withBookPatterns(packWith([dice]), [mask('six', 'd6', { kind: 'six' }), mask('two', '2', { kind: 'two' })]);
    expect(await masked(merged, 'Throw 12d6 now.')).toBe('Throw <ph id="1" kind="dice"/> now.');
  });

  it('masks with the id when the book pattern has no kind', async () => {
    const merged = withBookPatterns(packWith([]), [mask('tide-code', 'TC-\\d{3}')]);
    expect(await masked(merged, 'Open TC-104.')).toBe('Open <ph id="1" kind="tide-code"/>.');
  });
});
