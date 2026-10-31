import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packTemplate } from '../../src/cli/messages.ts';
import { TomeError } from '../../src/core/errors.ts';
import type { Finding } from '../../src/core/findings.ts';
import { lintPack, regexRisks } from '../../src/core/pack-lint.ts';
import { testPack } from '../../src/core/pack-test.ts';
import {
  createPack,
  detectRole,
  findPack,
  listPacks,
  locatePack,
  resolvePack,
  type PackLocation,
} from '../../src/core/pack.ts';
import { tempDir } from '../helpers.ts';

const SAMPLE = 'tests/fixtures/packs/sample-pack';

function codes(findings: readonly Finding[]): string[] {
  return findings.map((item) => item.code);
}

function failures(findings: readonly Finding[]): string[] {
  return findings.filter((item) => item.level === 'fail').map((item) => item.code);
}

/** 在工作區放一個規則包，檔案內容由測試指定。 */
function writePack(home: string, id: string, files: Readonly<Record<string, string>>): PackLocation {
  const dir = join(home, 'systems', id);
  for (const [file, text] of Object.entries(files)) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return { dir, source: 'workspace' };
}

function manifest(id: string, extra = ''): string {
  return `schema: tome-pack/1\nid: ${id}\nversion: 0.1.0\nlicense: UNLICENSED\nsource_langs: [en]\n${extra}`;
}

/** 複製合成規則包，測試要改它時用。 */
function sampleCopy(): { home: string; location: PackLocation } {
  const home = tempDir();
  const dir = join(home, 'systems', 'sample-pack');
  cpSync(SAMPLE, dir, { recursive: true });
  return { home, location: { dir, source: 'workspace' } };
}

describe('finding a pack', () => {
  it('prefers the workspace over a built-in pack of the same id', () => {
    const home = tempDir();
    const builtin = join(tempDir(), 'systems');
    mkdirSync(join(builtin, 'shared'), { recursive: true });
    mkdirSync(join(builtin, 'only-builtin'), { recursive: true });
    writeFileSync(join(builtin, 'shared', 'pack.yaml'), manifest('shared'));
    writeFileSync(join(builtin, 'only-builtin', 'pack.yaml'), manifest('only-builtin'));
    writePack(home, 'shared', { 'pack.yaml': manifest('shared') });
    expect(findPack(home, 'shared', builtin)?.source).toBe('workspace');
    expect(listPacks(home, builtin)).toEqual([
      { id: 'only-builtin', version: '0.1.0', source: 'builtin' },
      { id: 'shared', version: '0.1.0', source: 'workspace' },
    ]);
  });

  it('takes an id or a path, and says when neither is there', () => {
    const home = tempDir();
    writePack(home, 'by-id', { 'pack.yaml': manifest('by-id') });
    expect(locatePack(home, 'by-id').source).toBe('workspace');
    expect(locatePack(home, SAMPLE).source).toBe('path');
    for (const target of ['nope', 'no/such/path']) {
      try {
        locatePack(home, target);
        expect.unreachable();
      } catch (error) {
        expect((error as TomeError).code).toBe('pack.not_found');
      }
    }
  });
});

describe('createPack', () => {
  it('makes a skeleton that passes lint and test', async () => {
    const home = tempDir();
    expect(codes(createPack(home, 'fresh', packTemplate('fresh')))).toEqual(['pack.created']);
    const location = locatePack(home, 'fresh');
    expect(failures(await lintPack(home, location, { public: false }))).toEqual([]);
    expect(codes(await testPack(home, location))).toEqual(['pack.no_tests']);
  });

  it('does not touch a pack that exists', () => {
    const home = tempDir();
    createPack(home, 'fresh', packTemplate('fresh'));
    expect(codes(createPack(home, 'fresh', packTemplate('fresh')))).toEqual(['pack.exists']);
  });

  it.each(['Bad', 'has space', '../up', 'con'])('refuses the id %j', (id) => {
    expect(() => createPack(tempDir(), id, packTemplate(id))).toThrow(TomeError);
  });
});

describe('resolvePack', () => {
  it('lets a child override its parent and keeps the rest', () => {
    const home = tempDir();
    writePack(home, 'base', {
      'pack.yaml': manifest('base'),
      'roles.yaml': 'roles:\n  shared:\n    style: from the parent\n  parent_only: {}\n',
      'syntax_patterns.yaml': "patterns:\n  - { id: one, use: mask, regex: 'parent' }\n",
    });
    const child = writePack(home, 'child', {
      'pack.yaml': manifest('child', 'extends: base\n'),
      'roles.yaml': 'roles:\n  shared:\n    style: from the child\n',
      'syntax_patterns.yaml': "patterns:\n  - { id: one, use: mask, regex: 'child' }\n",
    });
    const { pack, findings } = resolvePack(home, child);
    expect(findings).toEqual([]);
    expect(pack?.chain.map((item) => item.content.manifest.id)).toEqual(['child', 'base']);
    expect(pack?.roles.map(({ pack: owner, name, style }) => [owner, name, style])).toEqual([
      ['child', 'shared', 'from the child'],
      ['base', 'parent_only', undefined],
    ]);
    expect(pack?.patterns.map((item) => item.regex)).toEqual(['child']);
  });

  it('reports a missing parent and a cycle', () => {
    const home = tempDir();
    const orphan = writePack(home, 'orphan', { 'pack.yaml': manifest('orphan', 'extends: gone\n') });
    expect(codes(resolvePack(home, orphan).findings)).toEqual(['pack.parent_missing']);
    writePack(home, 'first', { 'pack.yaml': manifest('first', 'extends: second\n') });
    const second = writePack(home, 'second', { 'pack.yaml': manifest('second', 'extends: first\n') });
    expect(codes(resolvePack(home, second).findings)).toEqual(['pack.parent_cycle']);
  });

  it('accepts a pack with no extends while the implicit root is not there yet', () => {
    const home = tempDir();
    const pack = writePack(home, 'alone', { 'pack.yaml': manifest('alone') });
    expect(resolvePack(home, pack).findings).toEqual([]);
  });
});

describe('detectRole', () => {
  it('needs every pattern of a role, and writes the namespace', () => {
    const home = tempDir();
    const location = locatePack(home, SAMPLE);
    const { pack } = resolvePack(home, location);
    if (pack === null) throw new Error('the sample pack did not load');
    expect(detectRole(pack, () => [[0, 1]])).toBe('sample-pack:stat_block');
    expect(detectRole(pack, (id) => (id === 'hp_line' ? [[0, 1]] : []))).toBeNull();
  });
});

describe('regexRisks', () => {
  it.each([
    ['(a+)+$', 'nested_quantifier'],
    ['(\\w+\\s*)*x', 'nested_quantifier'],
    ['(?:a*)*', 'nested_quantifier'],
    ['((a+))+', 'nested_quantifier'],
    ['(a|aa)+$', 'overlapping_alternation'],
    ['(ab|ac)*', 'overlapping_alternation'],
    ['.*foo.*bar', 'adjacent_wildcards'],
  ])('warns about %s', (source, risk) => {
    expect(regexRisks(source)).toContain(risk);
  });

  it.each([
    '\\b\\d*[dD]\\d+(?:[+-]\\d+)?\\b',
    '(?<name>[A-Z][a-z]+) rolls',
    '[(+*]+',
    '\\(a+\\)+',
    '(ab)+',
    '(a|b)+',
    '(foo|bar)',
    'a{2,3}',
  ])('stays quiet about %s', (source) => {
    expect(regexRisks(source)).toEqual([]);
  });
});

describe('lintPack', () => {
  it('passes the sample pack, public checks included', async () => {
    const home = tempDir();
    const findings = await lintPack(home, locatePack(home, SAMPLE), { public: true });
    expect(failures(findings)).toEqual([]);
    expect(codes(findings)).toContain('pack.lint_ok');
  });

  it('collects every problem at once', async () => {
    const home = tempDir();
    const location = writePack(home, 'bad', {
      'pack.yaml': manifest('other-name'),
      'roles.yaml': 'roles:\n  stat:\n    detect: [missing, masker]\n',
      'entities.yaml': 'classes:\n  deity:\n    default_pronoun: 他們\n',
      'glossary.yaml': 'terms:\n  - { source: { en: Word }, target: 字, class: nothing }\n',
      'syntax_patterns.yaml':
        "patterns:\n  - { id: broken, use: mask, regex: '(' }\n  - { id: masker, use: mask, regex: 'a' }\n  - { id: masker, use: mask, regex: 'b' }\n",
      'script.js': 'console.log("a pack is data");\n',
      'tests/bad.yaml': 'cases: nope\n',
    });
    expect(failures(await lintPack(home, location, { public: false })).sort()).toEqual(
      [
        'pack.bad_file',
        'pack.bad_regex',
        'pack.duplicate_pattern',
        'pack.id_mismatch',
        'pack.not_data',
        'pack.unknown_class',
        'pack.unknown_pattern',
        'pack.unknown_pattern',
        'pack.unknown_pronoun',
      ].sort(),
    );
  });

  it('reports a file that does not parse or does not fit the schema', async () => {
    const home = tempDir();
    const location = writePack(home, 'bad', {
      'pack.yaml': manifest('bad'),
      'roles.yaml': 'roles: [',
      'glossary.yaml': 'terms: nope\napi_key: x\n',
    });
    const findings = await lintPack(home, location, { public: false });
    expect(findings.filter((item) => item.code === 'pack.bad_file').map((item) => item.params['file'])).toEqual(
      expect.arrayContaining(['roles.yaml', 'glossary.yaml']),
    );
  });

  it('cannot go on without pack.yaml, and says so', async () => {
    const home = tempDir();
    const dir = join(home, 'systems', 'empty');
    mkdirSync(dir, { recursive: true });
    const findings = await lintPack(home, { dir, source: 'workspace' }, { public: false });
    expect(codes(findings)).toEqual(['pack.missing_file']);
  });

  it('warns about a risky pattern that still finishes', async () => {
    const { home, location } = sampleCopy();
    writeFileSync(
      join(location.dir, 'syntax_patterns.yaml'),
      "patterns:\n  - { id: risky, use: mask, regex: '(ab|ac)*d' }\n  - { id: hp_line, use: detect, regex: 'HP' }\n  - { id: ac_line, use: detect, regex: 'AC' }\n",
    );
    const findings = await lintPack(home, location, { public: false });
    expect(findings).toContainEqual({
      code: 'pack.risky_regex',
      level: 'warn',
      params: { pattern: 'risky', risk: 'overlapping_alternation' },
    });
    expect(failures(findings)).toEqual([]);
  });

  it.each([
    ['exponential', '(a+)+$'],
    ['cubic', '.*a.*b'],
  ])('fails a pattern that really blows up: %s', { timeout: 30_000 }, async (_name, regex) => {
    const home = tempDir();
    const location = writePack(home, 'slow', {
      'pack.yaml': manifest('slow'),
      'syntax_patterns.yaml': `patterns:\n  - { id: runaway, use: mask, regex: '${regex}' }\n`,
    });
    const findings = await lintPack(home, location, { public: false });
    expect(findings).toContainEqual({
      code: 'pack.slow_regex',
      level: 'fail',
      params: { pattern: 'runaway' },
    });
  });

  it.runIf(process.platform !== 'win32')('refuses a link out of the pack', async () => {
    const home = tempDir();
    const location = writePack(home, 'linked', { 'pack.yaml': manifest('linked') });
    symlinkSync('/etc/hostname', join(location.dir, 'notes.md'));
    expect(failures(await lintPack(home, location, { public: false }))).toEqual(['pack.not_data']);
  });

  describe('--public', () => {
    it('needs LICENSE, NOTICE and tests, which a private pack does not', async () => {
      const home = tempDir();
      const location = writePack(home, 'bare', {
        'pack.yaml': manifest('bare').replace('UNLICENSED', 'Apache-2.0'),
      });
      expect(failures(await lintPack(home, location, { public: false }))).toEqual([]);
      expect(failures(await lintPack(home, location, { public: true }))).toEqual([
        'pack.missing_file',
        'pack.missing_file',
        'pack.no_tests',
      ]);
    });

    it('refuses a license outside the list', async () => {
      const { home, location } = sampleCopy();
      writeFileSync(join(location.dir, 'pack.yaml'), manifest('sample-pack'));
      expect(failures(await lintPack(home, location, { public: true }))).toEqual([
        'pack.unknown_license',
      ]);
    });

    it('names each required notice that is missing from an ORC pack', async () => {
      const { home, location } = sampleCopy();
      writeFileSync(join(location.dir, 'pack.yaml'), manifest('sample-pack').replace('UNLICENSED', 'ORC'));
      writeFileSync(join(location.dir, 'LICENSE'), 'ORC License\n');
      writeFileSync(
        join(location.dir, 'NOTICE'),
        'This product is licensed under the ORC License held in the Library of Congress at TX 9-307-067.\n',
      );
      const findings = await lintPack(home, location, { public: true });
      expect(findings.filter((item) => item.code === 'pack.missing_notice').map((item) => item.params['phrase'])).toEqual([
        'Licensed Material',
        'Reserved Material',
      ]);
    });

    it('treats an empty notice as missing', async () => {
      const { home, location } = sampleCopy();
      writeFileSync(join(location.dir, 'NOTICE'), '  \n');
      expect(failures(await lintPack(home, location, { public: true }))).toEqual(['pack.missing_file']);
    });
  });

  it('keeps the content of a pack out of its findings', async () => {
    const home = tempDir();
    const location = writePack(home, 'quiet', {
      'pack.yaml': manifest('quiet'),
      'glossary.yaml': 'terms:\n  - { source: { en: Secret Name }, target: 祕名, class: nothing }\n',
    });
    const text = JSON.stringify(await lintPack(home, location, { public: false }));
    expect(text).not.toContain('Secret Name');
    expect(text).not.toContain('祕名');
  });
});

describe('testPack', () => {
  it('passes the sample pack', async () => {
    const home = tempDir();
    expect(await testPack(home, locatePack(home, SAMPLE))).toEqual([
      { code: 'pack.test_passed', level: 'info', params: { count: '3' } },
    ]);
  });

  it('names the case and the pattern that failed', async () => {
    const { home, location } = sampleCopy();
    writeFileSync(
      join(location.dir, 'tests', 'basic.yaml'),
      'cases:\n  - id: wrong_match\n    text: Roll 1D6.\n    matches:\n      dice: [1D8]\n  - id: unknown_pattern\n    text: Roll 1D6.\n    matches:\n      nothing: []\n  - id: wrong_role\n    text: Roll 1D6.\n    role: stat_block\n  - id: unexpected_role\n    text: HP 3 AC 4\n    role: null\n',
    );
    expect(await testPack(home, location)).toEqual([
      { code: 'pack.test_failed', level: 'fail', params: { case: 'wrong_match', pattern: 'dice' } },
      { code: 'pack.test_failed', level: 'fail', params: { case: 'unknown_pattern', pattern: 'nothing' } },
      { code: 'pack.test_role_failed', level: 'fail', params: { case: 'wrong_role' } },
      { code: 'pack.test_role_failed', level: 'fail', params: { case: 'unexpected_role' } },
    ]);
  });

  it('reports a runaway pattern by name', { timeout: 30_000 }, async () => {
    const home = tempDir();
    const text = 'a'.repeat(40);
    const location = writePack(home, 'slow', {
      'pack.yaml': manifest('slow'),
      'syntax_patterns.yaml': "patterns:\n  - { id: runaway, use: mask, regex: '(a+)+$' }\n",
      'tests/one.yaml': `cases:\n  - id: pump\n    text: "${text}!"\n`,
    });
    expect(await testPack(home, location)).toEqual([
      { code: 'pack.slow_regex', level: 'fail', params: { pattern: 'runaway' } },
    ]);
  });

  it('reports a test file it cannot read', async () => {
    const { home, location } = sampleCopy();
    writeFileSync(join(location.dir, 'tests', 'basic.yaml'), 'cases: [');
    expect(codes(await testPack(home, location))).toEqual(['pack.bad_file']);
    rmSync(join(location.dir, 'tests'), { recursive: true });
    expect(codes(await testPack(home, location))).toEqual(['pack.no_tests']);
  });
});
