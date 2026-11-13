import { describe, expect, it } from 'vitest';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import { openBookStore, type Store } from '../../src/core/store.ts';
import { library, type Library } from '../helpers/library.ts';

// `tome status` 說下一步（ADR-0130 第 16 項、ADR-0138）。只讀 `book.db`，不拿鎖、不連網、不重新估價。
// 狀態直接寫進合成書的 `book.db`，文字都是合成 PDF 的假文字。

function withStore<T>(home: string, action: (store: Store) => T): T {
  const store = openBookStore(home, 'book');
  try {
    return action(store);
  } finally {
    store.close();
  }
}

async function status(lib: Library): Promise<{ readonly exit: number; readonly output: Envelope; readonly text: string }> {
  const json = lib.session();
  const exit = await run(['status', 'book', '--json'], json.io);
  const plain = lib.session();
  await run(['status', 'book'], plain.io);
  return { exit, output: JSON.parse(json.stdout()) as Envelope, text: plain.stdout() };
}

function stage(home: string, name: string): void {
  withStore(home, (store) => store.run("INSERT OR REPLACE INTO stage (name, fingerprint, status, updated_at) VALUES (?, 'x', 'done', 't')", name));
}

function nextOf(output: Envelope): unknown {
  return output.data['next'];
}

describe('tome status names the next step (ADR-0138)', () => {
  it('asks to extract a book not extracted yet', async () => {
    const lib = await library({ extract: false });
    const { exit, output, text } = await status(lib);
    expect(exit).toBe(0);
    expect(nextOf(output)).toEqual({ step: 'extract', command: 'tome extract book' });
    expect(output.findings.at(-1)).toMatchObject({ code: 'status.next', params: { command: 'tome extract book' } });
    expect(text).toContain('tome extract book');
  });

  it('walks Pass 0, the review, the estimate, the batches, the translation and the output in order', async () => {
    const lib = await library();
    expect(nextOf((await status(lib)).output)).toEqual({ step: 'scan', command: 'tome scan-terms book --confirm' });

    stage(lib.home, 'scan-estimate');
    withStore(lib.home, (store) =>
      store.run("INSERT INTO entity (source, status, origin, sources, occurrences, created_at, updated_at) VALUES ('Forged Term', 'candidate', 'pass0', '[]', 1, 't', 't')"),
    );
    expect(nextOf((await status(lib)).output)).toMatchObject({ step: 'scan' });

    withStore(lib.home, (store) => store.run("UPDATE entity SET status = 'proposed', target = 'x'"));
    expect(nextOf((await status(lib)).output)).toEqual({ step: 'review', command: 'tome glossary review book --web' });

    withStore(lib.home, (store) => store.run("UPDATE entity SET status = 'locked', decided_by = 'human'"));
    expect(nextOf((await status(lib)).output)).toEqual({ step: 'estimate', command: 'tome estimate book --confirm' });

    // 估價建出翻譯單位，確認過才往下走。
    await run(['estimate', 'book'], lib.session().io);
    expect(nextOf((await status(lib)).output)).toMatchObject({ step: 'estimate' });
    stage(lib.home, 'estimate');
    expect(nextOf((await status(lib)).output)).toEqual({ step: 'translate', command: 'tome translate book' });

    withStore(lib.home, (store) =>
      store.run("INSERT INTO batch (nonce, state, requests, high_usd, created_at, stage) VALUES ('n1', 'submitted', 1, 0.1, 't', 'translate')"),
    );
    expect(nextOf((await status(lib)).output)).toEqual({ step: 'collect', command: 'tome batch collect book' });

    withStore(lib.home, (store) => {
      store.run("UPDATE batch SET state = 'collected'");
      store.run("UPDATE unit SET state = 'DONE'");
    });
    const done = await status(lib);
    expect(nextOf(done.output)).toEqual({ step: 'assemble', command: 'tome assemble book' });
    expect(done.output.findings.at(-1)).toMatchObject({ code: 'status.next_assemble', params: { book: 'book' } });

    withStore(lib.home, (store) => store.run("UPDATE unit SET state = 'FAILED_QA' WHERE unit_id = (SELECT MIN(unit_id) FROM unit)"));
    const failed = await status(lib);
    expect(nextOf(failed.output)).toEqual({ step: 'retry', command: 'tome translate book --retry-failed' });
    expect(failed.output.findings.at(-1)).toMatchObject({
      code: 'status.next_failed',
      params: { book: 'book', count: '1', command: 'tome translate book --retry-failed' },
    });
  });

  it('keeps --realtime when the last confirmed estimate was realtime', async () => {
    const lib = await library();
    stage(lib.home, 'scan-estimate');
    await run(['estimate', 'book'], lib.session().io);
    withStore(lib.home, (store) =>
      store.run("INSERT INTO estimate (stage, mode, model, requests, low_usd, high_usd, created_at) VALUES ('translate', 'realtime', 'm', 1, 0, 0, 't')"),
    );
    expect(nextOf((await status(lib)).output)).toEqual({ step: 'estimate', command: 'tome estimate book --confirm --realtime' });
    withStore(lib.home, (store) =>
      store.run("INSERT INTO estimate (stage, mode, model, requests, low_usd, high_usd, created_at) VALUES ('translate', 'batch', 'm', 1, 0, 0, 't')"),
    );
    expect(nextOf((await status(lib)).output)).toEqual({ step: 'estimate', command: 'tome estimate book --confirm' });
  });

  it('says each line of the next step as info', async () => {
    const lib = await library({ extract: false });
    const first = await status(lib);
    expect(first.output.findings[0]).toMatchObject({ code: 'status.no_units', level: 'info' });
    expect(first.output.findings.at(-1)).toMatchObject({ code: 'status.next', level: 'info' });
    const done = await library();
    stage(done.home, 'scan-estimate');
    await run(['estimate', 'book'], done.session().io);
    stage(done.home, 'estimate');
    withStore(done.home, (store) => store.run("UPDATE unit SET state = 'DONE'"));
    expect((await status(done)).output.findings.at(-1)).toMatchObject({ code: 'status.next_assemble', level: 'info' });
    withStore(done.home, (store) => store.run("UPDATE unit SET state = 'REFUSED' WHERE unit_id = (SELECT MIN(unit_id) FROM unit)"));
    expect((await status(done)).output.findings.at(-1)).toMatchObject({ code: 'status.next_failed', level: 'info', params: { count: '1' } });
  });

  it('waits for the Pass 0 batches, and wants units before taking an estimate as confirmed', async () => {
    const lib = await library();
    stage(lib.home, 'scan-estimate');
    stage(lib.home, 'estimate');
    // 記過確認，可是還沒有翻譯單位：照樣要估價。
    expect(nextOf((await status(lib)).output)).toMatchObject({ step: 'estimate' });
    withStore(lib.home, (store) =>
      store.run("INSERT INTO batch (nonce, state, requests, high_usd, created_at, stage) VALUES ('s1', 'submitted', 1, 0.1, 't', 'scan')"),
    );
    expect(nextOf((await status(lib)).output)).toEqual({ step: 'scan', command: 'tome scan-terms book --confirm' });
  });

  it('sends what was left in flight again, and counts blocked and refused units as not translated', async () => {
    const lib = await library();
    stage(lib.home, 'scan-estimate');
    await run(['estimate', 'book'], lib.session().io);
    stage(lib.home, 'estimate');
    const only = (state: string): void =>
      withStore(lib.home, (store) => {
        store.run("UPDATE unit SET state = 'DONE'");
        store.run('UPDATE unit SET state = ? WHERE unit_id = (SELECT MIN(unit_id) FROM unit)', state);
      });
    only('IN_FLIGHT');
    expect(nextOf((await status(lib)).output)).toMatchObject({ step: 'translate' });
    only('STALE');
    expect(nextOf((await status(lib)).output)).toMatchObject({ step: 'translate' });
    for (const state of ['BLOCKED', 'REFUSED', 'FAILED_QA']) {
      only(state);
      const { output } = await status(lib);
      expect(nextOf(output)).toMatchObject({ step: 'retry' });
      expect(output.findings.at(-1)?.params).toMatchObject({ count: '1' });
    }
  });

  it('leaves --realtime off while any batch is outstanding', async () => {
    const lib = await library();
    stage(lib.home, 'scan-estimate');
    withStore(lib.home, (store) => {
      store.run("INSERT INTO estimate (stage, mode, model, requests, low_usd, high_usd, created_at) VALUES ('scan', 'realtime', 'm', 1, 0, 0, 't')");
      store.run("INSERT INTO batch (nonce, state, requests, high_usd, created_at, stage) VALUES ('s1', 'submitted', 1, 0.1, 't', 'scan')");
      store.run("INSERT INTO batch (nonce, state, requests, high_usd, created_at, stage) VALUES ('t1', 'submitted', 1, 0.1, 't', 'translate')");
    });
    expect(nextOf((await status(lib)).output)).toEqual({ step: 'scan', command: 'tome scan-terms book --confirm' });
  });

  it('takes no lock, so it answers while another command holds the book', async () => {
    const lib = await library();
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(lib.home, 'books', 'book', 'book.lock'), String(process.pid));
    const { exit, output } = await status(lib);
    expect(exit).toBe(0);
    expect(nextOf(output)).toMatchObject({ step: 'scan' });
  });
});
