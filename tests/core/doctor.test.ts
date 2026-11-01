import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/core/doctor.ts';
import { exitCodeOf, type Finding } from '../../src/core/findings.ts';
import { runTool, type ToolRunner } from '../../src/core/process.ts';
import { keyEnvName, SecretStoreUnavailable, type SecretStore } from '../../src/core/secrets.ts';
import { initWorkspace } from '../../src/core/workspace.ts';
import { workspaceTemplate } from '../../src/cli/messages.ts';
import { MemorySecretStore, tempDir } from '../helpers.ts';

function codes(findings: readonly Finding[]): string[] {
  return findings.map((item) => item.code);
}

function workspace(): string {
  const home = join(tempDir(), 'home');
  initWorkspace({ home, env: {}, template: workspaceTemplate });
  return home;
}

const noUv: ToolRunner = async () => null;
const envWithKey = { [keyEnvName('anthropic')]: 'not-a-real-key' };

describe('runDoctor', () => {
  it('is clean with a workspace and a key, and does not count uv', async () => {
    const findings = await runDoctor({
      home: workspace(),
      env: envWithKey,
      store: new MemorySecretStore(),
      tool: noUv,
      nodeVersion: '24.22.1',
    });
    expect(exitCodeOf(findings)).toBe(0);
    expect(codes(findings)).toEqual([
      'node.ok',
      'sqlite.ok',
      'uv.missing',
      'key.ok',
      'workspace.ok',
      'engine.none',
      'prices.pending',
    ]);
    expect(findings.find((item) => item.code === 'uv.missing')?.level).toBe('info');
  });

  it('reports a missing workspace and a missing key as findings', async () => {
    const findings = await runDoctor({
      home: join(tempDir(), 'none'),
      env: {},
      store: new MemorySecretStore(),
      tool: noUv,
    });
    expect(exitCodeOf(findings)).toBe(1);
    expect(codes(findings)).toContain('key.missing');
    expect(codes(findings)).toContain('workspace.missing');
  });

  it('reports a Node that is too old', async () => {
    const findings = await runDoctor({
      home: workspace(),
      env: envWithKey,
      store: new MemorySecretStore(),
      tool: noUv,
      nodeVersion: '22.11.0',
    });
    expect(findings[0]).toMatchObject({
      code: 'node.too_old',
      level: 'fail',
      params: { version: '22.11.0', minimum: '24' },
    });
  });

  it('points at the environment variable when the keyring is unavailable', async () => {
    const broken: SecretStore = {
      get: async () => {
        throw new SecretStoreUnavailable();
      },
      set: async () => {},
      delete: async () => false,
    };
    const findings = await runDoctor({ home: workspace(), env: {}, store: broken, tool: noUv });
    expect(codes(findings)).toContain('keyring.unavailable');
    expect(codes(findings)).toContain('key.missing');
    expect(findings.find((item) => item.code === 'keyring.unavailable')?.level).toBe('warn');
  });

  it('does not need the keyring when the environment has the key', async () => {
    const broken: SecretStore = {
      get: async () => {
        throw new SecretStoreUnavailable();
      },
      set: async () => {},
      delete: async () => false,
    };
    const findings = await runDoctor({
      home: workspace(),
      env: envWithKey,
      store: broken,
      tool: noUv,
    });
    expect(exitCodeOf(findings)).toBe(0);
  });

  it('never carries the key itself', async () => {
    const findings = await runDoctor({
      home: workspace(),
      env: { [keyEnvName('anthropic')]: 'sk-synthetic-value' },
      store: new MemorySecretStore(),
      tool: noUv,
    });
    expect(JSON.stringify(findings)).not.toContain('sk-synthetic-value');
  });

  it('reports the version uv gives', async () => {
    const uv: ToolRunner = async () => ({ stdout: 'uv 1.2.3\n' });
    const findings = await runDoctor({
      home: workspace(),
      env: envWithKey,
      store: new MemorySecretStore(),
      tool: uv,
    });
    expect(findings.find((item) => item.code === 'uv.ok')?.params).toEqual({ version: '1.2.3' });
  });
});

describe('runTool', () => {
  it('hands a child no key from the environment', async () => {
    const script = 'process.stdout.write(String(process.env.TOME_ANTHROPIC_API_KEY))';
    const env = { ...process.env, TOME_ANTHROPIC_API_KEY: 'sk-synthetic-value' };
    expect(await runTool(process.execPath, ['-e', script], env)).toEqual({ stdout: 'undefined' });
  });

  it('answers null for a command that does not exist', async () => {
    expect(await runTool('tome-no-such-command', [], process.env)).toBeNull();
  });
});
