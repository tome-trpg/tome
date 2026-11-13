import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// 驗證下載到本機的公開素材（ADR-0061 第 2 項、ADR-0136）：檔案的位元組數與 SHA-256 要跟
// `tests/fixtures/SOURCES.yaml` 的 `external` 一筆一筆對上。只讀本機的檔案，不連網；下載用瀏覽器或指令手動做。
// 結束碼跟 spec 工具一致：0 都對上、1 有不對或找不到、2 用法錯了。

export const SOURCES = 'tests/fixtures/SOURCES.yaml';

export interface ExternalAsset {
  readonly id: string;
  readonly url: string;
  readonly file: string;
  readonly license: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly retrieved: string;
}

export type Check =
  | { readonly id: string; readonly status: 'ok' }
  | { readonly id: string; readonly status: 'missing' }
  | { readonly id: string; readonly status: 'changed'; readonly bytes: number; readonly sha256: string };

export function readExternal(text: string): readonly ExternalAsset[] {
  return (parse(text) as { external?: ExternalAsset[] }).external ?? [];
}

/** 一筆登記對一個檔案。位元組數先比，對上了才算雜湊。 */
export function checkFile(asset: ExternalAsset, path: string): Check {
  if (!existsSync(path)) return { id: asset.id, status: 'missing' };
  const bytes = statSync(path).size;
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  return bytes === asset.bytes && sha256 === asset.sha256 ? { id: asset.id, status: 'ok' } : { id: asset.id, status: 'changed', bytes, sha256 };
}

/** 資料夾裡照登記的檔名找；給了 `ids` 就只查那幾筆，沒登記的 ID 算找不到。 */
export function checkFolder(assets: readonly ExternalAsset[], dir: string, ids: readonly string[] = []): Check[] {
  const wanted = ids.length === 0 ? assets : ids.map((id) => assets.find((asset) => asset.id === id) ?? { id, file: '' });
  return wanted.map((asset) =>
    'url' in asset ? checkFile(asset, join(dir, basename(asset.file))) : { id: asset.id, status: 'missing' as const },
  );
}

function main(args: readonly string[]): number {
  const [dir, ...ids] = args;
  if (dir === undefined) {
    process.stderr.write('usage: node tools/verify-public.ts <folder> [id ...]\n');
    return 2;
  }
  const checks = checkFolder(readExternal(readFileSync(SOURCES, 'utf8')), dir, ids);
  for (const check of checks) {
    const detail = check.status === 'changed' ? ` ${check.bytes} bytes, sha256 ${check.sha256}` : '';
    process.stdout.write(`${check.id}: ${check.status}${detail}\n`);
  }
  return checks.every(({ status }) => status === 'ok') ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
