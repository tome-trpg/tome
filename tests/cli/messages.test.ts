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
