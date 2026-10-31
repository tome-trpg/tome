import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findViolations, isAllowedLicense, type LockEntry } from '../../tools/check-licenses.ts';

describe('isAllowedLicense', () => {
  it.each(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0'])(
    'allows %s',
    (license) => {
      expect(isAllowedLicense(license)).toBe(true);
    },
  );

  it.each([
    'AGPL-3.0-only',
    'GPL-2.0-or-later',
    'LGPL-3.0-only',
    'BSD-4-Clause',
    'CC-BY-NC-4.0',
    'SEE LICENSE IN LICENSE',
    'UNLICENSED',
    '',
    '(MIT',
    'MIT)',
    'MIT OR',
  ])('refuses %j', (license) => {
    expect(isAllowedLicense(license)).toBe(false);
  });

  it('refuses a missing license', () => {
    expect(isAllowedLicense(undefined)).toBe(false);
  });

  it('reads OR as either and AND as both', () => {
    expect(isAllowedLicense('MIT OR GPL-3.0-only')).toBe(true);
    expect(isAllowedLicense('(GPL-3.0-only OR MIT)')).toBe(true);
    expect(isAllowedLicense('MIT AND GPL-3.0-only')).toBe(false);
    expect(isAllowedLicense('(MIT OR Apache-2.0) AND ISC')).toBe(true);
    expect(isAllowedLicense('(MIT OR Apache-2.0) AND Unicode-3.0')).toBe(false);
  });
});

describe('findViolations', () => {
  it('skips the root and linked workspaces', () => {
    const packages: Record<string, LockEntry> = {
      '': { version: '0.0.0' },
      'node_modules/linked': { link: true },
    };
    expect(findViolations(packages)).toEqual([]);
  });

  it('reports a package outside the list, and a package with no license', () => {
    const packages: Record<string, LockEntry> = {
      'node_modules/fine': { version: '1.0.0', license: 'MIT' },
      'node_modules/bad': { version: '2.0.0', license: 'AGPL-3.0-only' },
      'node_modules/nothing': { version: '3.0.0' },
    };
    expect(findViolations(packages)).toEqual([
      { name: 'bad', version: '2.0.0', license: 'AGPL-3.0-only', reason: 'license' },
      { name: 'nothing', version: '3.0.0', license: '(none)', reason: 'license' },
    ]);
  });

  it('applies the same list to development dependencies', () => {
    const packages = { 'node_modules/bad': { version: '1.0.0', license: 'GPL-3.0-only', dev: true } };
    expect(findViolations(packages)).toHaveLength(1);
  });

  it('takes 0BSD from a development dependency, never from the main program', () => {
    const dev = { 'node_modules/tslib': { version: '2.9.1', license: '0BSD', dev: true } };
    const main = { 'node_modules/tslib': { version: '2.9.1', license: '0BSD' } };
    expect(findViolations(dev)).toEqual([]);
    expect(findViolations(main)).toEqual([
      { name: 'tslib', version: '2.9.1', license: '0BSD', reason: 'license' },
    ]);
  });

  it('takes the exception for png-js at that version only, and only in development', () => {
    expect(findViolations({ 'node_modules/png-js': { version: '2.0.0', dev: true } })).toEqual([]);
    expect(findViolations({ 'node_modules/png-js': { version: '2.0.1', dev: true } })).toHaveLength(1);
    expect(findViolations({ 'node_modules/png-js': { version: '2.0.0' } })).toHaveLength(1);
  });

  it('names the nested package, not its parent', () => {
    const packages = {
      'node_modules/a/node_modules/@scope/b': { version: '1.0.0', license: 'GPL-3.0-only' },
    };
    expect(findViolations(packages)[0]?.name).toBe('@scope/b');
  });

  it('stops an unreviewed native package from reaching the main program', () => {
    const packages = {
      'node_modules/some-native-linux-x64': { version: '1.0.0', license: 'MIT', os: ['linux'] },
    };
    expect(findViolations(packages)).toEqual([
      { name: 'some-native-linux-x64', version: '1.0.0', license: 'MIT', reason: 'native' },
    ]);
  });

  it('lets a reviewed native package and a development tool through', () => {
    const packages = {
      'node_modules/@napi-rs/keyring-linux-x64-gnu': {
        version: '2.1.2',
        license: 'MIT',
        os: ['linux'],
      },
      'node_modules/@esbuild/linux-x64': {
        version: '1.0.0',
        license: 'MIT',
        os: ['linux'],
        dev: true,
      },
    };
    expect(findViolations(packages)).toEqual([]);
  });

  it('passes the lockfile of this repository', () => {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
      packages: Record<string, LockEntry>;
    };
    expect(findViolations(lock.packages)).toEqual([]);
  });
});
