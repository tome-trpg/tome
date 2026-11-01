import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// PC-2：每個測試素材都要登記授權與雜湊，未登記的讓 CI 失敗（ADR-0061）。
const ROOT = 'tests/fixtures';
const LIST = 'SOURCES.yaml';
const LICENSES = new Set(['Apache-2.0']);

interface Asset {
  readonly path: string;
  readonly source: string;
  readonly license: string;
  readonly sha256: string;
}

function assets(): readonly Asset[] {
  return (parse(readFileSync(join(ROOT, LIST), 'utf8')) as { assets: Asset[] }).assets;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [relative('.', path).split(sep).join('/')];
  });
}

describe('the list of test assets', () => {
  it('names every file and nothing else', () => {
    const present = filesUnder(ROOT).filter((path) => path !== `${ROOT}/${LIST}`);
    expect(assets().map((asset) => asset.path).sort()).toEqual(present.sort());
  });

  it('has the right hash for each file', () => {
    for (const { path, sha256 } of assets()) {
      expect([path, createHash('sha256').update(readFileSync(path)).digest('hex')]).toEqual([path, sha256]);
    }
  });

  it('says where each file came from, under a license we can keep in the repo', () => {
    for (const { source, license } of assets()) {
      expect(source).not.toBe('');
      expect(LICENSES).toContain(license);
    }
  });

  it('holds no PDF', () => {
    expect(filesUnder(ROOT).filter((path) => path.toLowerCase().endsWith('.pdf'))).toEqual([]);
  });
});
