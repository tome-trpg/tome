import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TomeError } from '../../src/core/errors.ts';
import { scrubEnv } from '../../src/core/process.ts';
import {
  isProvider,
  keyEnvName,
  normalizeKey,
  osSecretStore,
  resolveApiKey,
  SecretStoreUnavailable,
} from '../../src/core/secrets.ts';
import { MemorySecretStore } from '../helpers.ts';

describe('resolveApiKey', () => {
  it('prefers the environment, so that CI and machines with no keyring can run', async () => {
    const store = new MemorySecretStore();
    await store.set('anthropic', 'from-keyring');
    const env = { [keyEnvName('anthropic')]: 'from-env' };
    expect(await resolveApiKey('anthropic', env, store)).toEqual({ key: 'from-env', source: 'env' });
  });

  it('falls back to the keyring', async () => {
    const store = new MemorySecretStore();
    await store.set('anthropic', 'from-keyring');
    expect(await resolveApiKey('anthropic', {}, store)).toEqual({
      key: 'from-keyring',
      source: 'keyring',
    });
  });

  it('does not read the key of other tools', async () => {
    const env = { ANTHROPIC_API_KEY: 'meant-for-another-tool' };
    expect(await resolveApiKey('anthropic', env, new MemorySecretStore())).toBeNull();
  });
});

describe('normalizeKey', () => {
  it('drops the line end a paste or a pipe brings', () => {
    expect(normalizeKey('  abc\r\n')).toBe('abc');
  });

  it.each([
    ['empty', ''],
    ['blank', '  \n'],
    ['two lines', 'abc\ndef'],
    ['too long', 'x'.repeat(1025)],
  ])('refuses %s, without repeating it', (_name, input) => {
    try {
      normalizeKey(input);
      expect.unreachable();
    } catch (error) {
      expect((error as TomeError).code).toBe('secret.invalid');
      expect((error as TomeError).params).toEqual({});
    }
  });
});

describe('isProvider', () => {
  it('knows only what 0.1.0 ships', () => {
    expect(isProvider('anthropic')).toBe(true);
    expect(isProvider('openai')).toBe(false);
  });
});

describe('scrubEnv', () => {
  it('removes every key-shaped name and keeps the rest', () => {
    const env = {
      PATH: '/bin',
      TOME_HOME: '/h',
      TOME_ANTHROPIC_API_KEY: 'a',
      ANTHROPIC_API_KEY: 'b',
      OPENAI_API_KEY: 'c',
      GITHUB_TOKEN: 'd',
      my_secret: 'e',
      DB_PASSWORD: 'f',
    };
    expect(scrubEnv(env)).toEqual({ PATH: '/bin', TOME_HOME: '/h' });
  });

  it('never keeps a name ending in API_KEY', () => {
    const prefix = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,12}$/);
    fc.assert(
      fc.property(prefix, (name) => {
        expect(scrubEnv({ [`${name}_API_KEY`]: 'x' })).toEqual({});
      }),
    );
  });
});

// CI 的 Ubuntu 沒有 Secret Service。Linux 二進位檔要載得起來，並回報不可用，不能退回只在記憶體裡的 keyutils（ADR-0083）。
describe.skipIf(!process.env['TOME_TEST_NO_KEYRING'])('osSecretStore with no keyring', () => {
  it('says it is unavailable, on read and on write', async () => {
    const store = osSecretStore('tome-trpg-test-unavailable');
    await expect(store.get('anthropic')).rejects.toBeInstanceOf(SecretStoreUnavailable);
    await expect(store.set('anthropic', 'not-a-real-key')).rejects.toBeInstanceOf(
      SecretStoreUnavailable,
    );
  });
});

// 動到真的憑證庫，預設不跑。H-14 的實測指令：TOME_TEST_KEYRING=1 npx --no-install vitest run tests/core/secrets
describe.skipIf(!process.env['TOME_TEST_KEYRING'])('osSecretStore on the real keyring', () => {
  it('stores, reads, overwrites and deletes across instances', async () => {
    const service = `tome-trpg-test-${process.pid}`;
    const store = osSecretStore(service);
    const other = osSecretStore(service);
    await store.delete('anthropic');
    expect(await store.get('anthropic')).toBeNull();
    try {
      await store.set('anthropic', 'not-a-real-key-測試');
      expect(await other.get('anthropic')).toBe('not-a-real-key-測試');
      await store.set('anthropic', 'not-a-real-key-2');
      expect(await other.get('anthropic')).toBe('not-a-real-key-2');
    } finally {
      expect(await store.delete('anthropic')).toBe(true);
    }
    expect(await other.get('anthropic')).toBeNull();
    expect(await store.delete('anthropic')).toBe(false);
  });
});
