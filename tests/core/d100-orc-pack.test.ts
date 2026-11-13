import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Finding } from '../../src/core/findings.ts';
import { lintPack } from '../../src/core/pack-lint.ts';
import { testPack } from '../../src/core/pack-test.ts';
import { findPack, patternInputs, resolvePack, type ResolvedPack } from '../../src/core/pack.ts';
import { runPatterns } from '../../src/core/patterns.ts';
import { tempDir } from '../helpers.ts';

// 內建規則包 d100-orc（ADR-0136）。依 Basic Roleplaying ORC Content Document 的 Creatures 一章，
// 照 ORC 授權發佈。這裡的句子都是自己編的。

const DIR = 'systems/d100-orc';

function location(home: string): NonNullable<ReturnType<typeof findPack>> {
  const found = findPack(home, 'd100-orc');
  if (found === null) throw new Error('d100-orc is missing');
  return found;
}

function d100(): ResolvedPack {
  const home = tempDir();
  const { pack } = resolvePack(home, location(home));
  if (pack === null) throw new Error('d100-orc did not load');
  return pack;
}

function problems(findings: readonly Finding[]): string[] {
  return findings.filter(({ level }) => level !== 'info').map(({ code }) => code);
}

function file(name: string): string {
  return readFileSync(join(DIR, name), 'utf8');
}

async function hits(text: string): Promise<string[]> {
  const inputs = patternInputs(d100()).filter(({ id }) => id === 'stat_line');
  const outcome = await runPatterns(inputs, [text]);
  if (outcome.status !== 'ok') throw new Error(outcome.status);
  return (outcome.matches['stat_line']?.[0] ?? []).map(([start, end]) => text.slice(start, end));
}

describe('the d100-orc pack', () => {
  it('passes the public checks with no warning', async () => {
    const home = tempDir();
    const findings = await lintPack(home, location(home), { public: true, targetLang: 'zh-TW' });
    expect(problems(findings)).toEqual([]);
  });

  it('passes its own tests', async () => {
    const home = tempDir();
    const findings = await testPack(home, location(home));
    expect(findings.map(({ code }) => code)).toEqual(['pack.test_passed']);
  });

  it('extends generic under the ORC License, and keeps the persona of generic', () => {
    const pack = d100();
    expect(pack.chain.map(({ content }) => content.manifest.id)).toEqual(['d100-orc', 'generic']);
    expect(pack.chain[0]?.content.manifest.license).toBe('ORC');
    expect(existsSync(join(DIR, 'persona_and_tone.md'))).toBe(false);
  });
});

// ORC 第 III 節的聲明與授權全文（ADR-0136）。聲明照 Chaosium 的寫法；全文是向美國著作權局註冊的定稿，
// 不是 Chaosium 網站上標著 INTERIM、號碼還空著的暫定版。
describe('the notices of d100-orc', () => {
  it('names the license, the Licensed Material, how to credit the pack, and its Reserved Material', () => {
    const notice = file('NOTICE');
    expect(notice).toContain('This product is licensed under the ORC License held in the Library of Congress at TX 9-307-067');
    expect(notice).toContain('"Basic Roleplaying: Universal Game Engine," copyright © 2024 Chaosium Inc., by Jason Durall and Steve Perrin.');
    expect(notice).toContain('Please credit them as "TOME contributors".');
    expect(notice).toContain('This pack contains no Reserved Material of the TOME contributors.');
    expect(notice).toContain('This is not an official Chaosium product.');
  });

  it('carries the registered text of the license in full', () => {
    const license = file('LICENSE');
    expect(license.startsWith('ORC LICENSE FINAL\n')).toBe(true);
    expect(license).toContain('Congress at TX 9-307-067');
    expect(license).not.toMatch(/INTERIM|TBD/u);
    expect(license).toContain('Licensor or You, including from the legal processes of any jurisdiction or authority.\n');
  });
});

describe('the terms of d100-orc', () => {
  interface Term {
    readonly source: { readonly en: string };
    readonly target: string;
    readonly keep_source?: boolean;
    readonly match?: { readonly roles?: readonly string[]; readonly case_sensitive?: boolean };
  }

  function terms(): Term[] {
    return d100().terms as unknown as Term[];
  }

  const sources = (): string[] => terms().map(({ source }) => source.en);

  it('holds the 299 terms the maintainer reviewed, each once', () => {
    expect(sources()).toHaveLength(299);
    expect(new Set(sources()).size).toBe(299);
  });

  it('keeps the abbreviations in English', () => {
    const kept = terms().filter(({ keep_source }) => keep_source === true);
    expect(kept.map(({ source }) => source.en).sort()).toEqual(
      ['CHA', 'CON', 'DEX', 'DM', 'HP', 'INT', 'MOV', 'POW', 'SAN', 'SIZ', 'STR', 'dm'].sort(),
    );
    expect(kept.every(({ source, target }) => source.en === target)).toBe(true);
  });

  // 角色帶規則包的 ID（`d100-orc:stat_block`）。寫成 `stat_block` 就一處都比對不到。
  it('restricts terms only to roles the pack has', () => {
    const declared = new Set(d100().roles.map(({ pack, name }) => `${pack}:${name}`));
    const roles = terms().flatMap(({ match }) => match?.roles ?? []);
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.filter((role) => !declared.has(role))).toEqual([]);
  });

  it('matches the words that also mean something else only in stat blocks', () => {
    const only = (en: string): readonly string[] | undefined => terms().find(({ source }) => source.en === en)?.match?.roles;
    for (const word of ['Sense', 'Tail', 'Shield', 'Hammer', 'Drowning', 'Move', 'fire', 'special']) {
      expect(only(word)).toEqual(['d100-orc:stat_block']);
    }
  });

  it('guards Spot and Science with longer terms, and leaves out the names that are also adjectives', () => {
    const target = (en: string): string | undefined => terms().find(({ source }) => source.en === en)?.target;
    expect(target('Spot Rules')).toBe('情境規則');
    expect(target('Science Fiction')).toBe('科幻');
    expect(sources()).not.toContain('Giant');
    expect(sources()).not.toContain('Sorcerer');
    expect(sources()).not.toContain('Psychic');
  });

  // opposed roll 留給之後的章，譯成「對抗檢定」；resistance roll 不能跟它撞名。
  it('calls a resistance roll 抗衡檢定, and has no opposed roll yet', () => {
    expect(terms().find(({ source }) => source.en === 'resistance roll')?.target).toBe('抗衡檢定');
    expect(sources().filter((source) => /opposed/iu.test(source))).toEqual([]);
  });
});

describe('the stat blocks of d100-orc', () => {
  function statBlock(): ResolvedPack['roles'][number] {
    const role = d100().roles.find(({ pack, name }) => pack === 'd100-orc' && name === 'stat_block');
    if (role === undefined) throw new Error('stat_block is missing');
    return role;
  }

  // 同名的角色由子包整個取代，所以 style 照抄 generic 那一句，維護者確認過（ADR-0136）。
  it('keeps the style of generic word for word', () => {
    expect(statBlock().style).toBe('保留所有數字與欄位順序，只翻譯標籤。');
    expect(statBlock().detect).toEqual(['stat_line']);
  });

  it('has a translation for every field', () => {
    const translated = new Set(d100().terms.filter(({ keep_source }) => keep_source !== true).map(({ source }) => source['en']));
    const fields = (statBlock().fields ?? []).map((label) => label['en']);
    expect(fields).toHaveLength(186);
    expect(fields.filter((field) => !translated.has(field))).toEqual([]);
  });

  it.each([
    ['the characteristic header', 'STR CON SIZ INT POW DEX CHA', ['STR CON SIZ INT POW DEX CHA']],
    ['a field', 'Damage Modifier: +1D4 Armor None', ['Damage Modifier:']],
    ['an attack', '• Claw 50%, 1D6+dm (bleeding)', ['Claw 50%, 1']],
    ['an attack with no damage roll', '• Grapple 25%, special', ['Grapple 25%, special']],
  ])('finds %s', async (_name, text, expected) => {
    expect(await hits(text)).toEqual(expected);
  });

  it.each([
    ['powers, which are prose', 'Powers: It can see in the dark.'],
    ['a sentence', 'The heron waits in the reeds until the tide turns.'],
    ['a power that raises a skill', 'Super Skill 15 (Brawl +40%, Fly +60%).'],
    ['two characteristics in a sentence', 'Use STR and SIZ to lift the gate.'],
  ])('does not find %s', async (_name, text) => {
    expect(await hits(text)).toEqual([]);
  });
});
