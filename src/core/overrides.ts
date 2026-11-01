import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { hashText, joinText } from './assemble.ts';
import { bookDir } from './book.ts';
import { TomeError } from './errors.ts';
import { finding, type Finding } from './findings.ts';
import type { DocumentBlock } from './ir.ts';
import type { SourceLanguage } from './language.ts';
import { validateOverrides } from './schema.ts';

// overrides 層：人工修正。獨立成檔，重新解析後還在。對不到的操作要回報，
// 不能靜默丟棄（白皮書 §5.2）。操作依序套用，後面的看得到前面的結果。

export const OVERRIDES_SCHEMA = 'tome-overrides/1';
const OVERRIDES_FILE = 'overrides.yaml';
const REDACTED = '[REDACTED]';

export type Operation =
  | { readonly op: 'role'; readonly block: string; readonly role: DocumentBlock['role'] }
  | { readonly op: 'move'; readonly block: string; readonly after: string | null }
  | { readonly op: 'merge'; readonly blocks: readonly string[] }
  | { readonly op: 'split'; readonly block: string; readonly before: string }
  | { readonly op: 'skip'; readonly block: string }
  | { readonly op: 'redact'; readonly block: string; readonly text: string };

export interface Overrides {
  readonly operations: readonly Operation[];
  /** 檔案內容的雜湊，進內容指紋。沒有檔案時是空字串。 */
  readonly hash: string;
}

export function readOverrides(home: string, slug: string): Overrides {
  const path = join(bookDir(home, slug), OVERRIDES_FILE);
  if (!existsSync(path)) return { operations: [], hash: '' };
  const text = readFileSync(path, 'utf8');
  let value: unknown;
  try {
    value = parse(text);
  } catch {
    throw new TomeError('file.corrupt', { path });
  }
  const checked = validateOverrides(value);
  if (!checked.ok) throw new TomeError('config.bad_schema', { path, expected: OVERRIDES_SCHEMA });
  return { operations: checked.value.operations, hash: createHash('sha256').update(text).digest('hex') };
}

/** 內容變了，雜湊跟著變。ID 不動，後面的操作與重新組裝才對得到它。 */
function rehash(block: DocumentBlock, change: Partial<DocumentBlock>): DocumentBlock {
  const text = change.text ?? block.text;
  return { ...block, ...change, text, content_hash: hashText(text) };
}

function newId(blocks: readonly DocumentBlock[], page: number, text: string): string {
  const base = `p${String(page).padStart(4, '0')}-${hashText(text).slice(0, 6)}`;
  const taken = new Set(blocks.map(({ id }) => id));
  let id = base;
  for (let count = 1; taken.has(id); count += 1) id = `${base}-${count}`;
  return id;
}

function redactBlock(block: DocumentBlock, needle: string): DocumentBlock | null {
  const scrub = (value: string): string => value.replaceAll(needle, REDACTED);
  if (!block.text.includes(needle) && !block.raw.includes(needle)) return null;
  const table =
    block.table === undefined
      ? {}
      : {
          table: {
            ...block.table,
            cells: block.table.cells.map((cell) => ({
              ...cell,
              text: scrub(cell.text),
              ...(cell.raw === undefined ? {} : { raw: scrub(cell.raw) }),
            })),
          },
        };
  return rehash(block, { ...table, text: scrub(block.text), raw: scrub(block.raw) });
}

function splitBlock(
  blocks: readonly DocumentBlock[],
  block: DocumentBlock,
  before: string,
): readonly [DocumentBlock, DocumentBlock] | null {
  const at = block.text.indexOf(before);
  if (at <= 0 || block.table !== undefined) return null;
  const head = block.text.slice(0, at).trimEnd();
  const tail = block.text.slice(at);
  const rawAt = block.raw.indexOf(before);
  const raws = rawAt > 0 ? [block.raw.slice(0, rawAt).trimEnd(), block.raw.slice(rawAt)] : [block.raw, tail];
  return [
    rehash(block, { text: head, raw: raws[0] ?? block.raw }),
    rehash(
      { ...block, id: newId(blocks, block.spans[0]?.page ?? 0, tail) },
      { text: tail, raw: raws[1] ?? tail },
    ),
  ];
}

function mergeBlocks(
  language: SourceLanguage,
  members: readonly DocumentBlock[],
): DocumentBlock | null {
  const [first, ...others] = members;
  if (first === undefined || members.some(({ table }) => table !== undefined)) return null;
  return rehash(first, {
    text: others.reduce((text, block) => joinText(language, text, block.text), first.text),
    raw: members.map(({ raw }) => raw).join('\n'),
    spans: members.flatMap(({ spans }) => spans),
  });
}

/** 套用失敗時回傳原因，清單不變。 */
function applyOperation(
  language: SourceLanguage,
  list: DocumentBlock[],
  operation: Operation,
): 'no_block' | 'no_text' | null {
  const indexOf = (id: string): number => list.findIndex((block) => block.id === id);
  if (operation.op === 'merge') {
    const indexes = operation.blocks.map(indexOf);
    if (indexes.some((index) => index < 0)) return 'no_block';
    const merged = mergeBlocks(language, indexes.flatMap((index) => list[index] ?? []));
    if (merged === null) return 'no_text';
    const first = indexes[0] ?? 0;
    list[first] = merged;
    const removed = new Set(indexes.slice(1));
    const kept = list.filter((_, index) => !removed.has(index));
    list.splice(0, list.length, ...kept);
    return null;
  }

  const index = indexOf(operation.block);
  const block = list[index];
  if (block === undefined) return 'no_block';
  switch (operation.op) {
    case 'role':
      list[index] = { ...block, role: operation.role };
      return null;
    case 'skip':
      list.splice(index, 1);
      return null;
    case 'redact': {
      const redacted = redactBlock(block, operation.text);
      if (redacted === null) return 'no_text';
      list[index] = redacted;
      return null;
    }
    case 'split': {
      const parts = splitBlock(list, block, operation.before);
      if (parts === null) return 'no_text';
      list.splice(index, 1, ...parts);
      return null;
    }
    case 'move': {
      if (operation.after !== null && indexOf(operation.after) < 0) return 'no_block';
      list.splice(index, 1);
      const target = operation.after === null ? 0 : indexOf(operation.after) + 1;
      list.splice(target, 0, block);
      return null;
    }
  }
}

function blockOf(operation: Operation): string {
  return operation.op === 'merge' ? operation.blocks.join(', ') : operation.block;
}

export function applyOverrides(
  language: SourceLanguage,
  blocks: readonly DocumentBlock[],
  operations: readonly Operation[],
): { readonly blocks: readonly DocumentBlock[]; readonly findings: readonly Finding[] } {
  const list = [...blocks];
  const findings: Finding[] = [];
  operations.forEach((operation, index) => {
    const problem = applyOperation(language, list, operation);
    if (problem === null) return;
    // 只回報第幾筆與區塊 ID，要找的文字可能是書本內容（ADR-0059）。給人看的編號從 1 起算（ADR-0091）。
    const params = { index: String(index + 1), block: blockOf(operation) };
    findings.push(finding(problem === 'no_block' ? 'overrides.no_block' : 'overrides.no_text', 'warn', params));
  });
  return { blocks: list, findings };
}
