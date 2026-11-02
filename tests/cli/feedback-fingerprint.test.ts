import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { library, type Library } from '../helpers/library.ts';

// `prompts/feedback.yaml` 隨程式發送，測試不能真的改它，所以換掉讀到的內容。這個檔案獨立出來，
// 其他測試讀到的還是原本的句子。

const swapped = vi.hoisted(() => ({ text: null as string | null }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const readFileSync = (...args: Parameters<typeof real.readFileSync>): unknown =>
    swapped.text !== null && String(args[0]).endsWith('feedback.yaml') ? swapped.text : real.readFileSync(...args);
  return { ...real, readFileSync };
});

async function estimate(lib: Library, ...args: string[]): Promise<Envelope> {
  const { io, stdout } = lib.session();
  await run(['estimate', 'book', '--realtime', '--json', ...args], io);
  return JSON.parse(stdout()) as Envelope;
}

afterEach(() => {
  swapped.text = null;
});

describe('the sentences of a resend (ADR-0104 item 41)', () => {
  it('ask for a new confirmation when they change', async () => {
    const lib = await library();
    await estimate(lib, '--budget', '100', '--confirm');
    expect((await estimate(lib)).data['confirmed']).toBe(true);
    swapped.text = 'too_short: Translate all of it.\n';
    expect((await estimate(lib)).data['confirmed']).toBe(false);
  });
});
