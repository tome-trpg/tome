import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspaceTemplate } from '../../src/cli/messages.ts';
import { addBook } from '../../src/core/book.ts';
import { addEngine } from '../../src/core/engine.ts';
import { extractBook, sourcePageFile } from '../../src/core/extract.ts';
import { exitCodeOf } from '../../src/core/findings.ts';
import type { SourcePage } from '../../src/core/ir.ts';
import { validateEngineRun, validateIr } from '../../src/core/schema.ts';
import { initWorkspace } from '../../src/core/workspace.ts';
import { forge, forgeFile } from '../forge/index.ts';
import { tempDir } from '../helpers.ts';

// 平常的 CI 不裝 Docling，用錄好的輸出（ADR-0064）。錄的是合成 PDF，沒有任何書的內容。
const RECORDED = resolve('tests/fixtures/engine-outputs/docling/blocks');
const FAKE_ENGINE = resolve('tests/fixtures/engines/fake');

function recordedPage(page: number): SourcePage {
  return JSON.parse(readFileSync(join(RECORDED, sourcePageFile(page)), 'utf8')) as SourcePage;
}

describe('the recorded Docling output', () => {
  it('is still the output of the PDF the forge makes', async () => {
    const { bytes } = await forge('blocks');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(recordedPage(0).pdf_sha256).toBe(sha256);
  });

  it('passes tome-ir/1, and its run record passes tome-engine/1', () => {
    for (const page of [0, 1]) expect(validateIr(recordedPage(page)).ok).toBe(true);
    const record: unknown = JSON.parse(readFileSync(join(RECORDED, 'engine.json'), 'utf8'));
    expect(validateEngineRun(record).ok).toBe(true);
  });

  it('holds every core role the forged page has', () => {
    expect(recordedPage(0).blocks.map((block) => block.role)).toEqual([
      'heading',
      'paragraph',
      'table',
      'paragraph',
      'figure',
      'caption',
      'furniture',
    ]);
  });

  it('keeps coordinates in PDF points from the bottom left, like pdf.js', () => {
    const [heading] = recordedPage(0).blocks;
    const [, bottom = 0, , top = 0] = heading?.spans[0]?.bbox ?? [];
    expect(bottom).toBeGreaterThan(600);
    expect(top).toBeGreaterThan(bottom);
  });

  it('goes through the protocol like any other engine', async () => {
    const home = join(tempDir(), 'home');
    initWorkspace({ home, env: {}, template: workspaceTemplate });
    await addEngine({ home, target: FAKE_ENGINE, gpu: false, env: process.env, tool: async () => null });
    await addBook({ home, pdf: await forgeFile('blocks', tempDir()), name: 'book' });
    const { findings } = await extractBook({
      home,
      slug: 'book',
      env: { ...process.env, FAKE_ENGINE_RECORDED: RECORDED },
      tool: async () => null,
    });
    expect(exitCodeOf(findings)).toBe(0);
    expect(findings[0]?.params).toEqual({ pages: '2', ran: '2', reused: '0' });
  });
});
