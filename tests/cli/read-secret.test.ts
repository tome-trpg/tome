import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readSecret, type SecretInput } from '../../src/cli/read-secret.ts';
import { TomeError } from '../../src/core/errors.ts';

function fakeTty(): { input: SecretInput; modes: boolean[]; type(text: string): void } {
  const stream = new PassThrough();
  const modes: boolean[] = [];
  const input = Object.assign(stream, {
    isTTY: true,
    setRawMode(mode: boolean) {
      modes.push(mode);
      return stream;
    },
  });
  return { input, modes, type: (text) => stream.write(text) };
}

describe('readSecret from a pipe', () => {
  it('reads everything and shows no prompt', async () => {
    let prompts = 0;
    const value = await readSecret(Readable.from(['not-a-', 'real-key\n']), () => (prompts += 1));
    expect(value).toBe('not-a-real-key\n');
    expect(prompts).toBe(0);
  });
});

describe('readSecret from a terminal', () => {
  it('prompts, reads with echo off, and restores the terminal', async () => {
    const { input, modes, type } = fakeTty();
    let prompts = 0;
    const pending = readSecret(input, () => (prompts += 1));
    type('abc\r');
    expect(await pending).toBe('abc');
    expect(prompts).toBe(1);
    expect(modes).toEqual([true, false]);
  });

  it('honours backspace and delete', async () => {
    const { input, type } = fakeTty();
    const pending = readSecret(input, () => {});
    type('abx\u007fc\by\n');
    expect(await pending).toBe('aby');
  });

  it('cancels on Ctrl-C and restores the terminal', async () => {
    const { input, modes, type } = fakeTty();
    const pending = readSecret(input, () => {});
    type('abc\u0003');
    await expect(pending).rejects.toBeInstanceOf(TomeError);
    expect(modes).toEqual([true, false]);
  });

  it('finishes on Ctrl-D', async () => {
    const { input, type } = fakeTty();
    const pending = readSecret(input, () => {});
    type('abc\u0004');
    expect(await pending).toBe('abc');
  });
});
