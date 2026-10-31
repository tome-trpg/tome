import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { BookConfig } from './book.ts';
import type { TomeIr } from './ir.ts';
import type { Language } from './language.ts';
import type { Probe } from './probe.ts';

const IR_FILE = 'tome-ir-1.schema.json';
const PACK_FILE = 'tome-pack-1.schema.json';
const BOOK_FILE = 'tome-book-1.schema.json';
const PROBE_FILE = 'tome-probe-1.schema.json';
const LANGUAGE_FILE = 'tome-lang-1.schema.json';

export type PackFileKind =
  | 'pack'
  | 'roles'
  | 'entities'
  | 'glossary'
  | 'syntaxPatterns'
  | 'packTest';

export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

export type Validation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly SchemaIssue[] };

function loadSchema(file: string): { $id: string } {
  // src 與 dist 到 repo 根目錄的深度相同。
  return JSON.parse(readFileSync(new URL(`../../schemas/${file}`, import.meta.url), 'utf8'));
}

interface Compiled {
  readonly ajv: Ajv2020;
  readonly irId: string;
  readonly packId: string;
  readonly bookId: string;
  readonly probeId: string;
  readonly languageId: string;
}

let cached: Compiled | undefined;

function compiled(): Compiled {
  if (cached === undefined) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    const ir = loadSchema(IR_FILE);
    const pack = loadSchema(PACK_FILE);
    const book = loadSchema(BOOK_FILE);
    const probe = loadSchema(PROBE_FILE);
    const language = loadSchema(LANGUAGE_FILE);
    for (const schema of [ir, pack, book, probe, language]) ajv.addSchema(schema);
    cached = {
      ajv,
      irId: ir.$id,
      packId: pack.$id,
      bookId: book.$id,
      probeId: probe.$id,
      languageId: language.$id,
    };
  }
  return cached;
}

function validator(ref: string): ValidateFunction {
  const validate = compiled().ajv.getSchema(ref);
  if (validate === undefined) throw new Error(`unknown schema reference: ${ref}`);
  return validate;
}

// 問題只帶路徑與規則，不帶資料本身：IR 含書籍內容，不能進訊息或紀錄（ADR-0059）。
function issuesOf(validate: ValidateFunction): SchemaIssue[] {
  return (validate.errors ?? []).map((error) => ({
    path: error.instancePath || '/',
    message: error.message ?? error.keyword,
  }));
}

function duplicateBlockIds(value: TomeIr): SchemaIssue[] {
  const seen = new Set<string>();
  const issues: SchemaIssue[] = [];
  value.blocks.forEach((block, index) => {
    if (seen.has(block.id)) {
      issues.push({ path: `/blocks/${index}/id`, message: 'duplicate block id' });
    }
    seen.add(block.id);
  });
  return issues;
}

export function validateIr(data: unknown): Validation<TomeIr> {
  const validate = validator(compiled().irId);
  if (!validate(data)) return { ok: false, issues: issuesOf(validate) };
  const value = data as TomeIr;
  const issues = duplicateBlockIds(value);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

function validateAs<T>(ref: string, data: unknown): Validation<T> {
  const validate = validator(ref);
  return validate(data) ? { ok: true, value: data as T } : { ok: false, issues: issuesOf(validate) };
}

export function validateBook(data: unknown): Validation<BookConfig> {
  return validateAs(compiled().bookId, data);
}

export function validateProbe(data: unknown): Validation<Probe> {
  return validateAs(compiled().probeId, data);
}

export function validateLanguage(data: unknown): Validation<Language> {
  return validateAs(compiled().languageId, data);
}

export function validatePackFile(kind: PackFileKind, data: unknown): Validation<unknown> {
  return validateAs(`${compiled().packId}#/$defs/${kind}`, data);
}
