import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readExternal } from '../../tools/verify-public.ts';

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

// 不在 repo 裡的公開素材：下載後驗證雜湊，檔案不進 repo（ADR-0061 第 2 項、ADR-0136）。
describe('the list of public assets kept outside the repository', () => {
  const EXTERNAL_LICENSES = new Set(['ORC', 'Public-Domain']);

  it('says for each where it came from, under what license, how big it is, its hash and when it was taken', () => {
    const external = readExternal(readFileSync(join(ROOT, LIST), 'utf8'));
    expect(external.length).toBeGreaterThan(0);
    for (const asset of external) {
      expect(Object.keys(asset).sort()).toEqual(['bytes', 'file', 'id', 'license', 'retrieved', 'sha256', 'url']);
      expect(asset.url).toMatch(/^https:\/\/[^\s/]+\/\S+$/u);
      expect(asset.url.endsWith(`/${asset.file}`)).toBe(true);
      expect(EXTERNAL_LICENSES).toContain(asset.license);
      expect(Number.isInteger(asset.bytes) && asset.bytes > 0).toBe(true);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(asset.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }
    expect(new Set(external.map(({ id }) => id)).size).toBe(external.length);
  });

  /** repo 的檔案，跳過安裝、建置與變異測試產生的資料夾。 */
  function repoFiles(dir: string): string[] {
    const skipped = new Set(['node_modules', '.git', 'dist', 'reports', '.stryker-tmp', 'coverage']);
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (skipped.has(entry.name)) return [];
      const path = join(dir, entry.name);
      return entry.isDirectory() ? repoFiles(path) : [path];
    });
  }

  it('keeps those files out of the repository', () => {
    const files = new Set(readExternal(readFileSync(join(ROOT, LIST), 'utf8')).map(({ file }) => file));
    expect(repoFiles('.').filter((path) => files.has(basename(path)))).toEqual([]);
  });
});
