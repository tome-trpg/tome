import { describe, expect, it } from 'vitest';
import { FORGE_CASES, forge, prose, type ForgeCase } from './index.ts';

const DETERMINISTIC = FORGE_CASES.filter((name) => !name.startsWith('encrypted'));

describe('the forge', () => {
  it.each(DETERMINISTIC)('gives the same bytes every time for %s', async (name: ForgeCase) => {
    const [first, second] = await Promise.all([forge(name), forge(name)]);
    expect(first.bytes.equals(second.bytes)).toBe(true);
  });

  it.each(FORGE_CASES)('makes a PDF with its answer for %s', async (name: ForgeCase) => {
    const { bytes, truth } = await forge(name);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(truth.encrypted === true || truth.kinds.length > 0).toBe(true);
  });

  it('writes made-up text from a seed', () => {
    expect(prose(3, 12)).toBe(prose(3, 12));
    expect(prose(3, 12)).not.toBe(prose(4, 12));
    expect(prose(3, 12).endsWith('.')).toBe(true);
  });
});
