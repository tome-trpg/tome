import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { vaultTexts } from '../../src/cli/messages.ts';
import type { EntityCard } from '../../src/core/entities.ts';
import type { DocumentBlock, IrDocument } from '../../src/core/ir.ts';
import { collectReport, renderReport, reportCounts, reportedBlocks, type BookReport } from '../../src/core/report.ts';
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
    expect(report.coverage).toEqual({ total: 4, kept: 1, fielded: 0, done: 2, in_flight: 0, blocked: 1, failed: 1, refused: 0, left: 0 });
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
      variants: 1,
      unused: 1,
      pending_cards: 1,
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

describe('renderReport (ADR-0123)', () => {
  const place = (id: string): string => `[[01#^${id}|01]]`;
  const FULL: BookReport = {
    coverage: { total: 4, kept: 1, fielded: 0, done: 2, in_flight: 0, blocked: 1, failed: 1, refused: 0, left: 0 },
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
    unused: [{ source: 'Warden', target: '看守人', blocks: ['p1', 'p4'] }],
  };

  it('writes the whole report, word for word', () => {
    expect(renderReport(FULL, vaultTexts.report, place)).toBe(
      [
        '# 交付報告',
        '',
        '> 這份報告由 tome assemble 產生，每次輸出都會重新寫入，請勿在此檔案上做筆記。',
        '',
        '## 覆蓋率與花費',
        '',
        '- 翻譯單位共 4 個：完成 2 個（其中原樣保留 1 個、本機欄位化 0 個），未通過驗證 1 個，遭拒答 0 個，個資閘門擋下 1 個，送出未收回 0 個，尚未完成 0 個。',
        '- 花費：翻譯 $0.40 美元、實體卡 $0.15 美元，共 $0.55 美元。預算 $5.00 美元。',
        '- 待審的實體卡 1 張。',
        '',
        '### 估價與實際花費',
        '',
        '| 確認時間（UTC） | 階段 | 模式 | 估價（美元） | 之後的花費（美元） | 落在估價區間 |',
        '| --- | --- | --- | --- | --- | --- |',
        '| 2026-11-09 00:50 | 翻譯 | 批次 | 0.20～0.60 | 0.40 | 50% |',
        '| 2026-11-09 00:20 | 實體卡 | 即時 | 0.10～0.10 | 0.15 | - |',
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
    expect(text).toContain('| 2026-11-09 00:50 | 翻譯 | 批次 | 0.20～0.60 | 0.40 | 50% |');
    expect(text).toContain('| 2026-11-09 00:20 | 實體卡 | 即時 | 0.10～0.10 | 0.15 | - |');
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
