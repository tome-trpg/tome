import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

export type PathIssue =
  | { readonly kind: 'git_repo'; readonly root: string }
  | { readonly kind: 'sync_folder'; readonly provider: string };

// 路徑片段的名稱，跨平台比對。Windows 的 OneDrive 另外看環境變數。
const SYNC_SEGMENTS: readonly (readonly [RegExp, string])[] = [
  [/^onedrive( - .+)?$/i, 'OneDrive'],
  [/^dropbox( \(.+\))?$/i, 'Dropbox'],
  [/^google ?drive$/i, 'Google Drive'],
  [/^icloud ?drive$/i, 'iCloud Drive'],
  [/^pcloud ?drive$/i, 'pCloud Drive'],
  [/^Box( Sync)?$/, 'Box'],
];

const ONEDRIVE_ENV = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'] as const;

/** 路徑可能還不存在。往上找到存在的祖先再解開連結，junction 與 symlink 才躲不過檢查。 */
export function canonicalize(target: string): string {
  const missing: string[] = [];
  let current = resolve(target);
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/** 回傳包含這個路徑的 git repo 根目錄。`.git` 在 worktree 裡是檔案，兩種都算。 */
export function findGitRoot(canonicalPath: string): string | null {
  let current = canonicalPath;
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** 不用正規表示式：一長串不在結尾的斜線，會讓 `[\\/]+$` 的耗時接近平方成長。 */
export function withoutTrailingSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === '/' || value[end - 1] === '\\')) end -= 1;
  return value.slice(0, end);
}

function isSameOrInside(path: string, folder: string, platform: NodeJS.Platform): boolean {
  const fold = (value: string) => (platform === 'win32' ? value.toLowerCase() : value);
  const a = fold(path);
  const b = withoutTrailingSeparators(fold(folder));
  return a === b || a.startsWith(b + sep);
}

export function detectSyncFolder(
  canonicalPath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  for (const name of ONEDRIVE_ENV) {
    const folder = env[name];
    if (folder && isSameOrInside(canonicalPath, canonicalize(folder), platform)) return 'OneDrive';
  }
  const segments = canonicalPath.split(/[\\/]+/);
  for (const [pattern, provider] of SYNC_SEGMENTS) {
    if (segments.some((segment) => pattern.test(segment))) return provider;
  }
  // macOS 把雲端硬碟掛在這兩個目錄底下。
  if (/[\\/]Library[\\/](Mobile Documents|CloudStorage)([\\/]|$)/.test(canonicalPath)) {
    return 'iCloud Drive';
  }
  return null;
}

/** ADR-0053：工作區與 vault 共用的路徑檢查。 */
export function inspectPath(
  target: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): readonly PathIssue[] {
  const canonical = canonicalize(target);
  const issues: PathIssue[] = [];
  const root = findGitRoot(canonical);
  if (root !== null) issues.push({ kind: 'git_repo', root });
  const provider = detectSyncFolder(canonical, env, platform);
  if (provider !== null) issues.push({ kind: 'sync_folder', provider });
  return issues;
}
