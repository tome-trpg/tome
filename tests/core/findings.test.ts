import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { exitCodeOf, finding, FINDING_CODES, type FindingLevel } from '../../src/core/findings.ts';

describe('exitCodeOf', () => {
  it('is 0 with nothing to report', () => {
    expect(exitCodeOf([])).toBe(0);
  });

  it('is 1 exactly when a finding fails', () => {
    const level = fc.constantFrom<FindingLevel>('fail', 'warn', 'info');
    fc.assert(
      fc.property(fc.array(level), (levels) => {
        const findings = levels.map((item) => finding(FINDING_CODES[0], item));
        expect(exitCodeOf(findings)).toBe(levels.includes('fail') ? 1 : 0);
      }),
    );
  });
});
