import { createHash } from 'node:crypto';
import {
  readBook,
  recordStage,
  stageFingerprint,
  updateBook,
  withBookLock,
  type Book,
  type BookConfig,
} from './book.ts';
import { checkBudget } from './budget.ts';
import { TomeError } from './errors.ts';
import { estimateRequest, outputTokens, sumEstimates, type Estimate } from './estimate.ts';
import { readDocument } from './extract.ts';
import { finding, type Finding } from './findings.ts';
import type { IrDocument } from './ir.ts';
import { loadTargetLanguage } from './language.ts';
import { spentUsd } from './ledger.ts';
import type { LocalizedTerm, ResolvedPack } from './pack.ts';
import { staticPrefix } from './prompt.ts';
import {
  findModel,
  loadProvider,
  priceFinding,
  thinkingParams,
  type LoadedProvider,
  type Provider,
  type ProviderModel,
  type ThinkingParams,
} from './provider.ts';
import { openBookStore, type Store } from './store.ts';
import { escapeAttribute, escapeText, unitTag } from './tags.ts';
import { buildUnits, syncUnits, type TranslationUnit } from './units.ts';
import { hitTerms, loadBookPack, visibleText } from './verify.ts';
import { piiFindings, workspaceModel, workspaceTargetLang } from './workspace.ts';

// 把單位組成請求（白皮書 §5.7、ADR-0103）。這裡只組資料與估價，不連網。

/** 一個請求約這麼多字元，用字元數是因為各家 token 計法不同（TC-5）。 */
export const REQUEST_CHARS = 6000;
/** 上文約這麼多字元。 */
export const CONTEXT_CHARS = 800;
const MIN_MAX_TOKENS = 1024;
/** 模型要翻完才停，`max_tokens` 留到預估輸出的 2 倍（ADR-0103）。 */
const OUTPUT_ROOM = 2;

export interface PlannedRequest {
  readonly id: string;
  /** 依送出的順序，`<s>` 的編號就是這裡的位置加 1。 */
  readonly units: readonly TranslationUnit[];
  /** 已經跳脫，可以直接放進 `<context>`。 */
  readonly context: string;
}

function charsOf(units: readonly TranslationUnit[]): number {
  return units.reduce((total, { source }) => total + source.length, 0);
}

/** 同一組的單位不拆開，就算它們在閱讀順序上不相鄰（ADR-0029）。 */
function groupsOf(units: readonly TranslationUnit[]): TranslationUnit[][] {
  const groups = new Map<string, TranslationUnit[]>();
  const list: TranslationUnit[][] = [];
  for (const unit of units) {
    const existing = unit.group === undefined ? undefined : groups.get(unit.group);
    if (existing !== undefined) {
      existing.push(unit);
      continue;
    }
    const group = [unit];
    list.push(group);
    if (unit.group !== undefined) groups.set(unit.group, group);
  }
  return list;
}

/** 同一章前面看得到的文字。佔位符拿掉，只用來理解語意，不用翻譯（ADR-0103）。 */
function contextOf(
  units: readonly TranslationUnit[],
  first: TranslationUnit,
  chapterOf: (unit: TranslationUnit) => number,
): string {
  const index = units.indexOf(first);
  const chapter = chapterOf(first);
  const lines: string[] = [];
  let size = 0;
  for (let at = index - 1; at >= 0 && size < CONTEXT_CHARS; at -= 1) {
    const unit = units[at];
    if (unit === undefined || chapterOf(unit) !== chapter) break;
    const line = visibleText(unit.masked);
    lines.unshift(line);
    size += line.length + 1;
  }
  return escapeText(lines.join('\n').slice(-CONTEXT_CHARS));
}

/**
 * 依閱讀順序組請求。`wanted` 決定哪些單位要送，其他單位只當上文。
 * 請求不跨章，單一組超過上限時自成一個請求。
 */
export function planRequests(
  units: readonly TranslationUnit[],
  chapterOf: (unit: TranslationUnit) => number,
  wanted: (unit: TranslationUnit) => boolean = () => true,
): PlannedRequest[] {
  const requests: PlannedRequest[] = [];
  let current: TranslationUnit[] = [];
  let chapter: number | undefined;
  const flush = (): void => {
    const [first] = current;
    if (first === undefined) return;
    requests.push({
      id: `r${requests.length + 1}`,
      units: current,
      context: contextOf(units, first, chapterOf),
    });
    current = [];
  };
  for (const group of groupsOf(units.filter((unit) => unit.needs_llm && wanted(unit)))) {
    const [first] = group;
    if (first === undefined) continue;
    const groupChapter = chapterOf(first);
    if (groupChapter !== chapter || charsOf(current) + charsOf(group) > REQUEST_CHARS) flush();
    chapter = groupChapter;
    current.push(...group);
  }
  flush();
  return requests;
}

export interface MessageContext {
  /** 這本書適用的詞條。 */
  readonly terms: readonly LocalizedTerm[];
  readonly pack: ResolvedPack;
}

function glossaryBlock(units: readonly TranslationUnit[], terms: readonly LocalizedTerm[]): string | null {
  const hits = new Map(units.flatMap((unit) => hitTerms(unit, terms)).map((hit) => [hit.text, hit]));
  if (hits.size === 0) return null;
  const lines = [...hits.values()].map(
    ({ text, term }) => `<term source="${escapeAttribute(text)}" target="${escapeAttribute(term.target)}"/>`,
  );
  return `<glossary>\n${lines.join('\n')}\n</glossary>`;
}

/** 只列這批出現、有寫 `style` 的角色，寫在 `user` 才不會動到靜態前綴。 */
function rolesBlock(units: readonly TranslationUnit[], pack: ResolvedPack): string | null {
  const used = new Set(units.map(({ role }) => role));
  const lines = pack.roles.flatMap(({ pack: owner, name, style }) => {
    const role = `${owner}:${name}`;
    if (style === undefined || !used.has(role)) return [];
    return [`<role name="${escapeAttribute(role)}">${escapeText(style)}</role>`];
  });
  return lines.length === 0 ? null : `<roles>\n${lines.join('\n')}\n</roles>`;
}

export function userMessage({ units, context }: PlannedRequest, { terms, pack }: MessageContext): string {
  const parts = [
    context === '' ? null : `<context>\n${context}\n</context>`,
    glossaryBlock(units, terms),
    rolesBlock(units, pack),
    units.map(({ role, masked }, index) => unitTag(String(index + 1), role, masked)).join('\n'),
  ];
  return parts.filter((part) => part !== null).join('\n\n');
}

export interface MessagesBody extends ThinkingParams {
  readonly model: string;
  readonly max_tokens: number;
  readonly system: string;
  readonly messages: readonly [{ readonly role: 'user'; readonly content: string }];
}

export interface BodyOptions {
  readonly prefix: string;
  readonly user: string;
  readonly model: ProviderModel;
  readonly provider: Provider;
}

/** 組成 Messages API 的內容。思考也吃 `max_tokens`，所以用含思考的預估輸出（ADR-0103）。 */
export function requestBody({ units }: PlannedRequest, { prefix, user, model, provider }: BodyOptions): MessagesBody {
  const expected = outputTokens(provider, model, charsOf(units));
  return {
    model: model.id,
    max_tokens: Math.max(MIN_MAX_TOKENS, Math.ceil(expected * OUTPUT_ROOM)),
    system: prefix,
    messages: [{ role: 'user', content: user }],
    ...thinkingParams(model),
  };
}

/** 區塊屬於哪一章，從 1 起算。第一章之前是 0，沒有章節的書整本算第 1 章（ADR-0103）。 */
export function chapterMap(document: IrDocument): Map<string, number> {
  const starts = new Map(
    document.sections.flatMap(({ block_id: id }, index) => (id === undefined ? [] : [[id, index + 1] as const])),
  );
  let current = starts.size === 0 ? 1 : 0;
  return new Map(
    document.blocks.map(({ id }) => {
      current = starts.get(id) ?? current;
      return [id, current];
    }),
  );
}

/** `3`、`1-3`、`1,3,5`。`count` 是這本書的章數。 */
export function parseChapters(spec: string, count: number): ReadonlySet<number> {
  const invalid = new TomeError('chapters.invalid', { spec, count: String(count) });
  const chapters = new Set<number>();
  for (const part of spec.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (match === null) throw invalid;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || from > to || to > count) throw invalid;
    for (let chapter = from; chapter <= to; chapter += 1) chapters.add(chapter);
  }
  return new Set([...chapters].sort((a, b) => a - b));
}

function chapterCount(document: IrDocument): number {
  return Math.max(1, document.sections.length);
}

/** 目前只接 Anthropic（ADR-0080）。 */
const PROVIDER_ID = 'anthropic';
const ESTIMATE_STAGE = 'estimate';

export interface BookPlan {
  readonly model: ProviderModel;
  readonly provider: LoadedProvider;
  readonly requests: readonly PlannedRequest[];
  readonly bodies: readonly MessagesBody[];
  readonly unitCount: number;
  readonly chars: number;
  readonly estimate: Estimate;
  /** 單位、模型、價格、範圍、預算、提示的內容指紋（ADR-0103）。 */
  readonly fingerprint: string;
}

export interface PlanResult {
  /** 規則包讀不全或模式逾時是 null，理由在 `findings`。 */
  readonly plan: BookPlan | null;
  readonly findings: readonly Finding[];
}

/** 要送的單位。`FAILED_QA` 這類要等人處理，`IN_FLIGHT` 已經送出去了，都不算（白皮書 §6.2）。 */
function pendingUnits(store: Store): ReadonlySet<string> {
  const rows = store.all<{ unit_id: string }>(
    "SELECT unit_id FROM unit WHERE state IN ('PENDING', 'QUEUED', 'STALE')",
  );
  return new Set(rows.map(({ unit_id }) => unit_id));
}

/** 組出這本書還要送的請求。單位寫進 `book.db`，其他什麼都不動。 */
async function planBook(home: string, book: Book, store: Store): Promise<PlanResult> {
  const modelId = workspaceModel(home, 'translator_model');
  if (modelId === undefined) throw new TomeError('model.missing');
  const provider = loadProvider(PROVIDER_ID);
  const model = findModel(provider.profile, modelId);
  const document = readDocument(home, book.slug);
  const { pack, terms, findings: packFindings } = loadBookPack(home, book);
  if (pack === null) return { plan: null, findings: packFindings };
  const { units, findings } = await buildUnits(document, pack, book.config.source_lang);
  if (findings.some(({ level }) => level === 'fail')) return { plan: null, findings };
  syncUnits(store, units);

  const chapters = chapterMap(document);
  const { chapters: spec } = book.config;
  const chosen = spec === undefined ? null : parseChapters(spec, chapterCount(document));
  const chapterOf = (unit: TranslationUnit): number => chapters.get(unit.block_id) ?? 0;
  const inScope = (unit: TranslationUnit): boolean => chosen === null || chosen.has(chapterOf(unit));
  const pending = pendingUnits(store);
  const requests = planRequests(units, chapterOf, (unit) => pending.has(unit.unit_id) && inScope(unit));

  const { profile: language } = loadTargetLanguage(workspaceTargetLang(home));
  const prefix = staticPrefix(language, pack);
  const sized = requests.map((request) => {
    const user = userMessage(request, { terms, pack });
    const sourceChars = charsOf(request.units);
    return {
      body: requestBody(request, { prefix, user, model, provider: provider.profile }),
      sourceChars,
      estimate: estimateRequest(
        provider.profile,
        model,
        { promptChars: prefix.length + user.length, sourceChars },
        'batch',
      ),
    };
  });
  const planned = requests.flatMap((request) => request.units);
  // 算範圍內全部的單位，不是還沒翻的：翻到一半中斷時，續跑不用重新確認（ADR-0054）。
  const scope = units.filter((unit) => unit.needs_llm && inScope(unit));
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        scope.map(({ unit_id, masked }) => [unit_id, masked]),
        model.id,
        provider.hash,
        spec ?? null,
        book.config.budget_usd ?? null,
        prefix,
      ]),
    )
    .digest('hex');
  return {
    plan: {
      model,
      provider,
      requests,
      bodies: sized.map(({ body }) => body),
      unitCount: planned.length,
      chars: sized.reduce((total, { sourceChars }) => total + sourceChars, 0),
      estimate: sumEstimates(sized.map(({ estimate }) => estimate)),
      fingerprint,
    },
    findings: packFindings,
  };
}

/** 小數位數跟著金額走：便宜的模型一本書可能不到一美元。 */
function usd(amount: number): string {
  return amount.toFixed(amount >= 0.01 || amount === 0 ? 2 : 6);
}

function planData(plan: BookPlan): Readonly<Record<string, unknown>> {
  return {
    model: plan.model.id,
    requests: plan.requests.length,
    units: plan.unitCount,
    chars: plan.chars,
    low_usd: plan.estimate.low_usd,
    high_usd: plan.estimate.high_usd,
    retention_days: plan.provider.profile.retention_days,
  };
}

function planParams(plan: BookPlan): Readonly<Record<string, string>> {
  return {
    model: plan.model.id,
    requests: String(plan.requests.length),
    units: String(plan.unitCount),
    chars: String(plan.chars),
    low: usd(plan.estimate.low_usd),
    high: usd(plan.estimate.high_usd),
    retention: String(plan.provider.profile.retention_days),
  };
}

export interface EstimateOptions {
  readonly home: string;
  readonly slug: string;
  /** 使用者打的字，這裡才驗證。 */
  readonly budget?: string | undefined;
  readonly chapters?: string | undefined;
  readonly confirm: boolean;
  readonly today?: Date;
}

export interface PlanOutcome {
  readonly data: Readonly<Record<string, unknown>>;
  readonly findings: readonly Finding[];
}

function parseBudget(value: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new TomeError('budget.invalid', { value });
  return amount;
}

/** 這次指定的預算與範圍，先驗證，都對了才寫進 `book.yaml`。 */
function chosenSettings(home: string, book: Book, options: EstimateOptions): Partial<BookConfig> {
  const { budget, chapters } = options;
  const patch: { budget_usd?: number; chapters?: string } = {};
  if (budget !== undefined) patch.budget_usd = parseBudget(budget);
  if (chapters !== undefined) {
    parseChapters(chapters, chapterCount(readDocument(home, book.slug)));
    patch.chapters = chapters;
  }
  return patch;
}

function confirmation(
  store: Store,
  plan: BookPlan,
  budget: number | undefined,
  spent: number,
  confirm: boolean,
): { readonly confirmed: boolean; readonly findings: readonly Finding[] } {
  const confirmed = stageFingerprint(store, ESTIMATE_STAGE) === plan.fingerprint;
  if (budget === undefined) {
    if (confirm) return { confirmed: false, findings: [finding('estimate.no_budget', 'fail')] };
    return {
      confirmed: false,
      findings: [finding('estimate.no_budget', 'warn'), finding('estimate.not_confirmed', 'info')],
    };
  }
  const spending = { budget: usd(budget), spent: usd(spent) };
  const shown = finding('estimate.budget', 'info', spending);
  const { ok } = checkBudget({ budget_usd: budget, spent_usd: spent, in_flight_usd: 0, next_usd: plan.estimate.high_usd });
  if (confirm && !ok) {
    const over = finding('estimate.over_budget', 'fail', { ...spending, high: usd(plan.estimate.high_usd) });
    return { confirmed: false, findings: [shown, over] };
  }
  if (confirm) {
    recordStage(store, ESTIMATE_STAGE, plan.fingerprint);
    return { confirmed: true, findings: [shown, finding('estimate.confirmed', 'info')] };
  }
  const reminder = confirmed ? [] : [finding('estimate.not_confirmed', 'info')];
  return { confirmed, findings: [shown, ...reminder] };
}

async function estimateLocked(options: EstimateOptions): Promise<PlanOutcome> {
  const { home, slug, confirm, today = new Date() } = options;
  const before = readBook(home, slug);
  const book = updateIfChosen(home, before, chosenSettings(home, before, options));
  const store = openBookStore(home, slug);
  try {
    const { plan, findings } = await planBook(home, book, store);
    const warnings = [...findings, ...piiFindings(home)];
    if (plan === null) return { data: { book: slug, confirmed: false }, findings: warnings };
    const stale = priceFinding(plan.provider.profile, today);
    const prices = stale.level === 'warn' ? [stale] : [];
    const summary =
      plan.requests.length === 0
        ? finding('estimate.nothing', 'info')
        : finding('estimate.done', 'info', planParams(plan));
    const budget = book.config.budget_usd;
    const spent = spentUsd(store);
    const { confirmed, findings: decided } = confirmation(store, plan, budget, spent, confirm);
    return {
      data: { book: slug, ...planData(plan), budget_usd: budget ?? null, spent_usd: spent, confirmed },
      findings: [summary, ...decided, ...warnings, ...prices],
    };
  } finally {
    store.close();
  }
}

function updateIfChosen(home: string, book: Book, patch: Partial<BookConfig>): Book {
  return Object.keys(patch).length === 0 ? book : updateBook(home, book, patch);
}

/** `tome estimate`。在本機算，不連網（ADR-0035）。 */
export function estimateBook(options: EstimateOptions): Promise<PlanOutcome> {
  return withBookLock(options.home, options.slug, () => estimateLocked(options));
}

async function dryRunLocked(home: string, slug: string): Promise<PlanOutcome> {
  const store = openBookStore(home, slug);
  try {
    const { plan, findings } = await planBook(home, readBook(home, slug), store);
    if (plan === null) return { data: { book: slug }, findings };
    const prefixes = new Set(plan.bodies.map(({ system }) => system));
    return {
      data: { book: slug, ...planData(plan) },
      findings: [
        finding('dry_run.done', 'info', planParams(plan)),
        ...(prefixes.size > 1 ? [finding('dry_run.prefix_unstable', 'fail')] : []),
        ...findings,
      ],
    };
  } finally {
    store.close();
  }
}

/** `tome translate --dry-run`：組出所有請求但不送出（ADR-0040）。 */
export function dryRunBook(home: string, slug: string): Promise<PlanOutcome> {
  return withBookLock(home, slug, () => dryRunLocked(home, slug));
}
