import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/cli/run.ts';
import { keyEnvName, SecretStoreUnavailable, type SecretStore } from '../../src/core/secrets.ts';
import { capture, MemorySecretStore, tempDir } from '../helpers.ts';

const SYNTHETIC_KEY = 'sk-synthetic-not-a-real-key';

function envelope(text: string): {
  schema: string;
  ok: boolean;
  data: Record<string, unknown>;
  findings: { code: string; level: string; message: string; params: Record<string, string> }[];
} {
  return JSON.parse(text);
}

describe('the command line', () => {
  it('prints usage with no arguments and with --help', async () => {
    for (const argv of [[], ['--help'], ['doctor', '--help']]) {
      const { io, stdout } = capture();
      expect(await run(argv, io)).toBe(0);
      expect(stdout()).toContain('用法：tome');
    }
  });

  it('prints the version of package.json', async () => {
    const { io, stdout } = capture();
    expect(await run(['--version'], io)).toBe(0);
    expect(stdout()).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it.each([
    [['nope'], 'cli.unknown_command'],
    [['provider', 'auth'], 'cli.unknown_command'],
    [['init', '--nope'], 'cli.unknown_option'],
    [['init', 'extra'], 'cli.no_arguments'],
    [['add', 'a.pdf', 'b'], 'cli.extra_arguments'],
    [['init', '--vault'], 'cli.bad_args'],
    [['provider', 'auth', 'set'], 'cli.missing_argument'],
  ])('exits 2 on %j', async (argv, code) => {
    const { io, stdout, stderr } = capture();
    expect(await run(argv, io)).toBe(2);
    expect(stderr()).not.toBe('');
    expect(stdout()).toBe('');
    const json = capture();
    expect(await run([...argv, '--json'], json.io)).toBe(2);
    expect(envelope(json.stdout()).findings[0]?.code).toBe(code);
    expect(envelope(json.stdout()).ok).toBe(false);
  });

  it('names a missing argument the way --help does', async () => {
    const { io, stderr } = capture();
    await run(['provider', 'auth', 'set'], io);
    expect(stderr()).toContain('<供應商>');
  });

  // 路徑有空格沒加引號時，`parseArgs` 把它切成好幾個參數（ADR-0114）。
  it('says how many arguments came and how many the command takes, and asks for quotes around a path', async () => {
    const { io, stderr } = capture();
    expect(await run(['add', 'C:\\My', 'Books\\Some', 'Title.pdf'], io)).toBe(2);
    expect(stderr()).toContain('tome add 只接受 1 個參數，這次收到 3 個');
    expect(stderr()).toContain('引號');
    const json = capture();
    await run(['add', 'C:\\My', 'Books\\Some', 'Title.pdf', '--json'], json.io);
    expect(envelope(json.stdout()).findings[0]?.params).toEqual({ command: 'tome add', expected: '1', received: '3' });
  });

  it('says a command takes no arguments at all', async () => {
    const { io, stderr } = capture();
    expect(await run(['provider', 'list', 'extra'], io)).toBe(2);
    expect(stderr()).toContain('tome provider list 不接受參數，這次收到 1 個');
  });

  // 金鑰貼在多出來的參數裡，不能印出來，`--json` 也一樣（ADR-0034、ADR-0114）。
  it('never echoes the extra arguments, where a key may have been pasted', async () => {
    const key = SYNTHETIC_KEY;
    const { io, stdout, stderr } = capture();
    expect(await run(['provider', 'auth', 'set', 'anthropic', key], io)).toBe(2);
    const json = capture();
    await run(['provider', 'auth', 'set', 'anthropic', key, '--json'], json.io);
    for (const text of [stdout(), stderr(), json.stdout(), json.stderr()]) {
      expect(text).not.toContain(key);
      expect(text).not.toContain('anthropic');
    }
    expect(stderr()).toContain('tome provider auth set 只接受 1 個參數，這次收到 2 個');
  });

  it('takes --json before the command too', async () => {
    const { io, stdout } = capture({ env: { TOME_HOME: join(tempDir(), 'home') } });
    expect(await run(['--json', 'init'], io)).toBe(0);
    expect(envelope(stdout()).schema).toBe('tome-cli/1');
  });

  it('reports an unexpected failure as untrusted, with no detail', async () => {
    const store: SecretStore = {
      get: async () => {
        throw new Error('detail that should not be shown');
      },
      set: async () => {},
      delete: async () => false,
    };
    const { io, stderr } = capture({ secrets: store, env: { TOME_HOME: tempDir() } });
    expect(await run(['doctor'], io)).toBe(2);
    expect(stderr()).not.toContain('detail');
  });
});

describe('tome init', () => {
  it('creates a workspace, and reports it in both forms', async () => {
    const home = join(tempDir(), 'home');
    const { io, stdout } = capture({ env: { TOME_HOME: home } });
    expect(await run(['init'], io)).toBe(0);
    expect(stdout()).toContain('工作區已建立');
    const again = capture({ env: { TOME_HOME: home } });
    expect(await run(['init', '--json'], again.io)).toBe(0);
    expect(envelope(again.stdout())).toMatchObject({
      schema: 'tome-cli/1',
      ok: true,
      data: { home },
      findings: [{ code: 'workspace.already_exists', level: 'info' }],
    });
  });

  it('exits 1 inside a git repo', async () => {
    const repo = tempDir();
    mkdirSync(join(repo, '.git'));
    const { io, stdout } = capture({ env: { TOME_HOME: join(repo, 'home') } });
    expect(await run(['init', '--json'], io)).toBe(1);
    expect(envelope(stdout())).toMatchObject({
      ok: false,
      findings: [{ code: 'workspace.in_git_repo', level: 'fail' }],
    });
  });

  it('warns about a sync folder and exits 0', async () => {
    const home = join(tempDir(), 'OneDrive', 'home');
    const { io, stdout } = capture({ env: { TOME_HOME: home } });
    expect(await run(['init'], io)).toBe(0);
    expect(stdout()).toContain('警告');
  });

  it('accepts --vault', async () => {
    const base = tempDir();
    const { io } = capture({ env: { TOME_HOME: join(base, 'home') } });
    expect(await run(['init', '--vault', join(base, 'vault')], io)).toBe(0);
  });
});

describe('tome doctor', () => {
  it('exits 1 on the findings of ADR-0082, and 0 once they are fixed', async () => {
    const home = join(tempDir(), 'home');
    const env = { TOME_HOME: home };
    const before = capture({ env });
    expect(await run(['doctor', '--json'], before.io)).toBe(1);
    expect(envelope(before.stdout()).findings.map((item) => item.code)).toEqual(
      expect.arrayContaining(['workspace.missing', 'key.missing']),
    );

    await run(['init'], capture({ env }).io);
    const store = new MemorySecretStore();
    await store.set('anthropic', SYNTHETIC_KEY);
    const after = capture({ env, secrets: store });
    expect(await run(['doctor'], after.io)).toBe(0);
    expect(after.stdout()).not.toContain(SYNTHETIC_KEY);
  });

  it('exits 2 on a config it cannot read', async () => {
    const home = tempDir();
    writeFileSync(join(home, 'tome.yaml'), 'a: [');
    const { io } = capture({ env: { TOME_HOME: home } });
    expect(await run(['doctor'], io)).toBe(2);
  });
});

describe('tome provider auth set', () => {
  it('stores what stdin gives, and repeats it nowhere', async () => {
    const secrets = new MemorySecretStore();
    const { io, stdout, stderr } = capture({
      secrets,
      stdin: Readable.from([`${SYNTHETIC_KEY}\n`]),
    });
    expect(await run(['provider', 'auth', 'set', 'anthropic'], io)).toBe(0);
    expect(secrets.keys.get('anthropic')).toBe(SYNTHETIC_KEY);
    expect(stdout()).toContain('已存入作業系統憑證庫');
    expect(stdout() + stderr()).not.toContain(SYNTHETIC_KEY);
  });

  it('has no flag that takes a key', async () => {
    const { io, stderr } = capture({ secrets: new MemorySecretStore() });
    const code = await run(['provider', 'auth', 'set', 'anthropic', `--key=${SYNTHETIC_KEY}`], io);
    expect(code).toBe(2);
    expect(stderr()).toContain('--key');
    expect(stderr()).not.toContain(SYNTHETIC_KEY);
  });

  it('refuses a second positional, which would land in shell history', async () => {
    const secrets = new MemorySecretStore();
    const { io } = capture({ secrets });
    expect(await run(['provider', 'auth', 'set', 'anthropic', SYNTHETIC_KEY], io)).toBe(2);
    expect(secrets.keys.size).toBe(0);
  });

  it.each([
    [['provider', 'auth', 'set', SYNTHETIC_KEY]],
    [['provider', 'auth', 'get', SYNTHETIC_KEY]],
    [[SYNTHETIC_KEY]],
  ])('does not repeat a key pasted in the wrong place: %j', async (argv) => {
    const { io, stdout, stderr } = capture();
    expect(await run(argv, io)).toBe(2);
    expect(stdout() + stderr()).not.toContain(SYNTHETIC_KEY);
    const json = capture();
    await run([...argv, '--json'], json.io);
    expect(json.stdout()).not.toContain(SYNTHETIC_KEY);
  });

  it('refuses a provider 0.1.0 does not ship', async () => {
    const { io, stderr } = capture();
    expect(await run(['provider', 'auth', 'set', 'openai'], io)).toBe(2);
    expect(stderr()).toContain('anthropic');
  });

  it('exits 2 on an empty key and stores nothing', async () => {
    const secrets = new MemorySecretStore();
    const { io } = capture({ secrets, stdin: Readable.from(['\n']) });
    expect(await run(['provider', 'auth', 'set', 'anthropic'], io)).toBe(2);
    expect(secrets.keys.size).toBe(0);
  });

  it('exits 1 and names the environment variable when the keyring is unavailable', async () => {
    const broken: SecretStore = {
      get: async () => null,
      set: async () => {
        throw new SecretStoreUnavailable();
      },
      delete: async () => false,
    };
    const { io, stdout } = capture({ secrets: broken, stdin: Readable.from([SYNTHETIC_KEY]) });
    expect(await run(['provider', 'auth', 'set', 'anthropic'], io)).toBe(1);
    expect(stdout()).toContain(keyEnvName('anthropic'));
    expect(stdout()).not.toContain(SYNTHETIC_KEY);
  });

  it('keeps the prompt out of the --json output', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
    const { io, stdout, stderr } = capture({ stdin });
    const pending = run(['provider', 'auth', 'set', 'anthropic', '--json'], io);
    stdin.write(`${SYNTHETIC_KEY}`);
    expect(await pending).toBe(0);
    expect(envelope(stdout())).toMatchObject({ ok: true, data: { provider: 'anthropic' } });
    expect(stderr()).toContain('anthropic');
  });
});

describe('the real process', () => {
  const main = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
  const exec = promisify(execFile);

  it('sets the exit code the core decided', async () => {
    const env = { ...process.env, TOME_HOME: join(tempDir(), 'home') };
    await expect(exec(process.execPath, [main, 'init'], { env })).resolves.toMatchObject({});
    await expect(exec(process.execPath, [main, 'nope'], { env })).rejects.toMatchObject({ code: 2 });
  });
});
