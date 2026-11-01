import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { finding, type Finding } from './findings.ts';
import { loadTargetLanguage } from './language.ts';
import notices from './pack-notices.json' with { type: 'json' };
import { readPackTests } from './pack-test.ts';
import {
  readPack,
  resolvePack,
  type PackContent,
  type PackLocation,
  type ResolvedPack,
} from './pack.ts';
import { runPatterns, type PatternInput } from './patterns.ts';

// tome system lint（ADR-0050、ADR-0084）。問題一次列完，訊息只帶檔名與 ID，不帶規則包的內容。

const TARGET_LANGUAGE = 'zh-TW';
const DATA_EXTENSIONS = new Set(['.yaml', '.yml', '.md']);
const NOTICE_FILES = new Set(['LICENSE', 'NOTICE']);
// 一樣算 CPU 時間，但比實際執行嚴一倍：規則包作者的機器可能比使用者快，
// 同一個限時的話，剛好過關的模式到了較慢的機器就會被終止。
const ATTACK_TIMEOUT_MS = 500;
const ATTACK_LENGTHS = [32, 5000];
const ATTACK_ALPHABET = ['a', 'A', '0', ' ', '-', '.'];

export type RegexRisk = 'nested_quantifier' | 'overlapping_alternation' | 'adjacent_wildcards';

interface Group {
  unbounded: boolean;
  branches: string[];
  current: string;
}

function isUnbounded(source: string, index: number): boolean {
  const char = source[index];
  if (char === '*' || char === '+') return true;
  return char === '{' && /^\{\d*,\}/.test(source.slice(index));
}

function overlaps(branches: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const branch of branches) {
    const first = branch[0];
    if (first === undefined) continue;
    if (seen.has(first)) return true;
    seen.add(first);
  }
  return false;
}

/** `[...]` 結束的位置。 */
function classEnd(source: string, start: number): number {
  let index = start + 1;
  if (source[index] === '^') index += 1;
  if (source[index] === ']') index += 1;
  while (index < source.length && source[index] !== ']') {
    index += source[index] === '\\' ? 2 : 1;
  }
  return index;
}

/** `(?:`、`(?=`、`(?<name>` 這類開頭的長度，一般的 `(` 是 1。 */
function groupOpenLength(source: string, index: number): number {
  return /^\(\?(?:[:=!]|<[=!]|<[^>]*>)/.exec(source.slice(index))?.[0].length ?? 1;
}

/**
 * 手寫的啟發式，不是完整的分析（ADR-0084）。會漏，也可能誤報，所以只是警告；
 * 真正的防護是 worker 限時（ADR-0049）。
 */
export function regexRisks(source: string): RegexRisk[] {
  const risks = new Set<RegexRisk>();
  const stack: Group[] = [{ unbounded: false, branches: [], current: '' }];
  let wildcardBefore = false;
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    const group = stack[stack.length - 1] as Group;
    if (char === '\\') {
      group.current += source.slice(index, index + 2);
      index += 2;
    } else if (char === '[') {
      const end = classEnd(source, index);
      group.current += source.slice(index, end + 1);
      index = end + 1;
    } else if (char === '(') {
      stack.push({ unbounded: false, branches: [], current: '' });
      index += groupOpenLength(source, index);
    } else if (char === '|') {
      group.branches.push(group.current);
      group.current = '';
      wildcardBefore = false;
      index += 1;
    } else if (char === ')' && stack.length > 1) {
      stack.pop();
      const parent = stack[stack.length - 1] as Group;
      group.branches.push(group.current);
      if (isUnbounded(source, index + 1)) {
        if (group.unbounded) risks.add('nested_quantifier');
        if (overlaps(group.branches)) risks.add('overlapping_alternation');
        parent.unbounded = true;
      }
      parent.unbounded ||= group.unbounded;
      parent.current += '(';
      wildcardBefore = false;
      index += 1;
    } else if (isUnbounded(source, index)) {
      group.unbounded = true;
      if (source[index - 1] === '.') {
        if (wildcardBefore) risks.add('adjacent_wildcards');
        wildcardBefore = true;
      }
      index += 1;
    } else {
      group.current += char;
      index += 1;
    }
  }
  return [...risks];
}

function attackTexts(source: string): string[] {
  const literals = source.replace(/\\./g, '').match(/[\p{L}\p{N}]/gu) ?? [];
  const alphabet = new Set([...literals, ...ATTACK_ALPHABET]);
  return [...alphabet].flatMap((char) =>
    ATTACK_LENGTHS.map((length) => `${char.repeat(length)}\u0000`),
  );
}

/** 用對抗輸入一個一個實跑，把會卡住的模式全部找出來。 */
async function slowPatterns(patterns: readonly PatternInput[]): Promise<string[]> {
  const slow: string[] = [];
  for (const pattern of patterns) {
    const outcome = await runPatterns([pattern], attackTexts(pattern.regex), ATTACK_TIMEOUT_MS);
    if (outcome.status !== 'ok') slow.push(pattern.id);
  }
  return slow;
}

function compiles({ regex, flags }: PatternInput): boolean {
  try {
    new RegExp(regex, `gu${flags ?? ''}`);
    return true;
  } catch {
    return false;
  }
}

async function lintPatterns(content: PackContent): Promise<Finding[]> {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const runnable: PatternInput[] = [];
  for (const { id, regex, flags } of content.patterns) {
    if (seen.has(id)) findings.push(finding('pack.duplicate_pattern', 'fail', { pattern: id }));
    seen.add(id);
    if (!compiles({ id, regex, flags })) {
      findings.push(finding('pack.bad_regex', 'fail', { pattern: id }));
      continue;
    }
    for (const risk of regexRisks(regex)) {
      findings.push(finding('pack.risky_regex', 'warn', { pattern: id, risk }));
    }
    runnable.push({ id, regex, flags });
  }
  for (const pattern of await slowPatterns(runnable)) {
    findings.push(finding('pack.slow_regex', 'fail', { pattern }));
  }
  return findings;
}

function lintReferences(content: PackContent, resolved: ResolvedPack): Finding[] {
  const findings: Finding[] = [];
  const detectors = new Set(
    resolved.patterns.filter((item) => item.use === 'detect').map((item) => item.id),
  );
  for (const [role, definition] of Object.entries(content.roles)) {
    for (const pattern of definition.detect ?? []) {
      if (!detectors.has(pattern)) {
        findings.push(finding('pack.unknown_pattern', 'fail', { role, pattern }));
      }
    }
  }
  content.terms.forEach((term, index) => {
    if (term.class !== undefined && !resolved.classes.has(term.class)) {
      findings.push(finding('pack.unknown_class', 'fail', { index: String(index), class: term.class }));
    }
  });
  const { pronouns } = loadTargetLanguage(TARGET_LANGUAGE).profile;
  for (const [name, entity] of Object.entries(content.classes)) {
    const pronoun = entity.default_pronoun;
    if (pronoun !== undefined && !pronouns.includes(pronoun)) {
      findings.push(finding('pack.unknown_pronoun', 'fail', { class: name }));
    }
  }
  return findings;
}

/** 規則包只能是資料（ADR-0044）。連結也擋下，它可能指到規則包外面。 */
function lintFiles(dir: string): Finding[] {
  const findings: Finding[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const file = relative(dir, path).replaceAll('\\', '/');
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) findings.push(finding('pack.not_data', 'fail', { file }));
      else if (stat.isDirectory()) walk(path);
      else if (!DATA_EXTENSIONS.has(extname(entry).toLowerCase()) && !NOTICE_FILES.has(entry)) {
        findings.push(finding('pack.not_data', 'fail', { file }));
      }
    }
  };
  walk(dir);
  return findings;
}

function lintNotice(dir: string, file: string, phrases: readonly string[]): Finding[] {
  const path = join(dir, file);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (text.trim() === '') return [finding('pack.missing_file', 'fail', { file })];
  return phrases
    .filter((phrase) => !text.includes(phrase))
    .map((phrase) => finding('pack.missing_notice', 'fail', { file, phrase }));
}

function lintPublic(dir: string, content: PackContent): Finding[] {
  const { license } = content.manifest;
  const required = (notices as Record<string, { LICENSE: string[]; NOTICE: string[] }>)[license];
  const findings =
    required === undefined
      ? [finding('pack.unknown_license', 'fail', { license })]
      : [];
  findings.push(
    ...lintNotice(dir, 'LICENSE', required?.LICENSE ?? []),
    ...lintNotice(dir, 'NOTICE', required?.NOTICE ?? []),
  );
  if (readPackTests(dir).cases.length === 0) findings.push(finding('pack.no_tests', 'fail'));
  return findings;
}

export interface LintOptions {
  readonly public: boolean;
}

export async function lintPack(
  home: string,
  location: PackLocation,
  options: LintOptions,
): Promise<Finding[]> {
  const { dir } = location;
  const findings = lintFiles(dir);
  const { content, findings: problems } = readPack(location);
  if (content === null) return [...findings, ...problems];
  const { id } = content.manifest;
  if (basename(dir) !== id) {
    findings.push(finding('pack.id_mismatch', 'fail', { id, dir: basename(dir) }));
  }
  const { pack, findings: inherited } = resolvePack(home, location);
  findings.push(...inherited);
  findings.push(...(await lintPatterns(content)));
  if (pack !== null) findings.push(...lintReferences(content, pack));
  findings.push(...readPackTests(dir).findings);
  if (options.public) findings.push(...lintPublic(dir, content));
  if (!findings.some((item) => item.level === 'fail')) {
    findings.push(finding('pack.lint_ok', 'info', { id }));
  }
  return findings;
}
