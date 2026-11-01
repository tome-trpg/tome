import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadTargetLanguage, scriptViolations } from '../../src/core/language.ts';

// 受版控的文字檔不得有簡體字（ADR-0086）。字表是語言資料，跟翻譯的驗證共用同一份（ADR-0102）。

const SKIPPED = /(^|\/)(package-lock\.json|uv\.lock|LICENSE)$/;
/** 刻意收錄簡體字的路徑與理由。 */
const EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  ['tests/tools/traditional-chinese.test.ts', '測試樣本本身就是簡體字'],
  ['languages/target/zh-TW.yaml', '翻譯驗證的字表本身就是簡體字，其他欄位由下面的測試檢查'],
]);
/** U+9FFF 是這個 repo 裡正規表示式範圍的端點，不是文字。 */
const ALLOWED_HAN = new Set(['鿿']);

const { profile } = loadTargetLanguage('zh-TW');

const MAINLAND_TERMS =
  /默認|軟件|硬件|信息|文檔|網絡|服務器|視頻|鏈接|內存|用戶|字符串|屏幕|菜單|博客|正則/gu;
const USER_DOCUMENTS = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/pull_request_template.md',
  'src/cli/messages/zh-TW.json',
];

function simplifiedIn(text: string): string[] {
  return scriptViolations(profile.script_check, text).filter((character) => !ALLOWED_HAN.has(character));
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

  it('is absent from the rest of the language profile, which is excepted for its word list', () => {
    const { script_check: _list, ...rest } = profile;
    expect(simplifiedIn(JSON.stringify(rest))).toEqual([]);
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

  it('does not address the reader as you in the CLI messages', () => {
    expect(readFileSync('src/cli/messages/zh-TW.json', 'utf8')).not.toMatch(/[你您]/u);
  });
});
