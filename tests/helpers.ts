import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { onTestFinished } from 'vitest';
import type { Io } from '../src/cli/run.ts';
import type { ProviderId, SecretStore } from '../src/core/secrets.ts';

/** 測試用的臨時目錄，在系統暫存區，不在任何 git repo 裡。 */
export function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'tome-test-'));
  onTestFinished(() => rmSync(path, { recursive: true, force: true, maxRetries: 5 }));
  return path;
}

export class MemorySecretStore implements SecretStore {
  readonly keys = new Map<ProviderId, string>();

  async get(provider: ProviderId): Promise<string | null> {
    return this.keys.get(provider) ?? null;
  }

  async set(provider: ProviderId, key: string): Promise<void> {
    this.keys.set(provider, key);
  }

  async delete(provider: ProviderId): Promise<boolean> {
    return this.keys.delete(provider);
  }
}

export interface Captured {
  readonly io: Io;
  stdout(): string;
  stderr(): string;
}

export function capture(overrides: Partial<Io> = {}): Captured {
  let out = '';
  let err = '';
  const io: Io = {
    stdin: Readable.from([]),
    stdout: { write: (text) => (out += text) },
    stderr: { write: (text) => (err += text) },
    env: {},
    secrets: new MemorySecretStore(),
    tool: async () => null,
    ...overrides,
  };
  return { io, stdout: () => out, stderr: () => err };
}
