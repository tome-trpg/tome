import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadSourceLanguage } from '../../src/core/language.ts';
import { openPdf, type PageFacts, type PdfHandle } from '../../src/core/pdf.ts';
import {
  classifyPage,
  detectGpu,
  probePdf,
  summarizeProbe,
  type PageProbe,
} from '../../src/core/probe.ts';
import { validateProbe } from '../../src/core/schema.ts';
import { FORGE_CASES, forge, forgeFile, type ForgeCase } from '../forge/index.ts';
import { tempDir } from '../helpers.ts';

const SHA = 'a'.repeat(64);
const QUALITY = loadSourceLanguage('en').profile.text_quality;

function facts(overrides: Partial<PageFacts> = {}): PageFacts {
  return {
    page: 0,
    width: 612,
    height: 792,
    runs: [{ text: 'word '.repeat(50), bbox: [0, 0, 1, 1], font: 'f' }],
    visibleGlyphs: 200,
    invisibleGlyphs: 0,
    imageLargest: 0,
    imageTotal: 0,
    vectorPaths: 0,
    links: [],
    ...overrides,
  };
}

async function opened(name: ForgeCase): Promise<PdfHandle> {
  const result = await openPdf(await forgeFile(name, tempDir()));
  if (result.status !== 'ok') throw new Error(`${name} did not open`);
  return result.pdf;
}

async function kinds(name: ForgeCase): Promise<PageProbe['kind'][]> {
  const pdf = await opened(name);
  const probe = await probePdf(pdf, SHA, QUALITY);
  await pdf.close();
  return probe.pages.map((page) => page.kind);
}

describe('classifyPage', () => {
  it('calls a page of visible text native', () => {
    expect(classifyPage(facts()).kind).toBe('native');
  });

  it('keeps a page of text over a full-page background native', () => {
    expect(classifyPage(facts({ imageLargest: 1, imageTotal: 1 })).kind).toBe('native');
  });

  it('calls a full-page image scan, even under one line of footer', () => {
    const footer = [{ text: 'Licensed to Someone', bbox: [0, 0, 1, 1] as const, font: 'f' }];
    expect(classifyPage(facts({ runs: [], visibleGlyphs: 0, imageLargest: 1, imageTotal: 1 })).kind).toBe('scan');
    expect(classifyPage(facts({ runs: footer, visibleGlyphs: 17, imageLargest: 0.9, imageTotal: 0.9 })).kind).toBe('scan');
  });

  it('sees through a hidden OCR layer', () => {
    const ocr = { visibleGlyphs: 0, invisibleGlyphs: 200, imageLargest: 1, imageTotal: 1 };
    expect(classifyPage(facts(ocr)).kind).toBe('scan');
  });

  it('calls a textless page with art image_only and an empty one native', () => {
    const empty = { runs: [], visibleGlyphs: 0 };
    expect(classifyPage(facts({ ...empty, imageLargest: 0.3, imageTotal: 0.3 })).kind).toBe('image_only');
    expect(classifyPage(facts({ ...empty, vectorPaths: 80 })).kind).toBe('image_only');
    expect(classifyPage(facts(empty)).kind).toBe('native');
  });

  it('counts private use, replacement and control characters as bad', () => {
    const page = classifyPage(
      facts({ runs: [{ text: '�\u0001ab', bbox: [0, 0, 1, 1], font: 'f' }] }),
    );
    expect(page).toMatchObject({ kind: 'broken_text', chars: 6, bad_chars: 4 });
  });

  it('does not count whitespace', () => {
    const page = classifyPage(facts({ runs: [{ text: ' a\tb\n', bbox: [0, 0, 1, 1], font: 'f' }] }));
    expect(page.chars).toBe(2);
  });
});

describe('the language signal', () => {
  const page = (text: string): PageFacts => facts({ runs: [{ text, bbox: [0, 0, 1, 1], font: 'f' }] });
  const rot13 = (text: string): string =>
    text.replace(/[a-z]/gi, (char) => {
      const base = char <= 'Z' ? 65 : 97;
      return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
    });
  const english = readFileSync('LICENSE', 'utf8');

  it('passes ordinary English, and gives a score', () => {
    const result = classifyPage(page(english), QUALITY);
    expect(result.kind).toBe('native');
    expect(result.language_match).toBeGreaterThan(0.9);
  });

  it('catches letters that are legal but wrong', () => {
    const result = classifyPage(page(rot13(english)), QUALITY);
    expect(result.kind).toBe('broken_text');
    expect(result.language_match).toBeLessThan(QUALITY.min_similarity);
  });

  it('catches a text layer shifted by a fixed distance', () => {
    const shifted = english.replace(/[a-z]/g, (char) =>
      String.fromCharCode(((char.charCodeAt(0) - 97 + 3) % 26) + 97),
    );
    expect(classifyPage(page(shifted), QUALITY).kind).toBe('broken_text');
  });

  it('leaves a page with few letters alone, such as a table of numbers', () => {
    const table = 'STR 45 CON 60 SIZ 70 DEX 50 '.repeat(4);
    const result = classifyPage(page(table), QUALITY);
    expect(result.kind).toBe('native');
    expect(result.language_match).toBeUndefined();
  });

  it('does not judge without a language', () => {
    expect(classifyPage(page(rot13(english))).kind).toBe('native');
  });
});

describe('probing forged PDFs', () => {
  it.each(FORGE_CASES.filter((name) => !name.startsWith('encrypted')))(
    'sorts the pages of %s',
    async (name) => {
      expect(await kinds(name)).toEqual((await forge(name)).truth.kinds);
    },
  );

  it.each(['encrypted-owner', 'encrypted-user'] as const)('refuses %s', async (name) => {
    const result = await openPdf(await forgeFile(name, tempDir()));
    expect(result.status).toBe('encrypted');
  });

  it('reads the structure the PDF carries', async () => {
    const pdf = await opened('structure');
    const probe = await probePdf(pdf, SHA);
    await pdf.close();
    expect(probe.tagged).toBe(true);
    expect(probe.page_labels.map((item) => item.label)).toEqual(['i', 'ii', '1', '2', '3']);
    expect(probe.outline).toEqual([
      {
        title: 'Forged Part One',
        page: 0,
        children: [{ title: 'Forged Chapter Two', page: 2, children: [] }],
      },
      { title: 'Forged Appendix', page: 4, children: [] },
    ]);
    expect(probe.links.map(({ page, uri, target_page }) => ({ page, uri, target_page }))).toEqual([
      { page: 1, uri: 'https://example.com/forged', target_page: undefined },
      { page: 1, uri: undefined, target_page: 2 },
    ]);
    expect(validateProbe(JSON.parse(JSON.stringify(probe))).ok).toBe(true);
  });

  it('reports nothing where the PDF carries nothing', async () => {
    const pdf = await opened('plain');
    const probe = await probePdf(pdf, SHA);
    await pdf.close();
    expect(summarizeProbe(probe)).toEqual({
      pages: 3,
      kinds: { native: 3, scan: 0, broken_text: 0, image_only: 0 },
      tagged: false,
      spread: false,
      outline_items: 0,
      outline_unresolved: 0,
      label_pages: 0,
      links: 0,
    });
  });

  it('notices a spread layout', async () => {
    const pdf = await opened('spread');
    expect((await probePdf(pdf, SHA)).spread).toBe(true);
    await pdf.close();
  });

  it('separates hidden glyphs from visible ones', async () => {
    const pdf = await opened('hidden');
    const page = await pdf.page(0);
    await pdf.close();
    expect(page.invisibleGlyphs).toBe(26);
    expect(page.visibleGlyphs).toBeGreaterThan(300);
  });
});

describe('detectGpu', () => {
  it('reads nvidia-smi', async () => {
    const tool = async () => ({ stdout: 'NVIDIA GeForce RTX 4060 Laptop GPU, 8188\r\n' });
    expect(await detectGpu({}, tool)).toEqual({
      name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
      vram_mb: 8188,
    });
  });

  it('takes the first card', async () => {
    const tool = async () => ({ stdout: 'First, 1024\nSecond, 2048\n' });
    expect(await detectGpu({}, tool)).toEqual({ name: 'First', vram_mb: 1024 });
  });

  it.each([[null], [{ stdout: '' }], [{ stdout: 'No devices were found' }]])(
    'reports no GPU on %j',
    async (result) => {
      expect(await detectGpu({}, async () => result)).toBeNull();
    },
  );
});
