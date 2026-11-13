import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFile, checkFolder, readExternal, type ExternalAsset } from '../../tools/verify-public.ts';
import { tempDir } from '../helpers.ts';

// 本機公開素材的驗證（ADR-0136）。檔案是這裡寫的幾個位元組，不是任何書。

const TEXT = 'a made-up public asset\n';

function asset(overrides: Partial<ExternalAsset> = {}): ExternalAsset {
  return {
    id: 'made-up',
    url: 'https://example.invalid/made-up.pdf',
    file: 'made-up.pdf',
    license: 'ORC',
    bytes: Buffer.byteLength(TEXT),
    sha256: createHash('sha256').update(TEXT).digest('hex'),
    retrieved: '2026-11-13',
    ...overrides,
  };
}

function folder(text = TEXT): string {
  const dir = tempDir();
  writeFileSync(join(dir, 'made-up.pdf'), text);
  return dir;
}

describe('checkFile', () => {
  it('passes a file of the listed size and hash', () => {
    expect(checkFile(asset(), join(folder(), 'made-up.pdf'))).toEqual({ id: 'made-up', status: 'ok' });
  });

  it('says what it found when the file changed', () => {
    const changed = 'a made-up public asset, changed\n';
    expect(checkFile(asset(), join(folder(changed), 'made-up.pdf'))).toEqual({
      id: 'made-up',
      status: 'changed',
      bytes: Buffer.byteLength(changed),
      sha256: createHash('sha256').update(changed).digest('hex'),
    });
  });

  it('does not pass a file of the right size with another hash', () => {
    const swapped = TEXT.replace('a', 'b');
    expect(checkFile(asset(), join(folder(swapped), 'made-up.pdf')).status).toBe('changed');
  });

  it('says when the file is not there', () => {
    expect(checkFile(asset(), join(tempDir(), 'made-up.pdf'))).toEqual({ id: 'made-up', status: 'missing' });
  });
});

describe('checkFolder', () => {
  it('looks for each listed file by name, or only the ones asked for', () => {
    const dir = folder();
    const other = asset({ id: 'other', file: 'other.pdf', url: 'https://example.invalid/other.pdf' });
    expect(checkFolder([asset(), other], dir)).toEqual([
      { id: 'made-up', status: 'ok' },
      { id: 'other', status: 'missing' },
    ]);
    expect(checkFolder([asset(), other], dir, ['made-up'])).toEqual([{ id: 'made-up', status: 'ok' }]);
  });

  it('counts an id that is not listed as missing', () => {
    expect(checkFolder([asset()], folder(), ['nothing'])).toEqual([{ id: 'nothing', status: 'missing' }]);
  });

  it('never reads a path out of the listed name', () => {
    const outside = asset({ file: '../made-up.pdf' });
    const dir = folder();
    expect(checkFolder([outside], join(dir, 'inner'))).toEqual([{ id: 'made-up', status: 'missing' }]);
  });
});

describe('readExternal', () => {
  it('reads the external list, and an empty one when there is none', () => {
    expect(readExternal('external:\n  - id: a\n')).toEqual([{ id: 'a' }]);
    expect(readExternal('assets: []\n')).toEqual([]);
  });
});

describe('node tools/verify-public.ts', () => {
  function verify(...args: string[]): { status: number | null; stdout: string } {
    const { status, stdout } = spawnSync(process.execPath, ['tools/verify-public.ts', ...args], { encoding: 'utf8' });
    return { status, stdout };
  }

  it('asks for a folder', () => {
    expect(verify().status).toBe(2);
  });

  it('fails when the listed files are not in the folder, and only prints ids and states', () => {
    const { status, stdout } = verify(tempDir());
    expect(status).toBe(1);
    expect(stdout).toBe('brp-orc-content: missing\norc-license: missing\n');
  });
});
