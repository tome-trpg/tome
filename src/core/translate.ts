import { readBook, stageFingerprint, withBookLock, type Book } from './book.ts';
import { checkBudget } from './budget.ts';
import { EgressBlocked, egressRecorder, guardedFetch } from './egress/client.ts';
import { hitCount, type PiiHit, type PiiRules } from './egress/gate.ts';
import { finding, type Finding } from './findings.ts';
import { recordUsage, spentUsd } from './ledger.ts';
import {
  sendWithRetry,
  sleepSeconds,
  type Answer,
  type ApiError,
  type LLMHost,
  type LLMProvider,
  type OnRetry,
  type RequestResult,
  type Sleep,
} from './llm.ts';
import { pairedJson } from './mask.ts';
import { memoryKey, recall, remember } from './memory.ts';
import { packHash } from './pack.ts';
import { promptHash } from './prompt.ts';
import { loadProvider, usd, type ProviderModel, type RequestMode } from './provider.ts';
import {
  ESTIMATE_STAGE,
  partOfRequest,
  piiRulesOf,
  planBook,
  planRequests,
  sizeRequest,
  splitRequest,
  type BookPlan,
  type Feedback,
  type MessagesBody,
  type PlannedRequest,
  type PlanOutcome,
  type SizedRequest,
} from './request.ts';
import { failureEvent, nextState, type UnitEvent, type UnitState } from './state.ts';
import { outsideFindings, scopeCounts, type ScopeCounts } from './status.ts';
import { openBookStore, openSeriesStore, type Store } from './store.ts';
import { parseUnits } from './tags.ts';
import type { TranslationUnit } from './units.ts';
import { bookVerifyContext, matchUnits, recordProblems, settle, verifyFragment, type VerifyContext } from './verify.ts';
import { workspaceTargetLang } from './workspace.ts';

// 翻譯流程（白皮書 §5.7、§6.2、ADR-0104、ADR-0107）。即時模式一次送一個請求，批次模式在 `batch.ts`，
// 收回、驗證、記帳、拒答與截斷兩邊共用。每一步都先寫進 `book.db`，中斷後再跑一次就會接著做，
// 已驗證的單位不重付。這裡不連網，請求都經過注入的轉接層與對外出口。

const CONFIRM_FLAGS: Readonly<Record<RequestMode, string>> = {
  realtime: '--realtime --confirm',
  batch: '--confirm',
};

export interface TranslateOptions {
  readonly home: string;
  readonly slug: string;
  readonly host: LLMHost;
  readonly retryFailed: boolean;
  readonly onProgress?: (done: number, total: number) => void;
  /** 要送出請求之前，說要送幾個（ADR-0111）。沒有要送的就不叫。 */
  readonly onStart?: (mode: RequestMode, requests: number) => void;
  readonly onRetry?: OnRetry;
}

/** 一次翻譯流程要的東西，即時與批次共用。 */
export interface TranslationRun {
  readonly slug: string;
  readonly store: Store;
  readonly series: Store;
  readonly plan: BookPlan;
  /** `tome batch collect` 不花新的錢，沒有預算時是無限大。 */
  readonly budget: number;
  readonly context: VerifyContext;
  readonly llm: LLMProvider;
  readonly sleep: Sleep;
  readonly rules: PiiRules;
  readonly targetLang: string;
  readonly hashes: { readonly prompt_hash: string; readonly pack_hash: string };
  readonly byId: ReadonlyMap<string, TranslationUnit>;
  /** 閱讀順序上前一個單位的遮蔽後文字，翻譯記憶的鍵要用。 */
  readonly previous: ReadonlyMap<string, string>;
  readonly onProgress: TranslateOptions['onProgress'];
  readonly onRetry: TranslateOptions['onRetry'];
  /** 不會讓流程停下的發現，最後一起回報。 */
  readonly notes: Finding[];
  /** 這次送出了幾個請求。 */
  sent: number;
  /** 這次送出了幾批。 */
  batches: number;
}

type Run = TranslationRun;

/** `model` 平常是主翻譯模型，單位被拒之後是 `fallback_model`。 */
export interface Work {
  readonly request: PlannedRequest;
  readonly model: ProviderModel;
}

/** 一個請求做完之後：接著要送什麼，或為什麼要停下來。 */
export interface Step {
  readonly next: readonly Work[];
  readonly stop: Finding | null;
}

export const GO_ON: Step = { next: [], stop: null };

export function stopAt(stop: Finding): Step {
  return { next: [], stop };
}

export function stateOf(store: Store, unitId: string): UnitState {
  const row = store.get<{ state: UnitState }>('SELECT state FROM unit WHERE unit_id = ?', unitId);
  if (row === undefined) throw new RangeError(`no unit ${unitId}`);
  return row.state;
}

export function move(store: Store, unitId: string, ...events: readonly UnitEvent[]): void {
  const state = events.reduce((current, event) => nextState(current, event), stateOf(store, unitId));
  store.run('UPDATE unit SET state = ? WHERE unit_id = ?', state, unitId);
}

export function moveAll(store: Store, units: readonly TranslationUnit[], event: UnitEvent): void {
  store.transaction(() => {
    for (const { unit_id } of units) move(store, unit_id, event);
  });
}

/** 模型回了譯文才算，含截斷（ADR-0104 第 27 項）。 */
function countAttempt(store: Store, unitId: string): number {
  store.run('UPDATE unit SET attempts = attempts + 1 WHERE unit_id = ?', unitId);
  return store.get<{ attempts: number }>('SELECT attempts FROM unit WHERE unit_id = ?', unitId)?.attempts ?? 0;
}

function saveResponse(store: Store, unitId: string, attempt: number, text: string, model: string): void {
  store.run(
    'INSERT INTO response (unit_id, attempt, text, model, created_at) VALUES (?, ?, ?, ?, ?)',
    unitId,
    attempt,
    text,
    model,
    new Date().toISOString(),
  );
}

function memoryKeyOf(run: Run, unit: TranslationUnit): string {
  const { plan, previous, context, targetLang } = run;
  const style = plan.pack.roles.find(({ pack, name }) => `${pack}:${name}` === unit.role)?.style;
  return memoryKey(unit, previous.get(unit.unit_id) ?? null, { terms: context.terms, targetLang, style });
}

/** 驗證存下來的回應，通過的進翻譯記憶。`attempts` 不動，重跑驗證不花錢。 */
function settleReply(
  run: Run,
  unit: TranslationUnit,
  state: UnitState,
  reply: { readonly fragment: string; readonly model: string; readonly attempts: number },
): void {
  const { store, series, context, llm, hashes, slug } = run;
  const { fragment, model, attempts } = reply;
  const verdict = verifyFragment(unit, fragment, context);
  settle(store, { unit_id: unit.unit_id, state, attempts }, verdict);
  if (!verdict.passed) return;
  const entry = { fragment, model, ...hashes, sdk_version: llm.sdkVersion, book: slug };
  remember(series, memoryKeyOf(run, unit), entry, unit, context);
}

const SAVED_REPLIES = `
  SELECT u.unit_id, u.state, u.attempts, r.text, r.model
  FROM unit u
  LEFT JOIN response r ON r.id = (SELECT MAX(id) FROM response WHERE unit_id = u.unit_id AND attempt = u.attempts)
  WHERE u.state IN ('RECEIVED', 'STALE')
`;

interface SavedReply {
  readonly unit_id: string;
  readonly state: UnitState;
  readonly attempts: number;
  readonly text: string | null;
  readonly model: string | null;
}

/** 還沒收回的批次：沒有遠端 ID 的意圖紀錄也算，它可能已經送到供應商（ADR-0107 第 8 項）。 */
export const OUTSTANDING = "state IN ('intent', 'submitted')";

/** 送出去、但不在任何還沒收回的批次裡的單位。在批次裡的要等收回，不能重送（ADR-0107 第 16 項）。 */
const STRAY_IN_FLIGHT = `
  SELECT unit_id FROM unit WHERE state = 'IN_FLIGHT' AND unit_id NOT IN (
    SELECT bu.unit_id FROM batch_unit bu JOIN batch b ON b.id = bu.batch_id WHERE b.${OUTSTANDING}
  )
`;

/** 還沒收回的批次。翻譯與 Pass 0 各算各的，各自的指令收（ADR-0118）。 */
export function outstandingBatches(store: Store, stage: 'translate' | 'scan' = 'translate'): number {
  return (
    store.get<{ count: number }>(`SELECT COUNT(*) AS count FROM batch WHERE ${OUTSTANDING} AND stage = ?`, stage)?.count ?? 0
  );
}

/**
 * 上次中斷留下來的。收到的回應已經付過錢，重跑驗證就好。即時模式送出去沒有下文的要重送，
 * 批次裡的等收回（ADR-0104 第 28 項、ADR-0107 第 16 項）。
 */
export function recover(run: Run): void {
  const { store, plan, byId } = run;
  const inFlight = store.all<{ unit_id: string }>(STRAY_IN_FLIGHT);
  const replies = store.all<SavedReply>(SAVED_REPLIES);
  store.transaction(() => {
    for (const { unit_id } of inFlight) move(store, unit_id, 'requeue');
    for (const { unit_id, state, attempts, text, model } of replies) {
      const unit = byId.get(unit_id);
      if (unit === undefined) continue;
      settleReply(run, unit, state, { fragment: text ?? '', model: model ?? plan.model.id, attempts });
    }
  });
}

const STUCK_EVENT: Readonly<Partial<Record<UnitState, UnitEvent>>> = {
  BLOCKED: 'release',
  FAILED_QA: 'retry',
  REFUSED: 'retry',
};

/** 額度歸零，否則 `FAILED_QA` 再失敗一次就直接放棄（白皮書 §6.2）。 */
export function requeueStuck({ store, plan, byId }: Run): void {
  const rows = store.all<{ unit_id: string; state: UnitState }>(
    "SELECT unit_id, state FROM unit WHERE state IN ('BLOCKED', 'FAILED_QA', 'REFUSED')",
  );
  store.transaction(() => {
    for (const { unit_id, state } of rows) {
      const unit = byId.get(unit_id);
      const event = STUCK_EVENT[state];
      if (unit === undefined || event === undefined || !plan.inScope(unit)) continue;
      move(store, unit_id, event);
      store.run('UPDATE unit SET attempts = 0 WHERE unit_id = ?', unit_id);
    }
  });
}

/** 輪到這個請求才查，同一本書前面剛翻好的段落也用得到。回傳還要送的單位。 */
export function skipRemembered(run: Run, units: readonly TranslationUnit[]): TranslationUnit[] {
  const { store, series, context } = run;
  const fresh: TranslationUnit[] = [];
  for (const unit of units) {
    const { unit_id } = unit;
    if (stateOf(store, unit_id) !== 'PENDING') {
      fresh.push(unit);
      continue;
    }
    const hit = recall(series, memoryKeyOf(run, unit), unit, context);
    if (hit === null) {
      move(store, unit_id, 'queue');
      fresh.push(unit);
      continue;
    }
    store.transaction(() => {
      move(store, unit_id, 'hit');
      store.run(
        'UPDATE unit SET translation = ?, translation_pc = ? WHERE unit_id = ?',
        hit.translation,
        pairedJson(hit.paired),
        unit_id,
      );
      // 留一列，規則改了 `tome verify` 才驗得到它。
      saveResponse(store, unit_id, 0, hit.entry.fragment, hit.entry.model);
      recordProblems(store, unit_id, hit.problems);
    });
  }
  return fresh;
}

function feedbackOf(store: Store, units: readonly TranslationUnit[]): Feedback {
  return new Map(
    units.map(({ unit_id }) => {
      const rows = store.all<{ code: string; detail: string | null }>(
        "SELECT code, detail FROM issue WHERE unit_id = ? AND level = 'resend' ORDER BY id",
        unit_id,
      );
      const items = rows.map(({ code, detail }) => ({
        code,
        detail: detail === null ? {} : (JSON.parse(detail) as Record<string, string>),
      }));
      return [unit_id, items];
    }),
  );
}

/** 只留還要送的單位，組成實際送出的內容並估價。 */
export function prepareWork(run: Run, work: Work): { readonly work: Work; readonly sized: SizedRequest } | null {
  const { store, plan } = run;
  const fresh = skipRemembered(run, work.request.units);
  if (fresh.length === 0) return null;
  const request = partOfRequest(plan.units, work.request.id, fresh, plan.chapterOf);
  const sized = sizeRequest(request, {
    prefix: plan.prefix,
    terms: plan.terms,
    pack: plan.pack,
    recent: plan.recent,
    feedback: feedbackOf(store, fresh),
    model: work.model,
    provider: plan.provider.profile,
    mode: plan.mode,
  });
  return { work: { request, model: work.model }, sized };
}

function charge(run: Run, { request, model }: Work, result: Answer, limit: number | null): void {
  recordUsage(run.store, {
    request_id: result.requestId,
    model,
    mode: run.plan.mode,
    usage: result.usage,
    units: request.units.map(({ unit_id, source }) => ({ unit_id, chars: source.length })),
    stop_reason: result.stopReason,
    max_tokens: limit,
  });
}

/** 還沒收回的批次的估價上限，預算的「進行中」（ADR-0081 第 2 項）。Pass 0 的批次也算（ADR-0118）。 */
export function inFlightUsd(store: Store): number {
  return store.get<{ total: number | null }>(`SELECT SUM(high_usd) AS total FROM batch WHERE ${OUTSTANDING}`)?.total ?? 0;
}

/** 超過預算就不送（ADR-0081 第 2 項）。批次是每批檢查，即時是每個請求檢查。 */
export function overBudget(run: Run, next: number): Finding | null {
  const { store, budget, slug, plan } = run;
  const spent = spentUsd(store);
  const check = { budget_usd: budget, spent_usd: spent, in_flight_usd: inFlightUsd(store), next_usd: next };
  if (checkBudget(check).ok) return null;
  const code = plan.mode === 'batch' ? 'batch.budget_exceeded' : 'translate.budget_exceeded';
  return finding(code, 'fail', { book: slug, budget: usd(budget), spent: usd(spent), next: usd(next) });
}

/** 只記清單的第幾項，從 1 算起。命中的文字就是個資。 */
export function markBlocked(
  { store }: Run,
  units: readonly TranslationUnit[],
  hits: readonly PiiHit[],
  events: readonly UnitEvent[],
): void {
  const detail = { entries: hits.map(({ entry }) => entry + 1).join(', ') };
  store.transaction(() => {
    for (const { unit_id } of units) {
      move(store, unit_id, ...events);
      recordProblems(store, unit_id, [{ code: 'pii_hit', level: 'report', detail }]);
    }
  });
}

export function blockedStop(count: number): Step {
  return stopAt(finding('translate.blocked', 'fail', { count: String(count) }));
}

/** `status` 是 null 表示沒有收到回應，訊息裡寫成 `-`。 */
export function providerFailed({ status }: ApiError): Finding {
  return finding('translate.provider_failed', 'fail', { status: String(status ?? '-') });
}

function afterRefusal({ plan }: Run, { request, model }: Work): Work[] {
  if (request.units.length > 1) {
    return splitRequest(plan.units, request, plan.chapterOf).map((part) => ({ request: part, model }));
  }
  const { fallback } = plan;
  return fallback === null || fallback.id === model.id ? [] : [{ request, model: fallback }];
}

/** 先對半拆，找出有問題的單位，拆到底才換模型，都不行才是 `REFUSED`（ADR-0104 第 12 項）。 */
function refused(run: Run, work: Work, category: string | null): Step {
  const { store } = run;
  const next = afterRefusal(run, work);
  store.transaction(() => {
    for (const { unit_id } of work.request.units) {
      if (next.length > 0) {
        move(store, unit_id, 'requeue');
        continue;
      }
      move(store, unit_id, 'receive', 'refuse');
      const detail = category === null ? {} : { detail: { category } };
      recordProblems(store, unit_id, [{ code: 'refused', level: 'report', ...detail }]);
    }
  });
  return { next, stop: null };
}

/**
 * 同樣大小再送一次也是被截斷，所以對半拆。沒得拆就放棄（ADR-0104 第 15 項）。
 * 這裡沒有存回應，`receive` 之後要一次走到下一個狀態，留在 `RECEIVED` 續跑時沒東西可驗。
 */
function truncated({ store, plan }: Run, { request, model }: Work): Step {
  const splittable = request.units.length > 1;
  const kept = store.transaction(() =>
    request.units.filter(({ unit_id }) => {
      const attempts = countAttempt(store, unit_id);
      if (splittable && failureEvent(attempts) === 'fail') {
        move(store, unit_id, 'receive', 'fail');
        return true;
      }
      move(store, unit_id, 'receive', 'give_up');
      recordProblems(store, unit_id, [{ code: 'truncated', level: 'report' }]);
      return false;
    }),
  );
  if (kept.length === 0) return GO_ON;
  const parts = splitRequest(plan.units, { ...request, units: kept }, plan.chapterOf);
  return { next: parts.map((part) => ({ request: part, model })), stop: null };
}

/** 送出時 `<s id>` 從 1 依序編號。 */
function numbered(units: readonly TranslationUnit[]): string[] {
  return units.map((_unit, index) => String(index + 1));
}

/** 回應先存，驗證另一步：驗證出事時這筆錢不會白花（ADR-0104 第 28 項）。 */
function replied(run: Run, { request, model }: Work, text: string, ids: readonly string[]): Step {
  const { store } = run;
  const { matched } = matchUnits(parseUnits(text), ids);
  const replies = store.transaction(() =>
    request.units.map((unit, index) => {
      const fragment = matched.get(ids[index] ?? '')?.raw ?? '';
      const attempts = countAttempt(store, unit.unit_id);
      move(store, unit.unit_id, 'receive');
      if (fragment !== '') saveResponse(store, unit.unit_id, attempts, fragment, model.id);
      return { unit, reply: { fragment, model: model.id, attempts } };
    }),
  );
  store.transaction(() => {
    for (const { unit, reply } of replies) settleReply(run, unit, 'RECEIVED', reply);
  });
  return GO_ON;
}

/**
 * 模型有回覆的請求，即時與批次共用。不管回應用不用得上都先記帳，
 * 否則預算會少算已經付的錢（ADR-0104 第 43 項）。`limit` 是送出時的 `max_tokens`，跟 `stop_reason`
 * 一起記進帳本（ADR-0114）。`ids` 是每個單位在回應裡的 `<s id>`，
 * 批次收回時照送出時的位置給，中間有單位不在了也對得上（ADR-0107 第 11 項）。
 */
export function answered(
  run: Run,
  work: Work,
  result: Answer,
  limit: number | null,
  ids: readonly string[] = numbered(work.request.units),
): Step {
  charge(run, work, result, limit);
  if (result.outcome === 'refused') return refused(run, work, result.category);
  return result.outcome === 'truncated' ? truncated(run, work) : replied(run, work, result.text, ids);
}

/** 閘門擋下不是錯誤，單位要標成 `BLOCKED`。其他錯誤照樣丟出去，單位留在 `IN_FLIGHT`，下次會重送。 */
async function exchange(run: Run, body: MessagesBody): Promise<RequestResult | EgressBlocked> {
  try {
    return await sendWithRetry(run.llm, body, run.sleep, run.onRetry);
  } catch (error) {
    if (error instanceof EgressBlocked) return error;
    throw error;
  }
}

/** 依序檢查預算、送出、收回、驗證（ADR-0104 第 18 項）。個資閘門與外送紀錄在對外出口裡。 */
async function sendWork(run: Run, planned: Work): Promise<Step> {
  const { store } = run;
  const prepared = prepareWork(run, planned);
  if (prepared === null) return GO_ON;
  const { work, sized } = prepared;
  const fresh = work.request.units;
  const over = overBudget(run, sized.estimate.high_usd);
  if (over !== null) return stopAt(over);
  moveAll(store, fresh, 'send');
  run.sent += 1;
  const result = await exchange(run, sized.body);
  if (result instanceof EgressBlocked) {
    markBlocked(run, fresh, result.hits, ['requeue', 'block']);
    return blockedStop(hitCount(result.hits));
  }
  if (result.outcome === 'error') {
    moveAll(store, fresh, 'requeue');
    return stopAt(providerFailed(result));
  }
  return answered(run, work, result, sized.body.max_tokens);
}

/** `PENDING`、`QUEUED` 的單位照閱讀順序組成請求。`exclude` 是已經排好要重送的單位。 */
export function queuedWork({ store, plan }: Run, exclude: ReadonlySet<string> = new Set()): Work[] {
  const rows = store.all<{ unit_id: string }>("SELECT unit_id FROM unit WHERE state IN ('PENDING', 'QUEUED')");
  const waiting = new Set(rows.map(({ unit_id }) => unit_id).filter((id) => !exclude.has(id)));
  const wanted = (unit: TranslationUnit): boolean => waiting.has(unit.unit_id) && plan.inScope(unit);
  return planRequests(plan.units, plan.chapterOf, wanted).map((request) => ({ request, model: plan.model }));
}

/** 範圍內的數字，範圍外沒完成的另算，跟 `tome status` 用同一套算法（ADR-0114）。 */
function counts({ store, plan }: Run): ScopeCounts {
  const rows = store.all<{ unit_id: string; state: UnitState }>('SELECT unit_id, state FROM unit');
  const states = new Map(rows.map(({ unit_id, state }) => [unit_id, state]));
  return scopeCounts(
    plan.units.flatMap((unit) => {
      const state = states.get(unit.unit_id);
      return state === undefined ? [] : [{ state, kept: !unit.needs_llm, inScope: plan.inScope(unit) }];
    }),
  );
}

export function reportProgress(run: Run): void {
  if (run.onProgress === undefined) return;
  const { states, total } = counts(run);
  run.onProgress(states.DONE, total);
}

/**
 * 重送到沒有要送的單位。驗證失敗的單位回到佇列，要等這一輪做完才一起重組，
 * 對半拆的請求排在最前面，不會被併回原本的大小。`attempts` 的上限保證走得完。
 */
async function drain(run: Run): Promise<Finding | null> {
  for (let queue = queuedWork(run); queue.length > 0; queue = queuedWork(run)) {
    for (let work = queue.shift(); work !== undefined; work = queue.shift()) {
      const { next, stop } = await sendWork(run, work);
      reportProgress(run);
      if (stop !== null) return stop;
      queue.unshift(...next);
    }
  }
  return null;
}

/**
 * 數字都是範圍內的，跟估價對得起來；範圍外沒完成的另印一行，不算成「尚未完成」（ADR-0114）。
 * 不需翻譯的單位建立時就原樣完成，算在 `done` 裡（ADR-0111）。
 */
export function report(run: Run, stop: Finding | null, findings: readonly Finding[]): PlanOutcome {
  const { total, kept, states, outside } = counts(run);
  const [done, blockedUnits, failed, refusedUnits] = [states.DONE, states.BLOCKED, states.FAILED_QA, states.REFUSED];
  const stuck = blockedUnits + failed + refusedUnits;
  const left = total - done - stuck;
  const spent = spentUsd(run.store);
  const { mode, chapters } = run.plan;
  const params = {
    book: run.slug,
    done: String(done),
    kept: String(kept),
    total: String(total),
    blocked: String(blockedUnits),
    failed: String(failed),
    refused: String(refusedUnits),
    left: String(left),
    spent: usd(spent),
  };
  return {
    data: {
      book: run.slug,
      mode,
      requests: run.sent,
      ...(mode === 'batch' ? { batches: run.batches } : {}),
      done,
      kept,
      total,
      blocked: blockedUnits,
      failed,
      refused: refusedUnits,
      left,
      outside,
      chapters,
      spent_usd: spent,
    },
    findings: [
      ...(stop === null ? [] : [stop]),
      finding('translate.done', stuck > 0 ? 'fail' : 'info', params),
      ...outsideFindings(run.slug, chapters, outside),
      ...run.notes,
      ...findings,
    ],
  };
}

/** 連到供應商的轉接層，請求都經過對外出口（ADR-0039、ADR-0104 第 2 項）。 */
export function connect(home: string, book: Book, store: Store, host: LLMHost): LLMProvider {
  const { profile } = loadProvider('anthropic');
  const endpoint = host.endpoint ?? profile.endpoint;
  const fetcher = guardedFetch({
    endpoint,
    provider: profile.id,
    rules: piiRulesOf(home, book),
    record: egressRecorder(store),
  });
  return host.connect(fetcher, endpoint);
}

export interface RunSetup {
  readonly mode: RequestMode;
  /** 要花新的錢的指令要先確認估價（ADR-0103 第 14 項）。 */
  readonly confirm: boolean;
  /** 即時模式遇到還沒收回的批次要停下，否則同一段要付兩次（ADR-0107 第 16 項）。 */
  readonly refusePending: boolean;
}

/** 開資料庫、組請求、檢查確認、載入驗證規則，把流程要的東西放進 `Run`。 */
export async function withRun(
  options: TranslateOptions,
  setup: RunSetup,
  work: (run: Run, findings: readonly Finding[]) => Promise<PlanOutcome>,
): Promise<PlanOutcome> {
  const { home, slug, host, onProgress, onRetry } = options;
  const book = readBook(home, slug);
  const store = openBookStore(home, slug);
  const series = openSeriesStore(home, slug);
  try {
    if (setup.refusePending && outstandingBatches(store) > 0) {
      return { data: { book: slug }, findings: [finding('batch.pending', 'fail', { book: slug })] };
    }
    const { plan, findings } = await planBook(home, book, store, setup.mode);
    if (plan === null) return { data: { book: slug }, findings };
    const budget = book.config.budget_usd;
    const confirmed = budget !== undefined && stageFingerprint(store, ESTIMATE_STAGE) === plan.fingerprint;
    if (setup.confirm && !confirmed) {
      const unconfirmed = finding('translate.not_confirmed', 'fail', { book: slug, flags: CONFIRM_FLAGS[setup.mode] });
      return { data: { book: slug }, findings: [unconfirmed, ...findings] };
    }
    // 片語表約 6 MB，確認過才載入。
    const { context, findings: loaded } = await bookVerifyContext({ home, slug, store });
    if (context === null) return { data: { book: slug }, findings: loaded };
    const run: Run = {
      slug,
      store,
      series,
      plan,
      budget: budget ?? Number.POSITIVE_INFINITY,
      context,
      llm: connect(home, book, store, host),
      sleep: host.sleep ?? sleepSeconds,
      rules: piiRulesOf(home, book),
      targetLang: workspaceTargetLang(home),
      hashes: { prompt_hash: promptHash(plan.prefix), pack_hash: packHash(plan.pack) },
      byId: new Map(plan.units.map((unit) => [unit.unit_id, unit])),
      previous: new Map(plan.units.flatMap(({ unit_id }, index) => {
        const before = plan.units[index - 1];
        return before === undefined ? [] : [[unit_id, before.masked] as const];
      })),
      onProgress,
      onRetry,
      notes: [],
      sent: 0,
      batches: 0,
    };
    return await work(run, findings);
  } finally {
    series.close();
    store.close();
  }
}

/** 開始送之前說要送幾個請求，送出前常有一段時間沒有輸出（ADR-0111）。 */
export function announce(run: Run, options: TranslateOptions): void {
  const requests = queuedWork(run).length;
  if (requests > 0) options.onStart?.(run.plan.mode, requests);
}

/** `tome translate --realtime`。一本書同時只跑一個流程（ADR-0054）。 */
export function translateBook(options: TranslateOptions): Promise<PlanOutcome> {
  const setup = { mode: 'realtime', confirm: true, refusePending: true } as const;
  return withBookLock(options.home, options.slug, () =>
    withRun(options, setup, async (run, findings) => {
      recover(run);
      if (options.retryFailed) requeueStuck(run);
      announce(run, options);
      return report(run, await drain(run), findings);
    }),
  );
}
