import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { vaultTexts } from '../../src/cli/messages.ts';
import type { EntityCard } from '../../src/core/entities.ts';
import type { DocumentBlock, IrDocument } from '../../src/core/ir.ts';
import {
  collectReport,
  compareEstimate,
  renderReport,
  reportCounts,
  reportedBlocks,
  type BookReport,
  type EstimateItem,
} from '../../src/core/report.ts';
import { openStore, type Store } from '../../src/core/store.ts';
import { tempDir } from '../helpers.ts';

// 交付報告（ADR-0123）。文字都是這裡編的。

function block(id: string, role: string, page = 0): DocumentBlock {
  return {
    id,
    content_hash: 'c'.repeat(64),
    role: role as DocumentBlock['role'],
    flow: 'main',
    spans: [{ page, bbox: [0, 0, 10, 10] }],
    text: id,
    raw: id,
    lang: 'en',
    writing_mode: 'horizontal-tb',
    provenance: { engine: 'fake', version: '1', config_hash: 'b'.repeat(64) },
  };
}

const DOCUMENT: IrDocument = {
  schema: 'tome-ir/1',
  layer: 'document',
  pdf_sha256: 'a'.repeat(64),
  pages: [
    { page: 0, status: 'ok' },
    { page: 1, status: 'skipped', reason: 'full_image' },
    { page: 2, status: 'failed', reason: 'characters_missing', missing: 3, total: 10 },
    { page: 3, status: 'ok', reason: 'accepted' },
  ],
  page_map: [
    { page: 0, label: '7' },
    { page: 1, label: '8' },
  ],
  sections: [],
  blocks: [block('p1', 'paragraph'), block('p2', 'paragraph'), block('p3', 'paragraph'), block('f1', 'figure', 3)],
};

function store(): Store {
  const db = openStore(join(tempDir(), 'book.db'), 'book');
  // 暫存資料夾刪除之前先關，Windows 才刪得掉。
  onTestFinished(() => db.close());
  return db;
}

function addUnit(db: Store, id: string, seq: number, source: string, state: string, translation: string | null, placeholders = '[]'): void {
  db.run(
    `INSERT INTO unit (unit_id, block_id, role, seq, source, masked, placeholders, state, translation)
     VALUES (?, ?, 'paragraph', ?, ?, ?, ?, ?, ?)`,
    id,
    id,
    seq,
    source,
    source,
    placeholders,
    state,
    translation,
  );
}

function addIssue(db: Store, unitId: string, code: string, level: string, detail: Record<string, string> | null = null): void {
  db.run(
    "INSERT INTO issue (unit_id, code, level, detail, created_at) VALUES (?, ?, ?, ?, 't')",
    unitId,
    code,
    level,
    detail === null ? null : JSON.stringify(detail),
  );
}

function addCost(db: Store, unitId: string, cost: number, at: string): void {
  db.run(
    `INSERT INTO ledger (request_id, unit_id, model, mode, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at)
     VALUES ('r', ?, 'm', 'batch', 0, 0, 0, 0, ?, ?)`,
    unitId,
    cost,
    at,
  );
}

function card(id: number, source: string, target: string, status = 'locked'): EntityCard {
  return { id, source, target, class: 'person', gender: null, pronoun: null, register: null, keep_source: false, match: null, status };
}

function filled(): { db: Store; report: BookReport } {
  const db = store();
  addUnit(db, 'p1', 0, 'The Warden waits at the ford.', 'DONE', '守衛在渡口等待。');
  addUnit(db, 'p2', 1, 'Rain falls.', 'FAILED_QA', null);
  addUnit(db, 'p3', 2, 'A secret name.', 'BLOCKED', null);
  addUnit(db, 'p4', 3, '12', 'DONE', '12', JSON.stringify([]));
  addIssue(db, 'p1', 'term_suspect', 'report', { term: '軟件', prefer: '軟體' });
  addIssue(db, 'p1', 'translationese', 'report', { text: '作為一個', prefer: '身為' });
  addIssue(db, 'p1', 'untranslatable', 'report', { reason: 'pun', text: '雙關\n語' });
  addIssue(db, 'p1', 'new_term', 'report', { source: 'Salt Marsh', target: '鹽沼' });
  addIssue(db, 'p4', 'new_term', 'report', { source: 'Salt Marsh', target: '鹽澤' });
  addIssue(db, 'p2', 'term_missing', 'resend', { term: 'Warden', target: '看守人' });
  addIssue(db, 'p2', 'too_short', 'resend');
  addIssue(db, 'p2', 'too_long', 'report');
  addCost(db, 'p1', 0.4, '2026-11-09T01:00:00.000Z');
  addCost(db, 'term:1', 0.1, '2026-11-09T00:30:00.000Z');
  addCost(db, 'summary', 0.05, '2026-11-09T00:30:00.000Z');
  db.run(
    "INSERT INTO estimate (stage, mode, model, requests, low_usd, high_usd, created_at) VALUES ('translate', 'batch', 'm', 1, 0.2, 0.6, '2026-11-09T00:50:00.000Z')",
  );
  db.run(
    "INSERT INTO estimate (stage, mode, model, requests, low_usd, high_usd, created_at) VALUES ('scan', 'realtime', 'm', 1, 0.1, 0.1, '2026-11-09T00:20:00.000Z')",
  );
  const cards = [card(1, 'Warden', '看守人'), card(2, 'Ferry', '渡船', 'proposed')];
  return { db, report: collectReport(db, DOCUMENT, cards, 5) };
}

describe('collectReport (ADR-0123)', () => {
  it('counts the units, and splits what was spent between translation and Pass 0', () => {
    const { report } = filled();
    expect(report.coverage).toEqual({ total: 4, kept: 1, fielded: 0, human: 0, done: 2, in_flight: 0, blocked: 1, failed: 1, refused: 0, left: 0 });
    expect(report.spent.translate).toBeCloseTo(0.4);
    expect(report.spent.scan).toBeCloseTo(0.15);
    expect(report.spent.budget).toBe(5);
    expect(report.pending_cards).toBe(1);
  });

  it('sets each confirmed estimate against what was spent after it, until the next one of the same stage', () => {
    const { db, report } = filled();
    expect(report.estimates.map(({ stage, spent_usd, position }) => [stage, Number(spent_usd.toFixed(2)), position])).toEqual([
      ['translate', 0.4, 50],
      ['scan', 0.15, null],
    ]);
    db.run(
      "INSERT INTO estimate (stage, mode, model, requests, low_usd, high_usd, created_at) VALUES ('translate', 'batch', 'm', 1, 0.2, 0.6, '2026-11-09T00:55:00.000Z')",
    );
    const later = collectReport(db, DOCUMENT, [], null).estimates;
    expect(later.map(({ spent_usd }) => Number(spent_usd.toFixed(2)))).toEqual([0, 0.15, 0.4]);
  });

  it('lists the units not translated, with the reasons to resend a failed one and none for a blocked one', () => {
    const { report } = filled();
    expect(report.untranslated).toEqual([
      { block_id: 'p2', state: 'FAILED_QA', codes: ['term_missing', 'too_short'] },
      { block_id: 'p3', state: 'BLOCKED', codes: [] },
    ]);
  });

  it('lists the pages and figures not translated, by the printed page', () => {
    const { report } = filled();
    expect(report.pages).toEqual([
      { label: '8', status: 'skipped', reason: 'full_image' },
      { label: '3', status: 'failed', reason: 'characters_missing' },
    ]);
    expect(report.figures).toEqual([
      { block_id: 'f1', label: '4' },
      { block_id: null, label: '8' },
    ]);
  });

  it('keeps the flags and the checks that only report from translated units, in reading order', () => {
    const { report } = filled();
    expect(report.flags).toEqual([{ block_id: 'p1', code: 'untranslatable', detail: { reason: 'pun', text: '雙關\n語' } }]);
    expect(report.checks.map(({ code }) => code)).toEqual(['term_suspect', 'translationese']);
  });

  it('finds a name the model translated two ways, and a locked name a translation left out', () => {
    const { report } = filled();
    expect(report.variants).toEqual([{ source: 'Salt Marsh', targets: [{ target: '鹽沼', units: 1 }, { target: '鹽澤', units: 1 }] }]);
    expect(report.unused).toEqual([{ source: 'Warden', target: '看守人', blocks: ['p1'] }]);
  });

  it('leaves out a name once a card for it is locked, and a name told one way only', () => {
    const { db } = filled();
    expect(collectReport(db, DOCUMENT, [card(3, 'Salt Marsh', '鹽沼')], null).variants).toEqual([]);
    db.run("DELETE FROM issue WHERE unit_id = 'p4'");
    expect(collectReport(db, DOCUMENT, [], null).variants).toEqual([]);
  });

  it('counts each part for tome report, with no book text', () => {
    const { report } = filled();
    expect(reportCounts(report)).toEqual({
      untranslated: 2,
      pages: 2,
      figures: 2,
      flags: 1,
      term_suspect: 1,
      translationese: 1,
      too_long: 0,
      number_extra: 0,
      pronoun_mismatch: 0,
      human_checks: 0,
      variants: 1,
      unused: 1,
      human_old_names: 0,
      pending_cards: 1,
      sync_unrecovered: 0,
    });
    expect(reportedBlocks(report)).toEqual(new Set(['p2', 'p3', 'f1', 'p1']));
  });
});

describe('collectReport: the edges (ADR-0123)', () => {
  it('lists a refused unit, and gives each cell of a table its own reasons', () => {
    const db = store();
    db.run(
      `INSERT INTO unit (unit_id, block_id, role, seq, source, masked, placeholders, state)
       VALUES ('t1-r0c0', 't1', 'paragraph', 0, 'A', 'A', '[]', 'FAILED_QA'),
              ('t1-r0c1', 't1', 'paragraph', 1, 'B', 'B', '[]', 'FAILED_QA'),
              ('t1-r0c2', 't1', 'paragraph', 2, 'D', 'D', '[]', 'BLOCKED'),
              ('p9', 'p9', 'paragraph', 3, 'C', 'C', '[]', 'REFUSED')`,
    );
    addIssue(db, 't1-r0c0', 'too_short', 'resend');
    addIssue(db, 't1-r0c1', 'script_mixed', 'resend');
    expect(collectReport(db, DOCUMENT, [], null).untranslated).toEqual([
      { block_id: 't1', state: 'FAILED_QA', codes: ['too_short'] },
      { block_id: 't1', state: 'FAILED_QA', codes: ['script_mixed'] },
      { block_id: 't1', state: 'BLOCKED', codes: [] },
      { block_id: 'p9', state: 'REFUSED', codes: [] },
    ]);
  });

  it('lists a page that holds only an image among the figures', () => {
    const document = { ...DOCUMENT, pages: [{ page: 0, status: 'skipped' as const, reason: 'image_only' }], blocks: [] };
    expect(collectReport(store(), document, [], null).figures).toEqual([{ block_id: null, label: '7' }]);
  });

  it('reads only the text values of a detail, and nothing from a detail that is not an object', () => {
    const db = store();
    addUnit(db, 'p1', 0, 'x', 'DONE', 'y');
    db.run(
      `INSERT INTO issue (unit_id, code, level, detail, created_at)
       VALUES ('p1', 'untranslatable', 'report', '{"reason":5,"text":"z"}', 't'),
              ('p1', 'untranslatable', 'report', '"ab"', 't'),
              ('p1', 'untranslatable', 'report', 'not json', 't')`,
    );
    expect(collectReport(db, DOCUMENT, [], null).flags.map(({ detail }) => detail)).toEqual([{ text: 'z' }, {}, {}]);
  });

  it('lists the checks of human translations apart from those of the model, with the codes that are resent otherwise (ADR-0126)', () => {
    const db = store();
    addUnit(db, 'p1', 0, 'The Warden waits.', 'DONE', '看守人在等。');
    addUnit(db, 'p2', 1, 'The Warden left.', 'DONE', '守衛走了。');
    addUnit(db, 'p3', 2, 'Rain falls.', 'FAILED_QA', null);
    db.run("UPDATE unit SET human = 1 WHERE unit_id = 'p2'");
    addIssue(db, 'p1', 'term_suspect', 'report', { term: '軟件', prefer: '軟體' });
    addIssue(db, 'p2', 'term_missing', 'report', { term: 'Warden', target: '看守人' });
    addIssue(db, 'p2', 'term_suspect', 'report', { term: '視頻', prefer: '影片' });
    for (const code of ['placeholder_mismatch', 'number_missing', 'script_mixed', 'too_short']) addIssue(db, 'p2', code, 'report');
    addIssue(db, 'p2', 'new_term', 'report', { source: 'Salt Marsh', target: '鹽沼' });
    addIssue(db, 'p2', 'untranslatable', 'report', { reason: 'pun', text: 'x' });
    addIssue(db, 'p3', 'too_short', 'resend');
    const report = collectReport(db, DOCUMENT, [], null);
    expect(report.checks).toEqual([{ block_id: 'p1', code: 'term_suspect', detail: { term: '軟件', prefer: '軟體' } }]);
    expect(report.human).toEqual([
      { block_id: 'p2', code: 'term_missing', detail: { term: 'Warden', target: '看守人' } },
      { block_id: 'p2', code: 'term_suspect', detail: { term: '視頻', prefer: '影片' } },
      { block_id: 'p2', code: 'placeholder_mismatch', detail: {} },
      { block_id: 'p2', code: 'number_missing', detail: {} },
      { block_id: 'p2', code: 'script_mixed', detail: {} },
      { block_id: 'p2', code: 'too_short', detail: {} },
    ]);
    expect(report.flags).toEqual([]);
    expect(reportCounts(report)).toMatchObject({ term_suspect: 1, human_checks: 6 });
    expect(reportedBlocks(report)).toEqual(new Set(['p3', 'f1', 'p1', 'p2']));
  });

  it('lists human translations that still use the name a locked card had before, once, and not as an unused name (ADR-0126)', () => {
    const db = store();
    const entity = (id: number, source: string, target: string, previous: string | null, status = 'locked'): void => {
      db.run(
        `INSERT INTO entity (id, source, target, status, origin, sources, occurrences, previous_target, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'human', '[]', 1, ?, 't', 't')`,
        id,
        source,
        target,
        status,
        previous,
      );
    };
    entity(1, 'Salt Marsh', '鹽沼地', '鹽沼');
    entity(2, 'Warden', '看守人', null);
    entity(3, 'Ferry', '渡船', '渡船');
    entity(4, 'Tide', '潮水', '');
    entity(5, 'Tide Pool', '大潮', '潮');
    entity(6, 'Marsh Hound', '鹽沼', null);
    entity(7, 'Salt Marsh Town', '鹽沼鎮', null, 'proposed');
    addUnit(db, 'p1', 0, 'The Salt Marsh floods.', 'DONE', '鹽沼淹水了。');
    addUnit(db, 'p2', 1, 'The Salt Marsh dries.', 'DONE', '鹽沼地乾了。');
    addUnit(db, 'p3', 2, 'The Salt Marsh again.', 'DONE', '又是鹽沼。');
    addUnit(db, 'p4', 3, 'Salt Marsh and the Salt Marsh.', 'DONE', '鹽沼地與鹽沼。');
    addUnit(db, 'p5', 4, 'The Warden and the Ferry and the Tide.', 'DONE', '守衛、渡口與潮。');
    addUnit(db, 'p6', 5, 'The Salt Marsh waits.', 'FAILED_QA', '鹽沼在等。');
    addUnit(db, 'p7', 6, 'The Tide Pool rises.', 'DONE', '大潮來了。');
    addUnit(db, 'p8', 7, 'Rain falls.', 'DONE', '雨落在鹽沼。');
    addUnit(db, 'p9', 8, 'The Ferry waits.', 'DONE', '渡船在等。');
    addUnit(db, 'p10', 9, 'Salt Marsh Town is far.', 'DONE', '鹽沼鎮很遠。');
    db.run("UPDATE unit SET human = 1 WHERE unit_id <> 'p3'");
    // 列進舊譯名一節的單位，同一張卡目前的譯名的「沒有用鎖定的譯名」不再列一次；別的卡、別的問題照列。
    addIssue(db, 'p1', 'term_missing', 'report', { term: 'Salt Marsh', target: '鹽沼地' });
    addIssue(db, 'p1', 'term_missing', 'report', { term: 'Tide Pool', target: '大潮' });
    addIssue(db, 'p1', 'number_missing', 'report', { numbers: '3' });
    addIssue(db, 'p2', 'term_missing', 'report', { term: 'Salt Marsh', target: '鹽沼地' });
    addIssue(db, 'p5', 'term_missing', 'report', { term: 'Warden', target: '看守人' });
    addIssue(db, 'p10', 'term_missing', 'report', { term: 'Salt Marsh', target: '鹽沼地' });
    const cards = [
      card(1, 'Salt Marsh', '鹽沼地'),
      card(2, 'Warden', '看守人'),
      card(3, 'Ferry', '渡船'),
      card(4, 'Tide', '潮水'),
      card(5, 'Tide Pool', '大潮'),
      card(6, 'Marsh Hound', '鹽沼'),
      card(7, 'Salt Marsh Town', '鹽沼鎮', 'proposed'),
    ];
    const report = collectReport(db, DOCUMENT, cards, null);
    // p2 的「鹽沼」在目前的譯名「鹽沼地」裡，p7 的「潮」在「大潮」的結尾；p3 是模型譯文；p6 沒有翻好；p8 沒有命中這張卡；
    // 別的卡目前叫「鹽沼」不算較長譯名；還沒鎖定的「鹽沼鎮」也不算；「渡船」的上一個譯名就是它自己。
    expect(report.old_names).toEqual([{ source: 'Salt Marsh', before: '鹽沼', target: '鹽沼地', blocks: ['p1', 'p4', 'p10'] }]);
    expect(report.unused).toEqual([
      { source: 'Salt Marsh', target: '鹽沼地', blocks: ['p3'] },
      { source: 'Warden', target: '看守人', blocks: ['p5'] },
      { source: 'Ferry', target: '渡船', blocks: ['p5'] },
      // p7 的「Tide」只出現在「Tide Pool」裡，命中的是長的那張卡，不算「Tide」沒用上（ADR-0133）。
      { source: 'Tide', target: '潮水', blocks: ['p5'] },
    ]);
    expect(report.human).toEqual([
      { block_id: 'p1', code: 'term_missing', detail: { term: 'Tide Pool', target: '大潮' } },
      { block_id: 'p1', code: 'number_missing', detail: { numbers: '3' } },
      { block_id: 'p2', code: 'term_missing', detail: { term: 'Salt Marsh', target: '鹽沼地' } },
      { block_id: 'p5', code: 'term_missing', detail: { term: 'Warden', target: '看守人' } },
    ]);
    expect(reportCounts(report)).toMatchObject({ unused: 4, human_old_names: 3, human_checks: 4 });
    expect(reportedBlocks(report)).toEqual(new Set(['p6', 'f1', 'p3', 'p5', 'p1', 'p2', 'p4', 'p10']));
  });

  it('knows no old name of a card that is no longer locked', () => {
    const db = store();
    db.run(
      `INSERT INTO entity (id, source, target, status, origin, sources, occurrences, previous_target, created_at, updated_at)
       VALUES (1, 'Salt Marsh', '鹽沼地', 'proposed', 'human', '[]', 1, '鹽沼', 't', 't')`,
    );
    addUnit(db, 'p1', 0, 'The Salt Marsh floods.', 'DONE', '鹽沼淹水了。');
    db.run("UPDATE unit SET human = 1 WHERE unit_id = 'p1'");
    expect(collectReport(db, DOCUMENT, [card(1, 'Salt Marsh', '鹽沼地', 'proposed')], null).old_names).toEqual([]);
  });

  // 短卡只出現在長卡裡時，人工譯文照長卡寫：短卡改過譯名，也不算內含它的舊譯名（ADR-0133）。
  it('does not list an old name of a shorter card that only sits inside a longer card', () => {
    const db = store();
    for (const [id, source, target, previous] of [
      [1, 'Warden', '看守人', '守衛'],
      [2, 'Grey Warden', '灰袍守望者', null],
    ] as const) {
      db.run(
        `INSERT INTO entity (id, source, target, status, origin, sources, occurrences, previous_target, created_at, updated_at)
         VALUES (?, ?, ?, 'locked', 'human', '[]', 1, ?, 't', 't')`,
        id,
        source,
        target,
        previous,
      );
    }
    // p1 的「守衛」是人自己寫的別的字，不是「Warden」的舊譯名：原文的 Warden 只在 Grey Warden 裡。
    addUnit(db, 'p1', 0, 'The Grey Warden waits.', 'DONE', '灰袍守望者帶著守衛在等。');
    addUnit(db, 'p2', 1, 'A Warden waits.', 'DONE', '一名守衛在等。');
    db.run("UPDATE unit SET human = 1");
    const report = collectReport(db, DOCUMENT, [card(1, 'Warden', '看守人'), card(2, 'Grey Warden', '灰袍守望者')], null);
    expect(report.old_names).toEqual([{ source: 'Warden', before: '守衛', target: '看守人', blocks: ['p2'] }]);
  });

  // 短卡只出現在長卡裡時不算命中：譯文照長卡寫，不算短卡沒用上（ADR-0133）。
  it('does not call a shorter card unused where it only sits inside a longer card', () => {
    const db = store();
    addUnit(db, 'p1', 0, 'The Grey Warden waits.', 'DONE', '灰袍守望者在等。');
    addUnit(db, 'p2', 1, 'A Warden waits.', 'DONE', '一名守衛在等。');
    const report = collectReport(db, DOCUMENT, [card(1, 'Warden', '看守人'), card(2, 'Grey Warden', '灰袍守望者')], null);
    expect(report.unused).toEqual([{ source: 'Warden', target: '看守人', blocks: ['p2'] }]);
  });

  it('counts the failed cards as pending, and leaves out a locked card every translation uses', () => {
    const db = store();
    addUnit(db, 'p1', 0, 'The Warden waits.', 'DONE', '看守人在等。');
    addUnit(db, 'p2', 1, 'The Warden left.', 'FAILED_QA', '守衛走了。');
    const cards = [card(1, 'Warden', '看守人'), card(2, 'Ferry', '渡船'), card(3, 'Tide', '潮', 'failed')];
    const report = collectReport(db, DOCUMENT, cards, null);
    expect(report.unused).toEqual([]);
    expect(report.pending_cards).toBe(1);
  });

  it('needs both a name and a translation in a new term, and a locked card, not a proposed one, to leave a name out', () => {
    const db = store();
    addUnit(db, 'p1', 0, 'x', 'DONE', 'y');
    addUnit(db, 'p2', 1, 'x', 'DONE', 'y');
    addIssue(db, 'p1', 'new_term', 'report', { source: 'Old Ferry', target: '老渡口' });
    addIssue(db, 'p2', 'new_term', 'report', { source: 'Old Ferry' });
    addIssue(db, 'p2', 'new_term', 'report', { source: ' Old Ferry ', target: '  ' });
    addIssue(db, 'p2', 'new_term', 'report', { target: '老渡' });
    addIssue(db, 'p1', 'new_term', 'report', { source: '  ', target: '渡頭' });
    addIssue(db, 'p1', 'new_term', 'report', { target: '渡口' });
    addIssue(db, 'p1', 'new_term', 'report', { source: 'Salt Marsh', target: '鹽沼' });
    addIssue(db, 'p2', 'new_term', 'report', { source: 'Salt Marsh', target: '鹽澤' });
    const report = collectReport(db, DOCUMENT, [card(1, 'Salt Marsh', '鹽沼', 'proposed')], null);
    expect(report.variants).toEqual([{ source: 'Salt Marsh', targets: [{ target: '鹽沼', units: 1 }, { target: '鹽澤', units: 1 }] }]);
  });
});

describe('compareEstimate (ADR-0132)', () => {
  /** 位置照 `collectReport` 的算法。 */
  function item(low: number, high: number, spent: number): EstimateItem {
    const width = high - low;
    const position = width > 0 ? Math.round(((spent - low) / width) * 100) : null;
    return { stage: 'translate', mode: 'batch', created_at: 't', low_usd: low, high_usd: high, spent_usd: spent, position };
  }

  // 前四列是 M3 收尾的數字（ADR-0129 第 4、5 項）。
  it.each([
    ['the rule book went over', item(0.8194, 1.3315, 1.8383), { comparison: 'over', percent: 38 }],
    ['its Pass 0 stayed under', item(0.1786, 0.2902, 0.1713), { comparison: 'under', percent: 4 }],
    ['the short story Pass 0 stayed under by less than 1%', item(0.0438, 0.0712, 0.0437), { comparison: 'under_small', percent: null }],
    ['the short story landed inside', item(0.3315, 0.5386, 0.5061), { comparison: 'within', percent: 84 }],
    ['a spending over by less than 1%', item(1, 2, 2.019), { comparison: 'over_small', percent: null }],
    ['a spending over by exactly 1%', item(1, 2, 2.02), { comparison: 'over', percent: 1 }],
    ['a spending under by exactly 1%', item(1, 2, 0.99), { comparison: 'under', percent: 1 }],
    ['a spending on the upper bound', item(1, 2, 2), { comparison: 'within', percent: 100 }],
    ['a spending on the lower bound', item(1, 2, 1), { comparison: 'within', percent: 0 }],
    ['no spending yet', item(1, 2, 0), { comparison: 'none', percent: null }],
    ['an estimate with no width, met exactly', item(1, 1, 1), { comparison: 'unknown', percent: null }],
    ['an estimate with no width, gone over', item(1, 1, 1.5), { comparison: 'over', percent: 50 }],
    ['a spending under by half, rounding the percent to 50', item(1, 2, 0.5), { comparison: 'under', percent: 50 }],
    // 上限是 0 時不拿它去除：不說超出無限大，照區間寬度 0 處理。
    ['an estimate of nothing that was spent on anyway', item(0, 0, 0.5), { comparison: 'unknown', percent: null }],
  ])('tells %s', (_name, estimate, expected) => {
    expect(compareEstimate(estimate)).toEqual(expected);
  });
});

describe('renderReport (ADR-0123)', () => {
  const place = (id: string): string => `[[01#^${id}|01]]`;
  const FULL: BookReport = {
    coverage: { total: 4, kept: 1, fielded: 0, human: 0, done: 2, in_flight: 0, blocked: 1, failed: 1, refused: 0, left: 0 },
    spent: { translate: 0.4, scan: 0.15, budget: 5 },
    estimates: [
      { stage: 'translate', mode: 'batch', created_at: '2026-11-09T00:50:00.000Z', low_usd: 0.2, high_usd: 0.6, spent_usd: 0.4, position: 50 },
      { stage: 'scan', mode: 'realtime', created_at: '2026-11-09T00:20:00.000Z', low_usd: 0.1, high_usd: 0.1, spent_usd: 0.15, position: null },
    ],
    pending_cards: 1,
    untranslated: [
      { block_id: 'p2', state: 'FAILED_QA', codes: ['term_missing', 'too_short'] },
      { block_id: 'p3', state: 'BLOCKED', codes: [] },
    ],
    pages: [{ label: '8', status: 'skipped', reason: 'full_image' }],
    figures: [
      { block_id: 'f1', label: '4' },
      { block_id: null, label: '8' },
    ],
    flags: [{ block_id: 'p1', code: 'untranslatable', detail: { reason: 'pun', text: ' 雙關\n語 ' } }],
    checks: [
      { block_id: 'p1', code: 'term_suspect', detail: { term: '軟件', prefer: '軟體' } },
      { block_id: 'p1', code: 'pronoun_mismatch', detail: { term: 'Mara', expected: '她', found: '他 牠' } },
    ],
    variants: [{ source: ' Salt Marsh ', targets: [{ target: '鹽沼', units: 2 }, { target: '鹽澤', units: 1 }] }],
    human: [],
    unused: [{ source: 'Warden', target: '看守人', blocks: ['p1', 'p4'] }],
    old_names: [],
    sync: [],
  };

  it('lists what tome sync could not take back, placed between, after or before its neighbors, or by file (ADR-0125)', () => {
    const report: BookReport = {
      ...FULL,
      sync: [
        { path: '01.md', kind: 'merged', before: 'p1', after: 'p2' },
        { path: '01.md', kind: 'added', before: 'p3', after: null },
        { path: '02.md', kind: 'deleted', before: null, after: 'p4' },
        { path: '00-交付報告.md', kind: 'file', before: null, after: null },
        { path: '02.md', kind: 'unknown_kind', before: null, after: null },
      ],
    };
    const text = renderReport(report, vaultTexts.report, place);
    expect(text).toContain(
      [
        '## 這次覆蓋的、tome sync 無法回收的修改（5）',
        '',
        '- 01.md：合併段落，位於 [[01#^p1|01]] 與 [[01#^p2|01]] 之間',
        '- 01.md：新增段落，位於 [[01#^p3|01]] 之後',
        '- 02.md：刪除段落，位於 [[01#^p4|01]] 之前',
        '- 00-交付報告.md：修改了章節以外的檔案',
        '- 02.md：unknown_kind',
        '',
        '> 上列修改已被這次輸出覆蓋。合併、拆分或略過段落請改用 overrides.yaml，修改段落的文字後再執行 tome sync。',
      ].join('\n'),
    );
    expect(renderReport(FULL, vaultTexts.report, place)).not.toContain('tome sync 無法回收');
    expect(reportedBlocks(report)).toEqual(new Set(['p2', 'p3', 'f1', 'p1', 'p4']));
    expect(reportCounts(report)).toMatchObject({ sync_unrecovered: 5 });
  });

  it('writes the checks of human translations and their old names only when there are some, after the sections they go with (ADR-0126)', () => {
    const none = renderReport(FULL, vaultTexts.report, place);
    expect(none).not.toContain('人工譯文的檢查');
    expect(none).not.toContain('內含舊譯名的人工譯文');
    const human: BookReport['human'] = [
      { block_id: 'p2', code: 'term_missing', detail: { term: 'Warden', target: '看守人' } },
      { block_id: 'p2', code: 'placeholder_mismatch', detail: { missing: '1D100' } },
      { block_id: 'p3', code: 'number_missing', detail: { numbers: '3' } },
      { block_id: 'p3', code: 'script_mixed', detail: { found: 'X' } },
      { block_id: 'p3', code: 'too_short', detail: {} },
    ];
    const old_names: BookReport['old_names'] = [{ source: ' Salt\nMarsh ', before: '鹽沼', target: '鹽沼地', blocks: ['p1', 'p4'] }];
    const text = renderReport({ ...FULL, human, old_names }, vaultTexts.report, place);
    expect(text).toContain(
      [
        '## 人工譯文的檢查（5）',
        '',
        '- [[01#^p2|01]]：「Warden」沒有用鎖定的譯名「看守人」',
        '- [[01#^p2|01]]：原文的「1D100」在譯文裡找不到',
        '- [[01#^p3|01]]：譯文少了數字 3',
        '- [[01#^p3|01]]：混入簡體字 X',
        '- [[01#^p3|01]]：譯文比原文短很多',
        '',
        '> 人工譯文的檢查只報告，不會重新送出翻譯。要修改請在 vault 裡改，再執行 tome sync。',
        '',
        '## 全書一致性',
      ].join('\n'),
    );
    expect(text).toContain(
      [
        '## 內含舊譯名的人工譯文（1）',
        '',
        '- 「Salt Marsh」的譯名從「鹽沼」改為「鹽沼地」，有 2 處人工譯文仍用舊譯名：[[01#^p1|01]]、[[01#^p4|01]]',
        '',
        '> 人工譯文不會自動替換譯名。要改用新的譯名，請在 vault 裡修改，再執行 tome sync。',
      ].join('\n'),
    );
    expect(text.indexOf('## 只報告的檢查')).toBeLessThan(text.indexOf('## 人工譯文的檢查'));
    expect(text.indexOf('## 全書一致性')).toBeLessThan(text.indexOf('## 內含舊譯名的人工譯文'));
    expect(text.endsWith('再執行 tome sync。\n')).toBe(true);
  });

  it('writes the whole report, word for word', () => {
    expect(renderReport(FULL, vaultTexts.report, place)).toBe(
      [
        '# 交付報告',
        '',
        '> 這份報告由 tome assemble 產生，每次輸出都會重新寫入，請勿在此檔案上做筆記。',
        '',
        '## 覆蓋率與花費',
        '',
        '- 翻譯單位共 4 個：完成 2 個（其中原樣保留 1 個、本機欄位化 0 個、人工譯文 0 個），未通過驗證 1 個，遭拒答 0 個，個資閘門擋下 1 個，送出未收回 0 個，尚未完成 0 個。',
        '- 花費：翻譯 $0.40 美元、實體卡 $0.15 美元，共 $0.55 美元。預算 $5.00 美元。',
        '- 待審的實體卡 1 張。',
        '',
        '### 估價與實際花費',
        '',
        '| 確認時間（UTC） | 階段 | 模式 | 估價（美元） | 之後的花費（美元） | 與估價相比 |',
        '| --- | --- | --- | --- | --- | --- |',
        '| 2026-11-09 00:50 | 翻譯 | 批次 | 0.20～0.60 | 0.40 | 在估價區間內（50% 處） |',
        '| 2026-11-09 00:20 | 實體卡 | 即時 | 0.10～0.10 | 0.15 | 超出上限 50% |',
        '',
        '## 未翻譯的單位（2）',
        '',
        '- [[01#^p2|01]]：未通過驗證（未使用鎖定譯名、譯文過短）',
        '- [[01#^p3|01]]：個資閘門擋下',
        '',
        '## 未翻譯的頁面（1）',
        '',
        '- 原書 p.8：整頁是圖片',
        '',
        '## 未翻譯的圖片（2）',
        '',
        '- [[01#^f1|01]]：原書 p.4 的圖',
        '- 原書 p.8：整頁是圖片',
        '',
        '## 不可譯標記（1）',
        '',
        '- [[01#^p1|01]]：pun「雙關 語」',
        '',
        '## 只報告的檢查（2）',
        '',
        '- [[01#^p1|01]]：疑似中國大陸用語「軟件」，建議用「軟體」',
        '- [[01#^p1|01]]：「Mara」的實體卡代名詞是「她」，譯文用了「他 牠」',
        '',
        '## 全書一致性（2）',
        '',
        '### 同一個原文、多種譯名',
        '',
        '- 「Salt Marsh」：「鹽沼」2 處、「鹽澤」1 處',
        '',
        '### 鎖定的譯名沒有用上',
        '',
        '- 「Warden」鎖定為「看守人」，有 2 處沒有用上：[[01#^p1|01]]、[[01#^p4|01]]',
        '',
        '> 以 tome glossary review 鎖定或確認譯名後，執行 tome verify，未使用鎖定譯名的單位會重新送出翻譯，需要費用，請先執行 tome estimate 確認。',
        '',
      ].join('\n'),
    );
  });

  it('keeps the book text of a check on one line, and leaves a missing part of a flag empty', () => {
    const text = renderReport(
      {
        ...FULL,
        flags: [{ block_id: 'p1', code: 'untranslatable', detail: {} }],
        checks: [{ block_id: 'p1', code: 'term_suspect', detail: { term: '軟\n件', prefer: '軟體' } }],
      },
      vaultTexts.report,
      place,
    );
    expect(text).toContain('- [[01#^p1|01]]：「」\n');
    expect(text).toContain('- [[01#^p1|01]]：疑似中國大陸用語「軟 件」，建議用「軟體」\n');
  });

  it('says there is nothing in the half of the consistency section that is empty', () => {
    const variantsOnly = renderReport({ ...FULL, unused: [] }, vaultTexts.report, place);
    expect(variantsOnly).toContain('## 全書一致性（1）');
    expect(variantsOnly).toContain('### 鎖定的譯名沒有用上\n\n無\n');
    const unusedOnly = renderReport({ ...FULL, variants: [] }, vaultTexts.report, place);
    expect(unusedOnly).toContain('### 同一個原文、多種譯名\n\n無\n');
  });

  it('writes every section with its count, links each item, and keeps book text on one line', () => {
    const text = renderReport(filled().report, vaultTexts.report, place);
    expect(text).toMatch(/^# 交付報告\n\n> /u);
    expect(text).toContain('## 未翻譯的單位（2）\n\n- [[01#^p2|01]]：未通過驗證（未使用鎖定譯名、譯文過短）\n- [[01#^p3|01]]：個資閘門擋下\n');
    expect(text).toContain('- 原書 p.8：整頁是圖片\n- 原書 p.3：文字不完整（字元守恆未通過）');
    expect(text).toContain('- [[01#^f1|01]]：原書 p.4 的圖\n- 原書 p.8：整頁是圖片');
    expect(text).toContain('- [[01#^p1|01]]：pun「雙關 語」');
    expect(text).toContain('- [[01#^p1|01]]：疑似中國大陸用語「軟件」，建議用「軟體」');
    expect(text).toContain('- [[01#^p1|01]]：疑似機翻腔「作為一個」，建議：身為');
    expect(text).toContain('### 同一個原文、多種譯名\n\n- 「Salt Marsh」：「鹽沼」1 處、「鹽澤」1 處');
    expect(text).toContain('- 「Warden」鎖定為「看守人」，有 1 處沒有用上：[[01#^p1|01]]');
    expect(text).not.toContain('A secret name.');
  });

  it('shows the money and the estimates as a table', () => {
    const text = renderReport(filled().report, vaultTexts.report, place);
    expect(text).toContain('- 花費：翻譯 $0.40 美元、實體卡 $0.15 美元，共 $0.55 美元。預算 $5.00 美元。');
    expect(text).toContain('| 2026-11-09 00:50 | 翻譯 | 批次 | 0.20～0.60 | 0.40 | 在估價區間內（50% 處） |');
    expect(text).toContain('| 2026-11-09 00:20 | 實體卡 | 即時 | 0.10～0.10 | 0.15 | 超出上限 50% |');
  });

  // 欄名不再是「落在估價區間」，每一種情況的寫法都在表裡（ADR-0132）。
  it('says in the table how each spending compares with its estimate', () => {
    const at = '2026-11-09T00:00:00.000Z';
    const rows: EstimateItem[] = [
      { stage: 'translate', mode: 'batch', created_at: at, low_usd: 0.1786, high_usd: 0.2902, spent_usd: 0.1713, position: -7 },
      { stage: 'translate', mode: 'batch', created_at: at, low_usd: 0.0438, high_usd: 0.0712, spent_usd: 0.0437, position: 0 },
      { stage: 'translate', mode: 'batch', created_at: at, low_usd: 1, high_usd: 2, spent_usd: 2.005, position: 101 },
      { stage: 'translate', mode: 'batch', created_at: at, low_usd: 1, high_usd: 2, spent_usd: 0, position: -100 },
      { stage: 'translate', mode: 'batch', created_at: at, low_usd: 1, high_usd: 1, spent_usd: 1, position: null },
    ];
    const text = renderReport({ ...filled().report, estimates: rows }, vaultTexts.report, place);
    expect(text).toContain('| 與估價相比 |');
    expect(text).not.toContain('落在估價區間');
    for (const cell of ['低於下限 4%', '低於下限不到 1%', '超出上限不到 1%', '尚無花費']) expect(text).toContain(`| ${cell} |`);
    expect(text).toContain('| 1.00～1.00 | 1.00 | - |');
  });

  it('says there is nothing where a section is empty, and leaves out the estimates and the advice', () => {
    const empty = collectReport(store(), { ...DOCUMENT, pages: [], blocks: [] }, [], null);
    const text = renderReport(empty, vaultTexts.report, place);
    expect(text).toContain('## 未翻譯的單位（0）\n\n無\n');
    expect(text).toContain('## 全書一致性（0）\n\n無\n');
    expect(text).not.toContain('估價與實際花費');
    expect(text).not.toContain('tome verify');
    expect(text).toContain('- 花費：翻譯 $0.00 美元、實體卡 $0.00 美元，共 $0.00 美元。\n');
  });
});
