import { randomBytes } from 'node:crypto';
import { readBook, withBookLock } from './book.ts';
import { EgressBlocked } from './egress/client.ts';
import { hitCount, scanBody } from './egress/gate.ts';
import { finding, type Finding } from './findings.ts';
import {
  RETRYABLE_BATCH_ERRORS,
  isApiError,
  retryableSubmit,
  submitRejected,
  withRetry,
  type ApiError,
  type BatchOutcome,
  type LLMHost,
  type LLMProvider,
  type OnRetry,
  type RemoteBatch,
  type Sleep,
} from './llm.ts';
import { findModel } from './provider.ts';
import { maxTokens, planBatches, type PlanOutcome } from './request.ts';
import { openBookStore, type Store } from './store.ts';
import {
  GO_ON,
  OUTSTANDING,
  announce,
  answered,
  blockedStop,
  connect,
  markBlocked,
  move,
  moveAll,
  outstandingBatches,
  overBudget,
  prepareWork,
  providerFailed,
  queuedWork,
  recover,
  report,
  reportProgress,
  requeueStuck,
  stateOf,
  stopAt,
  withRun,
  type Step,
  type TranslationRun as Run,
  type TranslateOptions,
  type Work,
} from './translate.ts';
import type { TranslationUnit } from './units.ts';

// 批次模式（白皮書 §5.7、§6.1、ADR-0033、ADR-0054、ADR-0107）。一次一批：送出、等結束、收回、驗證、
// 刪除遠端資料，再送下一批。送出前先寫意圖紀錄，中斷之後再跑一次就認回批次接著做，已經付費的結果不重送。
// 呼叫 Batches API 的轉接層在 brief 022 才有，019 只有測試注入。

/** 多久查一次。是提案，官方範例每 60 秒查一次（ADR-0107 第 12 項）。 */
export const POLL_SECONDS = 60;
/** 本機與伺服器的時鐘差。是提案（ADR-0107 第 9 項）。 */
export const CLOCK_SKEW_MS = 10 * 60 * 1000;
const NONCE_BYTES = 8;
/** 結果裡找不到這個請求時記成這個種類，當成可以重送的錯誤（ADR-0107 第 13 項）。 */
const MISSING = 'missing';

export interface BatchOptions extends TranslateOptions {
  /** 用本機的批次編號，中斷之後再跑也是同一個號碼。 */
  readonly onBatchSent?: (batch: number, requests: number) => void;
  readonly onBatchWait?: (batch: number, minutes: number) => void;
}

export interface BatchRow {
  readonly id: number;
  readonly nonce: string;
  readonly remote_id: string | null;
  readonly state: 'intent' | 'submitted' | 'collected' | 'abandoned';
  readonly requests: number;
  readonly created_at: string;
}

interface BatchRun {
  readonly run: Run;
  readonly options: BatchOptions;
}

/** 批次的共用動作要的東西。翻譯與 Pass 0 的流程都有（ADR-0118）。 */
export interface BatchHost {
  readonly store: Store;
  readonly llm: LLMProvider;
  readonly sleep: Sleep;
  readonly onRetry: OnRetry | undefined;
  readonly notes: Finding[];
}

export function customId(nonce: string, index: number): string {
  return `tome-${nonce}-${index + 1}`;
}

/** 翻譯的批次。Pass 0 的批次由 `tome scan-terms` 收（ADR-0118）。 */
function nextOutstanding(store: Store): BatchRow | undefined {
  return store.get<BatchRow>(`SELECT * FROM batch WHERE ${OUTSTANDING} AND stage = 'translate' ORDER BY id LIMIT 1`);
}

function outstandingRows(store: Store): BatchRow[] {
  return store.all<BatchRow>(`SELECT * FROM batch WHERE ${OUTSTANDING} ORDER BY id`);
}

function totalOf({ counts }: RemoteBatch): number {
  return counts.processing + counts.succeeded + counts.errored + counts.canceled + counts.expired;
}

interface SentUnit {
  readonly unit: TranslationUnit;
  /** 送出時在請求裡的位置，回應的 `<s id>` 是它加 1（ADR-0107 第 11 項）。 */
  readonly position: number;
}

interface SentRequest {
  readonly customId: string;
  readonly model: string;
  /** 計畫裡已經沒有的單位不在這裡，其他單位的位置照送出時的。 */
  readonly units: readonly SentUnit[];
  /** 送出時有幾個單位。 */
  readonly sent: number;
}

/** 依送出的順序，單位依在請求裡的位置。 */
function sentRequests({ store, byId }: Run, batchId: number): SentRequest[] {
  const rows = store.all<{ custom_id: string; position: number; unit_id: string; model: string }>(
    'SELECT custom_id, position, unit_id, model FROM batch_unit WHERE batch_id = ? ORDER BY rowid',
    batchId,
  );
  const requests = new Map<string, { model: string; units: SentUnit[]; sent: number }>();
  for (const { custom_id, position, unit_id, model } of rows) {
    const request = requests.get(custom_id) ?? { model, units: [], sent: 0 };
    requests.set(custom_id, request);
    request.sent += 1;
    const unit = byId.get(unit_id);
    if (unit !== undefined) request.units.push({ unit, position });
  }
  return [...requests].map(([id, { model, units, sent }]) => ({ customId: id, model, units, sent }));
}

/** 還在 `IN_FLIGHT` 的。估價確認之後內容改了，文字變了的單位已經回到起點，不能再套用舊的回應。 */
function liveUnits(store: Store, { units }: SentRequest): SentUnit[] {
  return units.filter(({ unit }) => stateOf(store, unit.unit_id) === 'IN_FLIGHT');
}

function inFlightUnits(run: Run, batchId: number): TranslationUnit[] {
  return sentRequests(run, batchId).flatMap((sent) => liveUnits(run.store, sent).map(({ unit }) => unit));
}

/** 沒有送到供應商，或結果拿不回來：單位放回佇列。 */
function giveBack(run: Run, batchId: number, state: 'abandoned' | 'collected'): void {
  const { store } = run;
  const units = inFlightUnits(run, batchId);
  store.transaction(() => {
    store.run('UPDATE batch SET state = ?, collected_at = ? WHERE id = ?', state, new Date().toISOString(), batchId);
    for (const { unit_id } of units) move(store, unit_id, 'requeue');
  });
}

/**
 * 刪除收到 404 當成已經刪除，不再重試：上次其實刪掉了、只是沒收到回應時，之後每次都會是 404。
 * 404 也可能是換了金鑰，資料還在原本的帳號，所以照樣警告（ADR-0109 第 24 項）。
 */
export function remove(run: BatchHost, remoteId: string): Promise<void> {
  return withRetry(() => run.llm.deleteRemote(remoteId), run.sleep, undefined, run.onRetry).then((error) => {
    if (error !== null && error.status !== 404) {
      run.notes.push(finding('batch.delete_failed', 'warn', { id: remoteId }));
      return;
    }
    if (error !== null) run.notes.push(finding('batch.delete_not_found', 'warn', { id: remoteId }));
    run.store.run('UPDATE batch SET deleted_at = ? WHERE remote_id = ?', new Date().toISOString(), remoteId);
  });
}

/** 等到整批結束。沒有逾時，批次最晚在建立後 24 小時結束（ADR-0107 第 12 項）。 */
export async function waitFor(
  run: BatchHost,
  onWait: BatchOptions['onBatchWait'],
  row: BatchRow,
  remoteId: string,
): Promise<RemoteBatch | Finding> {
  let waited = 0;
  for (;;) {
    const remote = await withRetry(() => run.llm.pollBatch(remoteId), run.sleep, undefined, run.onRetry);
    if (isApiError(remote)) return providerFailed(remote);
    if (remote.status === 'ended') return remote;
    await run.sleep(POLL_SECONDS);
    waited += POLL_SECONDS;
    onWait?.(row.id, Math.round(waited / 60));
  }
}

function failureType(result: BatchOutcome): string {
  if (result.outcome === 'errored') return result.type;
  return result.outcome;
}

interface Collected extends Step {
  /** 結果的 `custom_id` 對不上，不是這本書的批次（ADR-0107 第 9 項）。 */
  readonly foreign: boolean;
}

const FOREIGN: Collected = { next: [], stop: null, foreign: true };

/**
 * 等結束、收回、套用、刪除。單位還在 `IN_FLIGHT` 的請求才套用，中斷在收回到一半時，
 * 再下載一次結果就接得上（ADR-0107 第 11 項）。`unverified` 是認回來、還沒確認的批次。
 */
async function collect(batchRun: BatchRun, row: BatchRow, remoteId: string, unverified: boolean): Promise<Collected> {
  const { run } = batchRun;
  const { store, plan } = run;
  const ended = await waitFor(run, batchRun.options.onBatchWait, row, remoteId);
  if ('level' in ended) return { ...stopAt(ended), foreign: false };
  if (ended.archivedAt !== null) {
    if (unverified) return FOREIGN;
    giveBack(run, row.id, 'collected');
    run.notes.push(finding('batch.archived', 'warn', { id: remoteId }));
    await remove(run, remoteId);
    return { ...GO_ON, foreign: false };
  }
  const items = await withRetry(() => run.llm.collectBatch(remoteId), run.sleep, undefined, run.onRetry);
  if (isApiError(items)) return { ...stopAt(providerFailed(items)), foreign: false };
  const prefix = `tome-${row.nonce}-`;
  if (unverified && (items.length === 0 || items.some(({ customId: id }) => !id.startsWith(prefix)))) return FOREIGN;
  const results = new Map(items.map(({ customId: id, result }) => [id, result]));

  const next: Work[] = [];
  const failures: string[] = [];
  let applied = 0;
  let succeeded = 0;
  let failed = 0;
  let fatal = false;
  for (const sent of sentRequests(run, row.id)) {
    const live = liveUnits(store, sent);
    // 已經套用過：中斷之後再下載一次結果時跳過（ADR-0107 第 11 項）。
    if (live.length === 0) continue;
    applied += 1;
    const units = live.map(({ unit }) => unit);
    const result: BatchOutcome = results.get(sent.customId) ?? { outcome: 'errored', type: MISSING };
    if (result.outcome === 'ok' || result.outcome === 'truncated' || result.outcome === 'refused') {
      succeeded += 1;
      const model = findModel(plan.provider.profile, sent.model);
      const work = { request: { id: sent.customId, units, context: '' }, model };
      // 照送出時的位置對 `<s id>`，中間有單位不在了，後面的單位才不會拿到別人的譯文。
      const ids = live.map(({ position }) => String(position + 1));
      // 送出時的 `max_tokens` 沒有存，單位都還在才算得回來（ADR-0114）。
      const limit = live.length === sent.sent ? maxTokens(plan.provider.profile, model, units) : null;
      next.push(...answered(run, work, result, limit, ids).next);
      continue;
    }
    // 不收費，單位放回佇列，下一批重送（ADR-0107 第 13 項）。
    failed += 1;
    const type = failureType(result);
    if (!failures.includes(type)) failures.push(type);
    if (result.outcome === 'errored' && type !== MISSING && !RETRYABLE_BATCH_ERRORS.includes(type)) fatal = true;
    moveAll(store, units, 'requeue');
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
  // 不在同樣的錯誤上一直繞：重送也會失敗，或一整批沒有成功的結果（ADR-0107 第 13、14 項）。
  if (applied > 0 && (fatal || succeeded === 0)) {
    const stop = finding('batch.errored', 'fail', { count: String(failed), type: failures.join(', ') });
    return { next, stop, foreign: false };
  }
  return { next, stop: null, foreign: false };
}

/**
 * 沒有遠端 ID 的意圖紀錄：從最新的批次往回列，到意圖之前減掉時鐘差為止，
 * 找這本書還沒記錄過、請求總數相同的批次，取最早的（ADR-0107 第 9 項）。回傳認回的遠端 ID。
 */
export async function findCandidate(
  run: BatchHost,
  row: BatchRow,
  rejected: ReadonlySet<string>,
): Promise<string | null | Finding> {
  const { store } = run;
  const since = Date.parse(row.created_at) - CLOCK_SKEW_MS;
  const known = new Set(
    store.all<{ remote_id: string }>('SELECT remote_id FROM batch WHERE remote_id IS NOT NULL').map(({ remote_id }) => remote_id),
  );
  let best: RemoteBatch | null = null;
  let after: string | null = null;
  for (;;) {
    const page = await withRetry(() => run.llm.listBatches(after), run.sleep, undefined, run.onRetry);
    if (isApiError(page)) return providerFailed(page);
    let older = false;
    for (const remote of page.batches) {
      if (Date.parse(remote.createdAt) < since) {
        older = true;
        break;
      }
      if (known.has(remote.id) || rejected.has(remote.id) || totalOf(remote) !== row.requests) continue;
      if (best === null || Date.parse(remote.createdAt) < Date.parse(best.createdAt)) best = remote;
    }
    after = page.next;
    if (older || after === null) return best?.id ?? null;
  }
}

/** 上次刪除失敗的，這次再試（ADR-0107 第 15 項）。翻譯與 Pass 0 的批次都算。 */
export async function retryDeletes(run: BatchHost): Promise<void> {
  const rows = run.store.all<{ remote_id: string }>(
    "SELECT remote_id FROM batch WHERE state = 'collected' AND remote_id IS NOT NULL AND deleted_at IS NULL ORDER BY id",
  );
  for (const { remote_id } of rows) await remove(run, remote_id);
}

/** 先處理上次留下來的批次，任何模式都一樣（ADR-0107 第 16 項）。回傳收回後要重送的請求。 */
async function settleOutstanding(batchRun: BatchRun): Promise<Step> {
  const { run } = batchRun;
  const { store } = run;
  await retryDeletes(run);
  const rejected = new Set<string>();
  const carry: Work[] = [];
  for (let row = nextOutstanding(store); row !== undefined; row = nextOutstanding(store)) {
    let remoteId = row.remote_id;
    const unverified = row.state === 'intent';
    if (unverified && (remoteId === null || rejected.has(remoteId))) {
      const found = await findCandidate(run, row, rejected);
      if (found !== null && typeof found !== 'string') return stopAt(found);
      if (found === null) {
        giveBack(run, row.id, 'abandoned');
        run.notes.push(finding('batch.not_sent', 'info', { requests: String(row.requests) }));
        continue;
      }
      // 只記遠端 ID，確認之前仍是意圖：`tome batch cancel` 不會取消到別本書的批次。
      store.run('UPDATE batch SET remote_id = ? WHERE id = ?', found, row.id);
      remoteId = found;
    }
    if (remoteId === null) throw new RangeError(`batch ${row.id} has no remote id`);
    const collected = await collect(batchRun, row, remoteId, unverified);
    if (collected.foreign) {
      // 不是這本書的：不採用，也不刪除，再找下一個候選。
      rejected.add(remoteId);
      store.run('UPDATE batch SET remote_id = NULL WHERE id = ?', row.id);
      continue;
    }
    carry.push(...collected.next);
    if (collected.stop !== null) return { next: carry, stop: collected.stop };
  }
  return { next: carry, stop: null };
}

/** 個資閘門逐一掃描每個請求，命中就整批不送（ADR-0107 第 7 項）。 */
function gate(run: Run, prepared: readonly { readonly work: Work; readonly sized: { readonly body: unknown } }[]): Step | null {
  let count = 0;
  for (const { work, sized } of prepared) {
    const hits = scanBody(JSON.stringify(sized.body), run.rules);
    if (hits.length === 0) continue;
    count += hitCount(hits);
    markBlocked(run, work.request.units, hits, ['block']);
  }
  return count === 0 ? null : blockedStop(count);
}

/** 依序檢查預算與個資閘門、寫意圖紀錄、送出、等結束、收回（ADR-0107 第 6 到 8 項）。 */
async function sendBatch(batchRun: BatchRun, works: readonly Work[]): Promise<Step> {
  const { run, options } = batchRun;
  const { store } = run;
  const prepared = works.flatMap((work) => prepareWork(run, work) ?? []);
  if (prepared.length === 0) return GO_ON;
  const high = prepared.reduce((total, { sized }) => total + sized.estimate.high_usd, 0);
  const over = overBudget(run, high);
  if (over !== null) return stopAt(over);
  const blocked = gate(run, prepared);
  if (blocked !== null) return blocked;

  const nonce = randomBytes(NONCE_BYTES).toString('hex');
  const createdAt = new Date().toISOString();
  const units = prepared.flatMap(({ work }) => work.request.units);
  // 意圖、對應與 `IN_FLIGHT` 同一個交易，之後才呼叫建立（ADR-0054 第 4 項、ADR-0107 第 8 項）。
  const row = store.transaction((): BatchRow => {
    store.run(
      "INSERT INTO batch (nonce, state, requests, high_usd, created_at) VALUES (?, 'intent', ?, ?, ?)",
      nonce,
      prepared.length,
      high,
      createdAt,
    );
    const { id } = store.get<{ id: number }>('SELECT last_insert_rowid() AS id') ?? { id: 0 };
    prepared.forEach(({ work }, index) => {
      work.request.units.forEach(({ unit_id }, position) => {
        store.run(
          'INSERT INTO batch_unit (batch_id, custom_id, position, unit_id, model) VALUES (?, ?, ?, ?, ?)',
          id,
          customId(nonce, index),
          position,
          unit_id,
          work.model.id,
        );
      });
    });
    for (const { unit_id } of units) move(store, unit_id, 'send');
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
    // 對外出口是最後一關，在那裡才擋下時整批的單位都標成 `BLOCKED`。
    store.run("UPDATE batch SET state = 'abandoned' WHERE id = ?", row.id);
    markBlocked(run, units, error.hits, ['requeue', 'block']);
    return blockedStop(hitCount(error.hits));
  }
  if (isApiError(remote)) {
    // 4xx 代表沒有建立。5xx 與沒有收到回應就不知道，留著意圖紀錄，下次執行時去認（ADR-0108）。
    if (submitRejected(remote.status)) giveBack(run, row.id, 'abandoned');
    return stopAt(providerFailed(remote));
  }
  store.run(
    "UPDATE batch SET remote_id = ?, state = 'submitted', submitted_at = ?, expires_at = ? WHERE id = ?",
    remote.id,
    new Date().toISOString(),
    remote.expiresAt,
    row.id,
  );
  options.onBatchSent?.(row.id, prepared.length);
  const collected = await collect(batchRun, { ...row, state: 'submitted', remote_id: remote.id }, remote.id, false);
  return { next: collected.next, stop: collected.stop };
}

function charsOf(works: readonly Work[]): number {
  return works.reduce((total, { request }) => total + request.units.reduce((sum, { source }) => sum + source.length, 0), 0);
}

/**
 * 一次一批，直到沒有要送的單位（ADR-0107 第 4 項）。對半拆與換模型的請求照原樣排在下一批最前面，
 * 再放佇列裡的單位照閱讀順序組的請求，一起受字元上限（ADR-0107 第 5 項）。
 */
async function drainBatches(batchRun: BatchRun, carried: readonly Work[]): Promise<Finding | null> {
  const { run } = batchRun;
  let carry = carried;
  for (;;) {
    const exclude = new Set(carry.flatMap(({ request }) => request.units.map(({ unit_id }) => unit_id)));
    const queued = queuedWork(run, exclude).map(({ request }) => request);
    const [first = []] = planBatches(queued, run.plan.chapterOf, undefined, charsOf(carry));
    const works = [...carry, ...first.map((request) => ({ request, model: run.plan.model }))];
    if (works.length === 0) return null;
    const { next, stop } = await sendBatch(batchRun, works);
    reportProgress(run);
    if (stop !== null) return stop;
    carry = next;
  }
}

/** `tome translate`（批次模式）。一本書同時只跑一個流程（ADR-0054）。 */
export function translateInBatches(options: BatchOptions): Promise<PlanOutcome> {
  const setup = { mode: 'batch', confirm: true, refusePending: false } as const;
  return withBookLock(options.home, options.slug, () =>
    withRun(options, setup, async (run, findings) => {
      const batchRun = { run, options };
      recover(run);
      const settled = await settleOutstanding(batchRun);
      if (settled.stop !== null) return report(run, settled.stop, findings);
      if (options.retryFailed) requeueStuck(run);
      announce(run, options);
      return report(run, await drainBatches(batchRun, settled.next), findings);
    }),
  );
}

/**
 * `tome batch collect`：收回沒收回的批次，不送新的。不要求確認估價，不花新的錢，
 * 估價確認之後內容又改了，也還能把已經付費的結果收回來（ADR-0107 第 17 項）。
 */
export function collectBatches(options: BatchOptions): Promise<PlanOutcome> {
  const setup = { mode: 'batch', confirm: false, refusePending: false } as const;
  return withBookLock(options.home, options.slug, () =>
    withRun(options, setup, async (run, findings) => {
      recover(run);
      if (outstandingBatches(run.store) === 0) run.notes.push(finding('batch.none', 'info'));
      const settled = await settleOutstanding({ run, options });
      return report(run, settled.stop, findings);
    }),
  );
}

export interface BatchCommandOptions {
  readonly home: string;
  readonly slug: string;
  readonly host: LLMHost;
  readonly onRetry?: OnRetry;
}

/** 沒有遠端 ID 或還沒確認的批次：不知道是不是這本書的，不查也不取消（ADR-0107 第 9 項）。 */
function unconfirmed(row: BatchRow): Finding {
  return finding('batch.unconfirmed', 'info', { requests: String(row.requests) });
}

async function withBatches(
  options: BatchCommandOptions,
  each: (llm: LLMProvider, row: BatchRow & { readonly remote_id: string }) => Promise<{ finding: Finding; data: unknown }>,
): Promise<PlanOutcome> {
  const { home, slug, host } = options;
  return withBookLock(home, slug, async () => {
    const book = readBook(home, slug);
    const store = openBookStore(home, slug);
    try {
      const rows = outstandingRows(store);
      if (rows.length === 0) return { data: { book: slug, batches: [] }, findings: [finding('batch.none', 'info')] };
      const llm = connect(home, book, store, host);
      const findings: Finding[] = [];
      const batches: unknown[] = [];
      for (const row of rows) {
        const { remote_id: remoteId } = row;
        if (row.state === 'intent' || remoteId === null) {
          findings.push(unconfirmed(row));
          batches.push({ id: null, state: row.state, requests: row.requests });
          continue;
        }
        const result = await each(llm, { ...row, remote_id: remoteId });
        findings.push(result.finding);
        batches.push(result.data);
        if (result.finding.level === 'fail') break;
      }
      return { data: { book: slug, batches }, findings };
    } finally {
      store.close();
    }
  });
}

function batchData(remote: RemoteBatch): Readonly<Record<string, unknown>> {
  return { id: remote.id, status: remote.status, counts: remote.counts, expires_at: remote.expiresAt };
}

/** `tome batch status`：查供應商那邊的狀態，不等待，不改本機狀態（ADR-0107 第 17 項）。 */
export function batchStatus(options: BatchCommandOptions): Promise<PlanOutcome> {
  return withBatches(options, async (llm, row) => {
    const remote = await withRetry(() => llm.pollBatch(row.remote_id), options.host.sleep, undefined, options.onRetry);
    if (isApiError(remote)) return { finding: providerFailed(remote), data: { id: row.remote_id } };
    const params = { id: remote.id, book: options.slug };
    if (remote.status === 'in_progress') return { finding: finding('batch.processing', 'info', { id: remote.id }), data: batchData(remote) };
    if (remote.status === 'canceling') return { finding: finding('batch.canceling', 'info', params), data: batchData(remote) };
    const { succeeded, errored, canceled, expired } = remote.counts;
    const counts = { succeeded: String(succeeded), errored: String(errored), canceled: String(canceled), expired: String(expired) };
    return { finding: finding('batch.ended', 'info', { ...params, ...counts }), data: batchData(remote) };
  });
}

/** `tome batch cancel`：要求取消，不等待。之後收回時，處理完的照常套用，取消的放回佇列（ADR-0107 第 17 項）。 */
export function cancelBatches(options: BatchCommandOptions): Promise<PlanOutcome> {
  return withBatches(options, async (llm, row) => {
    const remote = await withRetry(() => llm.cancelBatch(row.remote_id), options.host.sleep, undefined, options.onRetry);
    if (isApiError(remote)) return { finding: providerFailed(remote), data: { id: row.remote_id } };
    return { finding: finding('batch.canceling', 'info', { id: remote.id, book: options.slug }), data: batchData(remote) };
  });
}
