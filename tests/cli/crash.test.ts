import { cpSync } from 'node:fs';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { run } from '../../src/cli/run.ts';
import { openBookStore, type Store } from '../../src/core/store.ts';
import { parseUnits } from '../../src/core/tags.ts';
import { fakeHost, startFakeProvider, translated, type FakeProvider, type FakeScript } from '../helpers/fake-provider.ts';
import { library, type Library } from '../helpers/library.ts';
import { capture, tempDir } from '../helpers.ts';

// 當機注入（白皮書 §8.4、Q-7、ADR-0107 第 22 項）：`book.db` 的第 N 次寫入時丟出錯誤，
// 交易整個回滾，跟真的當機一樣。N 從 1 跑到整個流程的寫入次數，每次中斷後重跑到完成，
// 檢查已經 `DONE` 的單位之後沒有再送出，帳本也沒有替它們重複記帳。正式程式不加測試用的掛勾。

const crash = vi.hoisted(() => ({ at: 0, writes: 0 }));

vi.mock('../../src/core/store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/store.ts')>();
  return {
    ...actual,
    openBookStore: (...args: Parameters<typeof actual.openBookStore>): Store => {
      const store = actual.openBookStore(...args);
      return {
        ...store,
        run: (sql: string, ...params: SQLInputValue[]) => {
          crash.writes += 1;
          if (crash.writes === crash.at) throw new Error('injected crash');
          store.run(sql, ...params);
        },
      };
    },
  };
});

/** 第一個請求被拒，拆成兩個再送，流程才有多個請求、多次寫入。 */
const SCRIPT: FakeScript = (request, index) => (index === 0 ? { refusal: true } : { text: translated(request.user) });

interface Snapshot {
  /**
   * 已經驗證過，或回應已經付費存下來的單位。這裡的回覆都過得了驗證，存下來的回應
   * 重跑驗證就好，不必重送（ADR-0104 第 28 項）。
   */
  readonly done: ReadonlyMap<string, string>;
  readonly charges: ReadonlyMap<string, number>;
  /** 同一個請求替同一個單位記了兩次帳的筆數。一筆費用只能記一次。 */
  readonly twice: number;
}

function snapshot(home: string): Snapshot {
  const store = openBookStore(home, 'book');
  try {
    const done = store.all<{ unit_id: string; masked: string }>(
      "SELECT unit_id, masked FROM unit WHERE state IN ('DONE', 'RECEIVED')",
    );
    const charges = store.all<{ unit_id: string; count: number }>('SELECT unit_id, COUNT(*) AS count FROM ledger GROUP BY unit_id');
    const twice = store.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM (SELECT 1 FROM ledger GROUP BY request_id, unit_id HAVING COUNT(*) > 1)',
    );
    return {
      done: new Map(done.map(({ unit_id, masked }) => [unit_id, masked])),
      charges: new Map(charges.map(({ unit_id, count }) => [unit_id, count])),
      twice: twice?.count ?? 0,
    };
  } finally {
    store.close();
  }
}

function states(home: string): string[] {
  const store = openBookStore(home, 'book');
  try {
    return store.all<{ state: string }>('SELECT state FROM unit ORDER BY seq').map(({ state }) => state);
  } finally {
    store.close();
  }
}

/** 請求裡要翻譯的單位，`<context>` 裡的上文不算。 */
function sentUnits(provider: FakeProvider, from: number): string[] {
  return provider.requests.slice(from).flatMap(({ user }) =>
    parseUnits(user).units.map(({ raw }) => raw.slice(raw.indexOf('>') + 1, raw.lastIndexOf('</s>'))),
  );
}

async function confirmedBase(flags: readonly string[]): Promise<Library> {
  const lib = await library();
  await run(['estimate', 'book', ...flags, '--budget', '100', '--confirm'], lib.session().io);
  return lib;
}

/** 每次從同一個確認好的工作區複製一份，不必每次都重新解析。 */
function copyOf(base: Library): string {
  const home = join(tempDir(), 'home');
  cpSync(base.home, home, { recursive: true });
  return home;
}

async function crashAt(base: Library, at: number, flags: readonly string[]): Promise<boolean> {
  const home = copyOf(base);
  const provider = await startFakeProvider(SCRIPT);
  const session = (): ReturnType<typeof capture> => capture({ env: { ...base.env, TOME_HOME: home }, llm: fakeHost(provider) });
  crash.writes = 0;
  crash.at = at;
  await run(['translate', 'book', ...flags], session().io);
  crash.at = 0;
  const crashed = crash.writes >= at;
  const before = snapshot(home);
  const sentBefore = provider.requests.length;
  const exit = await run(['translate', 'book', ...flags], session().io);
  expect(exit, `after a crash at write ${at}`).toBe(0);
  expect(states(home), `after a crash at write ${at}`).toEqual(['DONE', 'DONE', 'DONE']);
  const after = snapshot(home);
  expect(after.twice, `a request was charged twice after the crash at write ${at}`).toBe(0);
  const resent = sentUnits(provider, sentBefore);
  for (const [unitId, masked] of before.done) {
    expect(resent, `${unitId} was done before the crash at write ${at}`).not.toContain(masked);
    expect(after.charges.get(unitId), `${unitId} was charged again after the crash at write ${at}`).toBe(
      before.charges.get(unitId),
    );
  }
  return crashed;
}

describe('crash injection (Q-7, ADR-0107 item 22)', () => {
  for (const [mode, flags] of [
    ['realtime', ['--realtime']],
    ['batch', []],
  ] as const) {
    it(`never pays again for a verified unit in ${mode} mode, wherever it stops`, async () => {
      const base = await confirmedBase(flags);
      let at = 1;
      while (await crashAt(base, at, flags)) at += 1;
      // 至少走過送出、收回、驗證、記帳這幾步。
      expect(at).toBeGreaterThan(10);
    }, 600_000);
  }

  it('does not pay twice when it stops after the provider made the batch but before the reply (H-17)', async () => {
    const lib = await confirmedBase([]);
    const provider = await startFakeProvider(SCRIPT, { dropCreate: true });
    const host = fakeHost(provider);
    await run(['translate', 'book'], lib.session({ llm: host }).io);
    provider.batch.dropCreate = false;
    expect(await run(['translate', 'book'], lib.session({ llm: host }).io)).toBe(0);
    expect(provider.batches.filter(({ items }) => items[0]?.customId.startsWith('tome-'))).toHaveLength(2);
    expect(provider.requests).toHaveLength(3);
    expect(states(lib.home)).toEqual(['DONE', 'DONE', 'DONE']);
  });
});
