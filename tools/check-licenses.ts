import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 相依授權檢查（ADR-0016、ADR-0043、ADR-0068）。結束碼跟 spec 工具一致：0 乾淨、1 有發現、2 結果不可信。
// 只讀 package-lock.json，不用額外的工具。全部相依都查，開發相依也一樣。

const ALLOWED = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0']);

// 開發相依不進 npm 包，也不進主程式行程，所以多收這些。主程式的白名單不變（ADR-0084）。
const DEV_ONLY_ALLOWED = new Set(['0BSD']);

// 沒有 license 欄位、人工讀過 LICENSE 檔的開發相依。綁版本，升級時要重讀（ADR-0084）。
const DEV_LICENSE_EXCEPTIONS: Readonly<Record<string, string>> = {
  'png-js@2.0.0': 'MIT',
};

// lockfile 看不到原生二進位檔裡連結了什麼，所以主程式的原生套件要逐一審過才列在這裡（ADR-0083）。
const REVIEWED_NATIVE = [/^@napi-rs\/keyring-/];

export interface LockEntry {
  readonly license?: string;
  readonly version?: string;
  readonly dev?: boolean;
  readonly link?: boolean;
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
}

export interface Violation {
  readonly name: string;
  readonly version: string;
  readonly reason: 'license' | 'native';
  readonly license: string;
}

/** 解 SPDX 運算式：OR 取其一，AND 全部都要。看不懂的算不通過。 */
export function isAllowedLicense(
  expression: string | undefined,
  allowed: ReadonlySet<string> = ALLOWED,
): boolean {
  if (expression === undefined) return false;
  const tokens = expression.match(/[()]|[^\s()]+/g) ?? [];
  let index = 0;

  function parseOr(): boolean {
    let value = parseAnd();
    while (tokens[index] === 'OR') {
      index += 1;
      const right = parseAnd();
      value = value || right;
    }
    return value;
  }

  function parseAnd(): boolean {
    let value = parseAtom();
    while (tokens[index] === 'AND') {
      index += 1;
      const right = parseAtom();
      value = value && right;
    }
    return value;
  }

  function parseAtom(): boolean {
    const token = tokens[index];
    index += 1;
    if (token === '(') {
      const value = parseOr();
      if (tokens[index] !== ')') throw new SyntaxError(`bad SPDX expression: ${expression}`);
      index += 1;
      return value;
    }
    return token !== undefined && allowed.has(token);
  }

  try {
    const value = parseOr();
    return index === tokens.length && tokens.length > 0 && value;
  } catch {
    return false;
  }
}

function packageName(path: string): string {
  return path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

function licensePasses(name: string, entry: LockEntry): boolean {
  if (entry.dev !== true) return isAllowedLicense(entry.license);
  const license = entry.license ?? DEV_LICENSE_EXCEPTIONS[`${name}@${entry.version ?? ''}`];
  return isAllowedLicense(license, new Set([...ALLOWED, ...DEV_ONLY_ALLOWED]));
}

export function findViolations(packages: Readonly<Record<string, LockEntry>>): Violation[] {
  const violations: Violation[] = [];
  for (const [path, entry] of Object.entries(packages)) {
    if (path === '' || entry.link === true) continue;
    const name = packageName(path);
    const version = entry.version ?? '?';
    const license = entry.license ?? '(none)';
    if (!licensePasses(name, entry)) {
      violations.push({ name, version, license, reason: 'license' });
    }
    const native = entry.os !== undefined || entry.cpu !== undefined;
    if (native && entry.dev !== true && !REVIEWED_NATIVE.some((pattern) => pattern.test(name))) {
      violations.push({ name, version, license, reason: 'native' });
    }
  }
  return violations;
}

function main(): number {
  let lock: { packages?: Record<string, LockEntry> };
  try {
    lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  } catch (error) {
    process.stderr.write(`cannot read package-lock.json: ${String(error)}\n`);
    return 2;
  }
  if (lock.packages === undefined) {
    process.stderr.write('package-lock.json has no "packages" table\n');
    return 2;
  }
  const violations = findViolations(lock.packages);
  for (const item of violations) {
    const why = item.reason === 'native' ? 'unreviewed native package' : 'license not allowed';
    process.stdout.write(`${item.name}@${item.version}: ${item.license} (${why})\n`);
  }
  const count = Object.keys(lock.packages).length - 1;
  process.stdout.write(`${count} packages checked, ${violations.length} violations\n`);
  return violations.length > 0 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
