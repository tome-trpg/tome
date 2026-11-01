import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  detectSyncFolder,
  findGitRoot,
  inspectPath,
  withoutTrailingSeparators,
} from '../../src/core/path-guard.ts';
import { tempDir } from '../helpers.ts';

describe('findGitRoot', () => {
  it('finds a .git directory above a path that does not exist yet', () => {
    const root = canonicalize(tempDir());
    mkdirSync(join(root, '.git'));
    expect(findGitRoot(canonicalize(join(root, 'a', 'b', 'c')))).toBe(root);
  });

  it('treats a .git file as a repo, which is what a worktree has', () => {
    const root = canonicalize(tempDir());
    writeFileSync(join(root, '.git'), 'gitdir: elsewhere\n');
    expect(findGitRoot(join(root, 'sub'))).toBe(root);
  });

  it('finds nothing outside a repo', () => {
    expect(findGitRoot(canonicalize(tempDir()))).toBeNull();
  });
});

describe('inspectPath', () => {
  it('sees through a link into a repo', () => {
    const base = tempDir();
    const repo = join(base, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const link = join(base, 'link');
    symlinkSync(repo, link, 'junction');
    expect(inspectPath(join(link, 'workspace'), {})).toEqual([
      { kind: 'git_repo', root: canonicalize(repo) },
    ]);
  });

  it('reports nothing for a plain local directory', () => {
    expect(inspectPath(tempDir(), {})).toEqual([]);
  });

  it('reports a repo and a sync folder together', () => {
    const base = canonicalize(tempDir());
    const repo = join(base, 'Dropbox', 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    expect(inspectPath(repo, {}).map((issue) => issue.kind)).toEqual(['git_repo', 'sync_folder']);
  });
});

describe('detectSyncFolder', () => {
  const linux = 'linux' as const;

  it.each([
    [`${sep}home${sep}x${sep}OneDrive${sep}tome`, 'OneDrive'],
    [`${sep}home${sep}x${sep}OneDrive - Contoso${sep}tome`, 'OneDrive'],
    [`${sep}home${sep}x${sep}Dropbox${sep}tome`, 'Dropbox'],
    [`${sep}home${sep}x${sep}Dropbox (Personal)${sep}tome`, 'Dropbox'],
    [`${sep}home${sep}x${sep}Google Drive${sep}tome`, 'Google Drive'],
    [`${sep}home${sep}x${sep}iCloudDrive${sep}tome`, 'iCloud Drive'],
    [`${sep}home${sep}x${sep}Box${sep}tome`, 'Box'],
  ])('names the provider of %s', (path, provider) => {
    expect(detectSyncFolder(path, {}, linux)).toBe(provider);
  });

  it('does not mistake an ordinary folder that only contains the word', () => {
    expect(detectSyncFolder(`${sep}home${sep}x${sep}dropbox-notes`, {}, linux)).toBeNull();
    expect(detectSyncFolder(`${sep}home${sep}x${sep}box`, {}, linux)).toBeNull();
  });

  it('finds macOS cloud storage', () => {
    const path = '/Users/x/Library/CloudStorage/GoogleDrive-a/tome';
    expect(detectSyncFolder(path, {}, 'darwin')).toBe('iCloud Drive');
  });

  it('follows the OneDrive environment variable to a renamed folder', () => {
    const folder = canonicalize(tempDir());
    const env = { OneDriveCommercial: folder };
    expect(detectSyncFolder(join(folder, 'tome'), env, linux)).toBe('OneDrive');
    expect(detectSyncFolder(`${folder}-sibling`, env, linux)).toBeNull();
  });

  it('ignores case on Windows paths only', () => {
    const folder = canonicalize(tempDir());
    const env = { OneDrive: folder.toUpperCase() };
    expect(detectSyncFolder(join(folder, 'tome'), env, 'win32')).toBe('OneDrive');
  });
});

describe('withoutTrailingSeparators', () => {
  it('removes both kinds of separator, from the end only', () => {
    expect(withoutTrailingSeparators('C:\\')).toBe('C:');
    expect(withoutTrailingSeparators('/home/x//')).toBe('/home/x');
    expect(withoutTrailingSeparators('a\\/\\')).toBe('a');
    expect(withoutTrailingSeparators('a/b')).toBe('a/b');
    expect(withoutTrailingSeparators('///')).toBe('');
    expect(withoutTrailingSeparators('')).toBe('');
  });

  it('stays linear on a long run of separators that does not reach the end', () => {
    const value = `a${'\\'.repeat(100_000)}b`;
    const started = performance.now();
    expect(withoutTrailingSeparators(value)).toBe(value);
    // 正規表示式 /[\\/]+$/ 在這裡要 20 秒左右，CodeQL 回報成 js/polynomial-redos。
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
