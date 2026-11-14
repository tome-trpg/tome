import { describe, expect, it } from 'vitest';
import { addRenamed, policyOf } from '../../src/core/glossary.ts';
import type { ResolvedPack } from '../../src/core/pack.ts';

// 審定的權重與預設代名詞（ADR-0119 第 5 項、ADR-0138 第 10 項），與網頁上 S-16 的加總。規則包是這裡編的。

type Chain = Pick<ResolvedPack, 'chain'>;

function chain(...classes: Record<string, Record<string, unknown>>[]): Chain {
  return { chain: classes.map((entities) => ({ content: { classes: entities } })) } as unknown as Chain;
}

describe('policyOf', () => {
  it('takes each setting from the child first, separately for the weight and the pronoun', () => {
    const policy = policyOf(
      chain(
        { place: { review_weight: 5 }, beast: { default_pronoun: '牠' } },
        { place: { review_weight: 1, default_pronoun: '它' }, beast: { review_weight: 3, default_pronoun: '它' } },
      ),
    );
    expect(policy.weightOf('place')).toBe(5);
    expect(policy.pronounOf('place')).toBe('它');
    expect(policy.weightOf('beast')).toBe(3);
    expect(policy.pronounOf('beast')).toBe('牠');
  });

  it('falls back to a weight of 1 and no pronoun for a class with neither, an unknown class and no class', () => {
    const policy = policyOf(chain({ person: {} }));
    for (const kind of ['person', 'unknown', null]) {
      expect(policy.weightOf(kind)).toBe(1);
      expect(policy.pronounOf(kind)).toBeNull();
    }
  });
});

describe('addRenamed', () => {
  const one = { replaced: 1, resend: 2, reset: 3, in_flight: 4 };
  const two = { replaced: 10, resend: 20, reset: 30, in_flight: 40 };

  it('adds each count, and keeps the other side when one is null', () => {
    expect(addRenamed(one, two)).toEqual({ replaced: 11, resend: 22, reset: 33, in_flight: 44 });
    expect(addRenamed(null, two)).toBe(two);
    expect(addRenamed(one, null)).toBe(one);
    expect(addRenamed(null, null)).toBeNull();
  });
});
