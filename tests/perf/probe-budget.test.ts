import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { suggestPack, type PackCandidate } from '../../src/core/pack.ts';
import { openPdf } from '../../src/core/pdf.ts';
import { pageText, probePdf } from '../../src/core/probe.ts';
import { large } from '../forge/index.ts';
import { tempDir } from '../helpers.ts';

// Q-9 的效能預算（ADR-0068）。Q-9 的 30 秒是參考機器的目標，CI 機器較慢又有波動，所以門檻放寬。
const PAGES = 400;
const CI_BUDGET_MS = 120_000;

/** 建議規則包要在每一頁上跑模式，不能吃掉 Q-9 的預算（ADR-0100）。 */
const SUGGESTING: readonly PackCandidate[] = Array.from({ length: 3 }, (_, index) => ({
  id: `pack-${index}`,
  keywords: ['warden', 'lantern', 'crossing'],
  patterns: [
    { id: 'dice', regex: '\\b\\d*[dD]\\d+\\b' },
    { id: 'heading', regex: '^[A-Z][a-z]+ \\d+$', flags: 'm' },
  ],
}));

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

  it(`stays within the budget with packs to suggest`, { timeout: CI_BUDGET_MS * 2 }, async () => {
    const path = join(tempDir(), 'large.pdf');
    writeFileSync(path, await large(PAGES));
    const start = performance.now();
    const opened = await openPdf(path);
    if (opened.status !== 'ok') throw new Error('the forged PDF did not open');
    const texts: string[] = [];
    await probePdf(opened.pdf, 'a'.repeat(64), undefined, undefined, (facts) => texts.push(pageText(facts)));
    await opened.pdf.close();
    const { suggested, findings } = await suggestPack(SUGGESTING, texts);
    expect(findings).toEqual([]);
    expect(texts).toHaveLength(PAGES);
    expect(suggested?.keyword_pages).toBeGreaterThan(0);
    expect(performance.now() - start).toBeLessThan(CI_BUDGET_MS);
  });
});
