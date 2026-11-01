import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 受版控的文字檔不得有簡體字（ADR-0086）。標準 Big5 收的是繁體用字，大多數簡體字形不在裡面，
// 所以不用自己維護完整字表。少數簡體字形 Big5 也有，另外列在 SIMPLIFIED_IN_BIG5。

const SKIPPED = /(^|\/)(package-lock\.json|uv\.lock|LICENSE)$/;
/** 刻意收錄簡體字的路徑與理由。 */
const EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  ['tests/tools/traditional-chinese.test.ts', '字表與測試樣本本身就是簡體字'],
]);
/** U+9FFF 是正規表示式範圍的端點，不是文字。 */
const ALLOWED_HAN = new Set(['鿿']);

/**
 * Big5 也收錄的簡體字形。台、准、划、岩、症 這類在繁體也常用的字不列。
 * 字表取自 Windows 的繁簡對照，再加上對照表不轉換的 后、于、并、云、叶。
 */
const SIMPLIFIED_IN_BIG5 =
  /[儿几扑虫听坏厂万与气宁优价异忏机网体吨怀扰岭怜构极泞肮虮复洁种胜苹党茧蚕赶适惊据痒离确腊触蜡篱后于并云叶]/gu;
/** 這些詞在繁體也這樣寫。 */
const TRADITIONAL_WORDS = /皇后|王后|太后|茶几|云云/gu;
/** 准 本身是繁體用字，這些詞才是誤用。 */
const MISUSED_WORDS = /標准|水准|基准|准備|准確/gu;

const MAINLAND_TERMS =
  /默認|軟件|硬件|信息|文檔|網絡|服務器|視頻|鏈接|內存|用戶|字符串|屏幕|菜單|博客|正則/gu;
const USER_DOCUMENTS = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/pull_request_template.md',
];

function standardBig5(): Set<string> {
  const decoder = new TextDecoder('big5');
  const trails = [...Array(0xff).keys()].filter(
    (byte) => (byte >= 0x40 && byte <= 0x7e) || (byte >= 0xa1 && byte <= 0xfe),
  );
  const characters = new Set<string>();
  for (let lead = 0xa4; lead <= 0xf9; lead += 1) {
    // 0xC7、0xC8 是保留區，不是標準 Big5。
    if (lead === 0xc7 || lead === 0xc8) continue;
    for (const trail of trails) {
      const character = decoder.decode(new Uint8Array([lead, trail]));
      if (/^\p{Script=Han}$/u.test(character)) characters.add(character);
    }
  }
  return characters;
}

const BIG5 = standardBig5();

function simplifiedIn(text: string): string[] {
  const outside = [...text.matchAll(/\p{Script=Han}/gu)]
    .map(([character]) => character)
    .filter((character) => !BIG5.has(character) && !ALLOWED_HAN.has(character));
  const shared = text.replace(TRADITIONAL_WORDS, '').match(SIMPLIFIED_IN_BIG5) ?? [];
  const misused = text.match(MISUSED_WORDS) ?? [];
  return [...new Set([...outside, ...shared, ...misused])];
}

function trackedTextFiles(): string[] {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter((path) => path !== '' && !SKIPPED.test(path) && !EXCEPTIONS.has(path) && existsSync(path));
}

describe('simplified Chinese', () => {
  it('catches forms outside Big5, forms inside it and misused words', () => {
    expect(simplifiedIn('这是简体')).toEqual(['这', '简', '体']);
    expect(simplifiedIn('然后')).toEqual(['后']);
    expect(simplifiedIn('標准')).toEqual(['標准']);
  });

  it('leaves Traditional Chinese alone', () => {
    expect(simplifiedIn('臺灣的皇后、核准與不划算，祂都看過')).toEqual([]);
  });

  it('is absent from every tracked text file', () => {
    const found = trackedTextFiles().flatMap((path) => {
      const characters = simplifiedIn(readFileSync(path, 'utf8'));
      return characters.length === 0 ? [] : [`${path}: ${characters.join(' ')}`];
    });
    expect(found).toEqual([]);
  });
});

describe('the words in user documents', () => {
  it('has no mainland Chinese terms', () => {
    const found = USER_DOCUMENTS.flatMap((path) => {
      const terms = readFileSync(path, 'utf8').match(MAINLAND_TERMS) ?? [];
      return terms.length === 0 ? [] : [`${path}: ${[...new Set(terms)].join(' ')}`];
    });
    expect(found).toEqual([]);
  });
});
