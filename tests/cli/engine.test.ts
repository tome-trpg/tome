import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { run } from '../../src/cli/run.ts';
import type { Envelope } from '../../src/cli/output.ts';
import type { StreamRunner } from '../../src/core/process.ts';
import { forge, forgeFile } from '../forge/index.ts';
import { capture, tempDir, type Captured } from '../helpers.ts';

const FAKE_ENGINE = resolve('tests/fixtures/engines/fake');

function envelope(text: string): Envelope {
  return JSON.parse(text) as Envelope;
}

async function workspace(): Promise<{ env: NodeJS.ProcessEnv; home: string; session(): Captured }> {
  const home = join(tempDir(), 'home');
  const textFile = join(tempDir(), 'forged-text.json');
  writeFileSync(textFile, JSON.stringify((await forge('plain')).truth.text));
  const env = { ...process.env, TOME_HOME: home, FAKE_ENGINE_TEXT_FILE: textFile };
  const session = (): Captured => capture({ env, tool: async () => null });
  await run(['init'], session().io);
  return { env, home, session };
}

describe('tome engine', () => {
  it('adds, lists and removes an engine', async () => {
    const { session } = await workspace();
    const added = session();
    expect(await run(['engine', 'add', FAKE_ENGINE], added.io)).toBe(0);
    expect(added.stdout()).toContain('不是 TOME 隨附的');
    expect(added.stdout()).toContain('fake 1.2.3（cpu）');

    const listed = session();
    expect(await run(['engine', 'list', '--json'], listed.io)).toBe(0);
    expect(envelope(listed.stdout()).data['engines']).toEqual([
      { name: 'fake', version: '1.2.3', device: 'cpu', code_license: 'Apache-2.0', weights_license: 'none' },
    ]);

    const removed = session();
    expect(await run(['engine', 'remove', 'fake'], removed.io)).toBe(0);
    const empty = session();
    expect(await run(['engine', 'list'], empty.io)).toBe(0);
    expect(empty.stdout()).toContain('tome engine add docling');
  });

  it('reports an engine that is nowhere, and asks for the arguments it needs', async () => {
    const { session } = await workspace();
    expect(await run(['engine', 'add', 'no-such-engine'], session().io)).toBe(2);
    expect(await run(['engine', 'add'], session().io)).toBe(2);
    expect(await run(['engine', 'remove'], session().io)).toBe(2);
    expect(await run(['extract'], session().io)).toBe(2);
    expect(await run(['engine', 'remove', 'nothing'], session().io)).toBe(1);
  });

  it('refuses --gpu with no NVIDIA GPU', async () => {
    const { session } = await workspace();
    const attempt = session();
    expect(await run(['engine', 'add', FAKE_ENGINE, '--gpu'], attempt.io)).toBe(1);
    expect(attempt.stdout()).toContain('沒有 GPU 版');
  });

  it('prints the NVIDIA license notice after --gpu', async () => {
    const { env } = await workspace();
    const target = join(tempDir(), 'uvish');
    mkdirSync(target);
    writeFileSync(
      join(target, 'engine.yaml'),
      stringify({
        schema: 'tome-engine/1',
        name: 'uvish',
        pages: ['native'],
        command: ['python', 'main.py'],
        license: { code: 'MIT', weights: 'none', proprietary: ['Forged Library'] },
        setup: { kind: 'uv', extras: { cpu: 'cpu', gpu: 'gpu' } },
      }),
    );
    const stream: StreamRunner = async (_command, args, _env, options) => {
      if (args.includes('--version')) options?.onLine?.('9.9.9');
      return { status: 'exited', code: 0, signal: null, stderr: '' };
    };
    const added = capture({ env, stream, tool: async () => ({ stdout: 'Forged GPU, 8192, 8000\n' }) });
    expect(await run(['engine', 'add', target, '--gpu'], added.io)).toBe(0);
    expect(added.stdout()).toContain('uvish 9.9.9（gpu）');
    expect(added.stdout()).toContain('NVIDIA 專有授權');
    expect(added.stdout()).toContain('TOME 不隨附');
    expect(added.stdout()).toContain('專有授權的元件：Forged Library');
  });

  it('shows up in tome doctor', async () => {
    const { session, env } = await workspace();
    await run(['engine', 'add', FAKE_ENGINE], session().io);
    const { runTool } = await import('../../src/core/process.ts');
    const doctor = capture({ env, tool: runTool });
    await run(['doctor', '--json'], doctor.io);
    const codes = envelope(doctor.stdout()).findings.map((item) => item.code);
    expect(codes).toContain('engine.ok');
    expect(codes).not.toContain('engine.none');
  });
});

describe('tome extract', () => {
  it('runs the engine and keeps stdout clean for --json', async () => {
    const { session } = await workspace();
    await run(['engine', 'add', FAKE_ENGINE], session().io);
    await run(['add', await forgeFile('plain', tempDir()), '--as', 'book'], session().io);
    const extracted = session();
    expect(await run(['extract', 'book', '--json'], extracted.io)).toBe(0);
    const result = envelope(extracted.stdout());
    expect(result.data).toMatchObject({ book: 'book', pages: 3, ran: 3, failed: 0 });
    expect(result.data['engines']).toMatchObject([{ name: 'fake', version: '1.2.3', device: 'cpu' }]);
    expect(result.data['document']).toMatchObject({ reused: false, pages: { ok: 3, skipped: 0, failed: 0 } });
    expect(extracted.stderr()).toContain('已解析 3/3 頁。');
  });

  it('shows how the engine ended, in the message and in --json (ADR-0101)', async () => {
    const { env, session } = await workspace();
    await run(['engine', 'add', FAKE_ENGINE], session().io);
    await run(['add', await forgeFile('plain', tempDir()), '--as', 'book'], session().io);
    const crashing = { ...env, FAKE_ENGINE_SCENARIO: 'crash' };
    const plain = capture({ env: crashing, tool: async () => null });
    expect(await run(['extract', 'book'], plain.io)).toBe(1);
    expect(plain.stdout()).toContain('引擎結束狀態：fake:3。');
    const json = capture({ env: crashing, tool: async () => null });
    expect(await run(['extract', 'book', '--json'], json.io)).toBe(1);
    const failed = envelope(json.stdout()).findings.find((item) => item.code === 'extract.pages_failed');
    expect(failed?.params['exit']).toBe('fake:3');
  });

  it('says what it assembled, and that it reused it the second time', async () => {
    const { session } = await workspace();
    await run(['engine', 'add', FAKE_ENGINE], session().io);
    await run(['add', await forgeFile('plain', tempDir()), '--as', 'book'], session().io);
    const first = session();
    expect(await run(['extract', 'book'], first.io)).toBe(0);
    expect(first.stdout()).toContain('已組裝 document 層');
    const second = session();
    expect(await run(['extract', 'book'], second.io)).toBe(0);
    expect(second.stdout()).toContain('沿用既有的 document 層');
  });

  it('never prints the text of the book', async () => {
    const { session, home } = await workspace();
    await run(['engine', 'add', FAKE_ENGINE], session().io);
    await run(['add', await forgeFile('plain', tempDir()), '--as', 'book'], session().io);
    const extracted = session();
    await run(['extract', 'book'], extracted.io);
    const [firstPage] = (await forge('plain')).truth.text ?? [];
    expect(extracted.stdout() + extracted.stderr()).not.toContain(firstPage?.[0]?.slice(0, 20));
    expect(readFileSync(join(home, 'tome.yaml'), 'utf8')).toContain('fake');
  });

  it('tells you to install an engine', async () => {
    const { session } = await workspace();
    await run(['add', await forgeFile('plain', tempDir()), '--as', 'book'], session().io);
    const extracted = session();
    expect(await run(['extract', 'book'], extracted.io)).toBe(1);
    expect(extracted.stdout()).toContain('tome engine add docling');
  });
});
