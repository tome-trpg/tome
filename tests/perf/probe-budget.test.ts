import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openPdf } from '../../src/core/pdf.ts';
import { probePdf } from '../../src/core/probe.ts';
import { large } from '../forge/index.ts';
import { tempDir } from '../helpers.ts';

// Q-9 的效能預算（ADR-0068）。Q-9 的 30 秒是參考機器的目標，CI 機器較慢又有波動，所以門檻放寬。
const PAGES = 400;
const CI_BUDGET_MS = 120_000;

describe('the probe budget', () => {
  it(`probes ${PAGES} pages within the budget`, { timeout: CI_BUDGET_MS * 2 }, async () => {
    const path = join(tempDir(), 'large.pdf');
    writeFileSync(path, await large(PAGES));
    const start = performance.now();
    const opened = await openPdf(path);
    if (opened.status !== 'ok') throw new Error('the forged PDF did not open');
    const probe = await probePdf(opened.pdf, 'a'.repeat(64));
    await opened.pdf.close();
    expect(probe.pages).toHaveLength(PAGES);
    expect(probe.pages.every((page) => page.kind === 'native')).toBe(true);
    expect(performance.now() - start).toBeLessThan(CI_BUDGET_MS);
  });
});
