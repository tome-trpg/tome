import { join } from 'node:path';
import { onTestFinished, describe, expect, it } from 'vitest';
import { applyHuman, saveHuman, sourceHash } from '../../src/core/human.ts';
import { loadTargetLanguage } from '../../src/core/language.ts';
import { openStore, type Store } from '../../src/core/store.ts';
import { checkHumans, type VerifyContext } from '../../src/core/verify.ts';
import { tempDir } from '../helpers.ts';

// 人工譯文的存與套（ADR-0125）。文字都是這裡編的。

function stores(): { store: Store; series: Store } {
  const dir = tempDir();
  const store = openStore(join(dir, 'book.db'), 'book');
  const series = openStore(join(dir, 'series.db'), 'series');
  onTestFinished(() => {
    store.close();
    series.close();
  });
  return { store, series };
}

function addUnit(store: Store, id: string, source: string, state = 'FAILED_QA'): void {
  store.run(
    `INSERT INTO unit (unit_id, block_id, role, seq, source, masked, placeholders, state, translation)
     VALUES (?, ?, 'paragraph', 0, ?, ?, '[]', ?, NULL)`,
    id,
    id,
    source,
    source,
    state,
  );
  store.run("INSERT INTO issue (unit_id, code, level, created_at) VALUES (?, 'too_short', 'resend', 't')", id);
}

interface Row {
  readonly state: string;
  readonly translation: string | null;
  readonly human: number;
  readonly translation_pc: string | null;
}

function unit(store: Store, id: string): Row | undefined {
  return store.get<Row>('SELECT state, translation, human, translation_pc FROM unit WHERE unit_id = ?', id);
}

function issues(store: Store, id: string): number {
  return store.get<{ count: number }>('SELECT COUNT(*) AS count FROM issue WHERE unit_id = ?', id)?.count ?? 0;
}

describe('saveHuman (ADR-0125)', () => {
  it('keeps one translation per unit of a book, the latest', () => {
    const { series } = stores();
    saveHuman(series, 'book', [{ unit_id: 'u1', source: 'Source.', text: '第一次' }]);
    saveHuman(series, 'book', [{ unit_id: 'u1', source: 'Source, changed.', text: '第二次' }]);
    saveHuman(series, 'other', [{ unit_id: 'u1', source: 'Source.', text: '別本書' }]);
    expect(series.all('SELECT book, unit_id, source_sha256, text FROM human ORDER BY book')).toEqual([
      { book: 'book', unit_id: 'u1', source_sha256: sourceHash('Source, changed.'), text: '第二次' },
      { book: 'other', unit_id: 'u1', source_sha256: sourceHash('Source.'), text: '別本書' },
    ]);
  });
});

describe('applyHuman (ADR-0125)', () => {
  it('makes the unit a human translation in DONE, says how many it changed, and leaves its issues to the checks', () => {
    const { store, series } = stores();
    addUnit(store, 'u1', 'Source.');
    store.run("UPDATE unit SET translation_pc = '[]', attempts = 2 WHERE unit_id = 'u1'");
    saveHuman(series, 'book', [{ unit_id: 'u1', source: 'Source.', text: '人工譯文' }]);
    expect(applyHuman(store, series, 'book')).toEqual({ applied: 1, orphaned: 0 });
    expect(unit(store, 'u1')).toEqual({ state: 'DONE', translation: '人工譯文', human: 1, translation_pc: null });
    expect(store.get('SELECT attempts FROM unit')).toEqual({ attempts: 2 });
    // tome sync 與 tome verify 查過才換掉問題（ADR-0126）。
    expect(issues(store, 'u1')).toBe(1);
  });

  it('leaves a unit that already holds the same human translation, and its issues', () => {
    const { store, series } = stores();
    addUnit(store, 'u1', 'Source.');
    saveHuman(series, 'book', [{ unit_id: 'u1', source: 'Source.', text: '人工譯文' }]);
    applyHuman(store, series, 'book');
    store.run("DELETE FROM issue WHERE unit_id = 'u1'");
    store.run("INSERT INTO issue (unit_id, code, level, created_at) VALUES ('u1', 'term_suspect', 'report', 't')");
    expect(applyHuman(store, series, 'book')).toEqual({ applied: 0, orphaned: 0 });
    expect(issues(store, 'u1')).toBe(1);
  });

  it('takes a newer human translation, and makes a machine translation the reader kept as it was a human one', () => {
    const { store, series } = stores();
    addUnit(store, 'u1', 'Source.');
    addUnit(store, 'u2', 'Other.', 'DONE');
    store.run("UPDATE unit SET translation = '機器譯文' WHERE unit_id = 'u2'");
    saveHuman(series, 'book', [{ unit_id: 'u1', source: 'Source.', text: '人工譯文' }]);
    applyHuman(store, series, 'book');
    saveHuman(series, 'book', [
      { unit_id: 'u1', source: 'Source.', text: '再改過的人工譯文' },
      { unit_id: 'u2', source: 'Other.', text: '機器譯文' },
    ]);
    expect(applyHuman(store, series, 'book')).toEqual({ applied: 2, orphaned: 0 });
    expect(unit(store, 'u1')).toMatchObject({ translation: '再改過的人工譯文', human: 1 });
    expect(unit(store, 'u2')).toMatchObject({ translation: '機器譯文', human: 1 });
  });

  it('puts it back once the unit is written anew', () => {
    const { store, series } = stores();
    addUnit(store, 'u1', 'Source.');
    saveHuman(series, 'book', [{ unit_id: 'u1', source: 'Source.', text: '人工譯文' }]);
    applyHuman(store, series, 'book');
    store.run("UPDATE unit SET state = 'PENDING', translation = NULL, human = 0 WHERE unit_id = 'u1'");
    expect(applyHuman(store, series, 'book')).toEqual({ applied: 1, orphaned: 0 });
    expect(unit(store, 'u1')).toMatchObject({ state: 'DONE', human: 1 });
  });

  it('counts a translation whose unit is gone or whose source changed, and does not apply it', () => {
    const { store, series } = stores();
    addUnit(store, 'u1', 'Source changed.');
    saveHuman(series, 'book', [
      { unit_id: 'u1', source: 'Source.', text: '舊原文的譯文' },
      { unit_id: 'gone', source: 'Source.', text: '單位不在了' },
    ]);
    expect(applyHuman(store, series, 'book')).toEqual({ applied: 0, orphaned: 2 });
    expect(unit(store, 'u1')).toEqual({ state: 'FAILED_QA', translation: null, human: 0, translation_pc: null });
    expect(issues(store, 'u1')).toBe(1);
  });

  it.each(['IN_FLIGHT', 'RECEIVED'])('waits for a unit in %s, and applies it after', (state) => {
    const { store, series } = stores();
    addUnit(store, 'u1', 'Source.', state);
    saveHuman(series, 'book', [{ unit_id: 'u1', source: 'Source.', text: '人工譯文' }]);
    expect(applyHuman(store, series, 'book')).toEqual({ applied: 0, orphaned: 0 });
    expect(unit(store, 'u1')).toMatchObject({ state, human: 0 });
    store.run("UPDATE unit SET state = 'FAILED_QA' WHERE unit_id = 'u1'");
    expect(applyHuman(store, series, 'book')).toEqual({ applied: 1, orphaned: 0 });
  });

  it('applies only the translations of the book it is given', () => {
    const { store, series } = stores();
    addUnit(store, 'u1', 'Source.');
    saveHuman(series, 'other', [{ unit_id: 'u1', source: 'Source.', text: '別本書' }]);
    expect(applyHuman(store, series, 'book')).toEqual({ applied: 0, orphaned: 0 });
    expect(unit(store, 'u1')?.human).toBe(0);
  });
});

describe('checkHumans (ADR-0126)', () => {
  const context: VerifyContext = { language: loadTargetLanguage('zh-TW').profile, terms: [], phraseCheck: () => [] };
  const SOURCE = 'The warden counts 3 tide stones before each crossing and marks a lantern.';

  function human(store: Store, id: string, text: string, state = 'DONE'): void {
    addUnit(store, id, SOURCE);
    store.run('UPDATE unit SET state = ?, translation = ?, human = 1 WHERE unit_id = ?', state, text, id);
  }

  function found(store: Store, id: string): { code: string; level: string }[] {
    return store.all('SELECT code, level FROM issue WHERE unit_id = ? ORDER BY id', id);
  }

  it('checks every human translation that is done, replaces what was found before, and leaves the rest', () => {
    const { store } = stores();
    human(store, 'u1', '守望者清點潮石。');
    human(store, 'u2', '守望者在每次渡河前清點 3 顆潮石，並在提燈上做記號。');
    human(store, 'u3', '守望者。', 'IN_FLIGHT');
    addUnit(store, 'u4', SOURCE, 'DONE');
    expect(checkHumans(store, context)).toEqual({ checked: 2, flagged: 1 });
    expect(found(store, 'u1')).toEqual([{ code: 'number_missing', level: 'report' }, { code: 'too_short', level: 'report' }]);
    expect(found(store, 'u2')).toEqual([]);
    expect(found(store, 'u3')).toEqual([{ code: 'too_short', level: 'resend' }]);
    expect(found(store, 'u4')).toEqual([{ code: 'too_short', level: 'resend' }]);
    expect(unit(store, 'u1')).toEqual({ state: 'DONE', translation: '守望者清點潮石。', human: 1, translation_pc: null });
  });

  it('checks only the units it is given, and clears them without checking when the rule pack could not be read', () => {
    const { store } = stores();
    human(store, 'u1', '守望者清點潮石。');
    human(store, 'u2', '守望者清點潮石。');
    expect(checkHumans(store, context, new Set(['u2']))).toEqual({ checked: 1, flagged: 1 });
    expect(found(store, 'u1')).toEqual([{ code: 'too_short', level: 'resend' }]);
    expect(checkHumans(store, null, new Set(['u1']))).toEqual({ checked: 0, flagged: 0 });
    expect(found(store, 'u1')).toEqual([]);
    expect(found(store, 'u2')).toHaveLength(2);
  });
});
