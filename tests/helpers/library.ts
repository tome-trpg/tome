import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Io } from '../../src/cli/run.ts';
import { run } from '../../src/cli/run.ts';
import { forge, forgeFile } from '../forge/index.ts';
import { capture, tempDir, type Captured } from '../helpers.ts';

// 一個裝好假引擎、解析過合成 PDF 的工作區。文字都是合成 PDF 的假文字。

const FAKE_ENGINE = resolve('tests/fixtures/engines/fake');
export const MODEL = 'claude-sonnet-5-5';

export interface Library {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  session(overrides?: Partial<Io>): Captured;
}

export function setWorkspace(home: string, extra: string): void {
  writeFileSync(join(home, 'tome.yaml'), `schema: tome-workspace/1\nengines: [fake]\n${extra}`);
}

/** 在 document 層最後加一行沒有字母的分隔線。它不需要翻譯，建立時就原樣完成（ADR-0100）。 */
export function addSceneBreak(home: string): void {
  const path = join(home, 'books', 'book', 'ir', 'document.json');
  const document = JSON.parse(readFileSync(path, 'utf8')) as { blocks: Record<string, unknown>[] };
  const last = document.blocks.at(-1);
  if (last === undefined) throw new Error('the book has no blocks');
  const text = '* * *';
  const content_hash = createHash('sha256').update(text).digest('hex');
  document.blocks.push({ ...last, id: 'p0009-000000', content_hash, text, ...('raw' in last ? { raw: text } : {}) });
  writeFileSync(path, JSON.stringify(document));
}

export async function library(options: { extract?: boolean; config?: string } = {}): Promise<Library> {
  const home = join(tempDir(), 'home');
  const textFile = join(tempDir(), 'forged-text.json');
  writeFileSync(textFile, JSON.stringify((await forge('plain')).truth.text));
  const env = { ...process.env, TOME_HOME: home, FAKE_ENGINE_TEXT_FILE: textFile };
  const session = (overrides: Partial<Io> = {}): Captured => capture({ env, tool: async () => null, ...overrides });
  await run(['init'], session().io);
  await run(['engine', 'add', FAKE_ENGINE], session().io);
  await run(['add', await forgeFile('plain', tempDir()), '--as', 'book'], session().io);
  if (options.extract !== false) await run(['extract', 'book'], session().io);
  setWorkspace(home, options.config ?? `translator_model: ${MODEL}\npii: [Forged Buyer]\n`);
  return { env, home, session };
}
