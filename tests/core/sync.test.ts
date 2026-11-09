import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  alignFile,
  boundariesKept,
  diffSequences,
  lightlyEdited,
  normalizeText,
  reverseBlock,
  similarity,
  type OldBlock,
  type SyncBlock,
  type SyncUnit,
} from '../../src/core/sync.ts';

// tome sync 的比對與反推（ADR-0125）。文字都是這裡編的。

const FRONT = '---\n書: "book"\n章: 1\n---';

/** 照 `tome assemble` 的寫法排一個章節檔：frontmatter、頁碼註解、各區塊，用空行接起來。 */
function fileOf(blocks: readonly string[], marker = true): string {
  return `${[FRONT, ...(marker ? ['<!-- page: 1 -->'] : []), ...blocks].join('\n\n')}\n`;
}

function olds(...markdowns: string[]): OldBlock[] {
  return markdowns.map((markdown, index) => ({ block_id: `b${index}`, markdown }));
}

function unit(overrides: Partial<SyncUnit> & { unit_id: string }): SyncUnit {
  return { role: 'paragraph', source: 'Source text.', state: 'DONE', translation: '譯文', placeholders: '[]', human: 0, ...overrides };
}

describe('diffSequences', () => {
  it('keeps what is alike, and marks what was taken out and put in', () => {
    expect(diffSequences(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { type: 'equal', a: 0, b: 0 },
      { type: 'delete', a: 1 },
      { type: 'insert', b: 1 },
      { type: 'equal', a: 2, b: 2 },
    ]);
  });

  it('handles empty sides', () => {
    expect(diffSequences([], [])).toEqual([]);
    expect(diffSequences(['a'], [])).toEqual([{ type: 'delete', a: 0 }]);
    expect(diffSequences([], ['a'])).toEqual([{ type: 'insert', b: 0 }]);
  });

  it('finds a longest common part in the middle', () => {
    const ops = diffSequences(['a', 'b', 'c', 'd', 'e'], ['x', 'b', 'y', 'd', 'z']) ?? [];
    expect(ops.filter(({ type }) => type === 'equal')).toEqual([
      { type: 'equal', a: 1, b: 1 },
      { type: 'equal', a: 3, b: 3 },
    ]);
    expect(ops.filter(({ type }) => type !== 'equal')).toHaveLength(6);
  });

  it('gives up past the limit', () => {
    expect(diffSequences(['a', 'b', 'c'], ['x', 'y', 'z'], 5)).toBeNull();
    expect(diffSequences(['a', 'b', 'c'], ['x', 'y', 'z'], 6)).not.toBeNull();
  });

  it('agrees with a plain longest common subsequence on its length', () => {
    const lcs = (a: readonly string[], b: readonly string[]): number => {
      const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
      for (let i = 1; i <= a.length; i += 1) {
        for (let j = 1; j <= b.length; j += 1) {
          const row = table[i] as number[];
          row[j] = a[i - 1] === b[j - 1] ? (table[i - 1]?.[j - 1] ?? 0) + 1 : Math.max(table[i - 1]?.[j] ?? 0, row[j - 1] ?? 0);
        }
      }
      return table[a.length]?.[b.length] ?? 0;
    };
    const letters = fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { maxLength: 12 });
    fc.assert(
      fc.property(letters, letters, (a, b) => {
        const ops = diffSequences(a, b) ?? [];
        const equal = ops.filter(({ type }) => type === 'equal');
        expect(equal).toHaveLength(lcs(a, b));
        for (const op of equal) if (op.type === 'equal') expect(a[op.a]).toBe(b[op.b]);
        expect(ops.filter(({ type }) => type !== 'insert')).toHaveLength(a.length);
        expect(ops.filter(({ type }) => type !== 'delete')).toHaveLength(b.length);
      }),
    );
  });
});

describe('diffSequences: a valid edit script', () => {
  it('walks both sides once, in order, whatever the input', () => {
    const letters = fc.array(fc.constantFrom('a', 'b', 'c'), { maxLength: 14 });
    fc.assert(
      fc.property(letters, letters, (a, b) => {
        const ops = diffSequences(a, b) ?? [];
        const left = ops.flatMap((op) => (op.type === 'insert' ? [] : [op.a]));
        const right = ops.flatMap((op) => (op.type === 'delete' ? [] : [op.b]));
        expect(left).toEqual(a.map((_item, index) => index));
        expect(right).toEqual(b.map((_item, index) => index));
      }),
      { numRuns: 500 },
    );
  });

  it('keeps the prefix and the suffix apart when they overlap', () => {
    expect(diffSequences(['a', 'b', 'a'], ['a', 'b', 'a', 'b', 'a'])?.filter(({ type }) => type === 'equal')).toHaveLength(3);
    expect(diffSequences(['a'], ['a', 'a'])).toEqual([
      { type: 'equal', a: 0, b: 0 },
      { type: 'insert', b: 1 },
    ]);
    expect(diffSequences(['a', 'a'], ['a'])).toEqual([
      { type: 'equal', a: 0, b: 0 },
      { type: 'delete', a: 1 },
    ]);
  });

  it('matches the common tail at the end, all of it', () => {
    expect(diffSequences(['X', 'A', 'A'], ['Y', 'A', 'A', 'A'])?.slice(-2)).toEqual([
      { type: 'equal', a: 1, b: 2 },
      { type: 'equal', a: 2, b: 3 },
    ]);
  });
});

describe('boundariesKept (ADR-0125)', () => {
  it('holds for paragraphs edited where they are', () => {
    expect(boundariesKept(['守望者在渡口等待', '雨在冬夜落下'], ['守望者在渡口等候', '雨在冬夜落著'])).toBe(true);
    expect(boundariesKept(['甲'], ['乙'])).toBe(true);
  });

  it('fails for another count of paragraphs', () => {
    expect(boundariesKept(['甲乙'], ['甲', '乙'])).toBe(false);
  });

  it('fails when a few characters move across the boundary', () => {
    expect(boundariesKept(['甲乙丙丁戊己庚辛', '壬癸子丑寅卯辰巳'], ['甲乙丙丁戊己庚', '辛壬癸子丑寅卯辰巳'])).toBe(false);
  });

  it('fails on a tie, where an alignment across the boundary is as long', () => {
    expect(boundariesKept(['salt salt salt salt salt 0', 'salt salt salt salt 1'], ['salt salt salt salt salt', '0 salt salt salt salt 1'])).toBe(false);
  });

  it('checks every boundary, not only the first', () => {
    expect(boundariesKept(['甲乙丙丁', '戊己庚辛壬癸', '子丑寅卯辰巳'], ['甲乙丙丁', '戊己庚辛壬', '癸子丑寅卯辰巳'])).toBe(false);
  });

  it('does not line the boundary under check up with another boundary', () => {
    // 被查的那條界線兩邊各用自己的記號；對上別的界線，就把沒有挪動的界線也算成挪動了。
    expect(boundariesKept(['乙', '乙乙乙甲', '甲'], ['甲', '甲', '乙'])).toBe(true);
  });

  it('fails past the limit of the diff', () => {
    expect(boundariesKept(['a'.repeat(1500)], ['b'.repeat(1500)])).toBe(false);
    expect(boundariesKept(['甲', 'a'.repeat(1100)], ['甲', 'b'.repeat(1100)])).toBe(false);
  });
});

describe('lightlyEdited (ADR-0125)', () => {
  it('holds while both sides keep three quarters of their characters', () => {
    expect(lightlyEdited('甲乙丙丁', '甲乙丙戊')).toBe(true);
    expect(lightlyEdited('甲乙丙丁', '甲乙戊己')).toBe(false);
    expect(lightlyEdited('甲乙丙丁', '甲乙丙丁戊')).toBe(true);
    expect(lightlyEdited('甲乙丙丁', '甲乙丙丁戊己')).toBe(false);
    expect(lightlyEdited('甲乙丙丁戊己', '甲乙丙丁')).toBe(false);
  });

  it('fails past the limit of the diff', () => {
    expect(lightlyEdited('a'.repeat(2500), 'b'.repeat(2500))).toBe(false);
  });
});

describe('similarity', () => {
  it('is 1 for the same text and 0 for nothing in common', () => {
    expect(similarity('守望者在渡口', '守望者在渡口')).toBe(1);
    expect(similarity('甲乙丙', '丁戊己')).toBe(0);
    expect(similarity('', '')).toBe(1);
    expect(similarity('a', 'b')).toBe(0);
  });

  it('is in between for an edit', () => {
    const score = similarity('守望者在渡口等待傍晚的渡船。', '守望者在渡口等候傍晚的渡船。');
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });
});

describe('normalizeText', () => {
  it('drops a BOM and CRLF, and ends with one newline', () => {
    expect(normalizeText('﻿a\r\nb\r\n\r\n\n')).toBe('a\nb\n');
    expect(normalizeText('a')).toBe('a\n');
  });
});

describe('alignFile (ADR-0125)', () => {
  const blocks = olds('# 渡口', '守望者在渡口等待傍晚的渡船。', '雨在漫長的冬夜落在沼澤上。', '鹽沼的盡頭有一座燈塔。');
  const before = fileOf(blocks.map(({ markdown }) => markdown));

  it('finds nothing in a file as it was written, and gives the same file back', () => {
    const result = alignFile(blocks, before);
    expect(result.edits).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(result.candidate).toBe(before);
  });

  it('takes an edited paragraph back, and gives the old file back once it is put back', () => {
    const after = before.replace('等待', '等候');
    const result = alignFile(blocks, after);
    expect(result.edits).toEqual([{ block_id: 'b1', markdown: '守望者在渡口等候傍晚的渡船。' }]);
    expect(result.changes).toEqual([]);
    expect(result.candidate).toBe(before);
  });

  it('ignores CRLF, a BOM and spaces at the ends of lines', () => {
    const after = `﻿${before.replaceAll('\n', '\r\n').replace('沼澤上。', '沼澤上。  ')}`;
    const result = alignFile(blocks, after);
    expect(result.edits).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(result.candidate).toBe(before);
  });

  it('pairs two edited neighbors that each stay alike', () => {
    const after = before.replace('等待', '等候').replace('漫長', '悠長');
    expect(alignFile(blocks, after).edits).toEqual([
      { block_id: 'b1', markdown: '守望者在渡口等候傍晚的渡船。' },
      { block_id: 'b2', markdown: '雨在悠長的冬夜落在沼澤上。' },
    ]);
  });

  it('does not pair two neighbors that were edited and swapped', () => {
    const after = fileOf(['# 渡口', '雨在悠長的冬夜落在沼澤上。', '守望者在渡口等候傍晚的渡船。', '鹽沼的盡頭有一座燈塔。']);
    const result = alignFile(blocks, after);
    expect(result.edits).toEqual([]);
    expect(result.changes).toEqual([{ kind: 'ambiguous', before: 'b0', after: 'b3' }]);
  });

  it('does not pair neighbors rewritten past recognition', () => {
    const after = fileOf(['# 渡口', '完全不同的一段文字甲。', '另一段毫不相干的文字乙。', '鹽沼的盡頭有一座燈塔。']);
    expect(alignFile(blocks, after).changes).toEqual([{ kind: 'ambiguous', before: 'b0', after: 'b3' }]);
  });

  it('records a merge, a split, a deletion and an addition, and takes none of them', () => {
    const merged = alignFile(blocks, fileOf(['# 渡口', '守望者在渡口等待傍晚的渡船。雨在漫長的冬夜落在沼澤上。', '鹽沼的盡頭有一座燈塔。']));
    expect(merged).toMatchObject({ edits: [], changes: [{ kind: 'merged', before: 'b0', after: 'b3' }] });
    const split = alignFile(blocks, fileOf(['# 渡口', '守望者在渡口', '等待傍晚的渡船。', '雨在漫長的冬夜落在沼澤上。', '鹽沼的盡頭有一座燈塔。']));
    expect(split).toMatchObject({ edits: [], changes: [{ kind: 'split', before: 'b0', after: 'b2' }] });
    const deleted = alignFile(blocks, fileOf(['# 渡口', '雨在漫長的冬夜落在沼澤上。', '鹽沼的盡頭有一座燈塔。']));
    expect(deleted).toMatchObject({ edits: [], changes: [{ kind: 'deleted', before: 'b0', after: 'b2' }] });
    const added = alignFile(blocks, fileOf(['# 渡口', '守望者在渡口等待傍晚的渡船。', '我自己的筆記。', '雨在漫長的冬夜落在沼澤上。', '鹽沼的盡頭有一座燈塔。']));
    expect(added).toMatchObject({ edits: [], changes: [{ kind: 'added', before: 'b1', after: 'b2' }] });
  });

  it('does not hand a paragraph moved into the place of a deleted one to the deleted block', () => {
    const moved = alignFile(blocks, fileOf(['# 渡口', '雨在漫長的冬夜落在沼澤上。', '守望者在渡口等待傍晚的渡船。']));
    expect(moved.edits).toEqual([]);
    expect(moved.changes).toEqual([
      { kind: 'deleted', before: 'b0', after: 'b2' },
      { kind: 'moved', before: 'b2', after: null },
    ]);
    const edited = alignFile(blocks, fileOf(['# 渡口', '雨在漫長的冬夜落在沼澤上。', '守望者在渡口等候傍晚的渡船。']));
    expect(edited.edits).toEqual([]);
    expect(edited.changes.map(({ kind }) => kind)).toEqual(['deleted', 'ambiguous']);
  });

  it('records a moved paragraph once', () => {
    const moved = alignFile(blocks, fileOf(['# 渡口', '雨在漫長的冬夜落在沼澤上。', '鹽沼的盡頭有一座燈塔。', '守望者在渡口等待傍晚的渡船。']));
    expect(moved.edits).toEqual([]);
    expect(moved.changes).toEqual([{ kind: 'moved', before: 'b3', after: null }]);
  });

  it('records an addition at the very start and a deletion at the very end', () => {
    const result = alignFile(blocks, fileOf(['開頭的筆記。', '# 渡口', '守望者在渡口等待傍晚的渡船。', '雨在漫長的冬夜落在沼澤上。']));
    expect(result.changes).toEqual([
      { kind: 'added', before: null, after: 'b0' },
      { kind: 'deleted', before: 'b2', after: null },
    ]);
  });

  it('leaves a changed frontmatter or page marker to the candidate', () => {
    const after = before.replace('章: 1', '章: 1\ntags: [game]').replace('<!-- page: 1 -->', '<!-- page: 2 -->');
    const result = alignFile(blocks, after);
    expect(result.changes).toEqual([]);
    expect(result.candidate).not.toBe(before);
  });

  it('takes a part of a block with two paragraphs', () => {
    const two = olds('# 渡口', '第一段。\n\n第二段。', '尾段。');
    const after = fileOf(['# 渡口', '第一段。', '第二段改過。', '尾段。']);
    const result = alignFile(two, after);
    expect(result.edits).toEqual([{ block_id: 'b1', markdown: '第一段。\n\n第二段改過。' }]);
    expect(result.candidate).toBe(fileOf(['# 渡口', '第一段。\n\n第二段。', '尾段。']));
  });

  it('calls a part of a block mixed with its neighbor ambiguous', () => {
    const two = olds('第一段。\n\n第二段。', '尾段。');
    expect(alignFile(two, fileOf(['第一段。', '第二段改過。', '尾段改過。'])).changes).toEqual([{ kind: 'ambiguous', before: 'b0', after: null }]);
  });

  it('takes a translation in place of untranslated blocks by place alone, one or several in a row', () => {
    const waiting = olds('# 沼澤', '> [!untranslated] FAILED_QA\n> Rain falls on the marsh.', '> [!untranslated] REFUSED\n> The ferry waits.', '鹽沼的盡頭。');
    const one = alignFile(waiting, fileOf(['# 沼澤', '雨落在沼澤上。', '> [!untranslated] REFUSED\n> The ferry waits.', '鹽沼的盡頭。']));
    expect(one).toMatchObject({ edits: [{ block_id: 'b1', markdown: '雨落在沼澤上。' }], changes: [] });
    const both = alignFile(waiting, fileOf(['# 沼澤', '雨落在沼澤上。', '渡船在等。', '鹽沼的盡頭。']));
    expect(both.edits).toEqual([
      { block_id: 'b1', markdown: '雨落在沼澤上。' },
      { block_id: 'b2', markdown: '渡船在等。' },
    ]);
    const mixed = alignFile(waiting, fileOf(['# 沼澤', '雨落在沼澤上。', '渡船在等。', '鹽沼的盡頭改過。']));
    expect(mixed.edits).toEqual([]);
  });

  it('does not take a paragraph moved into the place of an untranslated block', () => {
    const waiting = olds('守望者在渡口等待傍晚的渡船。', '> [!untranslated] FAILED_QA\n> Rain falls on the marsh.', '鹽沼的盡頭有一座燈塔。');
    const result = alignFile(waiting, fileOf(['> [!untranslated] FAILED_QA\n> Rain falls on the marsh.', '守望者在渡口等候傍晚的渡船。', '鹽沼的盡頭有一座燈塔。']));
    expect(result.edits).toEqual([]);
  });

  it('ignores blank lines before the frontmatter', () => {
    expect(alignFile(blocks, `\n\n${before}`)).toMatchObject({ edits: [], changes: [] });
  });

  it('takes an edit of one of two identical blocks, which do not compete', () => {
    const twins = olds('## 注意', '守望者在渡口等待傍晚的渡船。', '## 注意', '雨在漫長的冬夜落在沼澤上。');
    const result = alignFile(twins, fileOf(['## 注意事項', '守望者在渡口等待傍晚的渡船。', '## 注意', '雨在漫長的冬夜落在沼澤上。']));
    expect(result.edits).toEqual([{ block_id: 'b0', markdown: '## 注意事項' }]);
  });

  it('calls a tie with another block ambiguous, and takes a rewrite that shares nothing with any block', () => {
    const three = olds('甲乙丙丁', '戊己庚辛', '甲乙壬癸', '子丑寅卯');
    const tie = alignFile(three, fileOf(['甲乙子丑寅', '戊己庚辛', '甲乙壬癸', '子丑寅卯'].map((text, index) => (index === 0 ? '甲乙辰巳' : text))));
    expect(tie).toMatchObject({ edits: [], changes: [{ kind: 'ambiguous', before: null, after: 'b1' }] });
    const rewrite = alignFile(three, fileOf(['午未申酉', '戊己庚辛', '甲乙壬癸', '子丑寅卯']));
    expect(rewrite.edits).toEqual([{ block_id: 'b0', markdown: '午未申酉' }]);
  });

  it('records a moved block of two paragraphs once', () => {
    const table = olds('守望者在渡口等待傍晚的渡船。', '| 甲 |\n| --- |\n| 乙 |\n\n^t1', '雨在漫長的冬夜落在沼澤上。', '鹽沼的盡頭有一座燈塔。');
    const moved = alignFile(table, fileOf(['守望者在渡口等待傍晚的渡船。', '雨在漫長的冬夜落在沼澤上。', '鹽沼的盡頭有一座燈塔。', '| 甲 |\n| --- |\n| 乙 |', '^t1']));
    expect(moved.changes).toEqual([{ kind: 'moved', before: 'b3', after: null }]);
  });

  it('does not pair neighbors whose boundary moved by a character', () => {
    const pair = olds('開頭。', '甲乙丙丁戊己庚辛', '壬癸子丑寅卯辰巳', '結尾。');
    const result = alignFile(pair, fileOf(['開頭。', '甲乙丙丁戊己庚', '辛壬癸子丑寅卯辰巳', '結尾。']));
    expect(result).toMatchObject({ edits: [], changes: [{ kind: 'ambiguous', before: 'b0', after: 'b3' }] });
  });

  it('pairs a block of two paragraphs with its neighbor, with the blank line between them', () => {
    const pair = olds('# 渡口', '守望者在渡口等待傍晚的渡船。\n\n雨在漫長的冬夜落在沼澤上。', '鹽沼的盡頭有一座燈塔，燈塔的光照著沼澤。', '蘆葦長滿了船隻停靠的岸邊。');
    const result = alignFile(pair, fileOf(['# 渡口', '守望者在渡口等候傍晚的渡船。', '雨在悠長的冬夜落在沼澤上。', '鹽沼的盡頭有一座燈塔，燈塔的光照著沼地。', '蘆葦長滿了船隻停靠的岸邊。']));
    expect(result.edits).toEqual([
      { block_id: 'b1', markdown: '守望者在渡口等候傍晚的渡船。\n\n雨在悠長的冬夜落在沼澤上。' },
      { block_id: 'b2', markdown: '鹽沼的盡頭有一座燈塔，燈塔的光照著沼地。' },
    ]);
  });

  it('does not pair neighbors when one of them lost more than a quarter, however alike each stays to its own', () => {
    const result = alignFile(blocks, before.replace('等待', '等候').replace('雨在漫長的冬夜落在沼澤上。', '大雨在漫長的夜晚打在沼地。'));
    expect(result).toMatchObject({ edits: [], changes: [{ kind: 'ambiguous', before: 'b0', after: 'b3' }] });
  });

  it('does not pair a block more like the new text of its neighbor than its own, or as alike', () => {
    const near = (second: string): OldBlock[] => olds('# 渡口', '甲乙丙丁戊己庚辛', second, '雨在漫長的冬夜落在沼澤上。');
    const more = alignFile(near('甲乙丙丁戊己庚辛壬癸子丑'), fileOf(['# 渡口', '甲乙天地戊己庚辛', '甲乙丙丁戊己庚辛壬癸子寅', '雨在漫長的冬夜落在沼澤上。']));
    expect(more).toMatchObject({ edits: [], changes: [{ kind: 'ambiguous', before: 'b0', after: 'b3' }] });
    // 甲乙丙丁戊己庚辛 跟第二段新文字的相似度，剛好等於跟自己新文字的。
    const tie = alignFile(near('甲乙丙丁戊己庚子丑寅卯辰巳午申'), fileOf(['# 渡口', '甲乙天地戊己庚辛', '甲乙丙丁戊己庚子丑寅卯辰巳午未', '雨在漫長的冬夜落在沼澤上。']));
    expect(tie).toMatchObject({ edits: [], changes: [{ kind: 'ambiguous', before: 'b0', after: 'b3' }] });
  });

  it('does not pair a block that the change covers only in part', () => {
    const parted = olds('雨在漫長的冬夜落在沼澤上。', '守望者在渡口等待傍晚的渡船，看著鹽沼盡頭的燈塔。\n\n好', '鹽沼的盡頭有一座燈塔。');
    const result = alignFile(parted, fileOf(['雨在悠長的冬夜落在沼澤上。', '守望者在渡口等候傍晚的渡船，看著鹽沼盡頭的燈塔。', '好', '鹽沼的盡頭有一座燈塔。']));
    expect(result).toMatchObject({ edits: [], changes: [{ kind: 'ambiguous' }] });
  });

  it('calls a paragraph of another block put in next to new words ambiguous, not moved', () => {
    const two = olds('守望者在渡口等待傍晚的渡船。\n\n燈塔', '雨在漫長的冬夜落在沼澤上。');
    const result = alignFile(two, fileOf(['雨在漫長的冬夜落在沼澤上。', '燈塔亮了', '雨在漫長的冬夜落在沼澤上。']));
    expect(result).toMatchObject({ edits: [], changes: [{ kind: 'ambiguous' }] });
  });

  it('counts joining two lines of a paragraph as an edit', () => {
    const lined = olds('守望者在渡口\n等待傍晚的渡船。', '鹽沼的盡頭有一座燈塔。');
    expect(alignFile(lined, fileOf(['守望者在渡口等待傍晚的渡船。', '鹽沼的盡頭有一座燈塔。'])).edits).toEqual([{ block_id: 'b0', markdown: '守望者在渡口等待傍晚的渡船。' }]);
  });

  it('reads a file with no frontmatter, and gives its first block back in the candidate', () => {
    const plain = `${blocks.map(({ markdown }) => markdown).join('\n\n')}\n`;
    const result = alignFile(blocks, plain.replace('# 渡口', '# 渡頭'));
    expect(result.edits).toEqual([{ block_id: 'b0', markdown: '# 渡頭' }]);
    expect(result.candidate).toBe(plain);
  });

  it('ignores blank lines at the end of a block as it was written', () => {
    const trailing = olds('守望者在渡口等待傍晚的渡船。\n\n', '鹽沼的盡頭有一座燈塔。');
    expect(alignFile(trailing, fileOf(['守望者在渡口等待傍晚的渡船。', '鹽沼的盡頭有一座燈塔。'])).changes).toEqual([]);
  });

  // 下面幾項是要回收之前的防護（ADR-0125 第 4 項）。
  const SIX = olds('守望者在渡口等待傍晚的渡船。', '雨在漫長的冬夜落在沼澤上。', '注', '鹽沼的盡頭有一座燈塔。', '蘆葦長滿了船隻停靠的岸邊。', '燈塔的光照著沼澤。');

  it('does not take a text that holds a deleted block, even a block of one character', () => {
    const merged = alignFile(SIX, fileOf(['守望者在渡口等待傍晚的渡船。注', '雨在漫長的冬夜落在沼澤上。', '鹽沼的盡頭有一座燈塔。', '蘆葦長滿了船隻停靠的岸邊。', '燈塔的光照著沼澤。']));
    expect(merged.edits).toEqual([]);
    expect(merged.changes).toEqual([
      { kind: 'deleted', before: 'b1', after: 'b3' },
      { kind: 'ambiguous', before: null, after: 'b1' },
    ]);
    const edited = alignFile(SIX, fileOf(['守望者在渡口等待傍晚的渡船。修', '雨在漫長的冬夜落在沼澤上。', '鹽沼的盡頭有一座燈塔。', '蘆葦長滿了船隻停靠的岸邊。', '燈塔的光照著沼澤。']));
    expect(edited.edits).toEqual([{ block_id: 'b0', markdown: '守望者在渡口等待傍晚的渡船。修' }]);
  });

  it('does not take an edit when a paragraph added elsewhere is a piece of the old text, unless the piece is short', () => {
    const lines = (added: string): string[] => ['守望者在渡口等待傍晚的渡船。', '雨在漫長的冬夜落在沼澤上。', '注', '鹽沼的盡頭有一座燈塔，修。', '蘆葦長滿了船隻停靠的岸邊。', added, '燈塔的光照著沼澤。'];
    expect(alignFile(SIX, fileOf(lines('燈塔。'))).edits).toEqual([{ block_id: 'b3', markdown: '鹽沼的盡頭有一座燈塔，修。' }]);
    const piece = alignFile(SIX, fileOf(lines('一座燈塔。')));
    expect(piece.edits).toEqual([]);
    expect(piece.changes.map(({ kind }) => kind).sort()).toEqual(['added', 'ambiguous']);
    // 五個雙字組有四個在舊的文字裡，剛好八成。
    expect(alignFile(SIX, fileOf(lines('有一座燈塔亮'))).edits).toEqual([]);
  });

  it('does not take the new text in the place of a block moved elsewhere and edited there', () => {
    const result = alignFile(SIX, fileOf(['守望者在渡口等待傍晚的渡船。', '我的筆記。', '注', '鹽沼的盡頭有一座燈塔。', '雨在漫長的冬夜落在沼澤上，修。', '蘆葦長滿了船隻停靠的岸邊。', '燈塔的光照著沼澤。']));
    expect(result.edits).toEqual([]);
    // 舊的十個雙字組有八個在搬去的段裡，剛好八成；搬去的段另外加了很多字。
    const exact = alignFile(SIX, fileOf(['守望者在渡口等待傍晚的渡船。', '雨在漫長的冬夜落在沼澤上。', '注', '我寫的筆記。', '蘆葦長滿了船隻停靠的岸邊。', '鹽沼的盡頭有一座燈，照著遠方的蘆葦', '燈塔的光照著沼澤。']));
    expect(exact.edits).toEqual([]);
  });

  it('does not take a text that holds four fifths of a deleted block, in pieces too short to be borrowed', () => {
    const result = alignFile(SIX, fileOf(['守望者在渡口等待傍晚的渡船。', '雨在漫長的冬夜鹽沼的盡頭有落在沼澤一座燈塔上。', '注', '蘆葦長滿了船隻停靠的岸邊。', '燈塔的光照著沼澤。']));
    expect(result.edits).toEqual([]);
  });

  it('does not take an edit once another edit given up holds a piece of it, so it checks again until nothing changes', () => {
    const four = olds('> [!untranslated]\n> abcde', '鹽沼的盡頭有一座燈塔。', '甲乙丙丁戊己庚辛壬癸', '子丑寅卯辰巳午未申酉');
    const result = alignFile(four, fileOf(['X甲乙丙丁戊己庚辛壬癸', '鹽沼的盡頭有一座燈塔。', '甲乙丙丁戊己庚辛壬子', '子丑寅卯辰巳午未申酉']));
    expect(result.edits).toEqual([]);
    expect(result.changes.map(({ kind }) => kind)).toEqual(['ambiguous', 'ambiguous']);
  });

  it('takes an edit that repeats its own words, even when an identical block holds them too', () => {
    const twins = olds('鹽沼的盡頭有一座燈塔。', '鹽沼的盡頭有一座燈塔。', '雨在漫長的冬夜落在沼澤上。');
    const result = alignFile(twins, fileOf(['鹽沼的盡頭有一座燈塔。鹽沼的盡頭有一座燈塔。', '鹽沼的盡頭有一座燈塔。', '雨在漫長的冬夜落在沼澤上。']));
    expect(result.edits).toEqual([{ block_id: 'b0', markdown: '鹽沼的盡頭有一座燈塔。鹽沼的盡頭有一座燈塔。' }]);
  });

  it('takes an edit whose added words make eight characters of another block only when put together', () => {
    const result = alignFile(SIX, fileOf(['守望者在鹽沼的盡渡口頭有一座等待傍晚的渡船。', '雨在漫長的冬夜落在沼澤上。', '注', '鹽沼的盡頭有一座燈塔。', '蘆葦長滿了船隻停靠的岸邊。', '燈塔的光照著沼澤。']));
    expect(result.edits).toEqual([{ block_id: 'b0', markdown: '守望者在鹽沼的盡渡口頭有一座等待傍晚的渡船。' }]);
  });

  it('does not take a fill that is the text of another block with spaces after it, even of eight characters', () => {
    const near = olds('> [!untranslated]\n> abcd', 'a甲b乙c丙d丁', '鹽沼的盡頭有一座燈塔。');
    const result = alignFile(near, fileOf(['a甲b乙c丙d丁  ', 'a甲b乙c丙d丁', '鹽沼的盡頭有一座燈塔。']));
    expect(result).toMatchObject({ edits: [], changes: [{ kind: 'ambiguous' }] });
  });

  it('does not take a fill too long to compare with what was there', () => {
    const near = olds('> [!untranslated]\n> Source.', '鹽沼的盡頭有一座燈塔。');
    const result = alignFile(near, fileOf(['甲乙丙丁戊己庚辛壬癸'.repeat(210), '鹽沼的盡頭有一座燈塔。']));
    expect(result).toMatchObject({ edits: [], changes: [{ kind: 'ambiguous' }] });
  });

  it('does not count a block written as nothing as merged into an edit', () => {
    const empty = olds('守望者在渡口等待傍晚的渡船。', '', '鹽沼的盡頭有一座燈塔。');
    expect(alignFile(empty, fileOf(['守望者在渡口等候傍晚的渡船。', '鹽沼的盡頭有一座燈塔。'])).edits).toEqual([{ block_id: 'b0', markdown: '守望者在渡口等候傍晚的渡船。' }]);
  });

  it('does not take an edit that adds eight characters or more found in another block, and takes seven', () => {
    const eight = alignFile(SIX, fileOf(['守望者在渡口等待傍晚的渡船，鹽沼的盡頭有一座。', '雨在漫長的冬夜落在沼澤上。', '注', '鹽沼的盡頭有一座燈塔。', '蘆葦長滿了船隻停靠的岸邊。', '燈塔的光照著沼澤。']));
    expect(eight).toMatchObject({ edits: [], changes: [{ kind: 'ambiguous', before: null, after: 'b1' }] });
    const seven = alignFile(SIX, fileOf(['守望者在渡口等待傍晚的渡船，鹽沼的盡頭有一。', '雨在漫長的冬夜落在沼澤上。', '注', '鹽沼的盡頭有一座燈塔。', '蘆葦長滿了船隻停靠的岸邊。', '燈塔的光照著沼澤。']));
    expect(seven.edits).toHaveLength(1);
  });

  it('does not take a whole new text found in another block', () => {
    const blocksWithLong = olds('第一段甲乙丙丁戊。', '第二段己庚辛壬癸。', '第三段子丑寅卯辰巳午未申酉戌亥。', '第四段。');
    const result = alignFile(blocksWithLong, fileOf(['第一段甲乙丙丁戊。', '子丑寅卯辰巳午未', '第三段子丑寅卯辰巳午未申酉戌亥。', '第四段。']));
    expect(result.edits).toEqual([]);
  });

  it('gives the whole file up past the limit', () => {
    const many = olds(...Array.from({ length: 1100 }, (_, index) => `段落 ${index}`));
    const rewritten = fileOf(Array.from({ length: 1100 }, (_, index) => `改寫 ${index}`));
    expect(alignFile(many, rewritten)).toMatchObject({ edits: [], changes: [{ kind: 'other', before: null, after: null }] });
  });
});

describe('reverseBlock (ADR-0125)', () => {
  const p = unit({ unit_id: 'p1' });
  const paragraph = (markdown: string, units: readonly SyncUnit[] = [p]): SyncBlock => ({ block_id: 'p1', markdown, units });

  it('takes a paragraph back, without the backslash and the anchor TOME added', () => {
    expect(reverseBlock(paragraph('譯文 ^p1'), '\\# 改過的譯文\n第二行 ^p1')).toEqual({
      ok: true,
      texts: [{ unit: p, text: '# 改過的譯文\n第二行' }],
      busy: 0,
    });
  });

  it('keeps bold and italic as written', () => {
    expect(reverseBlock(paragraph('**譯文**'), '**改過的**譯文')).toMatchObject({ ok: true, texts: [{ text: '**改過的**譯文' }] });
  });

  it('calls a paragraph that became a heading, a quote, a table or a list a change of type', () => {
    for (const markdown of ['# 標題', '> 引言', '| a |', '| 只有開頭的直線', '第一行\n## 標題', '第一行\n> 引言']) {
      expect(reverseBlock(paragraph('譯文'), markdown)).toEqual({ ok: false, kind: 'type' });
    }
    expect(reverseBlock(paragraph('譯文'), '- 清單')).toEqual({ ok: false, kind: 'type' });
    expect(reverseBlock(paragraph('譯文'), '第一行\n- 第二行')).toMatchObject({ ok: true });
    expect(reverseBlock(paragraph('譯文'), '甲或乙 |')).toMatchObject({ ok: true, texts: [{ text: '甲或乙 |' }] });
  });

  it('takes nothing when the text is as it was', () => {
    expect(reverseBlock(paragraph('譯文 ^p1'), '譯文')).toEqual({ ok: true, texts: [], busy: 0 });
  });

  it('turns a link to a page reference back into what it shows, and keeps a link of the reader', () => {
    const ref = unit({ unit_id: 'p1', placeholders: JSON.stringify([{ id: 1, kind: 'page_ref', text: 'p.3' }]) });
    const result = reverseBlock(paragraph('見 [[02-沼澤#沼澤|p.3]]。', [ref]), '請見 [[02-沼澤#沼澤|p.3]] 與 [[筆記|我的筆記]]。');
    expect(result).toMatchObject({ ok: true, texts: [{ text: '請見 p.3 與 [[筆記|我的筆記]]。' }] });
  });

  it('takes a heading of the same level, and calls another level a change of type', () => {
    const h = unit({ unit_id: 'h1', role: 'heading', translation: '渡口' });
    const heading: SyncBlock = { block_id: 'h1', markdown: '## 渡口 ^h1', units: [h] };
    expect(reverseBlock(heading, '## 新渡口 ^h1')).toMatchObject({ ok: true, texts: [{ text: '新渡口' }] });
    expect(reverseBlock(heading, '### 新渡口')).toEqual({ ok: false, kind: 'type' });
    expect(reverseBlock(heading, '## 新渡口\n第二行')).toEqual({ ok: false, kind: 'type' });
  });

  it('takes an untranslated heading once the callout line is gone', () => {
    const h = unit({ unit_id: 'h1', role: 'title', state: 'FAILED_QA', translation: null, source: 'The Ford' });
    const heading: SyncBlock = { block_id: 'h1', markdown: '# The Ford ^h1\n> [!untranslated] FAILED_QA', units: [h] };
    expect(reverseBlock(heading, '# 渡口 ^h1\n> [!untranslated] FAILED_QA')).toEqual({ ok: false, kind: 'untranslated' });
    expect(reverseBlock(heading, '# 渡口 ^h1')).toMatchObject({ ok: true, texts: [{ text: '渡口' }] });
    expect(reverseBlock(heading, '## 渡口')).toEqual({ ok: false, kind: 'type' });
  });

  it('takes a blocked heading as a heading line or as plain text', () => {
    const h = unit({ unit_id: 'h1', role: 'heading', state: 'BLOCKED', translation: null });
    const heading: SyncBlock = { block_id: 'h1', markdown: '> [!untranslated] BLOCKED', units: [h] };
    expect(reverseBlock(heading, '## 渡口')).toMatchObject({ ok: true, texts: [{ text: '渡口' }] });
    expect(reverseBlock(heading, '渡口')).toMatchObject({ ok: true, texts: [{ text: '渡口' }] });
    expect(reverseBlock(heading, '> 渡口')).toEqual({ ok: false, kind: 'type' });
  });

  it('takes a list item with its dash', () => {
    const item = unit({ unit_id: 'l1', role: 'list_item' });
    expect(reverseBlock({ block_id: 'l1', markdown: '- 譯文', units: [item] }, '- 改過的\n第二行')).toMatchObject({ ok: true, texts: [{ text: '改過的\n第二行' }] });
    expect(reverseBlock({ block_id: 'l1', markdown: '- 譯文', units: [item] }, '改過的')).toEqual({ ok: false, kind: 'type' });
  });

  it('takes a callout of the same type, and calls another type a change of type', () => {
    const side = unit({ unit_id: 's1', role: 'sidebar' });
    const block: SyncBlock = { block_id: 's1', markdown: '> [!sidebar]\n> 譯文\n^s1', units: [side] };
    expect(reverseBlock(block, '> [!sidebar]\n> 改過的\n>\n> \\> 第二行\n^s1')).toMatchObject({ ok: true, texts: [{ text: '改過的\n\n> 第二行' }] });
    expect(reverseBlock(block, '> [!note]\n> 改過的')).toEqual({ ok: false, kind: 'type' });
    expect(reverseBlock(block, '> [!sidebar]\n改過的')).toEqual({ ok: false, kind: 'type' });
    expect(reverseBlock(block, '改過的')).toEqual({ ok: false, kind: 'type' });
    const stat = unit({ unit_id: 'g1', role: 'generic:stat_block' });
    expect(reverseBlock({ block_id: 'g1', markdown: '> [!stat-block]\n> 譯文', units: [stat] }, '> [!stat-block]\n> 改過')).toMatchObject({ ok: true });
  });

  it('takes plain text in place of an untranslated callout, whatever the role', () => {
    for (const role of ['paragraph', 'sidebar', 'list_item']) {
      const waiting = unit({ unit_id: 'u1', role, state: 'FAILED_QA', translation: null });
      const block: SyncBlock = { block_id: 'u1', markdown: '> [!untranslated] FAILED_QA\n> Source text.\n^u1', units: [waiting] };
      expect(reverseBlock(block, '人工譯文。\n^u1')).toMatchObject({ ok: true, texts: [{ text: '人工譯文。' }] });
      expect(reverseBlock(block, '> [!untranslated] FAILED_QA\n> Source text, fixed.')).toEqual({ ok: false, kind: 'untranslated' });
    }
    const side = unit({ unit_id: 'u1', role: 'sidebar', state: 'BLOCKED', translation: null });
    expect(reverseBlock({ block_id: 'u1', markdown: '> [!untranslated] BLOCKED', units: [side] }, '> [!sidebar]\n> 人工譯文')).toMatchObject({
      ok: true,
      texts: [{ text: '人工譯文' }],
    });
  });

  it('takes the edited cells of a table, each to its own unit', () => {
    const cells = ['r0c0', 'r0c1', 'r1c0', 'r1c1'].map((id) => unit({ unit_id: `t1-${id}`, role: 'table' }));
    const table: SyncBlock = { block_id: 't1', markdown: '| 甲 | 乙 |\n| --- | --- |\n| 丙 | a\\|b<br>c |\n\n^t1', units: cells };
    const result = reverseBlock(table, '| 甲 | 乙改 |\n| --- | --- |\n| 丙 | a\\|b<br>c 改 |\n\n^t1');
    expect(result).toEqual({
      ok: true,
      texts: [
        { unit: cells[1], text: '乙改' },
        { unit: cells[3], text: 'a|b\nc 改' },
      ],
      busy: 0,
    });
  });

  it('takes nothing from a table Obsidian only padded', () => {
    const cells = ['r0c0', 'r1c0'].map((id) => unit({ unit_id: `t1-${id}`, role: 'table' }));
    const table: SyncBlock = { block_id: 't1', markdown: '| 甲 |\n| --- |\n| 丙 |', units: cells };
    expect(reverseBlock(table, '|  甲   |\n|:-----:|\n|  丙   |')).toEqual({ ok: true, texts: [], busy: 0 });
  });

  it('calls a table with other rows or columns, a broken separator or a filled cell with no unit a change of table', () => {
    const cells = ['r0c0', 'r0c1', 'r1c0'].map((id) => unit({ unit_id: `t1-${id}`, role: 'table' }));
    const table: SyncBlock = { block_id: 't1', markdown: '| 甲 | 乙 |\n| --- | --- |\n| 丙 |  |', units: cells };
    expect(reverseBlock(table, '| 甲 | 乙 |\n| --- | --- |\n| 丙 |  |\n| 丁 |  |')).toEqual({ ok: false, kind: 'table' });
    expect(reverseBlock(table, '| 甲 | 乙 | 丙 |\n| --- | --- | --- |\n| 丙 |  |  |')).toEqual({ ok: false, kind: 'table' });
    expect(reverseBlock(table, '| 甲 | 乙 |\n| 丙 |  |')).toEqual({ ok: false, kind: 'table' });
    expect(reverseBlock(table, '| 甲 | 乙 |\n| --- | --- |\n| 丙 | 填了 |')).toEqual({ ok: false, kind: 'table' });
    expect(reverseBlock(table, '| 甲 | 乙 |\n| --- | --- |\n丙 |  |')).toEqual({ ok: false, kind: 'table' });
    expect(reverseBlock(table, '| 甲 | 乙 |\n| -- | -- |\n| 丙 |  |')).toEqual({ ok: false, kind: 'table' });
  });

  it('takes a table of a header alone, and a row of one empty cell written with no space', () => {
    const header = ['r0c0', 'r0c1'].map((id) => unit({ unit_id: `t1-${id}`, role: 'table' }));
    expect(reverseBlock({ block_id: 't1', markdown: '| 甲 | 乙 |\n| --- | --- |', units: header }, '| 甲 | 丙 |\n| --- | --- |')).toEqual({
      ok: true,
      texts: [{ unit: header[1], text: '丙' }],
      busy: 0,
    });
    const rows = ['r0c0', 'r2c0'].map((id) => unit({ unit_id: `t1-${id}`, role: 'table' }));
    expect(reverseBlock({ block_id: 't1', markdown: '| 甲 |\n| --- |\n|  |\n| 丙 |', units: rows }, '| 甲 |\n| --- |\n||\n| 丁 |')).toEqual({
      ok: true,
      texts: [{ unit: rows[1], text: '丁' }],
      busy: 0,
    });
  });

  it('counts the units still out with the provider, and takes the rest', () => {
    const cells = [unit({ unit_id: 't1-r0c0', state: 'IN_FLIGHT', translation: null }), unit({ unit_id: 't1-r0c1', state: 'RECEIVED', translation: null }), unit({ unit_id: 't1-r1c0' })];
    const table: SyncBlock = { block_id: 't1', markdown: '| Source text. | Source text. |\n| --- | --- |\n| 譯文 |  |', units: cells };
    expect(reverseBlock(table, '| 甲 | 乙 |\n| --- | --- |\n| 丙 |  |')).toEqual({ ok: true, texts: [{ unit: cells[2], text: '丙' }], busy: 2 });
    const out = unit({ unit_id: 'p1', state: 'IN_FLIGHT', translation: null });
    expect(reverseBlock(paragraph('> [!untranslated] IN_FLIGHT\n> Source text.', [out]), '人工譯文。')).toEqual({ ok: true, texts: [], busy: 1 });
  });

  it('trims the spaces around a heading, whatever its level is known or not', () => {
    const h = unit({ unit_id: 'h1', role: 'heading', translation: '渡口' });
    expect(reverseBlock({ block_id: 'h1', markdown: '## 渡口', units: [h] }, '##  新渡口  ')).toMatchObject({ ok: true, texts: [{ text: '新渡口' }] });
    const blocked = unit({ unit_id: 'h1', role: 'heading', state: 'BLOCKED', translation: null });
    const old: SyncBlock = { block_id: 'h1', markdown: '> [!untranslated] BLOCKED', units: [blocked] };
    expect(reverseBlock(old, '##  渡口  ')).toMatchObject({ ok: true, texts: [{ text: '渡口' }] });
    expect(reverseBlock(old, '  渡口  ')).toMatchObject({ ok: true, texts: [{ text: '渡口' }] });
  });

  it('calls a callout with a line out of the quote, or a heading inside, a change of type', () => {
    const side = unit({ unit_id: 's1', role: 'sidebar' });
    const block: SyncBlock = { block_id: 's1', markdown: '> [!sidebar]\n> 譯文', units: [side] };
    expect(reverseBlock(block, '> [!sidebar]\n> 第一行\n第二行')).toEqual({ ok: false, kind: 'type' });
    expect(reverseBlock(block, '> [!sidebar]\n> 第一行\n> # 標題')).toEqual({ ok: false, kind: 'type' });
  });

  it('calls a list item with a heading on its second line a change of type', () => {
    const item = unit({ unit_id: 'l1', role: 'list_item' });
    expect(reverseBlock({ block_id: 'l1', markdown: '- 譯文', units: [item] }, '- 改過的\n# 標題')).toEqual({ ok: false, kind: 'type' });
  });

  it('keeps the kind of the first line a translated paragraph started with', () => {
    expect(reverseBlock(paragraph('- 原本就以破折號開頭'), '- 改過的，仍以破折號開頭')).toMatchObject({ ok: true, texts: [{ text: '- 改過的，仍以破折號開頭' }] });
    expect(reverseBlock(paragraph('譯文的結尾是|'), '改過的譯文結尾是|')).toMatchObject({ ok: true, texts: [{ text: '改過的譯文結尾是|' }] });
  });

  it('treats a unit with a translation that is not DONE as untranslated', () => {
    const stale = unit({ unit_id: 'p1', state: 'STALE', translation: '舊譯文' });
    const block: SyncBlock = { block_id: 'p1', markdown: '> [!untranslated] STALE\n> Source text.', units: [stale] };
    expect(reverseBlock(block, '人工譯文。')).toMatchObject({ ok: true, texts: [{ text: '人工譯文。' }] });
  });

  it('calls a table with only a header, fewer cells in a row, or a row with no closing bar a change of table', () => {
    const cells = ['r0c0', 'r0c1', 'r1c0', 'r1c1'].map((id) => unit({ unit_id: `t1-${id}`, role: 'table' }));
    const table: SyncBlock = { block_id: 't1', markdown: '| 甲 | 乙 |\n| --- | --- |\n| 丙 | 丁 |', units: cells };
    expect(reverseBlock(table, '| 甲 | 乙 |')).toEqual({ ok: false, kind: 'table' });
    expect(reverseBlock(table, '| 甲 | 乙 |\n| --- | --- |\n| 丙 |')).toEqual({ ok: false, kind: 'table' });
    expect(reverseBlock(table, '| 甲 | 乙 |\n| --- | --- |\n| 丙 | 丁')).toEqual({ ok: false, kind: 'table' });
  });

  it('calls a block with no unit, or one with a page marker inside, a change it cannot take', () => {
    expect(reverseBlock({ block_id: 'f1', markdown: '> [!figure] 原書 p.3 的圖', units: [] }, '> [!figure] 我改的')).toEqual({ ok: false, kind: 'type' });
    expect(reverseBlock(paragraph('譯文'), '<!-- page: 3 -->\n改過的')).toEqual({ ok: false, kind: 'other' });
  });
});

// ---------------------------------------------------------------- H-12：不會寫到別的區塊

interface Item {
  /** 沒有併段、拆段時，這段是哪個原本的區塊。 */
  readonly orig: number | null;
  /** 這段的文字來自哪些原本的區塊；新加的是空的。 */
  readonly from: readonly number[];
  readonly text: string;
}

interface Op {
  readonly type: 'edit' | 'split' | 'delete' | 'merge' | 'swap' | 'add' | 'move';
  readonly at: number;
  readonly to?: number;
}

const WORDS = ['salt', 'marsh', 'ferry', 'warden', 'lantern', 'reed', 'tide', 'stone', 'gate', 'rain', 'night', 'bridge'];

function applyOps(texts: readonly string[], ops: readonly Op[]): Item[] {
  let items: Item[] = texts.map((text, index) => ({ orig: index, from: [index], text }));
  let fresh = 0;
  for (const op of ops) {
    if (items.length === 0) break;
    const at = op.at % items.length;
    const item = items[at] as Item;
    if (op.type === 'edit') {
      fresh += 1;
      items[at] = { ...item, text: `${item.text} edited${fresh}` };
    } else if (op.type === 'delete') {
      items.splice(at, 1);
    } else if (op.type === 'add') {
      fresh += 1;
      items.splice(at, 0, { orig: null, from: [], text: `note${fresh} of the reader` });
    } else if (op.type === 'split') {
      const words = item.text.split(' ');
      // 把併起來的段在別處拆開，等於把字從一段搬到另一段，跟兩段各改一些分不出來，不在這裡驗證（ADR-0125）。
      if (words.length < 2 || item.from.length > 1) continue;
      const half = Math.floor(words.length / 2);
      items.splice(at, 1, { orig: null, from: item.from, text: words.slice(0, half).join(' ') }, { orig: null, from: item.from, text: words.slice(half).join(' ') });
    } else if (op.type === 'merge') {
      const next = items[at + 1];
      // 拆出來的一段再併進別段，同樣是把字搬過界線。
      const piece = (candidate: Item): boolean => candidate.orig === null && candidate.from.length > 0;
      if (next === undefined || piece(item) || piece(next)) continue;
      items.splice(at, 2, { orig: null, from: [...new Set([...item.from, ...next.from])], text: `${item.text} ${next.text}` });
    } else if (op.type === 'swap') {
      const next = items[at + 1];
      if (next === undefined) continue;
      items[at] = next;
      items[at + 1] = item;
    } else {
      items.splice(at, 1);
      items.splice((op.to ?? 0) % (items.length + 1), 0, item);
    }
  }
  return items;
}

const paragraphs = fc.array(fc.array(fc.constantFrom(...WORDS), { minLength: 4, maxLength: 9 }).map((words) => words.join(' ')), {
  minLength: 2,
  maxLength: 12,
});
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ type: fc.constantFrom('edit' as const, 'split' as const, 'delete' as const, 'merge' as const, 'swap' as const, 'add' as const), at: fc.nat(20) }),
  fc.record({ type: fc.constant('move' as const), at: fc.nat(20), to: fc.nat(20) }),
);

describe('H-12: tome sync never writes to another block (ADR-0125)', () => {
  // 開發時性質測試找到、逐一修掉的反例，固定留著，不靠亂數再碰到。
  const salt = (count: number): string[] => Array.from({ length: count }, () => 'salt salt salt salt');
  const FOUND: readonly (readonly [string, readonly string[], readonly Op[]])[] = [
    ['a paragraph moved into the place of a deleted one', salt(4), [{ type: 'move', at: 0, to: 17 }, { type: 'delete', at: 14 }]],
    ['a split, with one half moved away', salt(2), [{ type: 'split', at: 0 }, { type: 'move', at: 0, to: 2 }]],
    ['a piece as like every block as its own', salt(4), [{ type: 'split', at: 11 }, { type: 'move', at: 0, to: 1 }, { type: 'split', at: 3 }, { type: 'move', at: 8, to: 9 }, { type: 'move', at: 0, to: 3 }]],
    ['a piece moved into the place of a deleted block', salt(4), [{ type: 'split', at: 11 }, { type: 'delete', at: 0 }, { type: 'move', at: 14, to: 0 }]],
    ['a paragraph merged into a longer one', ['salt salt salt salt salt', 'salt salt salt salt', 'salt salt salt salt'], [{ type: 'move', at: 2, to: 0 }, { type: 'merge', at: 0 }]],
    ['a paragraph merged in after a move', ['salt lantern salt salt salt stone salt', 'salt salt salt salt', 'salt salt salt salt'], [{ type: 'move', at: 0, to: 1 }, { type: 'merge', at: 4 }, { type: 'move', at: 7, to: 0 }]],
    ['a fragment of another block in the place of a deleted one', ['warden salt gate salt', 'salt salt salt salt', 'lantern lantern salt gate'], [{ type: 'split', at: 17 }, { type: 'move', at: 13, to: 15 }, { type: 'swap', at: 5 }, { type: 'delete', at: 0 }, { type: 'move', at: 2, to: 1 }]],
    ['an edited paragraph moved away, with a note in its place', salt(3), [{ type: 'add', at: 0 }, { type: 'edit', at: 6 }, { type: 'swap', at: 0 }, { type: 'swap', at: 6 }]],
    ['a note added before a moved and edited paragraph', [...salt(3), 'salt tide salt salt', 'salt salt salt salt'], [{ type: 'add', at: 18 }, { type: 'move', at: 16, to: 0 }, { type: 'edit', at: 0 }]],
  ];

  it.each(FOUND)('never takes text that came from another block: %s', (_name, texts, ops) => {
    const unique = texts.map((text, index) => `${text} ${index}`);
    const items = applyOps(unique, ops);
    const { edits } = alignFile(olds(...unique), fileOf(items.map(({ text }) => text)));
    const kept = new Set(items.flatMap(({ from }) => from));
    for (const { block_id, markdown } of edits) {
      const block = Number(block_id.slice(1));
      const source = items.find((item) => item.text === markdown);
      const own = source !== undefined && source.from.length === 1 && source.from[0] === block;
      const replaced = source !== undefined && source.from.length === 0 && !kept.has(block);
      expect(own || replaced, `${block_id} got text that is not its own`).toBe(true);
    }
  });

  it('takes an edit next to a block that shares many words with it', () => {
    const unique = ['salt salt salt salt', 'salt tide ferry bridge', 'reed salt tide ferry gate bridge', 'salt salt salt salt', 'salt salt salt salt'].map((text, index) => `${text} ${index}`);
    const after = unique.map((text, index) => (index === 1 ? `${text} edited` : text));
    expect(alignFile(olds(...unique), fileOf(after)).edits).toEqual([{ block_id: 'b1', markdown: `${unique[1]} edited` }]);
  });

  it('never takes text that came from another block, whatever was done to the file', () => {
    fc.assert(
      fc.property(paragraphs, fc.array(op, { maxLength: 6 }), fc.boolean(), (texts, ops, marker) => {
        // 區塊各不相同，跟真的書一樣；重複的段落交給序列比對自己挑。
        const unique = texts.map((text, index) => `${text} ${index}`);
        const items = applyOps(unique, ops);
        const { edits } = alignFile(olds(...unique), fileOf(items.map(({ text }) => text), marker));
        const kept = new Set(items.flatMap(({ from }) => from));
        for (const { block_id, markdown } of edits) {
          const block = Number(block_id.slice(1));
          const source = items.find((item) => item.text === markdown);
          // 回收的文字只能來自這個區塊：改過的它、或它拆開後留下的一段。
          const own = source !== undefined && source.from.length === 1 && source.from[0] === block;
          // 已知的限制：同一個位置刪掉一段、又加一段別的，會當成改了那一段（ADR-0125）。
          const replaced = source !== undefined && source.from.length === 0 && !kept.has(block);
          expect(own || replaced, `${block_id} got text that is not its own`).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('takes back the whole final text of a block that was only edited, never a part of it', () => {
    fc.assert(
      fc.property(paragraphs, fc.array(fc.record({ type: fc.constantFrom('edit' as const, 'delete' as const, 'add' as const, 'move' as const, 'swap' as const), at: fc.nat(20), to: fc.nat(20) }), { maxLength: 6 }), (texts, ops) => {
        // 沒有拆段、併段時，回收的一定是那個區塊最後的整段文字。
        const unique = texts.map((text, index) => `${text} ${index}`);
        const items = applyOps(unique, ops);
        const { edits } = alignFile(olds(...unique), fileOf(items.map(({ text }) => text)));
        const kept = new Set(items.flatMap(({ from }) => from));
        for (const { block_id, markdown } of edits) {
          const block = Number(block_id.slice(1));
          const same = items.some((item) => item.orig === block && item.text === markdown);
          const replaced = !kept.has(block) && items.some((item) => item.from.length === 0 && item.text === markdown);
          expect(same || replaced, `${block_id} got a text that is not its final one`).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('takes back every edit that has unchanged neighbors', () => {
    fc.assert(
      fc.property(paragraphs, fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }), (texts, picks) => {
        const unique = texts.map((text, index) => `${text} ${index}`);
        // 彼此不相鄰的區塊改字。
        const chosen = unique.map((_text, index) => picks[index] === true && index % 2 === 1);
        const after = unique.map((text, index) => (chosen[index] ? `${text} edited` : text));
        const { edits, changes } = alignFile(olds(...unique), fileOf(after));
        expect(changes).toEqual([]);
        expect(edits).toEqual(after.flatMap((markdown, index) => (chosen[index] ? [{ block_id: `b${index}`, markdown }] : [])));
      }),
      { numRuns: 300 },
    );
  });
});
