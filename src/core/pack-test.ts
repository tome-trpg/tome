import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parse } from 'yaml';
import { fieldUnits } from './fields.ts';
import { finding, type Finding } from './findings.ts';
import { loadTargetLanguage } from './language.ts';
import { detectRole, patternInputs, resolvePack, termsFor, type PackLocation, type ResolvedPack } from './pack.ts';
import { runPatterns, type MatchRange } from './patterns.ts';
import { validatePackFile } from './schema.ts';
import { maskSources } from './units.ts';
import { DEFAULT_TARGET_LANG } from './workspace.ts';

// tome system test（ADR-0050）。不花 token，驗證模式抓得到什麼、判定出什麼角色，數值塊怎麼欄位化（ADR-0121）。

const TEST_DIR = 'tests';
const TEST_EXTENSIONS = ['.yaml', '.yml'];

export interface PackTestCase {
  readonly id: string;
  readonly text: string;
  /** 模式 ID 對應預期抓到的字串，依出現順序。空陣列表示不該命中。 */
  readonly matches?: Readonly<Record<string, readonly string[]>>;
  /** 預期判定出的角色，不帶命名空間。null 表示不該判定出任何角色。 */
  readonly role?: string | null;
  /** 預期本機欄位化的譯文（zh-TW，用規則包自己的詞條）。null 表示該送 LLM（ADR-0121）。 */
  readonly fielded?: string | null;
}

/**
 * 有寫 `fielded` 的案例：照判到的角色遮蔽、欄位化，跟翻譯時同一條路，只用規則包的詞條（沒有書，也沒有實體卡）。
 * 案例的文字照規則包的第一個來源語言，譯文照 zh-TW 寫。
 */
async function fieldedProblems(
  pack: ResolvedPack,
  cases: readonly { readonly item: PackTestCase; readonly role: string | null }[],
): Promise<Finding[]> {
  const wanted = cases.filter(({ item }) => item.fielded !== undefined);
  if (wanted.length === 0) return [];
  const sourceLang = pack.chain[0]?.content.manifest.source_langs[0] ?? 'en';
  const terms = termsFor(pack, sourceLang);
  const sources = wanted.map(({ item, role }) => ({ unit_id: item.id, block_id: item.id, role: role ?? 'paragraph', source: item.text }));
  const { units, findings } = await maskSources(sources, pack, terms);
  if (findings.length > 0) return [...findings];
  const { profile: language } = loadTargetLanguage(DEFAULT_TARGET_LANG);
  const fielded = fieldUnits(units, { pack, sourceLang, terms, names: [], language });
  return wanted.flatMap(({ item }) =>
    (fielded.get(item.id)?.translation ?? null) === item.fielded ? [] : [finding('pack.test_fielded_failed', 'fail', { case: item.id })],
  );
}

export function readPackTests(dir: string): {
  readonly cases: readonly PackTestCase[];
  readonly findings: readonly Finding[];
} {
  const root = join(dir, TEST_DIR);
  if (!existsSync(root)) return { cases: [], findings: [] };
  const cases: PackTestCase[] = [];
  const findings: Finding[] = [];
  for (const entry of readdirSync(root).sort()) {
    if (!TEST_EXTENSIONS.includes(extname(entry).toLowerCase())) continue;
    const file = `${TEST_DIR}/${entry}`;
    let value: unknown;
    try {
      value = parse(readFileSync(join(root, entry), 'utf8'));
    } catch {
      findings.push(finding('pack.invalid_yaml', 'fail', { file }));
      continue;
    }
    const checked = validatePackFile('packTest', value);
    if (checked.ok) {
      cases.push(...(checked.value as { cases: PackTestCase[] }).cases);
      continue;
    }
    for (const issue of checked.issues) {
      findings.push(finding('pack.bad_file', 'fail', { file, issue: `${issue.path} ${issue.message}` }));
    }
  }
  return { cases, findings };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function testPack(home: string, location: PackLocation): Promise<Finding[]> {
  const { cases, findings: problems } = readPackTests(location.dir);
  const { pack, findings: inherited } = resolvePack(home, location);
  const findings: Finding[] = [...problems, ...inherited];
  if (pack === null || findings.some((item) => item.level === 'fail')) return findings;
  if (cases.length === 0) return [...findings, finding('pack.no_tests', 'warn')];

  const outcome = await runPatterns(
    patternInputs(pack),
    cases.map((item) => item.text),
  );
  if (outcome.status !== 'ok') {
    return [...findings, finding('pack.slow_regex', 'fail', { pattern: outcome.pattern })];
  }
  const roles = cases.map((item, index) => {
    const rangesOf = (pattern: string): readonly MatchRange[] =>
      outcome.matches[pattern]?.[index] ?? [];
    for (const [pattern, expected] of Object.entries(item.matches ?? {})) {
      const found = rangesOf(pattern).map(([start, end]) => item.text.slice(start, end));
      if (outcome.matches[pattern] === undefined || !sameStrings(found, expected)) {
        findings.push(finding('pack.test_failed', 'fail', { case: item.id, pattern }));
      }
    }
    const role = detectRole(pack, rangesOf);
    if (item.role !== undefined && (role?.split(':')[1] ?? null) !== item.role) {
      findings.push(finding('pack.test_role_failed', 'fail', { case: item.id }));
    }
    return { item, role };
  });
  findings.push(...(await fieldedProblems(pack, roles)));
  if (!findings.some((item) => item.level === 'fail')) {
    findings.push(finding('pack.test_passed', 'info', { count: String(cases.length) }));
  }
  return findings;
}
