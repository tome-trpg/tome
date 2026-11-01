import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/cli/run.ts';
import { maskText } from '../../src/core/mask.ts';
import { openBookStore, type Store } from '../../src/core/store.ts';
import { syncUnits, type TranslationUnit } from '../../src/core/units.ts';
import { forgeFile } from '../forge/index.ts';
import { capture, tempDir } from '../helpers.ts';

// 文字都是這裡編的。

const SOURCE = 'The warden counts the tide stones before each crossing and marks a lantern.';
const GOOD = '<s id="1">守望者在每次渡河前清點潮石，並在提燈上做記號，等待晨鐘響起。</s>';
const BAD = '<s id="1">摘要。</s>';

function envelope(text: string): {
  ok: boolean;
  data: Record<string, unknown>;
  findings: { code: string; level: string; params: Record<string, string> }[];
} {
  return JSON.parse(text);
}

async function library(): Promise<{ env: NodeJS.ProcessEnv; open: () => Store }> {
  const env = { TOME_HOME: join(tempDir(), 'home') };
  await run(['init'], capture({ env }).io);
  await run(['add', await forgeFile('plain', tempDir()), '--as', 'book'], capture({ env }).io);
  return { env, open: () => openBookStore(env.TOME_HOME, 'book') };
}

function unit(unit_id: string): TranslationUnit {
  return { unit_id, block_id: unit_id, role: 'paragraph', source: SOURCE, ...maskText(SOURCE, []) };
}

/** 放一個已經收到回應的單位。 */
function received(store: Store, id: string, fragment: string, state: string, attempts = 1): void {
  syncUnits(store, [
    ...store.all<{ unit_id: string }>('SELECT unit_id FROM unit').map(({ unit_id }) => unit(unit_id)),
    unit(id),
  ]);
  store.run('UPDATE unit SET state = ?, attempts = ? WHERE unit_id = ?', state, attempts, id);
  store.run(
    "INSERT INTO response (unit_id, attempt, text, model, created_at) VALUES (?, ?, ?, 'm', 't')",
    id,
    attempts,
    fragment,
  );
}

async function verify(env: NodeJS.ProcessEnv): Promise<{ exit: number; output: ReturnType<typeof envelope> }> {
  const { io, stdout } = capture({ env });
  const exit = await run(['verify', 'book', '--json'], io);
  return { exit, output: envelope(stdout()) };
}

function stateOf(store: Store, id: string): { state: string; attempts: number; translation: string | null } {
  const row = store.get<{ state: string; attempts: number; translation: string | null }>(
    'SELECT state, attempts, translation FROM unit WHERE unit_id = ?',
    id,
  );
  if (row === undefined) throw new Error(`no unit ${id}`);
  return row;
}

describe('tome verify (ADR-0102)', () => {
  it('says so when there is nothing to check', async () => {
    const { env } = await library();
    const { exit, output } = await verify(env);
    expect(exit).toBe(0);
    expect(output.findings.map(({ code }) => code)).toEqual(['verify.nothing']);
    expect(output.data).toMatchObject({ book: 'book', checked: 0 });
  });

  it('passes a good response, and stores the finished translation', async () => {
    const { env, open } = await library();
    const store = open();
    received(store, 'a', GOOD, 'RECEIVED');
    store.close();
    const { exit, output } = await verify(env);
    expect(exit).toBe(0);
    expect(output.findings[0]).toMatchObject({ code: 'verify.done', params: { checked: '1' } });
    const after = open();
    expect(stateOf(after, 'a')).toMatchObject({ state: 'DONE', attempts: 1 });
    expect(stateOf(after, 'a').translation).toContain('守望者');
    after.close();
  });

  it('sends a failed response back while there are attempts left, and exits 1', async () => {
    const { env, open } = await library();
    const store = open();
    received(store, 'a', BAD, 'RECEIVED', 1);
    store.close();
    const { exit, output } = await verify(env);
    expect(exit).toBe(1);
    expect(output.ok).toBe(false);
    expect(output.findings[0]).toMatchObject({
      code: 'verify.failed',
      level: 'fail',
      params: { checked: '1', passed: '0', failed: '1', gave_up: '0' },
    });
    const after = open();
    expect(stateOf(after, 'a')).toEqual({ state: 'QUEUED', attempts: 1, translation: null });
    after.close();
  });

  it('gives up at the limit', async () => {
    const { env, open } = await library();
    const store = open();
    received(store, 'a', BAD, 'RECEIVED', 3);
    store.close();
    const { output } = await verify(env);
    expect(output.findings[0]?.params).toMatchObject({ failed: '1', gave_up: '1' });
    const after = open();
    expect(stateOf(after, 'a').state).toBe('FAILED_QA');
    after.close();
  });

  it('brings a failed unit back when the rules changed and it passes now', async () => {
    const { env, open } = await library();
    const store = open();
    received(store, 'a', GOOD, 'FAILED_QA', 3);
    store.close();
    expect((await verify(env)).exit).toBe(0);
    const after = open();
    expect(stateOf(after, 'a')).toMatchObject({ state: 'DONE', attempts: 3 });
    after.close();
  });

  it('takes back a done unit that no longer passes', async () => {
    const { env, open } = await library();
    const store = open();
    received(store, 'a', BAD, 'DONE', 1);
    store.run("UPDATE unit SET translation = '舊的' WHERE unit_id = 'a'");
    store.close();
    expect((await verify(env)).exit).toBe(1);
    const after = open();
    expect(stateOf(after, 'a')).toEqual({ state: 'QUEUED', attempts: 1, translation: null });
    after.close();
  });

  it('uses the latest response, costs no attempt and leaves other states alone', async () => {
    const { env, open } = await library();
    const store = open();
    received(store, 'a', BAD, 'RECEIVED', 1);
    received(store, 'a', GOOD, 'RECEIVED', 2);
    received(store, 'flying', GOOD, 'IN_FLIGHT', 1);
    store.close();
    expect((await verify(env)).output.data).toMatchObject({ checked: 1, passed: 1 });
    const after = open();
    expect(stateOf(after, 'a')).toMatchObject({ state: 'DONE', attempts: 2 });
    expect(stateOf(after, 'flying').state).toBe('IN_FLIGHT');
    after.close();
  });

  it('skips done units that have no response, such as memory hits', async () => {
    const { env, open } = await library();
    const store = open();
    syncUnits(store, [unit('a')]);
    store.run("UPDATE unit SET state = 'DONE'");
    store.close();
    expect((await verify(env)).output.data).toMatchObject({ checked: 0 });
  });

  it('stores what it found, and replaces what an earlier run found', async () => {
    const { env, open } = await library();
    const store = open();
    const noted = GOOD.replace('守望者', '<new-term source="warden">守望者</new-term>');
    received(store, 'a', noted, 'RECEIVED');
    store.close();
    await verify(env);
    await verify(env);
    const after = open();
    const issues = after.all<{ code: string; level: string; detail: string }>(
      "SELECT code, level, detail FROM issue WHERE unit_id = 'a'",
    );
    after.close();
    expect(issues).toEqual([
      { code: 'new_term', level: 'report', detail: JSON.stringify({ source: 'warden', target: '守望者' }) },
    ]);
  });

  it('keeps book text out of the message and of --json', async () => {
    const { env, open } = await library();
    const store = open();
    received(store, 'a', '<s id="1">祕密的摘要。</s>', 'RECEIVED');
    store.close();
    const plain = capture({ env });
    await run(['verify', 'book'], plain.io);
    const { output } = await verify(env);
    for (const text of [plain.stdout(), JSON.stringify(output)]) {
      expect(text).not.toContain('祕密');
      expect(text).not.toContain('warden');
    }
    expect(plain.stdout()).toContain('未通過');
  });

  it('refuses a second run while the first is going, and an unknown book', async () => {
    const { env } = await library();
    const unknown = capture({ env });
    expect(await run(['verify', 'nope'], unknown.io)).toBe(2);
    expect(unknown.stderr()).toContain('找不到書籍 nope');
    expect(await run(['verify'], capture({ env }).io)).toBe(2);
  });
});
