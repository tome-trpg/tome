import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readSecret, type SecretInput, type SecretOutput } from '../../src/cli/read-secret.ts';
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

function fakeOutput(): SecretOutput & { text(): string } {
  let written = '';
  return { write: (text) => (written += text), text: () => written };
}

describe('readSecret from a pipe', () => {
  it('reads everything and writes nothing, not even a line end', async () => {
    const output = fakeOutput();
    const value = await readSecret(Readable.from(['not-a-', 'real-key\n']), output, 'key: ');
    expect(value).toBe('not-a-real-key\n');
    expect(output.text()).toBe('');
  });
});

describe('readSecret from a terminal', () => {
  it('prompts, reads with echo off, restores the terminal and ends the line', async () => {
    const { input, modes, type } = fakeTty();
    const output = fakeOutput();
    const pending = readSecret(input, output, 'key: ');
    type('abc\r');
    expect(await pending).toBe('abc');
    expect(output.text()).toBe('key: \n');
    expect(modes).toEqual([true, false]);
  });

  it('honours backspace and delete', async () => {
    const { input, type } = fakeTty();
    const pending = readSecret(input, fakeOutput(), 'key: ');
    type('abx\u007fc\by\n');
    expect(await pending).toBe('aby');
  });

  it('cancels on Ctrl-C, restores the terminal and ends the line first', async () => {
    const { input, modes, type } = fakeTty();
    const output = fakeOutput();
    const pending = readSecret(input, output, 'key: ');
    let atSettle = '';
    pending.catch(() => (atSettle = output.text()));
    type('abc\u0003');
    await expect(pending).rejects.toBeInstanceOf(TomeError);
    expect(atSettle).toBe('key: \n');
    expect(modes).toEqual([true, false]);
  });

  it('finishes on Ctrl-D and ends the line', async () => {
    const { input, type } = fakeTty();
    const output = fakeOutput();
    const pending = readSecret(input, output, 'key: ');
    type('abc\u0004');
    expect(await pending).toBe('abc');
    expect(output.text()).toBe('key: \n');
  });

  it('never writes what was typed', async () => {
    const { input, type } = fakeTty();
    const output = fakeOutput();
    const pending = readSecret(input, output, 'key: ');
    type('not-a-real-key\r');
    await pending;
    expect(output.text()).not.toContain('not-a-real-key');
  });
});
