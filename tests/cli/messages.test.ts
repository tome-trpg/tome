import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { errorText, findingText } from '../../src/cli/messages.ts';
import catalog from '../../src/cli/messages/zh-TW.json' with { type: 'json' };
import { ERROR_CODES } from '../../src/core/errors.ts';
import { FINDING_CODES } from '../../src/core/findings.ts';
import notices from '../../src/core/pack-notices.json' with { type: 'json' };

const HAN = /[一-鿿]/;

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '');
}

describe('the message catalog', () => {
  it('has one message for each finding code, and none left over', () => {
    expect(Object.keys(catalog.finding).sort()).toEqual([...FINDING_CODES].sort());
  });

  it('has one message for each error code, and none left over', () => {
    expect(Object.keys(catalog.error).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('is written in Chinese', () => {
    for (const text of [...Object.values(catalog.finding), ...Object.values(catalog.error)]) {
      expect(text).toMatch(HAN);
    }
  });

  // 終端機裡全形字佔兩格，`--help` 的指令與選項兩段，各自把說明對齊在同一欄。
  it('lines up the descriptions of --help, counting a wide character as two columns', () => {
    // 東亞的寬字元（漢字、全形、韓文）的碼位範圍，寫成數字，受版控的檔才不用放這些字。
    const WIDE: readonly (readonly [number, number])[] = [
      [0x2e80, 0xa4cf],
      [0xac00, 0xd7a3],
      [0xf900, 0xfaff],
      [0xfe30, 0xfe4f],
      [0xff00, 0xff60],
      [0xffe0, 0xffe6],
    ];
    const wide = (char: string): boolean => {
      const code = char.codePointAt(0) ?? 0;
      return WIDE.some(([low, high]) => code >= low && code <= high);
    };
    const width = (text: string): number => [...text].reduce((sum, char) => sum + (wide(char) ? 2 : 1), 0);
    const columns = (section: string): number[] =>
      section.split('\n').flatMap((line) => {
        const found = /^( {2}\S.*?\S {2,})\S/u.exec(line);
        return found === null ? [] : [width(found[1] ?? '')];
      });
    const [, commands = '', options = ''] = catalog.usage.split('\n\n');
    expect(new Set(columns(commands))).toEqual(new Set([31]));
    expect(new Set(columns(options))).toEqual(new Set([13]));
  });

  // 這兩份清單寫在訊息裡，使用者才知道能填什麼。資料一改，訊息要跟著改。
  it('names every license a public pack may use', () => {
    for (const license of Object.keys(notices)) {
      expect(catalog.finding['pack.unknown_license']).toContain(license);
      expect(catalog.template.pack['pack.yaml']).toContain(license);
    }
  });

  it('names every pronoun of the target language', () => {
    const { pronouns } = parse(readFileSync('languages/target/zh-TW.yaml', 'utf8')) as {
      pronouns: string[];
    };
    for (const pronoun of pronouns) {
      expect(catalog.finding['pack.unknown_pronoun']).toContain(pronoun);
      expect(catalog.template.pack['entities.yaml']).toContain(pronoun);
    }
  });
});

describe('filling a message', () => {
  it('replaces each placeholder', () => {
    expect(findingText('node.too_old', { version: '22.0.0', minimum: '24' })).toBe(
      'Node 22.0.0 版本過舊，TOME 需要 24 以上。',
    );
  });

  it('leaves no placeholder when each is given', () => {
    for (const code of FINDING_CODES) {
      const params = Object.fromEntries(placeholders(catalog.finding[code]).map((n) => [n, 'x']));
      expect(placeholders(findingText(code, params))).toEqual([]);
    }
    for (const code of ERROR_CODES) {
      const params = Object.fromEntries(placeholders(catalog.error[code]).map((n) => [n, 'x']));
      expect(placeholders(errorText(code, params))).toEqual([]);
    }
  });
});
