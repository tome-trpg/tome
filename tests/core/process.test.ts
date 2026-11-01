import { describe, expect, it } from 'vitest';
import { runStream, scrubEnv } from '../../src/core/process.ts';

const NODE = process.execPath;

function script(body: string): readonly string[] {
  return ['-e', body];
}

describe('runStream', () => {
  it('hands over stdout line by line, also a last line with no newline', async () => {
    const lines: string[] = [];
    const outcome = await runStream(NODE, script("process.stdout.write('one\\r\\ntwo\\nthree')"), process.env, {
      onLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(['one', 'two', 'three']);
    expect(outcome).toMatchObject({ status: 'exited', code: 0 });
  });

  it('keeps a character that a chunk boundary cut in half', async () => {
    const lines: string[] = [];
    const body = `
      const bytes = Buffer.from('引擎\\n');
      process.stdout.write(bytes.subarray(0, 2));
      setTimeout(() => process.stdout.write(bytes.subarray(2)), 50);
    `;
    await runStream(NODE, script(body), process.env, { onLine: (line) => lines.push(line) });
    expect(lines).toEqual(['引擎']);
  });

  it('drops stderr unless told to keep it, because it can carry book text', async () => {
    const body = "console.error('a line of the book'); process.exitCode = 4";
    expect(await runStream(NODE, script(body), process.env)).toEqual({
      status: 'exited',
      code: 4,
      stderr: '',
    });
    const kept = await runStream(NODE, script(body), process.env, { keepStderr: true });
    expect(kept).toMatchObject({ status: 'exited', code: 4 });
    expect(kept).toHaveProperty('stderr', expect.stringContaining('a line of the book'));
  });

  it('reports a command that does not exist', async () => {
    expect(await runStream('tome-no-such-command', [], process.env)).toEqual({ status: 'not_found' });
  });

  it('ends a process that has gone quiet', async () => {
    const outcome = await runStream(NODE, script('setInterval(() => {}, 1000)'), process.env, {
      idleTimeoutMs: 300,
    });
    expect(outcome).toEqual({ status: 'timeout' });
  });

  it('counts each line as life, so a slow process is left alone', async () => {
    const body = `
      let left = 4;
      const tick = setInterval(() => {
        console.log('alive');
        left -= 1;
        if (left === 0) clearInterval(tick);
      }, 250);
    `;
    const outcome = await runStream(NODE, script(body), process.env, { idleTimeoutMs: 2000 });
    expect(outcome).toMatchObject({ status: 'exited', code: 0 });
  });

  it('adds extra variables after the keys are filtered out', async () => {
    const lines: string[] = [];
    const body = 'console.log(JSON.stringify([process.env.SOME_API_KEY, process.env.OFFLINE]))';
    await runStream(NODE, script(body), { ...process.env, SOME_API_KEY: 'not-a-real-key' }, {
      extraEnv: { OFFLINE: '1' },
      onLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(['[null,"1"]']);
  });
});

describe('scrubEnv', () => {
  it('keeps what a process needs and drops what looks like a secret', () => {
    expect(
      scrubEnv({ PATH: '/bin', HF_TOKEN: 'x', MY_API_KEY: 'x', AWS_SECRET_ACCESS_KEY: 'x', DB_PASSWORD: 'x' }),
    ).toEqual({ PATH: '/bin' });
  });
});
