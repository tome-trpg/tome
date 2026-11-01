import { describe, expect, it } from 'vitest';
import { checkBudget } from '../../src/core/budget.ts';

describe('checkBudget (ADR-0081 item 2)', () => {
  it('lets a request through while everything fits', () => {
    expect(checkBudget({ budget_usd: 10, spent_usd: 2, in_flight_usd: 3, next_usd: 4 })).toEqual({
      ok: true,
      remaining_usd: 1,
    });
  });

  it('lets it through when it lands exactly on the limit', () => {
    expect(checkBudget({ budget_usd: 10, spent_usd: 3, in_flight_usd: 3, next_usd: 4 }).ok).toBe(true);
  });

  it('stops it when spent, in flight and next go over together', () => {
    const result = checkBudget({ budget_usd: 10, spent_usd: 3, in_flight_usd: 3, next_usd: 4.01 });
    expect(result.ok).toBe(false);
    expect(result.remaining_usd).toBeCloseTo(-0.01);
  });

  it('counts what is in flight, which has not been billed yet', () => {
    expect(checkBudget({ budget_usd: 10, spent_usd: 0, in_flight_usd: 9, next_usd: 2 }).ok).toBe(false);
  });

  it('stops everything when nothing is left', () => {
    expect(checkBudget({ budget_usd: 1, spent_usd: 1.5, in_flight_usd: 0, next_usd: 0 }).ok).toBe(false);
  });
});
