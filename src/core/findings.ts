import type { Params } from './errors.ts';

export const FINDING_CODES = [
  'engines.pending',
  'key.missing',
  'key.ok',
  'key.stored',
  'keyring.unavailable',
  'node.ok',
  'node.too_old',
  'prices.pending',
  'sqlite.ok',
  'sqlite.unavailable',
  'uv.missing',
  'uv.ok',
  'vault.in_git_repo',
  'vault.sync_folder',
  'workspace.already_exists',
  'workspace.created',
  'workspace.in_git_repo',
  'workspace.missing',
  'workspace.ok',
  'workspace.secret_in_config',
  'workspace.sync_folder',
  'workspace.vault_ignored',
] as const;

export type FindingCode = (typeof FINDING_CODES)[number];

/** fail 讓結束碼變 1；warn 與 info 不影響結束碼。 */
export type FindingLevel = 'fail' | 'warn' | 'info';

export interface Finding {
  readonly code: FindingCode;
  readonly level: FindingLevel;
  readonly params: Params;
}

export function finding(code: FindingCode, level: FindingLevel, params: Params = {}): Finding {
  return { code, level, params };
}

/** 0 正常、1 有發現。2 由 TomeError 表示（ADR-0059）。 */
export function exitCodeOf(findings: readonly Finding[]): 0 | 1 {
  return findings.some((item) => item.level === 'fail') ? 1 : 0;
}
