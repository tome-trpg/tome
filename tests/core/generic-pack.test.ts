import { describe, expect, it } from 'vitest';
import type { Finding } from '../../src/core/findings.ts';
import { lintPack } from '../../src/core/pack-lint.ts';
import { testPack } from '../../src/core/pack-test.ts';
import { findPack, patternInputs, resolvePack, type ResolvedPack } from '../../src/core/pack.ts';
import { runPatterns } from '../../src/core/patterns.ts';
import { tempDir } from '../helpers.ts';

// 內建規則包 generic（ADR-0100）。文字都是這裡編的。

function location(home: string): NonNullable<ReturnType<typeof findPack>> {
  const found = findPack(home, 'generic');
  if (found === null) throw new Error('generic is missing');
  return found;
}

function generic(): ResolvedPack {
  const home = tempDir();
  const { pack } = resolvePack(home, location(home));
  if (pack === null) throw new Error('generic did not load');
  return pack;
}

function problems(findings: readonly Finding[]): string[] {
  return findings.filter(({ level }) => level !== 'info').map(({ code }) => code);
}

async function matches(pattern: string, text: string): Promise<string[]> {
  const inputs = patternInputs(generic()).filter(({ id }) => id === pattern);
  const outcome = await runPatterns(inputs, [text]);
  if (outcome.status !== 'ok') throw new Error(outcome.status);
  return (outcome.matches[pattern]?.[0] ?? []).map(([start, end]) => text.slice(start, end));
}

describe('the generic pack', () => {
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

  it('is the root, so it has no parent', () => {
    expect(generic().chain.map(({ content }) => content.manifest.id)).toEqual(['generic']);
  });

  it('declares the roles of ADR-0100, without detection', () => {
    const { roles } = generic();
    expect(roles.map(({ name }) => name).sort()).toEqual(['gm_note', 'handout', 'read_aloud', 'stat_block']);
    expect(roles.every(({ detect }) => detect === undefined)).toBe(true);
  });

  it('declares the entity classes of ADR-0100 and their pronouns', () => {
    const [loaded] = generic().chain;
    const classes = loaded?.content.classes ?? {};
    expect(Object.keys(classes).sort()).toEqual([
      'creature',
      'deity',
      'item',
      'organization',
      'person',
      'place',
      'skill',
      'spell',
    ]);
    expect(classes['deity']?.default_pronoun).toBe('祂');
    expect(classes['creature']?.default_pronoun).toBe('牠');
    expect(classes['item']?.default_pronoun).toBe('它');
  });
});

describe('the dice pattern', () => {
  it.each(['1D100', '2d6+1', '1/1D6', 'D100', 'd%', '1d4+1d6', '3d8-2', '1D6–1', '0/1D4+1'])(
    'hides all of %s',
    async (dice) => {
      expect(await matches('dice', `Roll ${dice} now.`)).toEqual([dice]);
      expect(await matches('dice', `(${dice})`)).toEqual([dice]);
      expect(await matches('dice', dice)).toEqual([dice]);
    },
  );

  it.each(['the d20s', 'd', '3D', 'D&D', 'and%', 'old6', 'A4', '3d6th', 'modd10'])('leaves %s alone', async (text) => {
    expect(await matches('dice', text)).toEqual([]);
  });

  it('finds both dice of a loss written as two rolls', async () => {
    expect(await matches('dice', 'lose 1D3/1D10 points')).toEqual(['1D3', '1D10']);
  });
});

describe('the page reference pattern', () => {
  it.each(['p.42', 'p. 42', 'pp. 42-45', 'pp.42–45', 'P.7'])('hides all of %s', async (reference) => {
    expect(await matches('page_ref', `See ${reference} for more.`)).toEqual([reference]);
  });

  it.each(['step. 42', 'map.3', 'p.', 'p 42', 'pp42'])('leaves %s alone', async (text) => {
    expect(await matches('page_ref', text)).toEqual([]);
  });
});
