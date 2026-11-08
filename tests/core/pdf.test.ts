import { describe, expect, it } from 'vitest';
import { fontStyle, openPdf, type PdfHandle } from '../../src/core/pdf.ts';
import { forgeFile } from '../forge/index.ts';
import { tempDir } from '../helpers.ts';

// 字型名稱都是常見的標準寫法，不是哪本書的字型（ADR-0116）。

describe('fontStyle', () => {
  it.each([
    ['Helvetica-Bold', true, false],
    ['ABCDEF+MinionPro-Semibold', true, false],
    ['Arial,BoldItalic', true, true],
    ['Helvetica-BoldOblique', true, true],
    ['TimesNewRomanPS-ItalicMT', false, true],
    ['ABCDEF+MinionPro-It', false, true],
    ['MinionPro-BoldIt', true, true],
    ['MinionPro-ItCapt', false, true],
    ['Futura-Heavy', true, false],
    ['Optima-DemiBold', true, false],
    ['Times-Roman', false, false],
    ['MinionPro-Regular', false, false],
    ['', false, false],
  ])('%j', (name, bold, italic) => {
    expect(fontStyle(name)).toEqual({ bold, italic });
  });

  it('reads only the style after the last hyphen, so a family name does not count', () => {
    expect(fontStyle('BlackChancery-Regular')).toEqual({ bold: false, italic: false });
    expect(fontStyle('Credit-Regular')).toEqual({ bold: false, italic: false });
    expect(fontStyle('HeavyMetal-Italic')).toEqual({ bold: false, italic: true });
  });

  it('reads the whole name when there is no style part, but not a lower case it', () => {
    expect(fontStyle('ArialBold')).toEqual({ bold: true, italic: false });
    expect(fontStyle('Explicit')).toEqual({ bold: false, italic: false });
  });
});

describe('openPdf with fontStyles', () => {
  async function opened(withStyles: boolean): Promise<PdfHandle> {
    const result = await openPdf(await forgeFile('blocks', tempDir()), withStyles ? { fontStyles: true } : {});
    if (result.status !== 'ok') throw new Error('blocks did not open');
    return result.pdf;
  }

  it('marks the runs drawn in bold and italic faces', async () => {
    const pdf = await opened(true);
    try {
      const { runs } = await pdf.page(0);
      expect(runs[0]).toMatchObject({ bold: true, italic: false });
      expect(runs.some(({ bold, italic }) => bold === false && italic === false)).toBe(true);
      expect(runs.some(({ bold, italic }) => bold === false && italic === true)).toBe(true);
    } finally {
      await pdf.close();
    }
  });

  it('leaves the runs without styles when it was not asked for them, as tome probe opens it', async () => {
    const pdf = await opened(false);
    try {
      const { runs } = await pdf.page(0);
      expect(runs.every((run) => !('bold' in run) && !('italic' in run))).toBe(true);
    } finally {
      await pdf.close();
    }
  });
});
