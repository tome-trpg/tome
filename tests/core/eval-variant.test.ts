import { onTestFinished, describe, expect, it } from 'vitest';
import { readBook } from '../../src/core/book.ts';
import { maskText } from '../../src/core/mask.ts';
import { readInstructions } from '../../src/core/prompt.ts';
import { findModel, loadProvider, thinkingParams } from '../../src/core/provider.ts';
import { EVAL_THINKING_FACTOR, planBook, planRequests, type EvalVariant, type PlannedRequest } from '../../src/core/request.ts';
import { openBookStore } from '../../src/core/store.ts';
import type { TranslationUnit } from '../../src/core/units.ts';
import { addBlock, library } from '../helpers/library.ts';

// 只給評測用的選項（ADR-0139）：換指令、開思考、一段一個請求。CLI 不傳它們。文字都是這裡編的。

const { profile } = loadProvider('anthropic');

function unit(unit_id: string, source: string, extra: Partial<TranslationUnit> = {}): TranslationUnit {
  return { unit_id, block_id: unit_id, role: 'paragraph', source, ...maskText(source, []), ...extra };
}

function ids(requests: readonly PlannedRequest[]): string[][] {
  return requests.map(({ units }) => units.map(({ unit_id }) => unit_id));
}

async function planned(variant?: EvalVariant) {
  const lib = await library();
  addBlock(lib.home, 'p0010-000001', 'The Grey Warden keeps the gate and counts the stones.');
  addBlock(lib.home, 'p0010-000002', 'Travellers meet the Grey Warden at the Old Ferry.');
  const store = openBookStore(lib.home, 'book');
  onTestFinished(() => store.close());
  const override = variant === undefined ? undefined : { cache: null, variant };
  const { plan } = await planBook(lib.home, readBook(lib.home, 'book'), store, 'batch', override);
  if (plan === null) throw new Error('the book has no plan');
  return plan;
}

describe('planRequests, one request per group (ADR-0139)', () => {
  const units = [
    unit('a', 'First paragraph.'),
    unit('b', 'Second paragraph.'),
    unit('c', 'A cell.', { group: 'g1' }),
    unit('d', 'Another cell.', { group: 'g1' }),
    unit('e', 'Third paragraph.'),
  ];

  it('keeps each group whole in a request of its own, with the text before it as context', () => {
    const separate = planRequests(units, () => 1, () => true, true);
    expect(ids(separate)).toEqual([['a'], ['b'], ['c', 'd'], ['e']]);
    expect(separate[1]?.context).toContain('First paragraph.');
    expect(separate[3]?.context).toContain('Another cell.');
    expect(ids(planRequests(units, () => 1, () => true))).toEqual([['a', 'b', 'c', 'd', 'e']]);
  });

  it('sends only the wanted units, each still with its own context', () => {
    const separate = planRequests(units, () => 1, ({ unit_id }) => unit_id === 'b' || unit_id === 'e', true);
    expect(ids(separate)).toEqual([['b'], ['e']]);
    expect(separate[1]?.context).toContain('Another cell.');
  });
});

describe('the variants of an evaluation (ADR-0139)', () => {
  it('changes nothing when no variant is given', async () => {
    const plan = await planned();
    expect(plan.prefix.startsWith(readInstructions().trim())).toBe(true);
    expect(plan.model).toEqual(findModel(profile, plan.model.id));
    expect(plan.separate).toBe(false);
  });

  it('puts other instructions at the head of the prefix, and the rest as it was', async () => {
    const plain = await planned();
    const swapped = await planned({ instructions: '這是測試用的指令。' });
    expect(swapped.prefix.startsWith('這是測試用的指令。\n\n')).toBe(true);
    expect(swapped.prefix.slice('這是測試用的指令。'.length)).toBe(plain.prefix.slice(readInstructions().trim().length));
  });

  it('turns thinking on with adaptive thinking, and plans for more output', async () => {
    const plain = await planned();
    const thinking = await planned({ thinking: 'adaptive' });
    expect(thinking.model.thinking).toEqual({ mode: 'adaptive', output_factor: EVAL_THINKING_FACTOR });
    expect(thinking.bodies[0]).toMatchObject({ thinking: { type: 'adaptive' } });
    expect(thinking.bodies[0]).not.toHaveProperty('output_config');
    expect(thinking.estimate.high_usd).toBeGreaterThan(plain.estimate.high_usd);
  });

  it('plans one request per group when asked', async () => {
    const plain = await planned();
    const separate = await planned({ separate: true });
    expect(separate.separate).toBe(true);
    expect(separate.requests.length).toBeGreaterThan(plain.requests.length);
    expect(separate.requests.every(({ units }) => new Set(units.map(({ group, unit_id }) => group ?? unit_id)).size === 1)).toBe(true);
  });

  it('asks the API for adaptive thinking in that mode', () => {
    expect(thinkingParams({ ...findModel(profile, 'claude-sonnet-5-5'), thinking: { mode: 'adaptive' } })).toEqual({ thinking: { type: 'adaptive' } });
  });
});
