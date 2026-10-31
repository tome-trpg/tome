import { TomeError } from './errors.ts';

// 0.1.0 只接 Anthropic（ADR-0080）。
export const PROVIDERS = ['anthropic'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const KEYRING_SERVICE = 'tome-trpg';

const KEY_ENV: Readonly<Record<ProviderId, string>> = {
  anthropic: 'TOME_ANTHROPIC_API_KEY',
};

// Windows 憑證管理員的上限是 2,560 位元組（UTF-16）。真正的金鑰遠短於此，超過就是貼錯東西。
const MAX_KEY_LENGTH = 1024;

export interface SecretStore {
  get(provider: ProviderId): Promise<string | null>;
  set(provider: ProviderId, key: string): Promise<void>;
  delete(provider: ProviderId): Promise<boolean>;
}

/** 憑證庫不可用，呼叫端要改走環境變數（ADR-0034）。 */
export class SecretStoreUnavailable extends Error {
  constructor() {
    super('secret store unavailable');
    this.name = 'SecretStoreUnavailable';
  }
}

export function keyEnvName(provider: ProviderId): string {
  return KEY_ENV[provider];
}

export function isProvider(value: string): value is ProviderId {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** 清掉貼上時帶的換行。錯誤訊息 MUST NOT 帶金鑰內容。 */
export function normalizeKey(input: string): string {
  const key = input.trim();
  if (key === '' || key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
    throw new TomeError('secret.invalid');
  }
  return key;
}

// 原生模組延後載入：平台沒有預編譯檔時只是憑證庫不可用，不是整支程式起不來。
// Linux 釘在 Secret Service，不用預設的自動退回：keyutils 只在記憶體裡，重開機金鑰就沒了（ADR-0083）。
async function openEntry(service: string, provider: ProviderId) {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    return new Entry(service, provider, { linux: { store: 'secret-service' } });
  } catch {
    throw new SecretStoreUnavailable();
  }
}

export function osSecretStore(service: string = KEYRING_SERVICE): SecretStore {
  const attempt = async <T>(
    provider: ProviderId,
    action: (entry: Awaited<ReturnType<typeof openEntry>>) => T,
  ): Promise<T> => {
    const entry = await openEntry(service, provider);
    try {
      return action(entry);
    } catch {
      throw new SecretStoreUnavailable();
    }
  };
  return {
    get: (provider) => attempt(provider, (entry) => entry.getPassword()),
    set: (provider, key) => attempt(provider, (entry) => entry.setPassword(key)),
    delete: (provider) => attempt(provider, (entry) => entry.deletePassword()),
  };
}

export type KeySource = 'env' | 'keyring';

export interface ResolvedKey {
  readonly key: string;
  readonly source: KeySource;
}

/** 環境變數優先，給沒有憑證庫的環境使用（ADR-0034）。 */
export async function resolveApiKey(
  provider: ProviderId,
  env: NodeJS.ProcessEnv,
  store: SecretStore,
): Promise<ResolvedKey | null> {
  const fromEnv = env[keyEnvName(provider)];
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const fromStore = await store.get(provider);
  return fromStore === null ? null : { key: fromStore, source: 'keyring' };
}
