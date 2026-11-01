import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/cli/run.ts';
import { capture, tempDir } from '../helpers.ts';

const SAMPLE = 'tests/fixtures/packs/sample-pack';

function envelope(text: string): {
  ok: boolean;
  data: Record<string, unknown>;
  findings: { code: string; level: string; params: Record<string, string> }[];
} {
  return JSON.parse(text);
}

async function workspace(): Promise<NodeJS.ProcessEnv> {
  const env = { TOME_HOME: join(tempDir(), 'home') };
  await run(['init'], capture({ env }).io);
  return env;
}

describe('tome system new', () => {
  it('creates a skeleton in the workspace', async () => {
    const env = await workspace();
    const { io, stdout } = capture({ env });
    expect(await run(['system', 'new', 'my-pack'], io)).toBe(0);
    expect(stdout()).toContain('已建立規則包 my-pack');
    expect(await run(['system', 'lint', 'my-pack'], capture({ env }).io)).toBe(0);
  });

  it('exits 1 when it exists or there is no workspace', async () => {
    const env = await workspace();
    await run(['system', 'new', 'my-pack'], capture({ env }).io);
    expect(await run(['system', 'new', 'my-pack'], capture({ env }).io)).toBe(1);
    const none = { TOME_HOME: join(tempDir(), 'none') };
    expect(await run(['system', 'new', 'my-pack'], capture({ env: none }).io)).toBe(1);
  });

  it('exits 2 on a bad id or none at all', async () => {
    const env = await workspace();
    expect(await run(['system', 'new', 'Bad Id'], capture({ env }).io)).toBe(2);
    expect(await run(['system', 'new'], capture({ env }).io)).toBe(2);
  });
});

describe('tome system list', () => {
  it('lists the built-in pack, then what the workspace adds', async () => {
    const env = await workspace();
    const builtin = capture({ env });
    expect(await run(['system', 'list'], builtin.io)).toBe(0);
    expect(builtin.stdout()).toContain('generic 0.1.0（來源：builtin）');
    await run(['system', 'new', 'my-pack'], capture({ env }).io);
    const listed = capture({ env });
    expect(await run(['system', 'list', '--json'], listed.io)).toBe(0);
    expect(envelope(listed.stdout()).data['packs']).toEqual([
      { id: 'generic', version: '0.1.0', source: 'builtin' },
      { id: 'my-pack', version: '0.1.0', source: 'workspace' },
    ]);
  });
});

describe('tome system lint', () => {
  it('takes a path, which is how CI checks the packs in the repository', async () => {
    const { io, stdout } = capture({ env: { TOME_HOME: tempDir() } });
    expect(await run(['system', 'lint', SAMPLE, '--public'], io)).toBe(0);
    expect(stdout()).toContain('檢查通過');
  });

  it('checks the built-in pack by its path, the way CI does', async () => {
    const { io, stdout } = capture({ env: { TOME_HOME: tempDir() } });
    expect(await run(['system', 'lint', 'systems/generic', '--public'], io)).toBe(0);
    expect(stdout()).toContain('規則包 generic 檢查通過');
  });

  it('reads the target language of the workspace (ADR-0100)', async () => {
    const env = await workspace();
    writeFileSync(join(env['TOME_HOME'] ?? '', 'tome.yaml'), 'schema: tome-workspace/1\ntarget_lang: xx\n');
    const { io, stderr } = capture({ env });
    expect(await run(['system', 'lint', SAMPLE], io)).toBe(2);
    expect(stderr()).toContain('不支援目標語言 xx');
    expect(stderr()).toContain('target_lang');
  });

  it('exits 1 on a finding, and 2 on a pack it cannot find', async () => {
    const env = await workspace();
    await run(['system', 'new', 'my-pack'], capture({ env }).io);
    const publicLint = capture({ env });
    expect(await run(['system', 'lint', 'my-pack', '--public'], publicLint.io)).toBe(1);
    expect(publicLint.stdout()).toContain('授權 UNLICENSED');
    expect(await run(['system', 'lint', 'nope'], capture({ env }).io)).toBe(2);
    expect(await run(['system', 'lint'], capture({ env }).io)).toBe(2);
  });
});

describe('tome system test', () => {
  it('runs the cases of a pack', async () => {
    const { io, stdout } = capture({ env: { TOME_HOME: tempDir() } });
    expect(await run(['system', 'test', SAMPLE], io)).toBe(0);
    expect(stdout()).toContain('3 個測試案例全部通過');
  });

  it('exits 2 without a pack', async () => {
    const { io } = capture({ env: { TOME_HOME: tempDir() } });
    expect(await run(['system', 'test'], io)).toBe(2);
  });
});

describe('the real process', () => {
  const main = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
  const exec = promisify(execFile);

  it('runs the worker from the source tree', async () => {
    const env = { ...process.env, TOME_HOME: tempDir() };
    const { stdout } = await exec(process.execPath, [main, 'system', 'test', SAMPLE, '--json'], { env });
    expect(JSON.parse(stdout).ok).toBe(true);
  });
});
