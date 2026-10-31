import { describe, expect, it } from 'vitest';
import { runPatterns } from '../../src/core/patterns.ts';

const DICE = { id: 'dice', regex: '\\b\\d*[dD]\\d+\\b' };

describe('runPatterns', () => {
  it('gives the ranges of each pattern over each text', async () => {
    const outcome = await runPatterns(
      [DICE, { id: 'word', regex: 'ferry', flags: 'i' }],
      ['Roll 1D6 and 2d8.', 'The Ferry waits.'],
    );
    expect(outcome).toEqual({
      status: 'ok',
      matches: {
        dice: [[[5, 8], [13, 16]], []],
        word: [[], [[4, 9]]],
      },
    });
  });

  it('has nothing to do without patterns', async () => {
    expect(await runPatterns([], ['text'])).toEqual({ status: 'ok', matches: {} });
  });

  it('ends a catastrophic pattern and names it', { timeout: 20_000 }, async () => {
    const start = performance.now();
    const outcome = await runPatterns(
      [DICE, { id: 'runaway', regex: '(a+)+$' }, { id: 'never_reached', regex: 'b' }],
      [`${'a'.repeat(40)}!`],
      300,
    );
    expect(outcome).toEqual({ status: 'timeout', pattern: 'runaway' });
    expect(performance.now() - start).toBeLessThan(10_000);
  });

  it('keeps the main thread free while a pattern runs away', { timeout: 20_000 }, async () => {
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 10);
    await runPatterns([{ id: 'runaway', regex: '(a|aa)+$' }], [`${'a'.repeat(60)}!`], 300);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(5);
  });

  it('reports a pattern that does not compile instead of hanging', async () => {
    const outcome = await runPatterns([{ id: 'broken', regex: '(' }], ['text']);
    expect(outcome).toEqual({ status: 'failed', pattern: 'broken' });
  });
});
