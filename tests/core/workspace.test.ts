import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TomeError } from '../../src/core/errors.ts';
import { exitCodeOf } from '../../src/core/findings.ts';
import {
  checkWorkspace,
  DEFAULT_TARGET_LANG,
  initWorkspace,
  readWorkspaceConfig,
  resolveHome,
  workspaceModel,
  workspacePii,
  workspaceTargetLang,
} from '../../src/core/workspace.ts';
import { workspaceTemplate } from '../../src/cli/messages.ts';
import { tempDir } from '../helpers.ts';

const template = workspaceTemplate;

describe('resolveHome', () => {
  it('prefers TOME_HOME', () => {
    expect(resolveHome({ TOME_HOME: 'somewhere' }, 'linux', '/home/x')).toBe(resolve('somewhere'));
  });

  it('uses the local application data folder on Windows', () => {
    expect(resolveHome({ LOCALAPPDATA: 'L' }, 'win32', 'H')).toBe(join('L', 'tome'));
    expect(resolveHome({}, 'win32', 'H')).toBe(join('H', 'AppData', 'Local', 'tome'));
  });

  it('uses the platform directory elsewhere', () => {
    expect(resolveHome({}, 'linux', 'H')).toBe(join('H', '.local', 'share', 'tome'));
    expect(resolveHome({}, 'darwin', 'H')).toBe(
      join('H', 'Library', 'Application Support', 'tome'),
    );
  });

  it('treats an empty TOME_HOME as unset', () => {
    expect(resolveHome({ TOME_HOME: '' }, 'linux', 'H')).toBe(join('H', '.local', 'share', 'tome'));
  });
});

describe('initWorkspace', () => {
  it('creates the layout of ADR-0053', () => {
    const home = join(tempDir(), 'home');
    const findings = initWorkspace({ home, env: {}, template });
    expect(findings.map((item) => item.code)).toEqual(['workspace.created']);
    for (const name of ['systems', 'engines', 'series', 'books', 'tome.yaml']) {
      expect(existsSync(join(home, name))).toBe(true);
    }
    expect(readWorkspaceConfig(home)?.schema).toBe('tome-workspace/1');
  });

  it('writes the target language into the template (ADR-0100)', () => {
    const home = join(tempDir(), 'home');
    initWorkspace({ home, env: {}, template });
    expect(readWorkspaceConfig(home)?.['target_lang']).toBe('zh-TW');
    expect(workspaceTargetLang(home)).toBe('zh-TW');
  });

  it('reads the target language, and falls back without one or without a workspace', () => {
    const home = tempDir();
    expect(workspaceTargetLang(home)).toBe(DEFAULT_TARGET_LANG);
    writeFileSync(join(home, 'tome.yaml'), 'schema: tome-workspace/1\n');
    expect(workspaceTargetLang(home)).toBe(DEFAULT_TARGET_LANG);
    writeFileSync(join(home, 'tome.yaml'), 'schema: tome-workspace/1\ntarget_lang: fr\n');
    expect(workspaceTargetLang(home)).toBe('fr');
  });

  it('leaves the model unset, since TOME has no default model (ADR-0041)', () => {
    const home = join(tempDir(), 'home');
    initWorkspace({ home, env: {}, template });
    expect(workspaceModel(home, 'translator_model')).toBeUndefined();
    expect(workspaceModel(home, 'fallback_model')).toBeUndefined();
    expect(workspacePii(home)).toEqual([]);
  });

  it('reads the models and the list of personal data', () => {
    const home = tempDir();
    writeFileSync(
      join(home, 'tome.yaml'),
      'schema: tome-workspace/1\ntranslator_model: model-a\nfallback_model: model-b\npii: [Forged Buyer]\n',
    );
    expect(workspaceModel(home, 'translator_model')).toBe('model-a');
    expect(workspaceModel(home, 'fallback_model')).toBe('model-b');
    expect(workspacePii(home)).toEqual(['Forged Buyer']);
  });

  it.each(['translator_model: [a]', 'pii: nope', 'pii: [1]'])('refuses %s', (line) => {
    const home = tempDir();
    writeFileSync(join(home, 'tome.yaml'), `schema: tome-workspace/1\n${line}\n`);
    expect(() => {
      workspaceModel(home, 'translator_model');
      workspacePii(home);
    }).toThrow(expect.objectContaining({ code: 'config.bad_schema' }));
  });

  it('refuses a target language that is not a string', () => {
    const home = tempDir();
    writeFileSync(join(home, 'tome.yaml'), 'schema: tome-workspace/1\ntarget_lang: [zh-TW]\n');
    expect(() => workspaceTargetLang(home)).toThrow(expect.objectContaining({ code: 'config.bad_schema' }));
  });

  it('refuses a path inside a git repo and writes nothing', () => {
    const repo = tempDir();
    mkdirSync(join(repo, '.git'));
    const home = join(repo, 'home');
    const findings = initWorkspace({ home, env: {}, template });
    expect(findings.map((item) => item.code)).toEqual(['workspace.in_git_repo']);
    expect(exitCodeOf(findings)).toBe(1);
    expect(existsSync(home)).toBe(false);
  });

  it('warns about a sync folder and still creates the workspace', () => {
    const home = join(tempDir(), 'Dropbox', 'home');
    const findings = initWorkspace({ home, env: {}, template });
    expect(findings.map((item) => item.code)).toEqual([
      'workspace.sync_folder',
      'workspace.created',
    ]);
    expect(exitCodeOf(findings)).toBe(0);
    expect(existsSync(join(home, 'tome.yaml'))).toBe(true);
  });

  it('does not overwrite an existing workspace', () => {
    const home = join(tempDir(), 'home');
    initWorkspace({ home, env: {}, template });
    const path = join(home, 'tome.yaml');
    const edited = `${readFileSync(path, 'utf8')}\nvault_path: /kept\n`;
    writeFileSync(path, edited);
    const findings = initWorkspace({ home, env: {}, template });
    expect(findings.map((item) => item.code)).toEqual(['workspace.already_exists']);
    expect(exitCodeOf(findings)).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(edited);
  });

  it('records the vault path and keeps the template comments', () => {
    const base = tempDir();
    const home = join(base, 'home');
    const vaultPath = join(base, 'vault');
    initWorkspace({ home, vaultPath, env: {}, template });
    expect(readWorkspaceConfig(home)?.vault_path).toBe(resolve(vaultPath));
    expect(readFileSync(join(home, 'tome.yaml'), 'utf8')).toContain('# translator_model:');
  });

  it('refuses a vault inside a git repo', () => {
    const base = tempDir();
    const repo = join(base, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const home = join(base, 'home');
    const findings = initWorkspace({ home, vaultPath: join(repo, 'vault'), env: {}, template });
    expect(findings.map((item) => item.code)).toEqual(['vault.in_git_repo']);
    expect(existsSync(home)).toBe(false);
  });

  it('says so when --vault cannot take effect on an existing workspace', () => {
    const base = tempDir();
    const home = join(base, 'home');
    initWorkspace({ home, env: {}, template });
    const findings = initWorkspace({ home, vaultPath: join(base, 'vault'), env: {}, template });
    expect(findings.map((item) => item.code)).toEqual([
      'workspace.vault_ignored',
      'workspace.already_exists',
    ]);
  });
});

describe('readWorkspaceConfig', () => {
  it('returns null when there is no workspace', () => {
    expect(readWorkspaceConfig(tempDir())).toBeNull();
  });

  it.each([
    ['broken yaml', 'a: [', 'config.invalid_yaml'],
    ['another format', 'schema: other/1\n', 'config.bad_schema'],
    ['no schema key', 'vault_path: x\n', 'config.bad_schema'],
    ['not a mapping', '- a\n', 'config.bad_schema'],
  ])('refuses %s as untrusted', (_name, text, code) => {
    const home = tempDir();
    writeFileSync(join(home, 'tome.yaml'), text);
    expect(() => readWorkspaceConfig(home)).toThrow(TomeError);
    try {
      readWorkspaceConfig(home);
    } catch (error) {
      expect((error as TomeError).code).toBe(code);
    }
  });
});

describe('checkWorkspace', () => {
  it('reports a missing workspace', () => {
    const findings = checkWorkspace(join(tempDir(), 'none'), {});
    expect(findings.map((item) => item.code)).toEqual(['workspace.missing']);
    expect(exitCodeOf(findings)).toBe(1);
  });

  it('passes a healthy workspace', () => {
    const home = join(tempDir(), 'home');
    initWorkspace({ home, env: {}, template });
    expect(checkWorkspace(home, {}).map((item) => item.code)).toEqual(['workspace.ok']);
  });

  it('notices a secret written into the config, at any depth', () => {
    const home = join(tempDir(), 'home');
    initWorkspace({ home, env: {}, template });
    writeFileSync(
      join(home, 'tome.yaml'),
      'schema: tome-workspace/1\nproviders:\n  anthropic:\n    api_key: x\n',
    );
    const findings = checkWorkspace(home, {});
    expect(findings).toEqual([
      expect.objectContaining({
        code: 'workspace.secret_in_config',
        level: 'fail',
        params: { key: 'providers.anthropic.api_key' },
      }),
    ]);
  });

  it('notices a vault moved into a repo after init', () => {
    const base = tempDir();
    const repo = join(base, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const home = join(base, 'home');
    initWorkspace({ home, env: {}, template });
    writeFileSync(
      join(home, 'tome.yaml'),
      `schema: tome-workspace/1\nvault_path: ${JSON.stringify(join(repo, 'vault'))}\n`,
    );
    expect(checkWorkspace(home, {}).map((item) => item.code)).toEqual(['vault.in_git_repo']);
  });
});
