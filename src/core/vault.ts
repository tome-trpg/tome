import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readBook, withBookLock } from './book.ts';
import { chapterMap, checkedLevel, levelOf } from './chapters.ts';
import { entityCards, type EntityCard } from './entities.ts';
import { readDocument } from './extract.ts';
import { finding } from './findings.ts';
import type { DocumentBlock, IrDocument, Section } from './ir.ts';
import { unitRuns, type PairedOffset, type Placeholder, type UnitFormats } from './mask.ts';
import { openPdf } from './pdf.ts';
import { markdownText, reviewParagraph, type PreviewRow } from './preview.ts';
import type { PlanOutcome } from './request.ts';
import { openBookStore, type Store } from './store.ts';
import { pathFindings, readWorkspaceConfig } from './workspace.ts';

// vault 輸出（白皮書 §5.5、ADR-0122）。一本書一個資料夾：書目與來源、一章一檔、實體卡、雙語對照。
// 檔案裡有書本文字，只寫進 vault；訊息只印 vault 的根目錄與數量，不印個別檔案的路徑（ADR-0113 第 18 項）。
// 核心不放給人看的文字，固定文字由 CLI 從訊息檔帶進來（ADR-0113 第 17 項）。

/** vault 的固定文字。`{page}` 這類由程式填。 */
export interface VaultTexts {
  readonly keys: { readonly book: string; readonly chapter: string; readonly title: string; readonly pages: string };
  /** 第一章之前的部分的檔名。 */
  readonly front: string;
  readonly info: {
    readonly file: string;
    readonly title: string;
    readonly author: string;
    readonly hash: string;
    readonly unknown: string;
    readonly notice: string;
    readonly credits: string;
  };
  /** 圖的位置，`{page}` 是原書的頁碼。不抽圖（ADR-0122）。 */
  readonly figure: string;
  readonly entity: {
    readonly source: string;
    readonly target: string;
    readonly class: string;
    readonly gender: string;
    readonly pronoun: string;
    readonly register: string;
  };
  /** `review/` 裡區塊對應表的檔名與欄名。 */
  readonly map: { readonly file: string; readonly block: string; readonly chapter: string };
}

export interface UnitRow extends PreviewRow {
  readonly unit_id: string;
  readonly placeholders: string;
}

const UNTRANSLATED = '[!untranslated]';
const SKIPPED: ReadonlySet<string> = new Set(['furniture', 'toc', 'index', 'credits']);
const PAGE_REF = 'page_ref';
/** 檔名與 Obsidian 連結都不能有的字元（白皮書 §5.5），加上 Windows 檔名不能用的。 */
const UNSAFE = /[\\/:*?"<>|#^[\]%\p{Cc}]/gu;
/** 標題裡有這些字元，連到標題的連結可能失效，改連區塊。 */
const LINK_BREAKERS = /[#|^:%[\]]/u;
const MAX_NAME = 60;
/** Windows 保留給裝置的檔名，不分大小寫，加了副檔名也一樣（含上標數字與 `CONIN$`、`CONOUT$`）。 */
const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(\..*)?$/iu;
const NUMBER = /\d+/u;

/** 檔名與連結用的名字：拿掉不能用的字元、合併空白、去掉結尾的點與空白、太長截斷。 */
export function safeName(text: string): string {
  return text.replace(UNSAFE, ' ').replace(/\s+/gu, ' ').trim().replace(/[. ]+$/u, '').slice(0, MAX_NAME).trim();
}

function fill(template: string, slots: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) => slots[name] ?? whole);
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

/** 書本文字開頭的 `#`、`>`、`|` 會變成標題、引言、表格，前面加反斜線（ADR-0122）。 */
export function escapeLines(text: string): string {
  return text.replace(/^([ \t]*)([#>|])/gmu, '$1\\$2');
}

function parsed<T>(json: string | null, fallback: T): T {
  return json === null ? fallback : (JSON.parse(json) as T);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 每個區塊在章節樹裡的深度，1 是最上層。 */
function sectionDepths(sections: readonly Section[], depth = 1, depths = new Map<string, number>()): Map<string, number> {
  for (const section of sections) {
    if (section.block_id !== undefined) depths.set(section.block_id, depth);
    sectionDepths(section.children, depth + 1, depths);
  }
  return depths;
}

function pageLabel(document: IrDocument, page: number): string {
  return document.page_map.find((item) => item.page === page)?.label ?? String(page + 1);
}

function pageOf(block: DocumentBlock): number {
  return block.spans[0]?.page ?? 0;
}

export interface RenderInput {
  readonly slug: string;
  readonly document: IrDocument;
  readonly chapterLevel: number;
  /** 依閱讀順序的單位。 */
  readonly units: readonly UnitRow[];
  readonly cards: readonly EntityCard[];
  readonly pdf: { readonly title?: string; readonly author?: string };
  readonly texts: VaultTexts;
}

export interface RenderedVault {
  /** 書的資料夾底下的相對路徑 → 內容。 */
  readonly files: ReadonlyMap<string, string>;
  /** 每個區塊輸出的 Markdown 與章節檔，給 `render` 表。 */
  readonly blocks: readonly { readonly block_id: string; readonly path: string; readonly markdown: string }[];
  readonly units: number;
  readonly untranslated: number;
  /** 標題與表格數：預期的（從 IR）與實際產生的。對不上就是程式錯誤（ADR-0122）。 */
  readonly structure: { readonly expected: Structure; readonly actual: Structure };
}

interface Structure {
  readonly headings: number;
  readonly tables: number;
}

interface BlockPlan {
  readonly block: DocumentBlock;
  readonly index: number;
  readonly chapter: number;
  readonly units: readonly UnitRow[];
}

const done = (unit: UnitRow): boolean => unit.state === 'DONE' && unit.translation !== null;

/** 單位的譯文，粗體、斜體用 Markdown（ADR-0116）。 */
function translationOf(unit: UnitRow): string {
  const translation = unit.translation ?? '';
  const styles = parsed<UnitFormats | null>(unit.formats, null);
  return markdownText(translation, unitRuns(translation, styles, parsed<PairedOffset[]>(unit.translation_pc, [])));
}

/** 沒翻成的單位：原文，`BLOCKED` 不放原文（個資，白皮書 §6.2）。 */
function untranslatedOf(unit: UnitRow): string {
  const head = `${UNTRANSLATED} ${unit.state}`;
  return unit.state === 'BLOCKED' ? quote(head) : `${quote(head)}\n${quote(escapeLines(unit.source))}`;
}

/** 表格的格子是一行：換行改成 `<br>`，`|` 跳脫。沒翻成的格子放原文，`BLOCKED` 只放狀態。 */
function cellText(unit: UnitRow | undefined): string {
  if (unit === undefined) return '';
  const text = done(unit) ? translationOf(unit) : unit.state === 'BLOCKED' ? unit.state : unit.source;
  return text.replace(/\r?\n/gu, '<br>').replaceAll('|', '\\|');
}

function tableOf(block: DocumentBlock, units: readonly UnitRow[]): string {
  const table = block.table;
  if (table === undefined) return '';
  const byCell = new Map(units.map((unit) => [unit.unit_id, unit]));
  const rows: string[] = [];
  for (let row = 0; row < table.rows; row += 1) {
    const cells = Array.from({ length: table.cols }, (_, col) => cellText(byCell.get(`${block.id}-r${row}c${col}`)));
    rows.push(`| ${cells.join(' | ')} |`);
    if (row === 0) rows.push(`|${' --- |'.repeat(table.cols)}`);
  }
  return rows.join('\n');
}

/** callout 的類型：規則包角色去掉命名空間、底線換連字號，例如 `stat-block`。 */
function calloutType(role: string): string | null {
  if (role === 'sidebar') return 'sidebar';
  const at = role.indexOf(':');
  return at < 0 ? null : role.slice(at + 1).replaceAll('_', '-');
}

/** 把整本書排成 vault 的檔案，不寫檔（ADR-0122）。 */
export function renderVault(input: RenderInput): RenderedVault {
  const { slug, document, chapterLevel, units, cards, pdf, texts } = input;
  const chapters = chapterMap(document, chapterLevel);
  const depths = sectionDepths(document.sections);
  const byBlock = new Map<string, UnitRow[]>();
  for (const unit of units) byBlock.set(unit.block_id, [...(byBlock.get(unit.block_id) ?? []), unit]);
  const plans: BlockPlan[] = document.blocks.map((block, index) => ({
    block,
    index,
    chapter: chapters.get(block.id) ?? 0,
    units: byBlock.get(block.id) ?? [],
  }));

  const plain = (plan: BlockPlan): string => {
    const [unit] = plan.units;
    if (unit === undefined) return '';
    return done(unit) ? (unit.translation ?? '') : unit.state === 'BLOCKED' ? '' : unit.source;
  };
  const isHeading = (plan: BlockPlan): boolean => plan.block.role === 'heading' || plan.block.role === 'title';

  // 章節檔名：編號加章名（ADR-0113 第 18 項），章名用這章第一個標題的譯文，沒有就只用編號。
  const names = new Map<number, { readonly stem: string; readonly title: string }>();
  for (const plan of plans) {
    if (names.has(plan.chapter)) continue;
    const name = plan.chapter === 0 ? texts.front : isHeading(plan) ? safeName(plain(plan)) : '';
    const number = String(plan.chapter).padStart(2, '0');
    names.set(plan.chapter, name === '' ? { stem: number, title: number } : { stem: `${number}-${name}`, title: name });
  }
  // 每個區塊的章都在 names 裡。
  const stemOf = (chapter: number): string => names.get(chapter)?.stem ?? '';

  // 頁碼參照的目標：那一頁第一個會輸出的區塊所在章節裡、在它之前最近的標題（ADR-0022、ADR-0122）。
  const rendered = plans.filter((plan) => !SKIPPED.has(plan.block.role));
  const headingBefore = new Map<number, BlockPlan>();
  let last: BlockPlan | undefined;
  for (const plan of rendered) {
    if (last !== undefined && last.chapter !== plan.chapter) last = undefined;
    if (isHeading(plan)) last = plan;
    if (last !== undefined) headingBefore.set(plan.index, last);
  }
  const anchors = new Set<string>();
  const linkTarget = (reference: string, from: number): string | null => {
    const number = NUMBER.exec(reference)?.[0];
    if (number === undefined) return null;
    const page = document.page_map.find((item) => item.label === number)?.page ?? Number(number) - 1;
    const target = rendered.find((plan) => pageOf(plan.block) === page);
    if (target === undefined) return null;
    const heading = headingBefore.get(target.index);
    const file = target.chapter === from ? '' : stemOf(target.chapter);
    const raw = heading === undefined ? '' : plain(heading);
    // 跟輸出的標題同樣合併空白，連結才對得上。
    const title = raw.replace(/\s+/gu, ' ').trim();
    const styled = heading?.units[0]?.formats !== null && heading?.units[0]?.formats !== undefined;
    if (title !== '' && !LINK_BREAKERS.test(title) && !styled && !raw.includes('\n')) return `${file}#${title}`;
    anchors.add(target.block.id);
    return `${file}#^${target.block.id}`;
  };

  /** 譯文裡的頁碼參照換成連結，顯示的文字照譯文。解析不到的留純文字。 */
  const withLinks = (text: string, unit: UnitRow, chapter: number): string => {
    let out = text;
    let from = 0;
    for (const { kind, text: reference } of parsed<Placeholder[]>(unit.placeholders, [])) {
      if (kind !== PAGE_REF) continue;
      const at = out.indexOf(reference, from);
      if (at < 0) continue;
      const target = linkTarget(reference, chapter);
      if (target === null) {
        from = at + reference.length;
        continue;
      }
      const link = `[[${target}|${reference}]]`;
      out = out.slice(0, at) + link + out.slice(at + reference.length);
      from = at + link.length;
    }
    return out;
  };

  // 先算一次連結，區塊回溯才知道要放在哪些區塊上。
  for (const plan of rendered) {
    for (const unit of plan.units) if (done(unit)) withLinks(unit.translation ?? '', unit, plan.chapter);
  }

  const blockText = (plan: BlockPlan): string => {
    const { block } = plan;
    const anchor = anchors.has(block.id) ? ` ^${block.id}` : '';
    if (block.role === 'figure') return `${quote(`[!figure] ${fill(texts.figure, { page: pageLabel(document, pageOf(block)) })}`)}${anchor ? `\n${anchor.trim()}` : ''}`;
    if (block.role === 'table') return `${tableOf(block, plan.units)}${anchor ? `\n\n${anchor.trim()}` : ''}`;
    const [unit] = plan.units;
    if (unit === undefined) return '';
    const level = Math.min(6, depths.get(block.id) ?? (block.role === 'title' ? 1 : 2));
    if (!done(unit)) {
      if (isHeading(plan) && unit.state !== 'BLOCKED') {
        return `${'#'.repeat(level)} ${unit.source.replace(/\s+/gu, ' ').trim()}${anchor}\n${quote(`${UNTRANSLATED} ${unit.state}`)}`;
      }
      return `${untranslatedOf(unit)}${anchor ? `\n${anchor.trim()}` : ''}`;
    }
    const text = withLinks(translationOf(unit), unit, plan.chapter);
    if (isHeading(plan)) return `${'#'.repeat(level)} ${text.replace(/\s+/gu, ' ').trim()}${anchor}`;
    const type = calloutType(block.role);
    if (type !== null) return `${quote(`[!${type}]`)}\n${quote(escapeLines(text))}${anchor ? `\n${anchor.trim()}` : ''}`;
    const body = escapeLines(text);
    return block.role === 'list_item' ? `- ${body}${anchor}` : `${body}${anchor}`;
  };

  const files = new Map<string, string>();
  const blocks: { block_id: string; path: string; markdown: string }[] = [];
  const chapterBodies = new Map<number, { readonly parts: string[]; readonly first: string; last: string }>();
  let previousPage: number | null = null;
  let unitCount = 0;
  let untranslated = 0;
  for (const plan of rendered) {
    const markdown = blockText(plan);
    if (markdown === '') continue;
    const path = `${stemOf(plan.chapter)}.md`;
    const page = pageOf(plan.block);
    const label = pageLabel(document, page);
    const body = chapterBodies.get(plan.chapter) ?? { parts: [], first: label, last: label };
    // 每個檔案開頭都標一次頁碼，換頁時再標。
    if (page !== previousPage || body.parts.length === 0) body.parts.push(`<!-- page: ${label} -->`);
    previousPage = page;
    body.parts.push(markdown);
    body.last = label;
    chapterBodies.set(plan.chapter, body);
    blocks.push({ block_id: plan.block.id, path, markdown });
    unitCount += plan.units.length;
    untranslated += plan.units.filter((unit) => !done(unit)).length;
  }
  for (const [chapter, { parts, first, last }] of chapterBodies) {
    const front = [
      '---',
      `${texts.keys.book}: ${JSON.stringify(slug)}`,
      `${texts.keys.chapter}: ${chapter}`,
      `${texts.keys.title}: ${JSON.stringify(names.get(chapter)?.title ?? '')}`,
      `${texts.keys.pages}: ${JSON.stringify(first === last ? first : `${first}-${last}`)}`,
      '---',
    ].join('\n');
    files.set(`${stemOf(chapter)}.md`, `${front}\n\n${parts.join('\n\n')}\n`);
  }

  // 書目與來源：PDF 的書名與作者、來源雜湊、不得散布的聲明、版權頁的原文（ADR-0011、PC-5）。
  const credits = plans.filter((plan) => plan.block.role === 'credits' && plan.block.text.trim() !== '');
  const info = [
    `# ${pdf.title ?? slug}`,
    '',
    `- ${texts.info.title}: ${pdf.title ?? slug}`,
    `- ${texts.info.author}: ${pdf.author ?? texts.info.unknown}`,
    `- ${texts.info.hash}: \`${document.pdf_sha256}\``,
    '',
    quote(texts.info.notice),
    ...(credits.length === 0 ? [] : ['', `## ${texts.info.credits}`, '', ...credits.map((plan) => quote(escapeLines(plan.block.text)))]),
    '',
  ].join('\n');
  files.set(`${texts.info.file}.md`, info);

  // 實體卡：每張鎖定的卡一個檔，章節裡不自動加連結（ADR-0122）。
  // Windows 與 macOS 的檔案系統不分大小寫（macOS 也不分 NFC、NFD），撞名照這樣判斷，撞了加卡的 id；
  // 加了 id 還撞就再加。Windows 的保留名稱也加 id（Manager 審 PR 71 時找到的）。
  const taken = new Set<string>();
  const key = (name: string): string => name.normalize('NFC').toLowerCase();
  for (const card of cards) {
    if (card.status !== 'locked' || card.target === null) continue;
    let name = safeName(card.target) || String(card.id);
    if (RESERVED.test(name)) name = `${name} ${card.id}`;
    while (taken.has(key(name))) name = `${name} ${card.id}`;
    taken.add(key(name));
    const line = (label: string, value: string | null): string[] => (value === null ? [] : [`- ${label}: ${value}`]);
    files.set(
      `entities/${name}.md`,
      [
        `# ${card.target}`,
        '',
        ...line(texts.entity.source, card.source),
        ...line(texts.entity.target, card.target),
        ...line(texts.entity.class, card.class),
        ...line(texts.entity.gender, card.gender),
        ...line(texts.entity.pronoun, card.pronoun),
        ...line(texts.entity.register, card.register),
        '',
      ].join('\n'),
    );
  }

  // 雙語對照：跟 `tome preview` 同一個格式，加上區塊對應表（白皮書 §5.5、ADR-0081）。
  const review = new Map<number, string[]>();
  for (const plan of plans) {
    if (plan.units.length === 0) continue;
    review.set(plan.chapter, [...(review.get(plan.chapter) ?? []), ...plan.units.map((unit) => reviewParagraph(unit))]);
  }
  for (const [chapter, paragraphs] of review) files.set(`review/${stemOf(chapter)}.md`, paragraphs.join('\n'));
  files.set(
    `review/${texts.map.file}.md`,
    [`| ${texts.map.block} | ${texts.map.chapter} |`, '| --- | --- |', ...blocks.map(({ block_id: id, path }) => `| ${id} | [[${path.slice(0, -3)}]] |`), ''].join('\n'),
  );

  const expected = {
    headings: rendered.filter((plan) => isHeading(plan) && plan.units[0] !== undefined && plan.units[0].state !== 'BLOCKED').length,
    tables: rendered.filter((plan) => plan.block.role === 'table' && plan.block.table !== undefined).length,
  };
  const actual = structureOf([...chapterBodies.values()].map(({ parts }) => parts.join('\n\n')));
  return { files, blocks, units: unitCount, untranslated, structure: { expected, actual } };
}

/**
 * 從產生的 Markdown 數標題與表格，引言（callout）裡的不算。表格從前一行不是表格列的 `|` 開始，
 * 下一行要是分隔線；格子裡寫著 `---` 的列不算新的表格。
 */
function structureOf(bodies: readonly string[]): Structure {
  let headings = 0;
  let tables = 0;
  for (const body of bodies) {
    const lines = body.split('\n');
    lines.forEach((line, index) => {
      if (/^#{1,6} /u.test(line)) headings += 1;
      const starts = line.startsWith('|') && !(lines[index - 1] ?? '').startsWith('|');
      if (starts && /^\|( --- \|)+$/u.test(lines[index + 1] ?? '')) tables += 1;
    });
  }
  return { headings, tables };
}

export interface AssembleOptions {
  readonly home: string;
  readonly slug: string;
  readonly texts: VaultTexts;
  /** 031 之前，vault 被人改過時照樣覆蓋（ADR-0122）。 */
  readonly force: boolean;
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

function recordRender(store: Store, rendered: RenderedVault): void {
  const now = new Date().toISOString();
  store.transaction(() => {
    store.run('DELETE FROM render');
    store.run('DELETE FROM render_file');
    for (const { block_id: id, path, markdown } of rendered.blocks) {
      store.run('INSERT INTO render (block_id, path, markdown, rendered_at) VALUES (?, ?, ?, ?)', id, path, markdown, now);
    }
    for (const [path, text] of rendered.files) {
      store.run('INSERT INTO render_file (path, sha256, rendered_at) VALUES (?, ?, ?)', path, sha256(text), now);
    }
  });
}

async function pdfInfo(path: string): Promise<{ readonly title?: string; readonly author?: string }> {
  try {
    const opened = await openPdf(path);
    if (opened.status !== 'ok') return {};
    try {
      return await opened.pdf.info();
    } finally {
      await opened.pdf.close();
    }
  } catch {
    return {};
  }
}

async function assembleLocked({ home, slug, texts, force }: AssembleOptions): Promise<PlanOutcome> {
  const book = readBook(home, slug);
  const document = readDocument(home, slug);
  const configured = readWorkspaceConfig(home)?.vault_path;
  // 沒設 vault 路徑就寫到工作區的 vault/，工作區在 tome init 時已經查過不在 git repo 裡（ADR-0122）。
  const root = configured ?? join(home, 'vault');
  const placement = pathFindings('vault', root, process.env, process.platform);
  const defaulted = configured === undefined ? [finding('vault.default', 'info', { path: root })] : [];
  if (placement.some(({ level }) => level === 'fail')) return { data: { book: slug, root }, findings: [...placement, ...defaulted] };
  const store = openBookStore(home, slug);
  try {
    const units = store.all<UnitRow>(
      'SELECT unit_id, block_id, source, state, translation, formats, translation_pc, placeholders FROM unit ORDER BY seq',
    );
    const rendered = renderVault({
      slug,
      document,
      chapterLevel: checkedLevel(document, levelOf(book)),
      units,
      cards: entityCards(store),
      pdf: await pdfInfo(book.config.pdf.path),
      texts,
    });
    const { expected, actual } = rendered.structure;
    if (expected.headings !== actual.headings || expected.tables !== actual.tables) {
      const params = { headings: String(expected.headings), found_headings: String(actual.headings), tables: String(expected.tables), found_tables: String(actual.tables) };
      return { data: { book: slug, root }, findings: [finding('assemble.structure_mismatch', 'fail', params), ...placement, ...defaulted] };
    }
    const folder = join(root, slug);
    const previous = store.all<{ path: string; sha256: string }>('SELECT path, sha256 FROM render_file');
    // 人改過的檔：還在、內容跟上次輸出的不同。刪掉的照樣重寫。
    const edited = previous.filter(({ path, sha256: hash }) => {
      const full = join(folder, path);
      return existsSync(full) && sha256(readFileSync(full, 'utf8')) !== hash;
    });
    if (edited.length > 0 && !force) {
      return { data: { book: slug, root, edited: edited.length }, findings: [finding('assemble.edited', 'fail', { count: String(edited.length) }), ...placement, ...defaulted] };
    }
    for (const [path, text] of rendered.files) writeAtomic(join(folder, path), text);
    // 這次沒有產生的舊檔（例如換了分章的層級）刪掉；使用者自己放的檔不在表裡，不會動到。
    for (const { path } of previous) {
      if (!rendered.files.has(path)) rmSync(join(folder, path), { force: true });
    }
    recordRender(store, rendered);
    const params = { root, files: String(rendered.files.size), units: String(rendered.units), untranslated: String(rendered.untranslated) };
    // 到這裡時，沒有 --force 就一定沒有改過的檔，所以 edited 的數量就是覆蓋的數量。
    return {
      data: { book: slug, root, files: rendered.files.size, units: rendered.units, untranslated: rendered.untranslated, overwritten: edited.length },
      findings: [finding('assemble.done', 'info', params), ...placement, ...defaulted],
    };
  } finally {
    store.close();
  }
}

/** `tome assemble`。一本書同時只跑一個流程（ADR-0054）。不連網，也不花 token。 */
export function assembleBook(options: AssembleOptions): Promise<PlanOutcome> {
  return withBookLock(options.home, options.slug, () => assembleLocked(options));
}
