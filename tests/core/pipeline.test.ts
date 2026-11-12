import { describe, expect, it } from 'vitest';
import { finding } from '../../src/core/findings.ts';
import { once } from '../../src/core/pipeline.ts';

// tome run 接起各步的發現時，同一行只留最後一次（ADR-0132）。參數都是編的數字。

describe('once (ADR-0132)', () => {
  it('keeps the last of the findings that say the same thing, in their order', () => {
    const budget = finding('estimate.budget', 'info', { budget: '5.00', spent: '0.10' });
    const done = finding('estimate.done', 'info', { units: '3' });
    expect(once([budget, done, { ...budget, params: { ...budget.params } }])).toEqual([done, budget]);
  });

  it('keeps both when the same code says different numbers', () => {
    const first = finding('estimate.budget', 'info', { budget: '5.00', spent: '0.10' });
    const second = finding('estimate.budget', 'info', { budget: '5.00', spent: '0.20' });
    expect(once([first, second])).toEqual([first, second]);
  });

  it('keeps both when the same code comes at another level', () => {
    const info = finding('estimate.no_budget', 'info');
    const warn = finding('estimate.no_budget', 'warn');
    expect(once([info, warn])).toEqual([info, warn]);
  });

  it('takes the parameters in any order as the same', () => {
    const one = finding('estimate.budget', 'info', { budget: '5.00', spent: '0.10' });
    const other = finding('estimate.budget', 'info', { spent: '0.10', budget: '5.00' });
    expect(once([one, other])).toEqual([other]);
  });

  // `--chapter-level` 在解析之後才寫進 book.yaml，解析那一步印的可能是舊的層級。
  it('keeps only the last chapter level, whatever it says', () => {
    const before = finding('chapters.levels', 'info', { book: 'book', levels: '2', counts: '1／2', level: '1', chapters: '1' });
    const after = finding('chapters.levels', 'info', { book: 'book', levels: '2', counts: '1／2', level: '2', chapters: '2' });
    expect(once([before, after])).toEqual([after]);
  });
});
