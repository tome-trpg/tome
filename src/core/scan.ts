import { createHash, randomBytes } from 'node:crypto';
import {
  customId,
  findCandidate,
  remove,
  retryDeletes,
  waitFor,
  type BatchHost,
  type BatchOptions,
  type BatchRow,
} from './batch.ts';
import { readBook, recordStage, stageFingerprint, updateBook, withBookLock, type Book } from './book.ts';
import { checkBudget } from './budget.ts';
import { mineCandidates, type Candidate } from './candidates.ts';
import { checkCard, parseBrief, parseCards, type CardRules, type ProposedCard } from './cards.ts';
import { EgressBlocked } from './egress/client.ts';
import { hitCount, scanBody, type PiiRules } from './egress/gate.ts';
import { TomeError } from './errors.ts';
import { estimateFixedOutput, sumEstimates, withThinking, type Estimate } from './estimate.ts';
import { readDocument } from './extract.ts';
import { finding, type Finding } from './findings.ts';
import type { DocumentBlock, IrDocument } from './ir.ts';
import { loadSourceLanguage, loadTargetLanguage } from './language.ts';
import { recordEstimate, recordUsage, spentUsd } from './ledger.ts';
import {
  RETRYABLE_BATCH_ERRORS,
  isApiError,
  retryableSubmit,
  sendWithRetry,
  sleepSeconds,
  submitRejected,
  withRetry,
  type Answer,
  type ApiError,
  type BatchOutcome,
  type LLMHost,
  type OnRetry,
  type RemoteBatch,
  type RequestResult,
} from './llm.ts';
import { packHash, termsFor, type ResolvedPack } from './pack.ts';
import { scanPrefix, summaryPrefix } from './prompt.ts';
import {
  findModel,
  loadProvider,
  priceFinding,
  thinkingParams,
  usd,
  type LoadedProvider,
  type ProviderModel,
  type RequestMode,
} from './provider.ts';
import {
  MIN_MAX_TOKENS,
  OUTPUT_ROOM,
  PROVIDER_ID,
  REQUEST_CHARS,
  REQUEST_UNITS,
  parseBudget,
  piiRulesOf,
  type MessagesBody,
  type PlanOutcome,
} from './request.ts';
import { MAX_ATTEMPTS } from './state.ts';
import { openBookStore, type Store } from './store.ts';
import { escapeText } from './tags.ts';
import { OUTSTANDING, connect, inFlightUsd, outstandingBatches, providerFailed } from './translate.ts';
import { UNTRANSLATED } from './units.ts';
import { loadBookPack } from './verify.ts';
import { piiFindings, workspaceModel, workspaceTargetLang } from './workspace.ts';

// Pass 0（白皮書 §5.6、ADR-0118）：候選詞與全書提要送給 `scanner_model`，拿回實體卡的提議與提要。
// 跟翻譯走同一條路：估價、確認、預算、個資閘門、外送紀錄與帳本都一樣，批次與即時兩種模式。
// 候選詞、譯名與提要都是書本內容，只存在 `book.db`，訊息只有數量（ADR-0059）。

/** 上一次顯示的估價的內容指紋，`--confirm` 要跟它相同才送（ADR-0118 第 8 項）。 */
export const SCAN_ESTIMATE_STAGE = 'scan-estimate';
/** 每個候選詞在輸出多要的 token：一張卡約 15 到 25 個。是提案（ADR-0118 第 10 項）。 */
export const CARD_OUTPUT_TOKENS = 32;
/** 提要最多 150 個英文詞，約 200 個 token，留 2 倍。是提案。 */
export const BRIEF_OUTPUT_TOKENS = 400;
/** 提要的輸入：目錄最多這麼多字元，其餘給開頭的文字，合計 `REQUEST_CHARS`（ADR-0118 第 4 項）。 */
export const TOC_CHARS = 2000;
const SUMMARY_KEY = 'summary';
const CONFIRM_FLAGS: Readonly<Record<RequestMode, string>> = { realtime: '--realtime --confirm', batch: '--confirm' };
const EXCLUDE = (ids: ReadonlySet<number>) => (item: ScanItem): boolean => !ids.has(item.id);

function termKey(id: number): string {
  return `term:${id}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface ScanItem {
  readonly id: number;
  readonly candidate: Candidate;
  /** 送出的書本文字：詞與上下文，帳本依它分攤。 */
  readonly chars: number;
}

interface SummaryInput {
  readonly toc: string;
  readonly opening: string;
  readonly hash: string;
}

type ScanWork =
  | { readonly kind: 'terms'; readonly items: readonly ScanItem[]; readonly model: ProviderModel }
  | { readonly kind: 'summary'; readonly input: SummaryInput; readonly model: ProviderModel };

interface Sized {
  readonly body: MessagesBody;
  readonly estimate: Estimate;
}

export interface ScanPlan {
  readonly mode: RequestMode;
  readonly model: ProviderModel;
  readonly fallback: ProviderModel | null;
  readonly provider: LoadedProvider;
  readonly rules: CardRules;
  readonly candidates: readonly Candidate[];
  readonly items: readonly ScanItem[];
  readonly byId: ReadonlyMap<number, ScanItem>;
  readonly summary: SummaryInput | null;
  readonly works: readonly ScanWork[];
  readonly estimate: Estimate;
  readonly fingerprint: string;
  readonly scanSystem: string;
  readonly summarySystem: string;
  readonly classes: string;
}

/** 依序把候選詞組成請求：最多 40 個、書本文字合計最多 6,000 字元，跟翻譯一樣（ADR-0118 第 10 項）。 */
function termWorks(items: readonly ScanItem[], model: ProviderModel): ScanWork[] {
  const works: ScanWork[] = [];
  let current: ScanItem[] = [];
  let chars = 0;
  for (const item of items) {
    if (current.length > 0 && (current.length + 1 > REQUEST_UNITS || chars + item.chars > REQUEST_CHARS)) {
      works.push({ kind: 'terms', items: current, model });
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.chars;
  }
  if (current.length > 0) works.push({ kind: 'terms', items: current, model });
  return works;
}

function blockText({ text, table }: DocumentBlock): string {
  return (table === undefined ? text : table.cells.map((cell) => cell.text).join('\n')).trim();
}

/** 目錄加上開頭的會翻譯文字，合計最多 6,000 字元（ADR-0118 第 4 項）。都沒有時不寫提要。 */
function summaryInput(document: IrDocument): SummaryInput | null {
  const toc = document.blocks
    .filter(({ role }) => role === 'toc')
    .map(blockText)
    .join('\n')
    .slice(0, TOC_CHARS)
    .trim();
  const room = REQUEST_CHARS - toc.length;
  let opening = '';
  for (const block of document.blocks) {
    if (UNTRANSLATED.has(block.role)) continue;
    const text = blockText(block);
    if (text === '') continue;
    const next = opening === '' ? text : `${opening}\n${text}`;
    if (next.length > room) {
      if (opening === '') opening = text.slice(0, room);
      break;
    }
    opening = next;
  }
  if (toc === '' && opening === '') return null;
  return { toc, opening, hash: sha256(JSON.stringify([toc, opening])) };
}

/** 規則包宣告的類別，一行一個，有預設代名詞的寫在後面。繼承鏈由子到父，子包的優先。 */
function classesBlock(pack: ResolvedPack): string {
  const pronouns = new Map<string, string>();
  for (const { content } of pack.chain) {
    for (const [name, { default_pronoun: pronoun }] of Object.entries(content.classes)) {
      if (!pronouns.has(name) && pronoun !== undefined) pronouns.set(name, pronoun);
    }
  }
  const lines = [...pack.classes].map((name) => {
    const pronoun = pronouns.get(name);
    return escapeText(pronoun === undefined ? name : `${name} ${pronoun}`);
  });
  return lines.length === 0 ? '' : `<classes>\n${lines.join('\n')}\n</classes>`;
}

/** 書本文字跳脫後放進標籤。同一個請求裡重複的句子只送一次（ADR-0118 第 5 項）。 */
function termsMessage(classes: string, items: readonly ScanItem[]): string {
  const seen = new Set<string>();
  const lines = items.flatMap(({ candidate }, index) => {
    const id = index + 1;
    const sentences = candidate.contexts.filter((text) => {
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    });
    return [
      `<term id="${id}" count="${candidate.occurrences}">${escapeText(candidate.source)}</term>`,
      ...sentences.map((text) => `<q id="${id}">${escapeText(text)}</q>`),
    ];
  });
  return [classes, lines.join('\n')].filter((part) => part !== '').join('\n\n');
}

function summaryMessage({ toc, opening }: SummaryInput): string {
  const parts = [
    toc === '' ? null : `<toc>\n${escapeText(toc)}\n</toc>`,
    opening === '' ? null : `<opening>\n${escapeText(opening)}\n</opening>`,
  ];
  return parts.filter((part) => part !== null).join('\n\n');
}

/** 輸出是固定的份量，不跟輸入的長度走，`max_tokens` 取 2 倍、下限 1,024（ADR-0118 第 10 項）。 */
function bodyOf(system: string, user: string, model: ProviderModel, tokens: number): MessagesBody {
  return {
    model: model.id,
    max_tokens: Math.max(MIN_MAX_TOKENS, Math.ceil(withThinking(model, tokens) * OUTPUT_ROOM)),
    system,
    messages: [{ role: 'user', content: user }],
    ...thinkingParams(model),
  };
}

function outputOf(work: ScanWork): number {
  return work.kind === 'terms' ? CARD_OUTPUT_TOKENS * work.items.length : BRIEF_OUTPUT_TOKENS;
}

function sizeWork(plan: ScanPlan, work: ScanWork): Sized {
  const system = work.kind === 'terms' ? plan.scanSystem : plan.summarySystem;
  const user = work.kind === 'terms' ? termsMessage(plan.classes, work.items) : summaryMessage(work.input);
  const tokens = outputOf(work);
  return {
    body: bodyOf(system, user, work.model, tokens),
    estimate: estimateFixedOutput(plan.provider.profile, work.model, system.length + user.length, tokens, plan.mode),
  };
}

interface EntityRow {
  readonly id: number;
  readonly source: string;
  readonly status: string;
}

/**
 * 候選詞寫進 `entity`（ADR-0118 第 7 項）。已有的列不刪，人工的結果不會不見；文件裡找不到的
 * 出現次數改成 0；新的加進來，狀態是 `candidate`。
 */
export function syncEntities(store: Store, candidates: readonly Candidate[]): Map<string, EntityRow> {
  const now = new Date().toISOString();
  store.transaction(() => {
    const known = new Map(
      store.all<{ id: number; source: string }>('SELECT id, source FROM entity').map(({ id, source }) => [source, id]),
    );
    const current = new Set(candidates.map(({ source }) => source));
    for (const { source, sources, occurrences, firstBlock } of candidates) {
      const id = known.get(source);
      if (id === undefined) {
        store.run(
          `INSERT INTO entity (source, status, origin, sources, occurrences, first_block, created_at, updated_at)
           VALUES (?, 'candidate', 'pass0', ?, ?, ?, ?, ?)`,
          source,
          JSON.stringify(sources),
          occurrences,
          firstBlock,
          now,
          now,
        );
      } else {
        store.run(
          'UPDATE entity SET sources = ?, occurrences = ?, first_block = ?, updated_at = ? WHERE id = ?',
          JSON.stringify(sources),
          occurrences,
          firstBlock,
          now,
          id,
        );
      }
    }
    for (const [source, id] of known) {
      if (!current.has(source)) store.run('UPDATE entity SET occurrences = 0, updated_at = ? WHERE id = ?', now, id);
    }
  });
  return new Map(
    store.all<EntityRow>('SELECT id, source, status FROM entity').map((row) => [row.source, row]),
  );
}

function statusOf(store: Store, id: number): string | undefined {
  return store.get<{ status: string }>('SELECT status FROM entity WHERE id = ?', id)?.status;
}

function summaryWanted(store: Store, input: SummaryInput | null): boolean {
  if (input === null) return false;
  const row = store.get<{ input_hash: string }>('SELECT input_hash FROM summary WHERE id = 1');
  return row?.input_hash !== input.hash;
}

export interface ScanPlanResult {
  readonly plan: ScanPlan | null;
  readonly findings: readonly Finding[];
}

/** 組出還要送的請求。候選詞寫進 `book.db`，其他什麼都不動，不連網。 */
export function planScan(home: string, book: Book, store: Store, mode: RequestMode): ScanPlanResult {
  const modelId = workspaceModel(home, 'scanner_model');
  if (modelId === undefined) throw new TomeError('scanner_model.missing');
  const provider = loadProvider(PROVIDER_ID);
  const model = findModel(provider.profile, modelId);
  const fallbackId = workspaceModel(home, 'fallback_model');
  const fallback = fallbackId === undefined ? null : findModel(provider.profile, fallbackId);
  const document = readDocument(home, book.slug);
  const { pack, findings } = loadBookPack(home, book);
  if (pack === null) return { plan: null, findings };
  const sourceLang = book.config.source_lang;
  const targetLang = workspaceTargetLang(home);
  const { profile: source } = loadSourceLanguage(sourceLang);
  const { profile: target } = loadTargetLanguage(targetLang);
  const known = new Set(termsFor(pack, sourceLang).map(({ text }) => text));
  const candidates = mineCandidates(document, source, known);
  const rows = syncEntities(store, candidates);
  const items = candidates.flatMap((candidate) => {
    const row = rows.get(candidate.source);
    if (row === undefined) return [];
    const chars = candidate.source.length + candidate.contexts.reduce((sum, text) => sum + text.length, 0);
    return [{ id: row.id, candidate, chars }];
  });
  const pending = items.filter(({ candidate }) => rows.get(candidate.source)?.status === 'candidate');
  const summary = summaryInput(document);
  const works: ScanWork[] = [
    ...termWorks(pending, model),
    ...(summaryWanted(store, summary) && summary !== null ? [{ kind: 'summary' as const, input: summary, model }] : []),
  ];
  const scanSystem = scanPrefix(target);
  const summarySystem = summaryPrefix();
  const partial = {
    mode,
    model,
    fallback,
    provider,
    rules: { classes: pack.classes, pronouns: new Set(target.pronouns), script: target.script_check },
    candidates,
    items,
    byId: new Map(items.map((item) => [item.id, item])),
    summary,
    works,
    scanSystem,
    summarySystem,
    classes: classesBlock(pack),
  };
  const sized = works.map((work) => sizeWork({ ...partial, estimate: { low_usd: 0, high_usd: 0 }, fingerprint: '' }, work));
  // 算全部的候選詞，不是還沒送的：送到一半中斷時，續跑不用重新確認（比照翻譯，ADR-0054）。
  const fingerprint = sha256(
    JSON.stringify([
      candidates.map(({ source: text, contexts }) => [text, contexts]),
      summary?.hash ?? null,
      model.id,
      fallback?.id ?? null,
      provider.hash,
      sha256(scanSystem),
      sha256(summarySystem),
      packHash(pack),
      sourceLang,
      targetLang,
      mode,
      book.config.budget_usd ?? null,
    ]),
  );
  return {
    plan: { ...partial, estimate: sumEstimates(sized.map(({ estimate }) => estimate)), fingerprint },
    findings,
  };
}

interface ScanRun extends BatchHost {
  readonly slug: string;
  readonly plan: ScanPlan;
  /** `tome batch collect` 不花新的錢，沒有預算時是無限大。 */
  readonly budget: number;
  readonly rules: PiiRules;
  readonly onWait: BatchOptions['onBatchWait'];
  readonly onBatchSent: BatchOptions['onBatchSent'];
  readonly onProgress: ((done: number, total: number) => void) | undefined;
  summaryAttempts: number;
  sent: number;
  batches: number;
}

interface Step {
  readonly next: readonly ScanWork[];
  readonly stop: Finding | null;
}

const GO_ON: Step = { next: [], stop: null };

function stopAt(stop: Finding): Step {
  return { next: [], stop };
}

/** 還是 `candidate` 的才送、才套用：中斷後再下載一次結果時，套用過的不再套用。 */
function live(run: ScanRun, work: ScanWork): ScanWork | null {
  if (work.kind === 'summary') return summaryWanted(run.store, work.input) && run.summaryAttempts < MAX_ATTEMPTS ? work : null;
  const items = work.items.filter(({ id }) => statusOf(run.store, id) === 'candidate');
  return items.length === 0 ? null : { ...work, items };
}

function recordIssue(store: Store, key: string, code: string, detail: Readonly<Record<string, string>> | null): void {
  store.run(
    'INSERT INTO issue (unit_id, code, level, detail, created_at) VALUES (?, ?, ?, ?, ?)',
    key,
    code,
    'report',
    detail === null ? null : JSON.stringify(detail),
    new Date().toISOString(),
  );
}

function saveResponse(store: Store, key: string, attempt: number, text: string, model: string): void {
  store.run(
    'INSERT INTO response (unit_id, attempt, text, model, created_at) VALUES (?, ?, ?, ?, ?)',
    key,
    attempt,
    text,
    model,
    new Date().toISOString(),
  );
}

function bumpAttempts(store: Store, id: number): number {
  store.run('UPDATE entity SET attempts = attempts + 1, updated_at = ? WHERE id = ?', new Date().toISOString(), id);
  return store.get<{ attempts: number }>('SELECT attempts FROM entity WHERE id = ?', id)?.attempts ?? 0;
}

function setStatus(store: Store, id: number, status: string): void {
  store.run('UPDATE entity SET status = ?, updated_at = ? WHERE id = ?', status, new Date().toISOString(), id);
}

function writeCard(store: Store, id: number, card: ProposedCard): void {
  store.run(
    `UPDATE entity SET status = 'proposed', target = ?, class = ?, gender = ?, pronoun = ?, register = ?,
       keep_source = ?, updated_at = ? WHERE id = ?`,
    card.target,
    card.class ?? null,
    card.gender ?? null,
    card.pronoun ?? null,
    card.register ?? null,
    card.keep_source ? 1 : 0,
    new Date().toISOString(),
    id,
  );
}

/** 還要送：送出前與批次裡（`sent`）的候選詞。 */
function open(status: string | undefined): boolean {
  return status === 'candidate' || status === 'sent';
}

/**
 * 每個候選詞恰好一個 `<card>` 或 `<skip>`。少了、標籤壞了、譯名是空的或混入簡體字的，下次再送，
 * 用完 3 次就是 `failed`，留給人填（ADR-0118 第 9 項）。`ids` 是每個詞在回應裡的 `<card id>`：
 * 批次收回時照送出時的位置給，中間有詞不在了，後面的詞才不會拿到別人的卡，跟翻譯一樣（ADR-0107 第 11 項）。
 */
function applyTerms(run: ScanRun, items: readonly ScanItem[], text: string, model: ProviderModel, ids: readonly string[]): void {
  const { store } = run;
  const { replies } = parseCards(text);
  store.transaction(() => {
    items.forEach((item, index) => {
      if (!open(statusOf(store, item.id))) return;
      const key = termKey(item.id);
      const reply = replies.get(ids[index] ?? '');
      const attempts = bumpAttempts(store, item.id);
      store.run('DELETE FROM issue WHERE unit_id = ?', key);
      if (reply !== undefined) saveResponse(store, key, attempts, reply.raw, model.id);
      if (reply?.kind === 'skip') {
        setStatus(store, item.id, 'skipped');
        return;
      }
      const checked = reply === undefined ? null : checkCard(reply, run.plan.rules);
      if (checked?.ok === true) {
        writeCard(store, item.id, checked.card);
        for (const attribute of checked.dropped) recordIssue(store, key, 'card_attribute', { attribute });
        return;
      }
      recordIssue(store, key, checked === null ? 'card_missing' : checked.reason, null);
      setStatus(store, item.id, attempts >= MAX_ATTEMPTS ? 'failed' : 'candidate');
    });
  });
}

/** 收不到結果或沒有送到的詞放回佇列，下一批重送（ADR-0107 第 13 項）。 */
function requeue(store: Store, ids: readonly number[]): void {
  for (const id of ids) {
    if (statusOf(store, id) === 'sent') setStatus(store, id, 'candidate');
  }
}

function sentIds(store: Store, batchId: number): number[] {
  return store
    .all<{ unit_id: string }>("SELECT unit_id FROM batch_unit WHERE batch_id = ? AND unit_id LIKE 'term:%'", batchId)
    .map(({ unit_id }) => Number(unit_id.slice('term:'.length)));
}

/** 整批沒有送到供應商，或結果拿不回來。 */
function giveBack(store: Store, batchId: number, state: 'abandoned' | 'collected'): void {
  store.transaction(() => {
    store.run('UPDATE batch SET state = ?, collected_at = ? WHERE id = ?', state, new Date().toISOString(), batchId);
    requeue(store, sentIds(store, batchId));
  });
}

function applySummary(run: ScanRun, input: SummaryInput, text: string, model: ProviderModel): void {
  const parsed = parseBrief(text);
  run.summaryAttempts += 1;
  if (parsed === null) return;
  const { era, tone, factions } = parsed.brief;
  run.store.transaction(() => {
    run.store.run(
      `INSERT INTO summary (id, era, tone, factions, input_hash, model, created_at) VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET era = excluded.era, tone = excluded.tone, factions = excluded.factions,
         input_hash = excluded.input_hash, model = excluded.model, created_at = excluded.created_at`,
      era,
      tone,
      factions,
      input.hash,
      model.id,
      new Date().toISOString(),
    );
    saveResponse(run.store, SUMMARY_KEY, run.summaryAttempts, parsed.raw, model.id);
  });
}

function giveUp(run: ScanRun, work: ScanWork, code: string): void {
  if (work.kind === 'summary') {
    run.summaryAttempts = MAX_ATTEMPTS;
    return;
  }
  run.store.transaction(() => {
    for (const { id } of work.items) {
      setStatus(run.store, id, 'failed');
      recordIssue(run.store, termKey(id), code, null);
    }
  });
}

function halves(work: Extract<ScanWork, { kind: 'terms' }>): ScanWork[] {
  const middle = Math.ceil(work.items.length / 2);
  return [work.items.slice(0, middle), work.items.slice(middle)].map((items) => ({ ...work, items }));
}

/** 要重送的請求：詞放回佇列，下一批送出時再標成 `sent`。 */
function again(run: ScanRun, works: readonly ScanWork[]): readonly ScanWork[] {
  const ids = works.flatMap((work) => (work.kind === 'terms' ? work.items.map(({ id }) => id) : []));
  run.store.transaction(() => requeue(run.store, ids));
  return works;
}

/** 先對半拆，拆到底才換 `fallback_model`，都不行就放棄，跟翻譯一樣（ADR-0104 第 12 項）。 */
function refused(run: ScanRun, work: ScanWork): readonly ScanWork[] {
  if (work.kind === 'terms' && work.items.length > 1) return again(run, halves(work));
  const { fallback } = run.plan;
  if (fallback !== null && fallback.id !== work.model.id) return again(run, [{ ...work, model: fallback }]);
  giveUp(run, work, 'refused');
  return [];
}

/** 同樣大小再送也是被截斷，所以對半拆；沒得拆就放棄（ADR-0104 第 15 項）。 */
function truncated(run: ScanRun, work: ScanWork): readonly ScanWork[] {
  if (work.kind === 'terms' && work.items.length > 1) return again(run, halves(work));
  if (work.kind === 'summary') {
    run.summaryAttempts += 1;
    return [];
  }
  giveUp(run, work, 'truncated');
  return [];
}

function unitsOf(work: ScanWork): { unit_id: string; chars: number }[] {
  if (work.kind === 'terms') return work.items.map(({ id, chars }) => ({ unit_id: termKey(id), chars }));
  return [{ unit_id: SUMMARY_KEY, chars: work.input.toc.length + work.input.opening.length }];
}

/** 送出時 `<term id>` 從 1 依序編號。 */
function numbered(work: ScanWork): string[] {
  return work.kind === 'terms' ? work.items.map((_item, index) => String(index + 1)) : [];
}

/** 不管回應用不用得上都先記帳，否則預算會少算已經付的錢（ADR-0104 第 43 項）。 */
function answered(
  run: ScanRun,
  work: ScanWork,
  result: Answer,
  limit: number | null,
  ids: readonly string[] = numbered(work),
): readonly ScanWork[] {
  recordUsage(run.store, {
    request_id: result.requestId,
    model: work.model,
    mode: run.plan.mode,
    usage: result.usage,
    units: unitsOf(work),
    stop_reason: result.stopReason,
    max_tokens: limit,
  });
  if (result.outcome === 'refused') return refused(run, work);
  if (result.outcome === 'truncated') return truncated(run, work);
  if (work.kind === 'terms') applyTerms(run, work.items, result.text, work.model, ids);
  else applySummary(run, work.input, result.text, work.model);
  return [];
}

/** 超過預算就不送（ADR-0081 第 2 項）。Pass 0 跟翻譯用同一份預算。 */
function overBudget(run: ScanRun, next: number): Finding | null {
  const { store, budget, slug } = run;
  const spent = spentUsd(store);
  const check = { budget_usd: budget, spent_usd: spent, in_flight_usd: inFlightUsd(store), next_usd: next };
  if (checkBudget(check).ok) return null;
  return finding('scan.budget_exceeded', 'fail', { book: slug, budget: usd(budget), spent: usd(spent), next: usd(next) });
}

function blocked(count: number): Step {
  return stopAt(finding('scan.blocked', 'fail', { count: String(count) }));
}

/** 還要送的：狀態是 `candidate` 的候選詞，加上還沒寫好的提要。`exclude` 是已經排好要重送的。 */
function pendingWorks(run: ScanRun, exclude: ReadonlySet<number> = new Set(), summaryCarried = false): ScanWork[] {
  const { plan, store } = run;
  const items = plan.items.filter(EXCLUDE(exclude)).filter(({ id }) => statusOf(store, id) === 'candidate');
  const works = termWorks(items, plan.model);
  const summary = plan.summary;
  if (!summaryCarried && summary !== null && summaryWanted(store, summary) && run.summaryAttempts < MAX_ATTEMPTS) {
    works.push({ kind: 'summary', input: summary, model: plan.model });
  }
  return works;
}

function reportProgress(run: ScanRun): void {
  if (run.onProgress === undefined) return;
  const done = run.plan.items.filter(({ id }) => !open(statusOf(run.store, id))).length;
  run.onProgress(done, run.plan.items.length);
}

async function exchange(run: ScanRun, body: MessagesBody): Promise<RequestResult | EgressBlocked> {
  try {
    return await sendWithRetry(run.llm, body, run.sleep, run.onRetry);
  } catch (error) {
    if (error instanceof EgressBlocked) return error;
    throw error;
  }
}

/** 依序檢查預算、送出、收回、套用。個資閘門與外送紀錄在對外出口裡（ADR-0039、ADR-0104）。 */
async function sendWork(run: ScanRun, planned: ScanWork): Promise<Step> {
  const work = live(run, planned);
  if (work === null) return GO_ON;
  const sized = sizeWork(run.plan, work);
  const over = overBudget(run, sized.estimate.high_usd);
  if (over !== null) return stopAt(over);
  run.sent += 1;
  const result = await exchange(run, sized.body);
  if (result instanceof EgressBlocked) return blocked(hitCount(result.hits));
  if (result.outcome === 'error') return stopAt(providerFailed(result));
  return { next: answered(run, work, result, sized.body.max_tokens), stop: null };
}

async function drain(run: ScanRun): Promise<Finding | null> {
  for (let queue = pendingWorks(run); queue.length > 0; queue = pendingWorks(run)) {
    for (let work = queue.shift(); work !== undefined; work = queue.shift()) {
      const { next, stop } = await sendWork(run, work);
      reportProgress(run);
      if (stop !== null) return stop;
      queue.unshift(...next);
    }
  }
  return null;
}

/** 批次裡一個請求的單位：`term:<id>` 或 `summary`。 */
interface SentScan {
  readonly customId: string;
  readonly model: string;
  readonly keys: readonly string[];
}

function sentScans(store: Store, batchId: number): SentScan[] {
  const rows = store.all<{ custom_id: string; unit_id: string; model: string }>(
    'SELECT custom_id, unit_id, model FROM batch_unit WHERE batch_id = ? ORDER BY rowid',
    batchId,
  );
  const requests = new Map<string, { model: string; keys: string[] }>();
  for (const { custom_id, unit_id, model } of rows) {
    const request = requests.get(custom_id) ?? { model, keys: [] };
    requests.set(custom_id, request);
    request.keys.push(unit_id);
  }
  return [...requests].map(([id, { model, keys }]) => ({ customId: id, model, keys }));
}

/** 收回時要套用的請求與每個詞的 `<card id>`。沒有要套用的是 null。 */
interface Collectible {
  readonly work: ScanWork;
  readonly ids: readonly string[];
  /** 送出時的詞都還在，`max_tokens` 才算得回來（ADR-0114）。 */
  readonly whole: boolean;
}

/**
 * 送出時的請求，換成目前的計畫。只套用還在批次裡（`sent`）的詞：中斷在收回到一半時，套用過的
 * 不再套用，也不會多算一次（ADR-0107 第 11 項）。重新解析後文件裡沒有的詞不套用，放回佇列。
 * 每個詞帶著送出時的位置，`<card id>` 是它加 1。
 */
function collectible(run: ScanRun, sent: SentScan): Collectible | null {
  const { plan, store } = run;
  const model = findModel(plan.provider.profile, sent.model);
  if (sent.keys.includes(SUMMARY_KEY)) {
    const work = plan.summary === null ? null : live(run, { kind: 'summary', input: plan.summary, model });
    return work === null ? null : { work, ids: [], whole: true };
  }
  const placed = sent.keys.map((key, position) => ({ id: Number(key.slice('term:'.length)), position }));
  const inFlight = placed.filter(({ id }) => statusOf(store, id) === 'sent');
  const gone = inFlight.filter(({ id }) => !plan.byId.has(id)).map(({ id }) => id);
  if (gone.length > 0) store.transaction(() => requeue(store, gone));
  const kept = inFlight.flatMap(({ id, position }) => {
    const item = plan.byId.get(id);
    return item === undefined ? [] : [{ item, position }];
  });
  if (kept.length === 0) return null;
  return {
    work: { kind: 'terms', items: kept.map(({ item }) => item), model },
    ids: kept.map(({ position }) => String(position + 1)),
    whole: kept.length === sent.keys.length,
  };
}

interface Collected extends Step {
  readonly foreign: boolean;
}

const FOREIGN: Collected = { next: [], stop: null, foreign: true };

/** 等結束、收回、套用、刪除，跟翻譯的批次一樣（ADR-0107）。 */
async function collect(run: ScanRun, row: BatchRow, remoteId: string, unverified: boolean): Promise<Collected> {
  const { store } = run;
  const ended: RemoteBatch | Finding = await waitFor(run, run.onWait, row, remoteId);
  if ('level' in ended) return { ...stopAt(ended), foreign: false };
  if (ended.archivedAt !== null) {
    if (unverified) return FOREIGN;
    giveBack(store, row.id, 'collected');
    run.notes.push(finding('batch.archived', 'warn', { id: remoteId }));
    await remove(run, remoteId);
    return { ...GO_ON, foreign: false };
  }
  const items = await withRetry(() => run.llm.collectBatch(remoteId), run.sleep, undefined, run.onRetry);
  if (isApiError(items)) return { ...stopAt(providerFailed(items)), foreign: false };
  const prefix = `tome-${row.nonce}-`;
  if (unverified && (items.length === 0 || items.some(({ customId: id }) => !id.startsWith(prefix)))) return FOREIGN;
  const results = new Map(items.map(({ customId: id, result }) => [id, result]));
  const next: ScanWork[] = [];
  const failures: string[] = [];
  let applied = 0;
  let succeeded = 0;
  let failed = 0;
  let fatal = false;
  for (const sent of sentScans(store, row.id)) {
    const found = collectible(run, sent);
    if (found === null) continue;
    const { work, ids, whole } = found;
    applied += 1;
    const result: BatchOutcome = results.get(sent.customId) ?? { outcome: 'errored', type: 'missing' };
    if (result.outcome === 'ok' || result.outcome === 'truncated' || result.outcome === 'refused') {
      succeeded += 1;
      // 送出時的 `max_tokens` 沒有存，詞都還在才算得回來（ADR-0114）。照送出時的位置對 `<card id>`。
      next.push(...answered(run, work, result, whole ? sizeWork(run.plan, work).body.max_tokens : null, ids));
      continue;
    }
    // 不收費，詞放回佇列，下一批重送（ADR-0107 第 13 項）。
    failed += 1;
    if (work.kind === 'terms') store.transaction(() => requeue(store, work.items.map(({ id }) => id)));
    const type = result.outcome === 'errored' ? result.type : result.outcome;
    if (!failures.includes(type)) failures.push(type);
    if (result.outcome === 'errored' && type !== 'missing' && !RETRYABLE_BATCH_ERRORS.includes(type)) fatal = true;
  }
  const now = new Date().toISOString();
  store.run(
    "UPDATE batch SET state = 'collected', remote_id = ?, ended_at = ?, collected_at = ? WHERE id = ?",
    remoteId,
    ended.endedAt ?? now,
    now,
    row.id,
  );
  if (unverified) run.notes.push(finding('batch.recovered', 'info', { id: remoteId }));
  await remove(run, remoteId);
  if (applied > 0 && (fatal || succeeded === 0)) {
    return { next, stop: finding('batch.errored', 'fail', { count: String(failed), type: failures.join(', ') }), foreign: false };
  }
  return { next, stop: null, foreign: false };
}

function nextOutstanding(store: Store): BatchRow | undefined {
  return store.get<BatchRow>(`SELECT * FROM batch WHERE ${OUTSTANDING} AND stage = 'scan' ORDER BY id LIMIT 1`);
}

/** 先收上次留下來的 Pass 0 批次（ADR-0107 第 16 項）。 */
async function settleOutstanding(run: ScanRun): Promise<Step> {
  const { store } = run;
  await retryDeletes(run);
  const rejected = new Set<string>();
  const carry: ScanWork[] = [];
  for (let row = nextOutstanding(store); row !== undefined; row = nextOutstanding(store)) {
    let remoteId = row.remote_id;
    const unverified = row.state === 'intent';
    if (unverified && (remoteId === null || rejected.has(remoteId))) {
      const found = await findCandidate(run, row, rejected);
      if (found !== null && typeof found !== 'string') return stopAt(found);
      if (found === null) {
        giveBack(store, row.id, 'abandoned');
        run.notes.push(finding('batch.not_sent', 'info', { requests: String(row.requests) }));
        continue;
      }
      store.run('UPDATE batch SET remote_id = ? WHERE id = ?', found, row.id);
      remoteId = found;
    }
    if (remoteId === null) throw new RangeError(`batch ${row.id} has no remote id`);
    const collected = await collect(run, row, remoteId, unverified);
    if (collected.foreign) {
      rejected.add(remoteId);
      store.run('UPDATE batch SET remote_id = NULL WHERE id = ?', row.id);
      continue;
    }
    carry.push(...collected.next);
    if (collected.stop !== null) return { next: carry, stop: collected.stop };
  }
  return { next: carry, stop: null };
}

const NONCE_BYTES = 8;

/** 檢查預算與個資閘門、寫意圖紀錄、送出、等結束、收回（ADR-0107 第 6 到 8 項）。 */
async function sendBatch(run: ScanRun, works: readonly ScanWork[]): Promise<Step> {
  const { store } = run;
  const prepared = works.flatMap((planned) => {
    const work = live(run, planned);
    return work === null ? [] : [{ work, sized: sizeWork(run.plan, work) }];
  });
  if (prepared.length === 0) return GO_ON;
  const high = prepared.reduce((total, { sized }) => total + sized.estimate.high_usd, 0);
  const over = overBudget(run, high);
  if (over !== null) return stopAt(over);
  const hits = prepared.reduce((count, { sized }) => count + hitCount(scanBody(JSON.stringify(sized.body), run.rules)), 0);
  if (hits > 0) return blocked(hits);

  const nonce = randomBytes(NONCE_BYTES).toString('hex');
  const createdAt = new Date().toISOString();
  const row = store.transaction((): BatchRow => {
    store.run(
      "INSERT INTO batch (nonce, state, requests, high_usd, created_at, stage) VALUES (?, 'intent', ?, ?, ?, 'scan')",
      nonce,
      prepared.length,
      high,
      createdAt,
    );
    const { id } = store.get<{ id: number }>('SELECT last_insert_rowid() AS id') ?? { id: 0 };
    prepared.forEach(({ work }, index) => {
      unitsOf(work).forEach(({ unit_id: key }, position) => {
        store.run(
          'INSERT INTO batch_unit (batch_id, custom_id, position, unit_id, model) VALUES (?, ?, ?, ?, ?)',
          id,
          customId(nonce, index),
          position,
          key,
          work.model.id,
        );
      });
      // 跟意圖紀錄同一個交易標成 `sent`，收回時只套用還在批次裡的詞（ADR-0107 第 8 項）。
      if (work.kind === 'terms') for (const item of work.items) setStatus(store, item.id, 'sent');
    });
    return { id, nonce, remote_id: null, state: 'intent', requests: prepared.length, created_at: createdAt };
  });
  run.sent += prepared.length;
  run.batches += 1;

  const requests = prepared.map(({ sized }, index) => ({ customId: customId(nonce, index), body: sized.body }));
  let remote: RemoteBatch | ApiError;
  try {
    remote = await withRetry(() => run.llm.submitBatch(requests), run.sleep, retryableSubmit, run.onRetry);
  } catch (error) {
    if (!(error instanceof EgressBlocked)) throw error;
    giveBack(store, row.id, 'abandoned');
    return blocked(hitCount(error.hits));
  }
  if (isApiError(remote)) {
    // 4xx 代表沒有建立。5xx 與沒有收到回應就不知道，留著意圖紀錄，下次執行時去認（ADR-0108）。
    if (submitRejected(remote.status)) giveBack(store, row.id, 'abandoned');
    return stopAt(providerFailed(remote));
  }
  store.run(
    "UPDATE batch SET remote_id = ?, state = 'submitted', submitted_at = ?, expires_at = ? WHERE id = ?",
    remote.id,
    new Date().toISOString(),
    remote.expiresAt,
    row.id,
  );
  run.onBatchSent?.(row.id, prepared.length);
  const collected = await collect(run, { ...row, state: 'submitted', remote_id: remote.id }, remote.id, false);
  return { next: collected.next, stop: collected.stop };
}

/** 一次一批，直到沒有要送的。重送的請求排在下一批最前面（ADR-0107 第 4、5 項）。 */
async function drainBatches(run: ScanRun, carried: readonly ScanWork[]): Promise<Finding | null> {
  let carry = carried;
  for (;;) {
    const exclude = new Set(carry.flatMap((work) => (work.kind === 'terms' ? work.items.map(({ id }) => id) : [])));
    const summaryCarried = carry.some(({ kind }) => kind === 'summary');
    const works = [...carry, ...pendingWorks(run, exclude, summaryCarried)];
    if (works.length === 0) return null;
    const { next, stop } = await sendBatch(run, works);
    reportProgress(run);
    if (stop !== null) return stop;
    carry = next;
  }
}

interface EntityCounts {
  readonly candidates: number;
  readonly proposed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly left: number;
}

function countEntities(store: Store, plan: ScanPlan): EntityCounts {
  const states = plan.items.map(({ id }) => statusOf(store, id) ?? 'candidate');
  const of = (status: string): number => states.filter((state) => state === status).length;
  return {
    candidates: plan.items.length,
    proposed: of('proposed'),
    skipped: of('skipped'),
    failed: of('failed'),
    // 還在批次裡沒收回的也算尚未處理。
    left: of('candidate') + of('sent'),
  };
}

function hasSummary(store: Store): boolean {
  return store.get<{ id: number }>('SELECT id FROM summary WHERE id = 1') !== undefined;
}

/** 只有數字：候選詞與譯名都是書本內容（ADR-0059）。 */
function report(run: ScanRun, stop: Finding | null, findings: readonly Finding[]): PlanOutcome {
  const counts = countEntities(run.store, run.plan);
  const summary = hasSummary(run.store);
  const spent = spentUsd(run.store);
  const params = {
    book: run.slug,
    candidates: String(counts.candidates),
    proposed: String(counts.proposed),
    skipped: String(counts.skipped),
    failed: String(counts.failed),
    left: String(counts.left),
    summary: summary ? '1' : '0',
    spent: usd(spent),
  };
  const level = counts.failed > 0 || counts.left > 0 ? 'warn' : 'info';
  return {
    data: {
      book: run.slug,
      mode: run.plan.mode,
      requests: run.sent,
      ...(run.plan.mode === 'batch' ? { batches: run.batches } : {}),
      ...counts,
      summary,
      spent_usd: spent,
    },
    findings: [
      ...(stop === null ? [] : [stop]),
      finding('scan.done', level, params),
      ...(run.plan.summary !== null && !summary && run.summaryAttempts >= MAX_ATTEMPTS ? [finding('scan.summary_failed', 'warn')] : []),
      ...run.notes,
      ...findings,
    ],
  };
}

function termCount(works: readonly ScanWork[]): number {
  return works.reduce((total, work) => total + (work.kind === 'terms' ? work.items.length : 0), 0);
}

function estimateParams(plan: ScanPlan): Readonly<Record<string, string>> {
  return {
    model: plan.model.id,
    candidates: String(plan.items.length),
    terms: String(termCount(plan.works)),
    summary: plan.works.some(({ kind }) => kind === 'summary') ? '1' : '0',
    requests: String(plan.works.length),
    low: usd(plan.estimate.low_usd),
    high: usd(plan.estimate.high_usd),
    retention: String(plan.provider.profile.retention_days),
  };
}

function estimateData(plan: ScanPlan): Readonly<Record<string, unknown>> {
  return {
    mode: plan.mode,
    model: plan.model.id,
    candidates: plan.items.length,
    terms: termCount(plan.works),
    summary: plan.works.some(({ kind }) => kind === 'summary'),
    requests: plan.works.length,
    low_usd: plan.estimate.low_usd,
    high_usd: plan.estimate.high_usd,
    retention_days: plan.provider.profile.retention_days,
  };
}

export interface ScanOptions {
  readonly home: string;
  readonly slug: string;
  readonly mode: RequestMode;
  readonly confirm: boolean;
  /** 使用者打的字，這裡才驗證。 */
  readonly budget?: string | undefined;
  /** `--confirm` 才要。 */
  readonly host?: LLMHost;
  readonly today?: Date;
  readonly onStart?: ((mode: RequestMode, requests: number) => void) | undefined;
  readonly onProgress?: ((done: number, total: number) => void) | undefined;
  readonly onRetry?: OnRetry | undefined;
  readonly onBatchSent?: BatchOptions['onBatchSent'] | undefined;
  readonly onBatchWait?: BatchOptions['onBatchWait'] | undefined;
}

function startRun(options: ScanOptions, book: Book, store: Store, plan: ScanPlan, host: LLMHost): ScanRun {
  return {
    slug: options.slug,
    store,
    plan,
    budget: book.config.budget_usd ?? Number.POSITIVE_INFINITY,
    rules: piiRulesOf(options.home, book),
    llm: connect(options.home, book, store, host),
    sleep: host.sleep ?? sleepSeconds,
    onRetry: options.onRetry,
    onWait: options.onBatchWait,
    onBatchSent: options.onBatchSent,
    onProgress: options.onProgress,
    notes: [],
    summaryAttempts: 0,
    sent: 0,
    batches: 0,
  };
}

/**
 * 不加 `--confirm` 只估價、記下這次的內容指紋；加了要跟上次顯示的估價相同才送，不同就重新估價、
 * 要再確認一次（ADR-0118 第 8 項）。預算跟翻譯共用。
 */
async function scanLocked(options: ScanOptions): Promise<PlanOutcome> {
  const { home, slug, mode, confirm, budget, today = new Date() } = options;
  const before = readBook(home, slug);
  const book = budget === undefined ? before : updateBook(home, before, { budget_usd: parseBudget(budget) });
  const store = openBookStore(home, slug);
  try {
    if (confirm && mode === 'realtime' && outstandingBatches(store, 'scan') > 0) {
      return { data: { book: slug }, findings: [finding('batch.pending', 'fail', { book: slug })] };
    }
    const { plan, findings } = planScan(home, book, store, mode);
    const warnings = [...findings, ...piiFindings(home)];
    if (plan === null) return { data: { book: slug }, findings: warnings };
    const shown = stageFingerprint(store, SCAN_ESTIMATE_STAGE);
    recordStage(store, SCAN_ESTIMATE_STAGE, plan.fingerprint);
    const stale = priceFinding(plan.provider.profile, today);
    const prices = stale.level === 'warn' ? [stale] : [];
    const outstanding = outstandingBatches(store, 'scan');
    const nothing = plan.works.length === 0 && outstanding === 0;
    const shownEstimate = nothing ? finding('scan.nothing', 'info') : finding('scan.estimate', 'info', estimateParams(plan));
    const spent = spentUsd(store);
    const limit = book.config.budget_usd;
    const money = limit === undefined ? [] : [finding('estimate.budget', 'info', { budget: usd(limit), spent: usd(spent) })];
    const data = { book: slug, ...estimateData(plan), budget_usd: limit ?? null, spent_usd: spent, confirmed: false };
    const shownFindings = [shownEstimate, ...money, ...warnings, ...prices];
    const flags = CONFIRM_FLAGS[mode];
    if (!confirm || nothing) {
      const reminder = nothing ? [] : [finding('scan.not_confirmed', 'info', { book: slug, flags })];
      return { data, findings: [...shownFindings, ...reminder] };
    }
    if (limit === undefined) return { data, findings: [...shownFindings, finding('scan.no_budget', 'fail')] };
    if (shown !== plan.fingerprint) {
      return { data, findings: [...shownFindings, finding('scan.changed', 'fail', { book: slug, flags })] };
    }
    const fits = checkBudget({ budget_usd: limit, spent_usd: spent, in_flight_usd: inFlightUsd(store), next_usd: plan.estimate.high_usd });
    if (!fits.ok) {
      const over = finding('scan.over_budget', 'fail', { budget: usd(limit), spent: usd(spent), high: usd(plan.estimate.high_usd) });
      return { data, findings: [...shownFindings, over] };
    }
    const { host } = options;
    if (host === undefined) throw new RangeError('scan-terms --confirm needs a provider');
    // 確認過、要送出的估價，交付報告拿來對照實際花費（ADR-0123）。
    recordEstimate(store, { stage: 'scan', mode, model: plan.model.id, requests: plan.works.length, ...plan.estimate });
    const run = startRun(options, book, store, plan, host);
    if (plan.works.length > 0) options.onStart?.(mode, plan.works.length);
    if (mode === 'batch') {
      const settled = await settleOutstanding(run);
      if (settled.stop !== null) return report(run, settled.stop, warnings);
      return report(run, await drainBatches(run, settled.next), warnings);
    }
    return report(run, await drain(run), warnings);
  } finally {
    store.close();
  }
}

/** `tome scan-terms`。一本書同時只跑一個流程（ADR-0054）。 */
export function scanTerms(options: ScanOptions): Promise<PlanOutcome> {
  return withBookLock(options.home, options.slug, () => scanLocked(options));
}

/** 還沒收回的批次有幾批，翻譯與 Pass 0 分開算。`tome batch collect` 依它決定要收哪幾種。 */
export function countOutstanding(home: string, slug: string, stage: 'translate' | 'scan'): number {
  const store = openBookStore(home, slug);
  try {
    return outstandingBatches(store, stage);
  } finally {
    store.close();
  }
}

export interface ScanCollectOptions {
  readonly home: string;
  readonly slug: string;
  readonly host: LLMHost;
  readonly onRetry?: OnRetry | undefined;
  readonly onBatchWait?: BatchOptions['onBatchWait'] | undefined;
}

/** `tome batch collect` 收 Pass 0 的批次：不送新的、不要求確認（ADR-0107 第 17 項）。 */
export function collectScans(options: ScanCollectOptions): Promise<PlanOutcome> {
  const { home, slug, host } = options;
  return withBookLock(home, slug, async () => {
    const book = readBook(home, slug);
    const store = openBookStore(home, slug);
    try {
      const { plan, findings } = planScan(home, book, store, 'batch');
      if (plan === null) return { data: { book: slug }, findings };
      const run = startRun({ ...options, mode: 'batch', confirm: false }, book, store, plan, host);
      const settled = await settleOutstanding(run);
      return report(run, settled.stop, findings);
    } finally {
      store.close();
    }
  });
}
