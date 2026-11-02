import { readBook, stageFingerprint, withBookLock } from './book.ts';
import { checkBudget } from './budget.ts';
import { EgressBlocked, egressRecorder, guardedFetch } from './egress/client.ts';
import { finding, type Finding } from './findings.ts';
import { recordUsage, spentUsd, type Usage } from './ledger.ts';
import { sendWithRetry, type LLMHost, type LLMProvider, type RequestResult, type Sleep } from './llm.ts';
import { memoryKey, recall, remember } from './memory.ts';
import { packHash } from './pack.ts';
import { promptHash } from './prompt.ts';
import type { ProviderModel, RequestMode } from './provider.ts';
import {
  ESTIMATE_STAGE,
  partOfRequest,
  piiRulesOf,
  planBook,
  planRequests,
  sizeRequest,
  splitRequest,
  usd,
  type BookPlan,
  type Feedback,
  type MessagesBody,
  type PlannedRequest,
  type PlanOutcome,
} from './request.ts';
import { failureEvent, nextState, type UnitEvent, type UnitState } from './state.ts';
import { openBookStore, openSeriesStore, type Store } from './store.ts';
import { parseUnits } from './tags.ts';
import type { TranslationUnit } from './units.ts';
import { bookVerifyContext, matchUnits, recordProblems, settle, verifyFragment, type VerifyContext } from './verify.ts';
import { workspaceTargetLang } from './workspace.ts';

// 即時模式的翻譯流程（白皮書 §5.7、§6.2、ADR-0104）。一次送一個請求，每一步都先寫進 `book.db`，
// 中斷後再跑一次就會接著做，已驗證的單位不重付。這裡不連網，請求都經過注入的轉接層與對外出口。

const MODE: RequestMode = 'realtime';
const CONFIRM_FLAGS = '--realtime --confirm';

export interface TranslateOptions {
  readonly home: string;
  readonly slug: string;
  readonly host: LLMHost;
  readonly retryFailed: boolean;
  readonly onProgress?: (done: number, total: number) => void;
}

interface Run {
  readonly slug: string;
  readonly store: Store;
  readonly series: Store;
  readonly plan: BookPlan;
  readonly budget: number;
  readonly context: VerifyContext;
  readonly llm: LLMProvider;
  readonly sleep: Sleep | undefined;
  readonly targetLang: string;
  readonly hashes: { readonly prompt_hash: string; readonly pack_hash: string };
  readonly byId: ReadonlyMap<string, TranslationUnit>;
  /** 閱讀順序上前一個單位的遮蔽後文字，翻譯記憶的鍵要用。 */
  readonly previous: ReadonlyMap<string, string>;
  readonly onProgress: TranslateOptions['onProgress'];
  /** 這次送出了幾個請求。 */
  sent: number;
}

/** `model` 平常是主翻譯模型，單位被拒之後是 `fallback_model`。 */
interface Work {
  readonly request: PlannedRequest;
  readonly model: ProviderModel;
}

/** 一個請求做完之後：接著要送什麼，或為什麼要停下來。 */
interface Step {
  readonly next: readonly Work[];
  readonly stop: Finding | null;
}

const GO_ON: Step = { next: [], stop: null };

function stopAt(stop: Finding): Step {
  return { next: [], stop };
}

function stateOf(store: Store, unitId: string): UnitState {
  const row = store.get<{ state: UnitState }>('SELECT state FROM unit WHERE unit_id = ?', unitId);
  if (row === undefined) throw new RangeError(`no unit ${unitId}`);
  return row.state;
}

function move(store: Store, unitId: string, ...events: readonly UnitEvent[]): void {
  const state = events.reduce((current, event) => nextState(current, event), stateOf(store, unitId));
  store.run('UPDATE unit SET state = ? WHERE unit_id = ?', state, unitId);
}

function moveAll(store: Store, units: readonly TranslationUnit[], event: UnitEvent): void {
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

/** 上次中斷留下來的。收到的回應已經付過錢，重跑驗證就好。送出去沒有下文的要重送（ADR-0104 第 28 項）。 */
function recover(run: Run): void {
  const { store, plan, byId } = run;
  const inFlight = store.all<{ unit_id: string }>("SELECT unit_id FROM unit WHERE state = 'IN_FLIGHT'");
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
function requeueStuck({ store, plan, byId }: Run): void {
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
function skipRemembered(run: Run, units: readonly TranslationUnit[]): TranslationUnit[] {
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
      store.run('UPDATE unit SET translation = ? WHERE unit_id = ?', hit.translation, unit_id);
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

function charge(run: Run, { request, model }: Work, requestId: string, usage: Usage): void {
  recordUsage(run.store, {
    request_id: requestId,
    model,
    mode: MODE,
    usage,
    units: request.units.map(({ unit_id, source }) => ({ unit_id, chars: source.length })),
  });
}

function blocked({ store }: Run, units: readonly TranslationUnit[], error: EgressBlocked): Step {
  // 只記清單的第幾項，從 1 算起。命中的文字就是個資。
  const detail = { entries: error.hits.map(({ entry }) => entry + 1).join(', ') };
  store.transaction(() => {
    for (const { unit_id } of units) {
      move(store, unit_id, 'requeue', 'block');
      recordProblems(store, unit_id, [{ code: 'pii_hit', level: 'report', detail }]);
    }
  });
  return stopAt(finding('translate.blocked', 'fail', error.params));
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

/** 回應先存，驗證另一步：驗證出事時這筆錢不會白花（ADR-0104 第 28 項）。 */
function replied(run: Run, { request, model }: Work, text: string): Step {
  const { store } = run;
  const ids = request.units.map((_unit, index) => String(index + 1));
  const { matched } = matchUnits(parseUnits(text), ids);
  const replies = store.transaction(() =>
    request.units.map((unit, index) => {
      const fragment = matched.get(String(index + 1))?.raw ?? '';
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

/** 閘門擋下不是錯誤，單位要標成 `BLOCKED`。其他錯誤照樣丟出去，單位留在 `IN_FLIGHT`，下次會重送。 */
async function exchange(run: Run, body: MessagesBody): Promise<RequestResult | EgressBlocked> {
  try {
    return await sendWithRetry(run.llm, body, run.sleep);
  } catch (error) {
    if (error instanceof EgressBlocked) return error;
    throw error;
  }
}

/** 依序檢查預算、送出、收回、驗證（ADR-0104 第 18 項）。個資閘門與外送紀錄在對外出口裡。 */
async function sendWork(run: Run, work: Work): Promise<Step> {
  const { store, plan, slug } = run;
  const { model } = work;
  const fresh = skipRemembered(run, work.request.units);
  if (fresh.length === 0) return GO_ON;
  const request = partOfRequest(plan.units, work.request.id, fresh, plan.chapterOf);
  const sized = sizeRequest(request, {
    prefix: plan.prefix,
    terms: plan.terms,
    pack: plan.pack,
    feedback: feedbackOf(store, fresh),
    model,
    provider: plan.provider.profile,
    mode: MODE,
  });
  const spent = spentUsd(store);
  const next = sized.estimate.high_usd;
  if (!checkBudget({ budget_usd: run.budget, spent_usd: spent, in_flight_usd: 0, next_usd: next }).ok) {
    const params = { book: slug, budget: usd(run.budget), spent: usd(spent), next: usd(next) };
    return stopAt(finding('translate.budget_exceeded', 'fail', params));
  }
  moveAll(store, fresh, 'send');
  run.sent += 1;
  const result = await exchange(run, sized.body);
  if (result instanceof EgressBlocked) return blocked(run, fresh, result);
  if (result.outcome === 'error') {
    moveAll(store, fresh, 'requeue');
    return stopAt(finding('translate.provider_failed', 'fail', { status: String(result.status ?? '-') }));
  }
  const sent = { request, model };
  // 不管回應用不用得上都先記帳，否則預算會少算已經付的錢（ADR-0104 第 43 項）。
  charge(run, sent, result.requestId, result.usage);
  if (result.outcome === 'refused') return refused(run, sent, result.category);
  return result.outcome === 'truncated' ? truncated(run, sent) : replied(run, sent, result.text);
}

function queuedWork({ store, plan }: Run): Work[] {
  const rows = store.all<{ unit_id: string }>("SELECT unit_id FROM unit WHERE state IN ('PENDING', 'QUEUED')");
  const waiting = new Set(rows.map(({ unit_id }) => unit_id));
  const wanted = (unit: TranslationUnit): boolean => waiting.has(unit.unit_id) && plan.inScope(unit);
  return planRequests(plan.units, plan.chapterOf, wanted).map((request) => ({ request, model: plan.model }));
}

function unitCounts({ store }: Run): (state: UnitState) => number {
  const rows = store.all<{ state: UnitState; count: number }>('SELECT state, COUNT(*) AS count FROM unit GROUP BY state');
  const counts = new Map(rows.map(({ state, count }) => [state, count]));
  return (state) => counts.get(state) ?? 0;
}

function totalUnits({ store }: Run): number {
  return store.get<{ count: number }>('SELECT COUNT(*) AS count FROM unit')?.count ?? 0;
}

/**
 * 重送到沒有要送的單位。驗證失敗的單位回到佇列，要等這一輪做完才一起重組，
 * 對半拆的請求排在最前面，不會被併回原本的大小。`attempts` 的上限保證走得完。
 */
async function drain(run: Run): Promise<Finding | null> {
  const total = totalUnits(run);
  for (let queue = queuedWork(run); queue.length > 0; queue = queuedWork(run)) {
    for (let work = queue.shift(); work !== undefined; work = queue.shift()) {
      const { next, stop } = await sendWork(run, work);
      run.onProgress?.(unitCounts(run)('DONE'), total);
      if (stop !== null) return stop;
      queue.unshift(...next);
    }
  }
  return null;
}

function report(run: Run, stop: Finding | null, findings: readonly Finding[]): PlanOutcome {
  const of = unitCounts(run);
  const total = totalUnits(run);
  const [done, blockedUnits, failed, refusedUnits] = [of('DONE'), of('BLOCKED'), of('FAILED_QA'), of('REFUSED')];
  const stuck = blockedUnits + failed + refusedUnits;
  const left = total - done - stuck;
  const spent = spentUsd(run.store);
  const params = {
    done: String(done),
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
      mode: MODE,
      requests: run.sent,
      done,
      total,
      blocked: blockedUnits,
      failed,
      refused: refusedUnits,
      left,
      spent_usd: spent,
    },
    findings: [...(stop === null ? [] : [stop]), finding('translate.done', stuck > 0 ? 'fail' : 'info', params), ...findings],
  };
}

async function translateLocked(options: TranslateOptions): Promise<PlanOutcome> {
  const { home, slug, host, retryFailed, onProgress } = options;
  const book = readBook(home, slug);
  const store = openBookStore(home, slug);
  const series = openSeriesStore(home, slug);
  try {
    const { plan, findings } = await planBook(home, book, store, MODE);
    if (plan === null) return { data: { book: slug }, findings };
    const budget = book.config.budget_usd;
    if (budget === undefined || stageFingerprint(store, ESTIMATE_STAGE) !== plan.fingerprint) {
      const unconfirmed = finding('translate.not_confirmed', 'fail', { book: slug, flags: CONFIRM_FLAGS });
      return { data: { book: slug }, findings: [unconfirmed, ...findings] };
    }
    // 片語表約 6 MB，確認過才載入。
    const { context, findings: loaded } = await bookVerifyContext({ home, slug });
    if (context === null) return { data: { book: slug }, findings: loaded };
    const { profile } = plan.provider;
    const fetcher = guardedFetch({
      endpoint: host.endpoint ?? profile.endpoint,
      provider: profile.id,
      rules: piiRulesOf(home, book),
      record: egressRecorder(store),
    });
    const run: Run = {
      slug,
      store,
      series,
      plan,
      budget,
      context,
      llm: host.connect(fetcher),
      sleep: host.sleep,
      targetLang: workspaceTargetLang(home),
      hashes: { prompt_hash: promptHash(plan.prefix), pack_hash: packHash(plan.pack) },
      byId: new Map(plan.units.map((unit) => [unit.unit_id, unit])),
      previous: new Map(plan.units.flatMap(({ unit_id }, index) => {
        const before = plan.units[index - 1];
        return before === undefined ? [] : [[unit_id, before.masked] as const];
      })),
      onProgress,
      sent: 0,
    };
    recover(run);
    if (retryFailed) requeueStuck(run);
    return report(run, await drain(run), findings);
  } finally {
    series.close();
    store.close();
  }
}

/** `tome translate --realtime`。一本書同時只跑一個流程（ADR-0054）。 */
export function translateBook(options: TranslateOptions): Promise<PlanOutcome> {
  return withBookLock(options.home, options.slug, () => translateLocked(options));
}
