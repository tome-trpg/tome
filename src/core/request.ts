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
import { hitCount, scanBody, type PiiRules } from './egress/gate.ts';
import { TomeError } from './errors.ts';
import { estimateRequest, outputTokens, sumEstimates, type Estimate } from './estimate.ts';
import { readDocument } from './extract.ts';
import { finding, type Finding } from './findings.ts';
import type { IrDocument } from './ir.ts';
import { loadTargetLanguage } from './language.ts';
import { spentUsd } from './ledger.ts';
import { packHash, type LocalizedTerm, type ResolvedPack } from './pack.ts';
import { feedbackSentences, fillSentence, promptHash, staticPrefix } from './prompt.ts';
import {
  findModel,
  loadProvider,
  priceFinding,
  thinkingParams,
  usd,
  type LoadedProvider,
  type Provider,
  type ProviderModel,
  type RequestMode,
  type ThinkingParams,
} from './provider.ts';
import { openBookStore, type Store } from './store.ts';
import { escapeAttribute, escapeText, unitTag } from './tags.ts';
import { buildUnits, syncUnits, type TranslationUnit } from './units.ts';
import { hitTerms, loadBookPack, visibleText } from './verify.ts';
import { piiFindings, workspaceModel, workspacePii, workspaceTargetLang } from './workspace.ts';

// 把單位組成請求（白皮書 §5.7、ADR-0103）。這裡只組資料與估價，不連網。

/** 一個請求約這麼多字元，用字元數是因為各家 token 計法不同（TC-5）。 */
export const REQUEST_CHARS = 6000;
/**
 * 一個請求最多這麼多個單位，同一組不拆。是提案：規則書的短格子讓一個請求多達 161 個單位，
 * 出事時整個請求都要重送（ADR-0114）。
 */
export const REQUEST_UNITS = 40;
/** 上文約這麼多字元。 */
export const CONTEXT_CHARS = 800;
const MIN_MAX_TOKENS = 1024;
/** 模型要翻完才停，`max_tokens` 留到預估輸出的 2 倍（ADR-0103）。 */
const OUTPUT_ROOM = 2;
/**
 * 每個單位在輸出多要的 token，例如 `<s id>` 的標籤。依字元預估的輸出沒算到它，短格子的請求
 * 因此被截斷。是提案，取 M2 兩本書帳本擬合的較大者（ADR-0114）。
 */
export const UNIT_OUTPUT_TOKENS = 16;

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

/** 同一組沒有一起送的單位。重送與對半拆時才會有（ADR-0104 第 29 項）。 */
function restOfGroups(units: readonly TranslationUnit[], sent: readonly TranslationUnit[]): TranslationUnit[] {
  const going = new Set(sent.map(({ unit_id }) => unit_id));
  const groups = new Set(sent.flatMap(({ group }) => (group === undefined ? [] : [group])));
  if (groups.size === 0) return [];
  return units.filter(({ group, unit_id }) => group !== undefined && groups.has(group) && !going.has(unit_id));
}

/**
 * 同一組沒送的單位排在最前面，超過上限時留前面的部分，表頭才留得住（ADR-0104 第 29 項）。
 * 剩下的空間給同一章前面看得到的文字。佔位符拿掉，只用來理解語意，不用翻譯（ADR-0103）。
 */
function contextOf(
  units: readonly TranslationUnit[],
  sent: readonly TranslationUnit[],
  chapterOf: (unit: TranslationUnit) => number,
): string {
  const [first] = sent;
  if (first === undefined) return '';
  const rest = restOfGroups(units, sent);
  const shown = new Set(rest.map(({ unit_id }) => unit_id));
  const head = rest.map(({ masked }) => visibleText(masked)).join('\n').slice(0, CONTEXT_CHARS);
  const room = head === '' ? CONTEXT_CHARS : CONTEXT_CHARS - head.length - 1;
  const chapter = chapterOf(first);
  const lines: string[] = [];
  let size = 0;
  for (let at = units.indexOf(first) - 1; at >= 0 && size < room; at -= 1) {
    const unit = units[at];
    if (unit === undefined || chapterOf(unit) !== chapter) break;
    if (shown.has(unit.unit_id)) continue;
    const line = visibleText(unit.masked);
    lines.unshift(line);
    size += line.length + 1;
  }
  const before = room > 0 ? lines.join('\n').slice(-room) : '';
  return escapeText([head, before].filter((part) => part !== '').join('\n'));
}

/** 拿請求的一部分組成新的請求。上下文要重算，同一組的單位可能剛好被分開。 */
export function partOfRequest(
  units: readonly TranslationUnit[],
  id: string,
  part: readonly TranslationUnit[],
  chapterOf: (unit: TranslationUnit) => number,
): PlannedRequest {
  return { id, units: part, context: contextOf(units, part, chapterOf) };
}

/** 依單位數對半拆，前半多一個。單一單位拆不了，回傳的還是一個（ADR-0104 第 12 項）。 */
export function splitRequest(
  units: readonly TranslationUnit[],
  request: PlannedRequest,
  chapterOf: (unit: TranslationUnit) => number,
): PlannedRequest[] {
  const middle = Math.ceil(request.units.length / 2);
  return [request.units.slice(0, middle), request.units.slice(middle)]
    .filter((part) => part.length > 0)
    .map((part, index) => partOfRequest(units, `${request.id}.${index + 1}`, part, chapterOf));
}

/**
 * 依閱讀順序組請求。`wanted` 決定哪些單位要送，其他單位只當上文。
 * 請求不跨章，字元與單位數都有上限，單一組超過上限時自成一個請求（ADR-0029、ADR-0114）。
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
    if (current.length === 0) return;
    requests.push(partOfRequest(units, `r${requests.length + 1}`, current, chapterOf));
    current = [];
  };
  for (const group of groupsOf(units.filter((unit) => unit.needs_llm && wanted(unit)))) {
    const [first] = group;
    if (first === undefined) continue;
    const groupChapter = chapterOf(first);
    const full =
      charsOf(current) + charsOf(group) > REQUEST_CHARS || current.length + group.length > REQUEST_UNITS;
    if (groupChapter !== chapter || full) flush();
    chapter = groupChapter;
    current.push(...group);
  }
  flush();
  return requests;
}

/** 一批最多這麼多字元原文，算法跟請求一樣。是提案，等真實請求量過（ADR-0107 第 3 項）。 */
export const BATCH_CHARS = 100_000;

function requestChars({ units }: PlannedRequest): number {
  return charsOf(units);
}

/** 依章分段。請求不跨章，所以同一章的請求一定相鄰（ADR-0103）。 */
function chaptersOf(
  requests: readonly PlannedRequest[],
  chapterOf: (unit: TranslationUnit) => number,
): PlannedRequest[][] {
  const chapters: PlannedRequest[][] = [];
  let chapter: number | undefined;
  for (const request of requests) {
    const [first] = request.units;
    const current = first === undefined ? chapter : chapterOf(first);
    const last = chapters.at(-1);
    if (last === undefined || current !== chapter) chapters.push([request]);
    else last.push(request);
    chapter = current;
  }
  return chapters;
}

/**
 * 照閱讀順序把整章放進同一批，加入下一章會超過上限時先切開。單一章超過上限時，
 * 才在請求的邊界切成幾批，每批至少一個請求（ADR-0099 第 22 項、ADR-0107 第 3 項）。
 * `used` 是第一批已經放進去的字元，重送的請求排在最前面，一起受上限（ADR-0107 第 5 項）。
 */
export function planBatches(
  requests: readonly PlannedRequest[],
  chapterOf: (unit: TranslationUnit) => number,
  limit: number = BATCH_CHARS,
  used = 0,
): PlannedRequest[][] {
  const batches: PlannedRequest[][] = [];
  let current: PlannedRequest[] = [];
  let size = used;
  const flush = (): void => {
    if (current.length > 0 || batches.length === 0) batches.push(current);
    current = [];
    size = 0;
  };
  for (const chapter of chaptersOf(requests, chapterOf)) {
    const chars = chapter.reduce((total, request) => total + requestChars(request), 0);
    if (size + chars <= limit) {
      current.push(...chapter);
      size += chars;
      continue;
    }
    if (current.length > 0 || size > 0) flush();
    if (chars <= limit) {
      current.push(...chapter);
      size = chars;
      continue;
    }
    for (const request of chapter) {
      const next = requestChars(request);
      if (current.length > 0 && size + next > limit) flush();
      current.push(request);
      size += next;
    }
    flush();
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface FeedbackItem {
  /** 驗證的代碼，對應 `prompts/feedback.yaml` 的一句話。 */
  readonly code: string;
  readonly detail: Readonly<Record<string, string>>;
}

/** 依 `unit_id`。上次的問題，存在 `issue`，所以中斷之後還在。 */
export type Feedback = ReadonlyMap<string, readonly FeedbackItem[]>;

export interface MessageContext {
  /** 這本書適用的詞條。 */
  readonly terms: readonly LocalizedTerm[];
  readonly pack: ResolvedPack;
  readonly feedback?: Feedback;
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

/** 只有說明，不放上次的譯文。`id` 是單位在這個請求的編號（ADR-0104 第 16 項）。 */
function feedbackBlock(units: readonly TranslationUnit[], feedback: Feedback): string | null {
  const sentences = feedbackSentences();
  const lines = units.flatMap(({ unit_id }, index) =>
    (feedback.get(unit_id) ?? []).map(({ code, detail }) => {
      const sentence = fillSentence(sentences[code] ?? '', detail);
      return `<problem id="${index + 1}">${escapeText(sentence)}</problem>`;
    }),
  );
  return lines.length === 0 ? null : `<feedback>\n${lines.join('\n')}\n</feedback>`;
}

export function userMessage({ units, context }: PlannedRequest, { terms, pack, feedback }: MessageContext): string {
  const parts = [
    context === '' ? null : `<context>\n${context}\n</context>`,
    glossaryBlock(units, terms),
    rolesBlock(units, pack),
    feedback === undefined ? null : feedbackBlock(units, feedback),
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

/**
 * 請求的 `max_tokens`。思考也吃它，所以用含思考的預估輸出（ADR-0103），再加上每個單位的標籤（ADR-0114）。
 * 只是上限，計費看實際產生的 token，估價不用這個數字。
 */
export function maxTokens(provider: Provider, model: ProviderModel, units: readonly TranslationUnit[]): number {
  const expected = outputTokens(provider, model, charsOf(units)) + UNIT_OUTPUT_TOKENS * units.length;
  return Math.max(MIN_MAX_TOKENS, Math.ceil(expected * OUTPUT_ROOM));
}

/** 組成 Messages API 的內容。 */
export function requestBody({ units }: PlannedRequest, { prefix, user, model, provider }: BodyOptions): MessagesBody {
  return {
    model: model.id,
    max_tokens: maxTokens(provider, model, units),
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

/** 這本書的章數，沒有章節的書算 1 章。 */
export function chapterCount(document: IrDocument): number {
  return Math.max(1, document.sections.length);
}

/** 目前只接 Anthropic（ADR-0080）。 */
const PROVIDER_ID = 'anthropic';
export const ESTIMATE_STAGE = 'estimate';

export interface SizedRequest {
  readonly body: MessagesBody;
  readonly sourceChars: number;
  readonly estimate: Estimate;
}

export interface SizeOptions extends MessageContext {
  readonly prefix: string;
  readonly model: ProviderModel;
  readonly provider: Provider;
  readonly mode: RequestMode;
}

/** 組成請求內容並估價。實際送出與估價走同一段，數字才對得起來。 */
export function sizeRequest(request: PlannedRequest, options: SizeOptions): SizedRequest {
  const { prefix, model, provider, mode } = options;
  const user = userMessage(request, options);
  const sourceChars = charsOf(request.units);
  return {
    body: requestBody(request, { prefix, user, model, provider }),
    sourceChars,
    estimate: estimateRequest(provider, model, { promptChars: prefix.length + user.length, sourceChars }, mode),
  };
}

export interface BookPlan {
  readonly mode: RequestMode;
  readonly model: ProviderModel;
  /** `tome.yaml` 的 `fallback_model`，拒答時改送（白皮書 §5.7）。 */
  readonly fallback: ProviderModel | null;
  readonly provider: LoadedProvider;
  readonly requests: readonly PlannedRequest[];
  readonly bodies: readonly MessagesBody[];
  readonly unitCount: number;
  /** 範圍內不需翻譯、原樣保留的單位，跟 `tome translate` 的總數對得起來（ADR-0111）。 */
  readonly keptCount: number;
  readonly chars: number;
  readonly estimate: Estimate;
  /** 單位、模型、回退模型、價格、範圍、預算、提示、規則包、來源語言與模式的內容指紋（ADR-0103、ADR-0104、ADR-0106）。 */
  readonly fingerprint: string;
  /** 全書依閱讀順序的單位，上文要用。 */
  readonly units: readonly TranslationUnit[];
  readonly chapterOf: (unit: TranslationUnit) => number;
  readonly inScope: (unit: TranslationUnit) => boolean;
  /** `book.yaml` 的範圍，沒設是 null。 */
  readonly chapters: string | null;
  readonly prefix: string;
  readonly pack: ResolvedPack;
  readonly terms: readonly LocalizedTerm[];
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
export async function planBook(home: string, book: Book, store: Store, mode: RequestMode): Promise<PlanResult> {
  const modelId = workspaceModel(home, 'translator_model');
  if (modelId === undefined) throw new TomeError('model.missing');
  const provider = loadProvider(PROVIDER_ID);
  const model = findModel(provider.profile, modelId);
  const fallbackId = workspaceModel(home, 'fallback_model');
  const fallback = fallbackId === undefined ? null : findModel(provider.profile, fallbackId);
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
  const sized = requests.map((request) =>
    sizeRequest(request, { prefix, terms, pack, model, provider: provider.profile, mode }),
  );
  const planned = requests.flatMap((request) => request.units);
  // 算範圍內全部的單位，不是還沒翻的：翻到一半中斷時，續跑不用重新確認（ADR-0054）。
  const scope = units.filter((unit) => unit.needs_llm && inScope(unit));
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        scope.map(({ unit_id, masked }) => [unit_id, masked]),
        model.id,
        fallback?.id ?? null,
        provider.hash,
        spec ?? null,
        book.config.budget_usd ?? null,
        promptHash(prefix),
        packHash(pack),
        book.config.source_lang,
        mode,
      ]),
    )
    .digest('hex');
  return {
    plan: {
      mode,
      model,
      fallback,
      provider,
      requests,
      bodies: sized.map(({ body }) => body),
      unitCount: planned.length,
      keptCount: units.filter((unit) => !unit.needs_llm && inScope(unit)).length,
      chars: sized.reduce((total, { sourceChars }) => total + sourceChars, 0),
      estimate: sumEstimates(sized.map(({ estimate }) => estimate)),
      fingerprint,
      units,
      chapterOf,
      inScope,
      chapters: spec ?? null,
      prefix,
      pack,
      terms,
    },
    findings: packFindings,
  };
}

function planData(plan: BookPlan): Readonly<Record<string, unknown>> {
  return {
    mode: plan.mode,
    model: plan.model.id,
    requests: plan.requests.length,
    units: plan.unitCount,
    kept: plan.keptCount,
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
    kept: String(plan.keptCount),
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
  /** 不存進 `book.yaml`，只隨確認記在指紋裡（ADR-0104）。 */
  readonly mode: RequestMode;
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
  const { home, slug, confirm, mode, today = new Date() } = options;
  const before = readBook(home, slug);
  const book = updateIfChosen(home, before, chosenSettings(home, before, options));
  const store = openBookStore(home, slug);
  try {
    const { plan, findings } = await planBook(home, book, store, mode);
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

/** 這本書送出前要比對的清單。 */
export function piiRulesOf(home: string, book: Book): PiiRules {
  return { pii: workspacePii(home), exceptions: book.config.pii_exceptions ?? [] };
}

/** 跟真的送出時掃描同樣的內容：序列化後的完整請求。 */
function gateFindings(bodies: readonly MessagesBody[], rules: PiiRules): readonly Finding[] {
  const count = bodies.reduce((total, body) => total + hitCount(scanBody(JSON.stringify(body), rules)), 0);
  return count === 0 ? [] : [finding('translate.blocked', 'fail', { count: String(count) })];
}

async function dryRunLocked(home: string, slug: string, mode: RequestMode): Promise<PlanOutcome> {
  const book = readBook(home, slug);
  const store = openBookStore(home, slug);
  try {
    const { plan, findings } = await planBook(home, book, store, mode);
    if (plan === null) return { data: { book: slug }, findings };
    const prefixes = new Set(plan.bodies.map(({ system }) => system));
    return {
      data: { book: slug, ...planData(plan) },
      findings: [
        finding('dry_run.done', 'info', planParams(plan)),
        ...(prefixes.size > 1 ? [finding('dry_run.prefix_unstable', 'fail')] : []),
        ...gateFindings(plan.bodies, piiRulesOf(home, book)),
        ...findings,
      ],
    };
  } finally {
    store.close();
  }
}

/** `tome translate --dry-run`：組出所有請求但不送出，閘門照樣檢查（ADR-0040、白皮書 §8.1）。 */
export function dryRunBook(home: string, slug: string, mode: RequestMode): Promise<PlanOutcome> {
  return withBookLock(home, slug, () => dryRunLocked(home, slug, mode));
}
