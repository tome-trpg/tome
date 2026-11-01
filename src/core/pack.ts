import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { TomeError } from './errors.ts';
import { finding, type Finding } from './findings.ts';
import type { MatchRange, PatternInput } from './patterns.ts';
import { validatePackFile, type PackFileKind } from './schema.ts';
import { assertSafeId } from './store.ts';

// 規則包的載入與繼承（白皮書 §5.8）。規則包是不受信任的資料，這裡只讀固定的檔名。

const ROOT_PACK = 'generic';
const PACK_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type DataFile = Exclude<PackFileKind, 'packTest'>;

export const PACK_FILES: Readonly<Record<DataFile, string>> = {
  pack: 'pack.yaml',
  roles: 'roles.yaml',
  entities: 'entities.yaml',
  glossary: 'glossary.yaml',
  syntaxPatterns: 'syntax_patterns.yaml',
};

export interface PackManifest {
  readonly schema: 'tome-pack/1';
  readonly id: string;
  readonly version: string;
  readonly extends?: string;
  readonly license: string;
  readonly source_langs: readonly string[];
}

export interface RoleDefinition {
  readonly detect?: readonly string[];
  readonly style?: string;
  readonly review?: boolean;
  readonly fields?: readonly string[];
}

export interface PatternDefinition {
  readonly id: string;
  readonly use: 'mask' | 'detect';
  readonly kind?: string;
  readonly regex: string;
  readonly flags?: string;
}

export interface GlossaryTerm {
  readonly source: Readonly<Record<string, string>>;
  readonly target: string;
  readonly class?: string;
  readonly keep_source?: boolean;
  readonly match?: unknown;
}

export interface PackContent {
  readonly manifest: PackManifest;
  readonly roles: Readonly<Record<string, RoleDefinition>>;
  readonly classes: Readonly<Record<string, { readonly default_pronoun?: string }>>;
  readonly terms: readonly GlossaryTerm[];
  readonly patterns: readonly PatternDefinition[];
}

export type PackSource = 'builtin' | 'workspace' | 'path';

export interface PackLocation {
  readonly dir: string;
  readonly source: PackSource;
}

export interface LoadedPack {
  readonly location: PackLocation;
  readonly content: PackContent;
}

export interface ResolvedRole extends RoleDefinition {
  /** 宣告這個角色的規則包，子包覆寫時是子包。 */
  readonly pack: string;
  readonly name: string;
}

/** 繼承解開後的樣子。`chain` 由子到父，子包覆寫父包（ADR-0045）。 */
export interface ResolvedPack {
  readonly id: string;
  readonly chain: readonly LoadedPack[];
  readonly roles: readonly ResolvedRole[];
  readonly patterns: readonly PatternDefinition[];
  readonly classes: ReadonlySet<string>;
}

export function isPackId(value: string): boolean {
  return PACK_ID.test(value);
}

function builtinDir(): string {
  // src 與 dist 到 repo 根目錄的深度相同。
  return fileURLToPath(new URL('../../systems/', import.meta.url));
}

function workspaceDir(home: string): string {
  return join(home, 'systems');
}

function packIn(root: string, id: string, source: PackSource): PackLocation | null {
  const dir = join(root, id);
  return existsSync(join(dir, PACK_FILES.pack)) ? { dir, source } : null;
}

/** 同 ID 時本機優先（ADR-0046）。 */
export function findPack(
  home: string,
  id: string,
  builtin: string = builtinDir(),
): PackLocation | null {
  return packIn(workspaceDir(home), id, 'workspace') ?? packIn(builtin, id, 'builtin');
}

/** 指令的參數可以是規則包 ID 或路徑：合法的 ID 就當 ID，CI 用路徑查 repo 裡的包。 */
export function locatePack(home: string, target: string): PackLocation {
  const location = isPackId(target)
    ? findPack(home, target)
    : existsSync(join(target, PACK_FILES.pack))
      ? { dir: target, source: 'path' as const }
      : null;
  if (location === null) throw new TomeError('pack.not_found', { id: target });
  return location;
}

export interface PackListing {
  readonly id: string;
  readonly version: string;
  readonly source: PackSource;
}

function idsIn(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, PACK_FILES.pack)))
    .map((entry) => entry.name);
}

export function listPacks(home: string, builtin: string = builtinDir()): PackListing[] {
  const ids = new Set([...idsIn(workspaceDir(home)), ...idsIn(builtin)]);
  return [...ids].sort().flatMap((id) => {
    const location = findPack(home, id, builtin);
    if (location === null) return [];
    const { content } = readPack(location);
    return [{ id, version: content?.manifest.version ?? '?', source: location.source }];
  });
}

function readFile<T>(dir: string, kind: DataFile, findings: Finding[]): T | null {
  const file = PACK_FILES[kind];
  const path = join(dir, file);
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = parse(readFileSync(path, 'utf8'));
  } catch {
    findings.push(finding('pack.invalid_yaml', 'fail', { file }));
    return null;
  }
  const checked = validatePackFile(kind, value);
  if (checked.ok) return checked.value as T;
  for (const issue of checked.issues) {
    findings.push(finding('pack.bad_file', 'fail', { file, issue: `${issue.path} ${issue.message}` }));
  }
  return null;
}

/** 檔案壞了不丟錯，lint 要把問題一次列完。`pack.yaml` 讀不了時 `content` 是 null。 */
export function readPack(location: PackLocation): {
  readonly content: PackContent | null;
  readonly findings: readonly Finding[];
} {
  const findings: Finding[] = [];
  const { dir } = location;
  const manifest = readFile<PackManifest>(dir, 'pack', findings);
  const roles = readFile<{ roles: PackContent['roles'] }>(dir, 'roles', findings);
  const entities = readFile<{ classes: PackContent['classes'] }>(dir, 'entities', findings);
  const glossary = readFile<{ terms: PackContent['terms'] }>(dir, 'glossary', findings);
  const patterns = readFile<{ patterns: PackContent['patterns'] }>(dir, 'syntaxPatterns', findings);
  if (manifest === null) {
    if (findings.length === 0) {
      findings.push(finding('pack.missing_file', 'fail', { file: PACK_FILES.pack }));
    }
    return { content: null, findings };
  }
  return {
    content: {
      manifest,
      roles: roles?.roles ?? {},
      classes: entities?.classes ?? {},
      terms: glossary?.terms ?? [],
      patterns: patterns?.patterns ?? [],
    },
    findings,
  };
}

function parentOf(manifest: PackManifest): string | null {
  if (manifest.extends !== undefined) return manifest.extends;
  return manifest.id === ROOT_PACK ? null : ROOT_PACK;
}

function merge(chain: readonly LoadedPack[]): ResolvedPack {
  const roles = new Map<string, ResolvedRole>();
  const patterns = new Map<string, PatternDefinition>();
  const classes = new Set<string>();
  for (const { content } of chain) {
    for (const [name, role] of Object.entries(content.roles)) {
      if (!roles.has(name)) roles.set(name, { ...role, name, pack: content.manifest.id });
    }
    for (const pattern of content.patterns) {
      if (!patterns.has(pattern.id)) patterns.set(pattern.id, pattern);
    }
    for (const name of Object.keys(content.classes)) classes.add(name);
  }
  const id = chain[0]?.content.manifest.id ?? '';
  return { id, chain, roles: [...roles.values()], patterns: [...patterns.values()], classes };
}

/** 解開繼承。`generic` 是隱含的根，內建包到 M2 才有，所以隱含的根找不到時不算錯。 */
export function resolvePack(
  home: string,
  location: PackLocation,
): { readonly pack: ResolvedPack | null; readonly findings: readonly Finding[] } {
  const findings: Finding[] = [];
  const chain: LoadedPack[] = [];
  const seen = new Set<string>();
  let next: PackLocation | null = location;
  while (next !== null) {
    const { content, findings: problems } = readPack(next);
    findings.push(...problems);
    if (content === null) return { pack: null, findings };
    const { id } = content.manifest;
    if (seen.has(id)) {
      findings.push(finding('pack.parent_cycle', 'fail', { id }));
      return { pack: null, findings };
    }
    seen.add(id);
    chain.push({ location: next, content });
    const parent = parentOf(content.manifest);
    next = parent === null ? null : findPack(home, parent);
    if (next === null && content.manifest.extends !== undefined) {
      findings.push(finding('pack.parent_missing', 'fail', { id, parent: content.manifest.extends }));
    }
  }
  return { pack: merge(chain), findings };
}

export function patternInputs(pack: ResolvedPack): PatternInput[] {
  return pack.patterns.map(({ id, regex, flags }) => ({ id, regex, flags }));
}

/**
 * 依命中結果判定規則包宣告的角色，寫成 `<規則包 ID>:<角色>`。
 * `detect` 列的模式全部命中才算，要「其一」就在正則裡寫分支。沒有 `detect` 的角色不判定。
 */
export function detectRole(
  pack: ResolvedPack,
  hits: (pattern: string) => readonly MatchRange[],
): string | null {
  for (const role of pack.roles) {
    const detect = role.detect ?? [];
    if (detect.length > 0 && detect.every((pattern) => hits(pattern).length > 0)) {
      return `${role.pack}:${role.name}`;
    }
  }
  return null;
}

/** 空白骨架。內容是給人看的，由呼叫端提供，核心不放文字。 */
export function createPack(
  home: string,
  id: string,
  files: Readonly<Record<string, string>>,
): Finding[] {
  if (!isPackId(id)) throw new TomeError('pack.bad_id', { id });
  assertSafeId(id);
  const dir = join(workspaceDir(home), id);
  if (existsSync(dir)) return [finding('pack.exists', 'fail', { id, path: dir })];
  for (const [file, text] of Object.entries(files)) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { flag: 'wx' });
  }
  return [finding('pack.created', 'info', { id, path: dir })];
}
