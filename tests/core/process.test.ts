import { describe, expect, it } from 'vitest';
import { describeExit, runStream, scrubEnv, type StreamOutcome } from '../../src/core/process.ts';

const NODE = process.execPath;

function script(body: string): readonly string[] {
  return ['-e', body];
}

function exited(code: number | null, signal: NodeJS.Signals | null = null): StreamOutcome {
  return { status: 'exited', code, signal, stderr: '' };
}

describe('describeExit (ADR-0101)', () => {
  it.each([
    [exited(0), '0'],
    [exited(3), '3'],
    [exited(255), '255'],
    [exited(0xffff), '65535'],
    [exited(0x10000), '65536 (0x00010000)'],
    [exited(3221225477), '3221225477 (0xC0000005)'],
    [exited(3221226505), '3221226505 (0xC0000409)'],
    [exited(-1073741819), '-1073741819 (0xC0000005)'],
    [exited(null, 'SIGSEGV'), 'signal SIGSEGV'],
    [exited(null), 'unknown'],
    [{ status: 'timeout' } as const, 'timeout'],
    [{ status: 'not_found' } as const, 'not_found'],
  ])('%j', (outcome, text) => {
    expect(describeExit(outcome)).toBe(text);
  });

  it('never shows stderr, which can carry book text', () => {
    const outcome: StreamOutcome = { status: 'exited', code: 1, signal: null, stderr: 'a line of the book' };
    expect(describeExit(outcome)).toBe('1');
  });
});

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
      signal: null,
      stderr: '',
    });
    const kept = await runStream(NODE, script(body), process.env, { keepStderr: true });
    expect(kept).toMatchObject({ status: 'exited', code: 4 });
    expect(kept).toHaveProperty('stderr', expect.stringContaining('a line of the book'));
  });

  it('says which signal ended a process (ADR-0101)', async () => {
    const outcome = await runStream(NODE, script("process.kill(process.pid, 'SIGKILL')"), process.env);
    // Windows 沒有訊號，行程被終止時 Node 回報的是結束碼 1。
    expect(outcome).toEqual(
      process.platform === 'win32'
        ? { status: 'exited', code: 1, signal: null, stderr: '' }
        : { status: 'exited', code: null, signal: 'SIGKILL', stderr: '' },
    );
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
