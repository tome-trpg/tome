import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBook, withBookLock } from './book.ts';
import { finding, type Finding } from './findings.ts';
import { applyHuman, BUSY_STATES, saveHuman, withSeries, type HumanText } from './human.ts';
import type { Placeholder } from './mask.ts';
import type { PlanOutcome } from './request.ts';
import { openBookStore, type Store } from './store.ts';
import { calloutType } from './vault.ts';
import { pathFindings, readWorkspaceConfig } from './workspace.ts';

// tome sync（ADR-0012、ADR-0125）。讀回 vault 的章節檔，跟上次輸出的區塊做序列比對：一個區塊對一段新文字
// 才回收成人工譯文，併段、拆段、搬動、新增、刪除與類型改變都不猜，記成回收不了。寧可回收不了，
// 不要寫到別的區塊（H-12）。讀回的是書本文字，只存進 book.db 與 series.db；訊息只印數量（ADR-0059）。

export const CHANGE_KINDS = [
  'merged',
  'split',
  'moved',
  'added',
  'deleted',
  'type',
  'untranslated',
  'table',
  'ambiguous',
  'in_flight',
  'other',
  'file',
  // `tome assemble --force` 才記：上次 `tome sync` 之後才改的檔，或沒跑過 `tome sync` 的檔。
  'unsynced',
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** 一個檔的差異超過這麼多段就整個檔記成回收不了，不往下算。 */
export const MAX_EDITS = 2000;
/** 跨區塊的一塊差異裡，一對一配的兩段新舊都至少要留著這麼多的字（字元的最長共同子序列）。 */
export const MIN_KEPT = 0.75;
/** 一段的字元雙字組有這麼多出現在另一段裡，就當成它的一部分（拆出來或併進去的）。 */
export const CONTAINED = 0.8;
/** 比這短的段（字元雙字組的數量）不當成拆出來的段。 */
const MIN_PIECE = 4;

const PARAGRAPH_BREAK = /\n{2,}/gu;
const FRONTMATTER = /^---\n[\s\S]*\n---$/u;
const PAGE_MARKER = /^<!-- page: [^\n]* -->$/u;
const UNTRANSLATED_LINE = /^> ?\[!untranslated\]/u;
const HEADING_LINE = /^(#{1,6}) (.*)$/u;
const TABLE_SEPARATOR = /^\|(\s*:?-{3,}:?\s*\|)+$/u;
const LINK = /\[\[[^\]|]*\|([^\]]*)\]\]/gu;
const PAGE_REF = 'page_ref';

// ---------------------------------------------------------------- 序列比對

export type DiffOp =
  | { readonly type: 'equal'; readonly a: number; readonly b: number }
  | { readonly type: 'delete'; readonly a: number }
  | { readonly type: 'insert'; readonly b: number };

/** Myers 差異演算法的中段。`limit` 是最多幾個增刪，超過回傳 null。 */
function myers(a: readonly string[], b: readonly string[], limit: number): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // 每一步開始前的 V，只留 k 在 [-d-1, d+1] 的那一段，記憶體跟增刪數的平方成正比。
  const trace: Int32Array[] = [];
  const at = (k: number): number => v[offset + k] ?? 0;
  for (let d = 0; d <= Math.min(max, limit); d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? at(k + 1) : at(k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], n: number, m: number): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const window = trace[d] as Int32Array;
    const get = (k: number): number => window[k + d + 1] ?? 0;
    const k = x - y;
    const previousK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const previousX = get(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      ops.push({ type: 'equal', a: x, b: y });
    }
    if (d > 0) {
      if (x === previousX) ops.push({ type: 'insert', b: y - 1 });
      else ops.push({ type: 'delete', a: x - 1 });
    }
    x = previousX;
    y = previousY;
  }
  return ops.reverse();
}

/** 兩串段的差異，先去掉頭尾相同的。增刪超過 `limit` 回傳 null。 */
export function diffSequences(a: readonly string[], b: readonly string[], limit: number = MAX_EDITS): DiffOp[] | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const middle = myers(a.slice(head, a.length - tail), b.slice(head, b.length - tail), limit);
  if (middle === null) return null;
  const shifted = middle.map((op): DiffOp => {
    if (op.type === 'equal') return { type: 'equal', a: op.a + head, b: op.b + head };
    return op.type === 'delete' ? { type: 'delete', a: op.a + head } : { type: 'insert', b: op.b + head };
  });
  const before = Array.from({ length: head }, (_, index): DiffOp => ({ type: 'equal', a: index, b: index }));
  const after = Array.from({ length: tail }, (_, index): DiffOp => ({
    type: 'equal',
    a: a.length - tail + index,
    b: b.length - tail + index,
  }));
  return [...before, ...shifted, ...after];
}

interface Grams {
  readonly text: string;
  readonly counts: ReadonlyMap<string, number>;
  readonly size: number;
}

function gramsOf(text: string): Grams {
  const counts = new Map<string, number>();
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return { text, counts, size: Math.max(text.length - 1, 0) };
}

function dice(a: Grams, b: Grams): number {
  const total = a.size + b.size;
  if (total === 0) return a.text === b.text ? 1 : 0;
  let both = 0;
  for (const [gram, count] of a.counts) both += Math.min(count, b.counts.get(gram) ?? 0);
  return (2 * both) / total;
}

/** 字元雙字組的 Dice 係數，0 到 1。 */
export function similarity(left: string, right: string): number {
  return dice(gramsOf(left), gramsOf(right));
}

/** `part` 的字元雙字組有多少出現在 `whole` 裡，0 到 1。`part` 只有一個字時看有沒有這個字。 */
function containment(part: Grams, whole: Grams): number {
  if (part.size === 0) return part.text !== '' && whole.text.includes(part.text) ? 1 : 0;
  let both = 0;
  for (const [gram, count] of part.counts) both += Math.min(count, whole.counts.get(gram) ?? 0);
  return both / part.size;
}

/** 加進去的一串字至少這麼長（字元），又原封不動出現在別的區塊裡，就當成從那裡併過來的。 */
export const MIN_BORROWED = 8;

/**
 * 新文字整段、或加進去的字（跟舊的比）有一串，在同一個檔的別的區塊原封不動出現：多半是別處拆出來、
 * 併過來或搬過來的（ADR-0125）。
 */
function borrowed(blocks: readonly OldBlock[], owner: number, markdown: string): boolean {
  const mine = blocks[owner]?.markdown ?? '';
  const others = blocks.filter((block, index) => index !== owner && block.markdown !== mine);
  const whole = markdown.trim();
  if (Array.from(whole).length >= MIN_BORROWED && !mine.includes(whole) && others.some((block) => block.markdown.includes(whole))) return true;
  const before = Array.from(mine);
  const after = Array.from(markdown);
  const ops = diffSequences(before, after);
  if (ops === null) return true;
  const runs: string[] = [];
  let run = '';
  for (const op of ops) {
    if (op.type === 'insert') {
      run += after[op.b] ?? '';
    } else if (op.type === 'equal') {
      runs.push(run);
      run = '';
    }
  }
  runs.push(run);
  // 併過來的字前後常帶著接起來的標點或空白，所以看加進去的字裡有沒有任何一串 `MIN_BORROWED` 個字在別的區塊。
  return runs.some((text) => {
    const chars = Array.from(text);
    for (let start = 0; start + MIN_BORROWED <= chars.length; start += 1) {
      const window = chars.slice(start, start + MIN_BORROWED).join('');
      if (others.some((block) => block.markdown.includes(window))) return true;
    }
    return false;
  });
}

function commonLength(left: readonly string[], right: readonly string[]): number | null {
  const ops = diffSequences(left, right);
  return ops === null ? null : ops.filter(({ type }) => type === 'equal').length;
}

/**
 * 段與段的界線沒有移動：把新舊各自接起來，界線用不會出現在書裡的字。保住每一條界線的對齊（各段分開算的
 * 最長共同子序列加上界線），要比任何一條界線對不上的對齊都長；一樣長就表示界線可能往前或往後挪了（ADR-0125）。
 */
export function boundariesKept(before: readonly string[], after: readonly string[]): boolean {
  if (before.length !== after.length) return false;
  let separate = before.length - 1;
  for (const [index, part] of before.entries()) {
    const common = commonLength(Array.from(part), Array.from(after[index] ?? ''));
    if (common === null) return false;
    separate += common;
  }
  // 第 `cut` 條界線兩邊用不同的字，對不上；其他界線照樣可以對上。
  const joined = (parts: readonly string[], cut: number, side: string): string[] =>
    parts.flatMap((part, index) => (index === 0 ? Array.from(part) : [index === cut ? `\u0000${side}` : '\u0000', ...Array.from(part)]));
  for (let cut = 1; cut < before.length; cut += 1) {
    const crossing = commonLength(joined(before, cut, 'old'), joined(after, cut, 'new'));
    if (crossing === null || crossing >= separate) return false;
  }
  return true;
}

/** 新舊兩段的字都至少留著 `MIN_KEPT`：只改了幾個字，不是換了一段、也沒有併進別的段（ADR-0125）。 */
export function lightlyEdited(before: string, after: string): boolean {
  const left = Array.from(before);
  const right = Array.from(after);
  const ops = diffSequences(left, right);
  if (ops === null) return false;
  const kept = ops.filter(({ type }) => type === 'equal').length;
  return kept >= MIN_KEPT * left.length && kept >= MIN_KEPT * right.length;
}

// ---------------------------------------------------------------- 對回區塊

export interface OldBlock {
  readonly block_id: string;
  readonly markdown: string;
}

export interface BlockEdit {
  readonly block_id: string;
  /** 這個區塊在目前的檔案裡的樣子。 */
  readonly markdown: string;
}

export interface FileChange {
  readonly kind: ChangeKind;
  /** 前一個與後一個對上的區塊，交付報告連到這裡。 */
  readonly before: string | null;
  readonly after: string | null;
}

export interface FileAlignment {
  readonly edits: readonly BlockEdit[];
  readonly changes: readonly FileChange[];
  /** 把對上的區塊換回上次的 Markdown 之後的檔案，跟上次輸出的雜湊一樣才算整個檔都回收了。 */
  readonly candidate: string;
}

interface Chunk {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** CRLF 換成 LF、拿掉 BOM、結尾的換行補成一個。 */
export function normalizeText(text: string): string {
  return `${text.replace(/^﻿/u, '').replace(/\r\n?/gu, '\n').replace(/\n+$/u, '')}\n`;
}

function chunksOf(body: string): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0;
  for (const match of body.matchAll(PARAGRAPH_BREAK)) {
    chunks.push({ text: body.slice(start, match.index), start, end: match.index });
    start = match.index + match[0].length;
  }
  chunks.push({ text: body.slice(start), start, end: body.length });
  return chunks.filter(({ text }) => text !== '');
}

/** 比對用的鍵：忽略行尾空白，編輯器去掉行尾空白不算改動。 */
function keyOf(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
}

function isSkeleton(chunk: Chunk, index: number): boolean {
  return (index === 0 && FRONTMATTER.test(chunk.text)) || PAGE_MARKER.test(chunk.text);
}

interface Hunk {
  readonly deleted: number[];
  readonly inserted: number[];
  readonly before: string | null;
  after: string | null;
}

/**
 * 把目前的檔案對回上次輸出的區塊（ADR-0125）。兩段沒變的段之間是一塊差異：全部屬於同一個區塊、段數一樣才回收；
 * 跨區塊要段數一樣、每一對都夠像而且比配給別的區塊像；其他都記成回收不了。
 */
export function alignFile(blocks: readonly OldBlock[], text: string): FileAlignment {
  const normalized = normalizeText(text);
  const body = normalized.slice(0, -1);
  const oldChunks = blocks.flatMap((block, owner) =>
    block.markdown.split(PARAGRAPH_BREAK).filter((part) => part !== '').map((part) => ({ owner, text: part })),
  );
  const partsOf = blocks.map((_block, owner) => oldChunks.flatMap((chunk, index) => (chunk.owner === owner ? [index] : [])));
  const all = chunksOf(body);
  const content = all.filter((chunk, index) => !isSkeleton(chunk, index));
  const ops = diffSequences(
    oldChunks.map(({ text: part }) => keyOf(part)),
    content.map((chunk) => keyOf(chunk.text)),
  );
  if (ops === null) return { edits: [], changes: [{ kind: 'other', before: null, after: null }], candidate: normalized };

  const blockId = (owner: number): string => blocks[owner]?.block_id ?? '';
  const oldGrams = blocks.map(({ markdown }) => gramsOf(markdown));
  const oldKeys = new Set(oldChunks.map(({ text: part }) => keyOf(part)));
  // 檔案裡有別的區塊跟配給它的區塊一樣像、或更像這段新文字，就不能照位置配：多半是別處搬過來或拆出來的段落。
  // 跟每個區塊都沒有共同的字（整段重寫）才只看位置。文字一樣的區塊不算。
  // 沒翻成的區塊上次輸出的是原文，人工譯文本來就不像它，不比像不像，只看位置與下面的防護（ADR-0125）。
  const untranslated = (owner: number): boolean => (blocks[owner]?.markdown ?? '').split('\n').some((line) => UNTRANSLATED_LINE.test(line));
  const rivalled = (owner: number, fresh: Grams, own: number): boolean =>
    blocks.some((block, other) => {
      const grams = oldGrams[other];
      if (other === owner || grams === undefined || block.markdown === blocks[owner]?.markdown) return false;
      const score = dice(grams, fresh);
      return score > 0 && score >= own;
    });
  // 目前的檔案裡每一段屬於哪個區塊（沒變的與回收的）；舊的段哪些原封不動對上了。
  const assigned = new Map<number, number>();
  const unchanged = new Set<number>();
  // `replaces`：這筆換掉的舊段。
  const edits: (BlockEdit & {
    readonly owner: number;
    readonly indices: readonly number[];
    readonly replaces: readonly number[];
    readonly before: string | null;
    readonly after: string | null;
  })[] = [];
  const changes: FileChange[] = [];
  const removed: { readonly keys: string; readonly change: FileChange }[] = [];
  const added: { readonly keys: string; readonly change: FileChange }[] = [];
  // 只屬於一個區塊的差異先記著：同一個區塊可能有好幾塊（中間隔著沒變的段），全部看完才合成一筆（ADR-0125）。
  interface Pending {
    readonly replaced: Map<number, number>;
    readonly inserted: number[];
    readonly before: string | null;
    after: string | null;
  }
  const pending = new Map<number, Pending>();

  const settle = (hunk: Hunk): void => {
    const { deleted, inserted, before, after } = hunk;
    const record = (kind: ChangeKind): FileChange => {
      const change = { kind, before, after };
      changes.push(change);
      return change;
    };
    if (deleted.length === 0) {
      added.push({ keys: inserted.map((index) => keyOf(content[index]?.text ?? '')).join('\n\n'), change: record('added') });
      return;
    }
    if (inserted.length === 0) {
      removed.push({ keys: deleted.map((index) => keyOf(oldChunks[index]?.text ?? '')).join('\n\n'), change: record('deleted') });
      return;
    }
    if (inserted.length !== deleted.length) {
      record(inserted.length > deleted.length ? 'split' : 'merged');
      return;
    }
    const owners = [...new Set(deleted.map((index) => oldChunks[index]?.owner ?? -1))];
    if (owners.length === 1) {
      const owner = owners[0] as number;
      const entry: Pending = pending.get(owner) ?? { replaced: new Map(), inserted: [], before, after };
      for (const [order, index] of deleted.entries()) entry.replaced.set(index, inserted[order] as number);
      entry.inserted.push(...inserted);
      entry.after = after;
      pending.set(owner, entry);
      return;
    }
    // 跨區塊：舊的都是完整的區塊，才照各區塊的段數一對一配。
    const whole = owners.every((owner) => (partsOf[owner] ?? []).every((index) => deleted.includes(index)));
    if (!whole) {
      record('ambiguous');
      return;
    }
    let cursor = 0;
    const groups = owners.map((owner) => {
      const count = (partsOf[owner] ?? []).length;
      const indices = inserted.slice(cursor, cursor + count);
      cursor += count;
      return { owner, indices, markdown: indices.map((index) => content[index]?.text ?? '').join('\n\n') };
    });
    const old = owners.map((owner) => blocks[owner]?.markdown ?? '');
    if (!boundariesKept(old, groups.map((group) => group.markdown))) {
      record('ambiguous');
      return;
    }
    const score = old.map((markdown) => groups.map((group) => similarity(markdown, group.markdown)));
    // 連續幾段沒翻成的一起補上譯文：只看位置（界線上面已經查過）。
    const filled = owners.every(untranslated);
    const paired = filled || score.every((row, i) => {
      const own = row[i] ?? 0;
      const group = groups[i];
      const before = old[i] ?? '';
      return (
        group !== undefined &&
        lightlyEdited(before, group.markdown) &&
        row.every((value, j) => j === i || value < own) &&
        score.every((other, j) => j === i || (other[i] ?? 0) < own) &&
        !rivalled(group.owner, gramsOf(group.markdown), own)
      );
    });
    if (!paired) {
      record('ambiguous');
      return;
    }
    for (const { owner, indices, markdown } of groups) {
      for (const index of indices) assigned.set(index, owner);
      edits.push({ block_id: blockId(owner), markdown, owner, indices, replaces: partsOf[owner] ?? [], before, after });
    }
  };

  let hunk: Hunk = { deleted: [], inserted: [], before: null, after: null };
  let last: string | null = null;
  const flush = (after: string | null): void => {
    if (hunk.deleted.length + hunk.inserted.length > 0) settle({ ...hunk, after });
  };
  for (const op of ops) {
    if (op.type === 'equal') {
      const owner = oldChunks[op.a]?.owner ?? -1;
      flush(blockId(owner));
      assigned.set(op.b, owner);
      unchanged.add(op.a);
      last = blockId(owner);
      hunk = { deleted: [], inserted: [], before: last, after: null };
    } else if (op.type === 'delete') {
      hunk.deleted.push(op.a);
    } else {
      hunk.inserted.push(op.b);
    }
  }
  flush(null);

  const chunkGrams = oldChunks.map(({ text: part }) => gramsOf(part));
  // 一段一段也比：別的區塊有一段跟換掉的舊段一樣像、或更像這段新文字。區塊有好幾段時，整個區塊比會被其他段稀釋。
  const rivalledPart = (owner: number, index: number, fresh: number): boolean => {
    const text = gramsOf(content[fresh]?.text ?? '');
    const own = dice(chunkGrams[index] as Grams, text);
    return oldChunks.some((chunk, other) => {
      if (blocks[chunk.owner]?.markdown === blocks[owner]?.markdown) return false;
      const score = dice(chunkGrams[other] as Grams, text);
      return score > 0 && score >= own;
    });
  };

  // 一個區塊只回收一筆，它改過的段都在裡面；分開記的話，存人工譯文時後一筆會蓋掉前一筆（ADR-0125）。
  // 檔案裡有別的區塊跟它一樣像或更像合起來的新文字、或其中一段新文字，就不收。
  for (const [owner, { replaced, inserted, before, after }] of pending) {
    const markdown = (partsOf[owner] ?? [])
      .map((index) => {
        const fresh = replaced.get(index);
        return fresh === undefined ? (oldChunks[index]?.text ?? '') : (content[fresh]?.text ?? '');
      })
      .join('\n\n');
    const fresh = gramsOf(markdown);
    const ownGrams = oldGrams[owner];
    const contested = (): boolean => rivalled(owner, fresh, dice(ownGrams as Grams, fresh)) || [...replaced].some(([index, part]) => rivalledPart(owner, index, part));
    if (ownGrams === undefined || (!untranslated(owner) && contested())) {
      const moved = inserted.every((index) => oldKeys.has(keyOf(content[index]?.text ?? '')));
      changes.push({ kind: moved ? 'moved' : 'ambiguous', before, after });
      continue;
    }
    for (const index of inserted) assigned.set(index, owner);
    edits.push({ block_id: blockId(owner), markdown, owner, indices: inserted, replaces: [...replaced.keys()], before, after });
  }
  edits.sort((left, right) => (left.indices[0] ?? 0) - (right.indices[0] ?? 0));

  // 沒有對上任何區塊的段像某個要回收的區塊（那個區塊可能被拆開、搬走了一部分），或沒有對上的舊段像要回收的
  // 新文字（新文字可能併進了那一段），都不回收（ADR-0125）。一個區塊可以有好幾段，所以舊的文字一段一段比。
  // 不回收的區塊與它的段也算沒對上，所以做到沒有變化為止。
  /** 舊的第 `index` 段有八成在 `text` 裡。 */
  const holds = (text: Grams, index: number): boolean => {
    const part = chunkGrams[index];
    return part !== undefined && containment(part, text) >= CONTAINED;
  };
  for (let changed = true; changed; ) {
    changed = false;
    const loose = content.flatMap((chunk, index) => (assigned.has(index) ? [] : [gramsOf(chunk.text)]));
    const matched = new Set([...unchanged, ...edits.flatMap(({ replaces }) => replaces)]);
    const unmatched = oldChunks.flatMap((_chunk, index) => (matched.has(index) ? [] : [index]));
    for (const edit of [...edits]) {
      const grams = oldGrams[edit.owner];
      const fresh = gramsOf(edit.markdown);
      // 太短的段（例如使用者加的分隔線）到處都找得到，不算拆出來的。舊的任何一段出現在沒對上的段裡，
      // 是搬到別處（可能也改了），原位置的新文字不是它的。
      const split =
        grams !== undefined &&
        loose.some((piece) => (piece.size >= MIN_PIECE && containment(piece, grams) >= CONTAINED) || (partsOf[edit.owner] ?? []).some((index) => holds(piece, index)));
      // 文字一樣的區塊（包括它自己）的段不算。
      const merged =
        unmatched.some((index) => blocks[oldChunks[index]?.owner ?? -1]?.markdown !== blocks[edit.owner]?.markdown && holds(fresh, index)) ||
        borrowed(blocks, edit.owner, edit.markdown);
      if (grams !== undefined && !split && !merged) continue;
      edits.splice(edits.indexOf(edit), 1);
      for (const index of edit.indices) assigned.delete(index);
      changes.push({ kind: 'ambiguous', before: edit.before, after: edit.after });
      changed = true;
    }
  }

  // 加的段跟某個刪掉的段一模一樣，就是搬動，記一筆。
  for (const item of added) {
    const match = removed.findIndex(({ keys }) => keys === item.keys);
    if (match < 0) continue;
    const [gone] = removed.splice(match, 1);
    changes.splice(changes.indexOf(gone?.change as FileChange), 1);
    changes[changes.indexOf(item.change)] = { ...item.change, kind: 'moved' };
  }

  return {
    edits: edits.map(({ block_id, markdown }) => ({ block_id, markdown })),
    changes,
    candidate: candidateOf(body, content, assigned, blocks),
  };
}

/** 對上的區塊換回上次的 Markdown，frontmatter、頁碼註解與段之間的空行照目前的檔案。 */
function candidateOf(
  body: string,
  content: readonly Chunk[],
  assigned: ReadonlyMap<number, number>,
  blocks: readonly OldBlock[],
): string {
  const regions = new Map<number, { start: number; end: number }>();
  for (const [index, owner] of assigned) {
    const chunk = content[index];
    if (chunk === undefined) continue;
    const region = regions.get(owner);
    regions.set(owner, region === undefined ? { start: chunk.start, end: chunk.end } : { start: Math.min(region.start, chunk.start), end: Math.max(region.end, chunk.end) });
  }
  let result = '';
  let cursor = 0;
  for (const [owner, { start, end }] of [...regions].sort((left, right) => left[1].start - right[1].start)) {
    if (start < cursor) continue;
    result += body.slice(cursor, start) + (blocks[owner]?.markdown ?? '');
    cursor = end;
  }
  return `${result}${body.slice(cursor)}\n`;
}

// ---------------------------------------------------------------- 從 Markdown 反推譯文

export interface SyncUnit {
  readonly unit_id: string;
  readonly role: string;
  readonly source: string;
  readonly state: string;
  readonly translation: string | null;
  readonly placeholders: string;
  readonly human: number;
}

export interface SyncBlock {
  readonly block_id: string;
  readonly markdown: string;
  readonly units: readonly SyncUnit[];
}

export type Reversed =
  | { readonly ok: true; readonly texts: readonly { readonly unit: SyncUnit; readonly text: string }[]; readonly busy: number }
  | { readonly ok: false; readonly kind: ChangeKind };

type LineKind = 'heading' | 'quote' | 'table' | 'list' | 'text';

function lineKind(line: string): LineKind {
  if (HEADING_LINE.test(line)) return 'heading';
  if (line.startsWith('>')) return 'quote';
  if (line.startsWith('|')) return 'table';
  return /^[-*+] /u.test(line) ? 'list' : 'text';
}

/** 拿掉 TOME 在開頭加的反斜線（`vault.ts` 的 `escapeLines`）。 */
function unescapeLines(text: string): string {
  return text.replace(/^([ \t]*)\\([#>|])/gmu, '$1$2');
}

/** 另起一段、另起一行或行尾的 `^區塊 ID`（ADR-0122 第 9 項）。正則只在 worker 裡跑，這裡比字串（ADR-0049）。 */
function withoutAnchor(markdown: string, blockId: string): string {
  for (const lead of ['\n\n', '\n', ' ']) {
    const tail = `${lead}^${blockId}`;
    if (markdown.endsWith(tail)) return markdown.slice(0, -tail.length);
  }
  return markdown;
}

/** 頁碼參照的連結換回顯示的字，只換這個單位的頁碼參照；使用者自己加的連結照留。 */
function withoutLinks(text: string, unit: SyncUnit): string {
  const references = new Set(
    (JSON.parse(unit.placeholders) as Placeholder[]).filter(({ kind }) => kind === PAGE_REF).map(({ text: reference }) => reference),
  );
  return text.replace(LINK, (whole, shown: string) => (references.has(shown) ? shown : whole));
}

const isDone = (unit: SyncUnit): boolean => unit.state === 'DONE' && unit.translation !== null;

/** 內文的每一行都不能變成標題、引言或表格，變了是結構改動。 */
function plainBody(lines: readonly string[]): boolean {
  return lines.every((line) => {
    const kind = lineKind(line);
    return kind === 'text' || kind === 'list';
  });
}

/** 單一單位的區塊。回傳 null 表示結構變了。 */
function unitText(unit: SyncUnit, markdown: string, wasDone: boolean, oldMarkdown: string): string | null {
  const lines = markdown.split('\n');
  const first = lines[0] ?? '';
  const rest = lines.slice(1);
  const role = unit.role;
  if (role === 'heading' || role === 'title') {
    if (lines.length !== 1) return null;
    const heading = HEADING_LINE.exec(first);
    const level = HEADING_LINE.exec(oldMarkdown.split('\n')[0] ?? '')?.[1];
    if (level !== undefined) return heading?.[1] === level ? (heading[2] ?? '').trim() : null;
    if (heading !== null) return (heading[2] ?? '').trim();
    return lineKind(first) === 'text' ? unescapeLines(first).trim() : null;
  }
  const callout = calloutType(role);
  if (callout !== null) {
    if (first === `> [!${callout}]`) {
      if (!rest.every((line) => line.startsWith('>'))) return null;
      const inner = rest.map((line) => line.replace(/^> ?/u, ''));
      return plainBody(inner) ? unescapeLines(inner.join('\n')) : null;
    }
    return !wasDone && plainBody(lines) && lineKind(first) === 'text' ? unescapeLines(markdown) : null;
  }
  if (role === 'list_item') {
    if (first.startsWith('- ')) return plainBody(rest) ? unescapeLines([first.slice(2), ...rest].join('\n')) : null;
    return !wasDone && plainBody(lines) && lineKind(first) === 'text' ? unescapeLines(markdown) : null;
  }
  const expected = wasDone ? lineKind(oldMarkdown.split('\n')[0] ?? '') : 'text';
  return lineKind(first) === expected && plainBody(rest) ? unescapeLines(markdown) : null;
}

function cellsOf(row: string): string[] | null {
  const trimmed = row.trimEnd();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|') || trimmed.length < 2) return null;
  return trimmed
    .slice(1, -1)
    .split(/(?<!\\)\|/u)
    .map((cell) => cell.trim().replace(/<br\s*\/?>/gu, '\n').replaceAll('\\|', '|'));
}

/** 表格的列與格子。第二行要是分隔線，收 Obsidian 重排過的寫法。 */
function tableOf(markdown: string): string[][] | null {
  const lines = markdown.split('\n');
  if (lines.length < 2 || !TABLE_SEPARATOR.test((lines[1] ?? '').trimEnd())) return null;
  const rows = [lines[0] ?? '', ...lines.slice(2)].map(cellsOf);
  return rows.every((row) => row !== null) ? (rows as string[][]) : null;
}

/**
 * 把一個區塊在 vault 裡的新樣子反推成單位的人工譯文（`vault.ts` 的 `blockText` 反過來，ADR-0125）。
 * 內容跟上次一樣的不算；送出中的單位不收，算在 `busy`。
 */
export function reverseBlock(block: SyncBlock, markdown: string): Reversed {
  const now = withoutAnchor(markdown, block.block_id);
  const old = withoutAnchor(block.markdown, block.block_id);
  if (now.split('\n').some((line) => PAGE_MARKER.test(line))) return { ok: false, kind: 'other' };
  const texts: { unit: SyncUnit; text: string }[] = [];
  let busy = 0;
  const take = (unit: SyncUnit, text: string): void => {
    if (BUSY_STATES.has(unit.state)) busy += 1;
    else texts.push({ unit, text: withoutLinks(text, unit) });
  };

  if (old.startsWith('|')) {
    const before = tableOf(old);
    const after = tableOf(now);
    if (before === null || after === null || before.length !== after.length) return { ok: false, kind: 'table' };
    const byId = new Map(block.units.map((unit) => [unit.unit_id, unit]));
    for (const [row, cells] of after.entries()) {
      const previous = before[row] ?? [];
      if (cells.length !== previous.length) return { ok: false, kind: 'table' };
      for (const [col, cell] of cells.entries()) {
        if (cell === previous[col]) continue;
        const unit = byId.get(`${block.block_id}-r${row}c${col}`);
        if (unit === undefined) return { ok: false, kind: 'table' };
        take(unit, cell);
      }
    }
    return { ok: true, texts, busy };
  }

  // 沒有單位的區塊（圖）改了，回收不了。
  const [unit] = block.units;
  if (unit === undefined) return { ok: false, kind: 'type' };
  const wasDone = isDone(unit);
  const nowLines = now.split('\n');
  if (!wasDone && (UNTRANSLATED_LINE.test(nowLines[0] ?? '') || UNTRANSLATED_LINE.test(nowLines[1] ?? ''))) {
    return { ok: false, kind: 'untranslated' };
  }
  const text = unitText(unit, now, wasDone, old);
  if (text === null) return { ok: false, kind: 'type' };
  if (wasDone && text === unitText(unit, old, wasDone, old)) return { ok: true, texts: [], busy: 0 };
  take(unit, text);
  return { ok: true, texts, busy };
}

// ---------------------------------------------------------------- 一本書

export interface SyncChangeRow extends FileChange {
  readonly path: string;
}

export interface SyncSummary {
  /** 上次輸出後被改過的檔。 */
  readonly files: number;
  readonly recovered: number;
  readonly unrecovered: number;
  readonly in_flight: number;
  readonly orphaned: number;
}

interface RenderRow {
  readonly block_id: string;
  readonly path: string;
  readonly markdown: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 讀回一本書在 `folder` 裡的章節檔，存人工譯文、記回收不了的改動。不拿鎖、不查 vault 的位置，
 * 呼叫端負責（`tome sync` 與量測都用）。
 */
export function syncFolder(store: Store, series: Store, slug: string, folder: string): SyncSummary {
  const files = store.all<{ path: string; sha256: string }>('SELECT path, sha256 FROM render_file');
  const rendered = store.all<RenderRow>('SELECT block_id, path, markdown FROM render ORDER BY rowid');
  const units = store.all<SyncUnit & { readonly block_id: string }>(
    'SELECT unit_id, block_id, role, source, state, translation, placeholders, human FROM unit ORDER BY seq',
  );
  const unitsOf = new Map<string, SyncUnit[]>();
  for (const unit of units) unitsOf.set(unit.block_id, [...(unitsOf.get(unit.block_id) ?? []), unit]);
  const byPath = new Map<string, RenderRow[]>();
  for (const row of rendered) byPath.set(row.path, [...(byPath.get(row.path) ?? []), row]);

  const human: HumanText[] = [];
  const changes: SyncChangeRow[] = [];
  const markdowns: BlockEdit[] = [];
  const recoveredFiles: { readonly path: string; readonly sha256: string }[] = [];
  const unrecoveredFiles: { readonly path: string; readonly sha256: string }[] = [];
  let changed = 0;
  let busy = 0;
  for (const file of files) {
    const full = join(folder, file.path);
    // 被刪掉的檔，下次輸出照樣重寫，不算改過（ADR-0122 第 11 項）。
    if (!existsSync(full)) continue;
    const raw = readFileSync(full, 'utf8');
    const hash = sha256(raw);
    if (hash === file.sha256) continue;
    changed += 1;
    const blocks = byPath.get(file.path);
    if (blocks === undefined) {
      changes.push({ path: file.path, kind: 'file', before: null, after: null });
      unrecoveredFiles.push({ path: file.path, sha256: hash });
      continue;
    }
    const alignment = alignFile(blocks, raw);
    const local: FileChange[] = [...alignment.changes];
    for (const edit of alignment.edits) {
      const block = blocks.find(({ block_id }) => block_id === edit.block_id);
      if (block === undefined) continue;
      const reversed = reverseBlock({ ...block, units: unitsOf.get(block.block_id) ?? [] }, edit.markdown);
      if (!reversed.ok) {
        local.push({ kind: reversed.kind, before: block.block_id, after: block.block_id });
        continue;
      }
      human.push(...reversed.texts.map(({ unit, text }) => ({ unit_id: unit.unit_id, source: unit.source, text })));
      // 有單位還在送出中，下次 `tome sync` 要從上次輸出的樣子再比一次，這個區塊不換基準。
      if (reversed.busy > 0) {
        busy += reversed.busy;
        local.push({ kind: 'in_flight', before: block.block_id, after: block.block_id });
      } else {
        markdowns.push(edit);
      }
    }
    if (local.length === 0 && sha256(alignment.candidate) !== file.sha256) local.push({ kind: 'other', before: null, after: null });
    (local.length === 0 ? recoveredFiles : unrecoveredFiles).push({ path: file.path, sha256: hash });
    changes.push(...local.map((change) => ({ ...change, path: file.path })));
  }

  saveHuman(series, slug, human);
  const now = new Date().toISOString();
  store.transaction(() => {
    store.run('DELETE FROM sync_change');
    for (const { path, kind, before, after } of changes) {
      store.run(
        'INSERT INTO sync_change (path, kind, before_block, after_block, created_at) VALUES (?, ?, ?, ?, ?)',
        path,
        kind,
        before,
        after,
        now,
      );
    }
    // 回收的區塊下次從目前的寫法比；整個檔都回收了，`tome assemble` 就不再擋（ADR-0125）。
    for (const { block_id, markdown } of markdowns) store.run('UPDATE render SET markdown = ? WHERE block_id = ?', markdown, block_id);
    for (const { path, sha256: hash } of recoveredFiles) store.run('UPDATE render_file SET sha256 = ? WHERE path = ?', hash, path);
    // 回收不了的檔記下讀回時的雜湊：`tome assemble --force` 時檔案不一樣了，就是之後又改過，上面的記錄不準。
    store.run('DELETE FROM sync_file');
    for (const { path, sha256: hash } of unrecoveredFiles) store.run('INSERT INTO sync_file (path, sha256) VALUES (?, ?)', path, hash);
  });
  const { orphaned } = applyHuman(store, series, slug);
  return {
    files: changed,
    recovered: human.length,
    unrecovered: changes.filter(({ kind }) => kind !== 'in_flight').length,
    in_flight: busy,
    orphaned,
  };
}

function syncLocked(home: string, slug: string): PlanOutcome {
  readBook(home, slug);
  const configured = readWorkspaceConfig(home)?.vault_path;
  const root = configured ?? join(home, 'vault');
  const placement = pathFindings('vault', root, process.env, process.platform);
  if (placement.some(({ level }) => level === 'fail')) return { data: { book: slug, root }, findings: placement };
  const store = openBookStore(home, slug);
  try {
    const summary = withSeries(home, slug, (series) => syncFolder(store, series, slug, join(root, slug)));
    const data = { book: slug, root, ...summary };
    const count = (value: number): string => String(value);
    const findings: Finding[] =
      summary.files === 0 && summary.orphaned === 0
        ? [finding('sync.nothing', 'info', { book: slug })]
        : [
            finding('sync.done', 'info', {
              book: slug,
              files: count(summary.files),
              recovered: count(summary.recovered),
              unrecovered: count(summary.unrecovered),
            }),
            ...(summary.unrecovered === 0 ? [] : [finding('sync.unrecovered', 'warn', { book: slug, count: count(summary.unrecovered) })]),
            ...(summary.in_flight === 0 ? [] : [finding('sync.in_flight', 'warn', { book: slug, count: count(summary.in_flight) })]),
            ...(summary.orphaned === 0 ? [] : [finding('sync.orphaned', 'warn', { count: count(summary.orphaned) })]),
          ];
    return { data, findings: [...findings, ...placement] };
  } finally {
    store.close();
  }
}

/** `tome sync`。一本書同時只跑一個流程（ADR-0054）。只讀 vault，不寫，不連網。 */
export function syncBook(home: string, slug: string): Promise<PlanOutcome> {
  return withBookLock(home, slug, async () => syncLocked(home, slug));
}
