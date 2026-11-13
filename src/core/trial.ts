import { createHash } from 'node:crypto';
import { sendInBatches, type BatchOptions } from './batch.ts';
import { readBook, recordStage, stageFingerprint, updateBook, withBookLock } from './book.ts';
import { checkBudget } from './budget.ts';
import { breakEven, requestTokens, sumEstimates, type CacheTtl } from './estimate.ts';
import { finding, type Finding } from './findings.ts';
import { loadCalibration, recordEstimate, saveCalibration, spentUsd, type CalibrationRow } from './ledger.ts';
import type { LLMHost } from './llm.ts';
import { priceFinding, usd, type RequestMode } from './provider.ts';
import {
  cacheParams,
  middleOf,
  parseBudget,
  partOfRequest,
  planBook,
  planRequests,
  retentionFinding,
  sizeRequest,
  userMessage,
  type BookPlan,
  type PlannedRequest,
  type PlanOutcome,
  type PlanOverride,
} from './request.ts';
import { openBookStore, type Store } from './store.ts';
import { announce, drain, inFlightUsd, outstandingBatches, recover, trialUnitIds, withRun } from './translate.ts';
import { piiFindings } from './workspace.ts';

// 試翻（白皮書 §6.1、§8、ADR-0035、ADR-0135）：在 `--chapters` 範圍內平均間隔挑約 10% 的請求先翻，
// 用帳本的實際 token 校準這本書的估價，並量提示快取的命中率。試翻的譯文照一般翻譯驗證，通過就是
// `DONE`，主翻譯跳過它們。估價、確認、預算、個資閘門、外送紀錄與帳本都跟翻譯走同一條路。

/** 上一次顯示的試翻估價的內容指紋，`--confirm` 要跟它相同才送，比照 Pass 0（ADR-0118 第 8 項）。 */
export const TRIAL_ESTIMATE_STAGE = 'trial-estimate';
/** 規劃好的請求約這個比例，最少、最多這麼多個。都是提案，M3 的帳本模擬過（ADR-0135）。 */
export const TRIAL_SHARE = 0.1;
export const TRIAL_MIN = 5;
export const TRIAL_MAX = 30;
/** 試翻的請求一律開快取：批次可能做很久、同一批的請求相隔可能超過 5 分鐘，用 1 小時；即時一個接一個送。 */
export const TRIAL_TTL: Readonly<Record<RequestMode, CacheTtl>> = { batch: '1h', realtime: '5m' };
/** `tome trial` 與之後的 `tome estimate` 都用這組旗標確認。 */
const CONFIRM_FLAGS: Readonly<Record<RequestMode, string>> = { realtime: '--realtime --confirm', batch: '--confirm' };

/** 試翻幾個請求：約 10%，最少 5 個、最多 30 個，不超過規劃好的數量。 */
export function trialSize(planned: number): number {
  return Math.min(planned, TRIAL_MAX, Math.max(TRIAL_MIN, Math.round(planned * TRIAL_SHARE)));
}

/** 平均間隔挑整個請求，取每一段的中間，不只看書的開頭；照閱讀順序，不重複（ADR-0135）。 */
export function pickTrial<T>(requests: readonly T[]): T[] {
  const size = trialSize(requests.length);
  return Array.from({ length: size }, (_, index) => requests[Math.floor(((index + 0.5) * requests.length) / size)]).filter(
    (request): request is T => request !== undefined,
  );
}

export interface TrialOptions extends Omit<BatchOptions, 'home' | 'slug' | 'host' | 'retryFailed'> {
  readonly home: string;
  readonly slug: string;
  readonly mode: RequestMode;
  readonly confirm: boolean;
  /** 使用者打的字，這裡才驗證。 */
  readonly budget?: string | undefined;
  /** `--confirm` 才要。 */
  readonly host?: LLMHost;
  readonly today?: Date;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function unitIds(requests: readonly PlannedRequest[]): string[] {
  return requests.flatMap(({ units }) => units.map(({ unit_id }) => unit_id));
}

/**
 * 挑中、已經送出但還沒驗證完的單位：批次還在供應商那邊，或送出之後被中斷。它們不是待送的，也不是做完了，
 * 要先收回才能校準（ADR-0135 第 3 項）。
 */
function unsettledTrial(store: Store): number {
  return (
    store.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM unit WHERE state IN ('IN_FLIGHT', 'RECEIVED') AND unit_id IN (SELECT unit_id FROM trial_unit)",
    )?.count ?? 0
  );
}

/** 這次要試翻的請求：上次挑中、還沒做完的接著做；沒有就從規劃好的請求挑。 */
function trialRequests(store: Store, plan: BookPlan): { readonly requests: PlannedRequest[]; readonly resumed: boolean } {
  const saved = trialUnitIds(store);
  if (saved.size === 0) return { requests: pickTrial(plan.requests), resumed: false };
  const pending = new Set(unitIds(plan.requests));
  const wanted = (unit: { readonly unit_id: string }): boolean => saved.has(unit.unit_id) && pending.has(unit.unit_id);
  return { requests: planRequests(plan.units, plan.chapterOf, wanted), resumed: true };
}

interface LedgerRow {
  readonly request_id: string;
  readonly unit_id: string;
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly cost_usd: number;
}

interface TrialRequest {
  readonly model: string;
  readonly units: string[];
  input: number;
  output: number;
  cost: number;
}

/**
 * 用帳本裡試翻的請求校準（ADR-0135）。第一次送出、用主翻譯模型的請求，照當時的組法重建，跟估價器的
 * 估計比，輸入與輸出各一個倍數；重送比例與快取命中率只記下來。沒有能比的請求就是 null。
 */
export function calibrate(store: Store, plan: BookPlan, now: Date = new Date()): CalibrationRow | null {
  const rows = store.all<LedgerRow>(
    `SELECT request_id, unit_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
     FROM ledger WHERE trial = 1 ORDER BY id`,
  );
  const first = new Map(
    store
      .all<{ unit_id: string; request_id: string }>('SELECT unit_id, request_id FROM ledger WHERE id IN (SELECT MIN(id) FROM ledger GROUP BY unit_id)')
      .map(({ unit_id, request_id }) => [unit_id, request_id]),
  );
  const requests = new Map<string, TrialRequest>();
  let read = 0;
  let written = 0;
  for (const row of rows) {
    const request = requests.get(row.request_id) ?? { model: row.model, units: [], input: 0, output: 0, cost: 0 };
    requests.set(row.request_id, request);
    request.units.push(row.unit_id);
    // 快取讀寫不算在 `input_tokens` 裡，加起來才是整個提示。
    request.input += row.input_tokens + row.cache_read_tokens + row.cache_write_tokens;
    request.output += row.output_tokens;
    request.cost += row.cost_usd;
    read += row.cache_read_tokens;
    written += row.cache_write_tokens;
  }
  const profile = plan.provider.profile;
  const estimated = { input: 0, output: 0 };
  const actual = { input: 0, output: 0 };
  let firstCost = 0;
  let totalCost = 0;
  let count = 0;
  for (const [id, request] of requests) {
    totalCost += request.cost;
    const ids = new Set(request.units);
    if (request.model !== plan.model.id || !request.units.every((unit) => first.get(unit) === id)) continue;
    const units = plan.units.filter(({ unit_id }) => ids.has(unit_id));
    if (units.length !== ids.size) continue;
    const rebuilt = partOfRequest(plan.units, id, units, plan.chapterOf);
    const user = userMessage(rebuilt, { terms: plan.terms, pack: plan.pack, recent: plan.recent });
    const sourceChars = units.reduce((total, { source }) => total + source.length, 0);
    const size = { prefixChars: plan.prefix.length, userChars: user.length, sourceChars, units: units.length };
    const tokens = requestTokens(profile, plan.model, size);
    estimated.input += tokens.prefix + tokens.rest;
    estimated.output += tokens.output;
    actual.input += request.input;
    actual.output += request.output;
    firstCost += request.cost;
    count += 1;
  }
  if (count === 0 || estimated.input === 0 || estimated.output === 0) return null;
  const cached = read + written > 0;
  return {
    model: plan.model.id,
    mode: plan.mode,
    input_factor: actual.input / estimated.input,
    output_factor: actual.output / estimated.output,
    requests: count,
    resend_ratio: firstCost > 0 ? (totalCost - firstCost) / firstCost : 0,
    cache_ttl: cached ? TRIAL_TTL[plan.mode] : null,
    cache_hit_rate: cached ? read / (read + written) : null,
    created_at: now.toISOString(),
  };
}

function percent(share: number): string {
  return String(Math.round(share * 100));
}

/** 試翻做完：存校準、清掉挑中的單位，說量到什麼與下一步。只有數字（ADR-0059）。 */
function finish(store: Store, plan: BookPlan, slug: string, notes: readonly Finding[]): PlanOutcome {
  const row = calibrate(store, plan);
  const spent = store.get<{ spent: number | null }>('SELECT SUM(cost_usd) AS spent FROM ledger WHERE trial = 1')?.spent ?? 0;
  store.run('DELETE FROM trial_unit');
  if (row === null) {
    return { data: { book: slug, mode: plan.mode, calibrated: false, spent_usd: spent }, findings: [finding('trial.no_data', 'warn'), ...notes] };
  }
  saveCalibration(store, row);
  const done = finding('trial.done', 'info', {
    book: slug,
    requests: String(row.requests),
    input: row.input_factor.toFixed(2),
    output: row.output_factor.toFixed(2),
    resend: percent(row.resend_ratio),
    spent: usd(spent),
  });
  const { cache_ttl: ttl, cache_hit_rate: rate } = row;
  const cache =
    ttl === null || rate === null
      ? []
      : [
          finding(
            rate > breakEven(plan.model, plan.mode, ttl) ? 'trial.cache_on' : 'trial.cache_off',
            'info',
            cacheParams(rate, plan.model, plan.mode, ttl),
          ),
        ];
  const next = finding('trial.next', 'info', { book: slug, flags: CONFIRM_FLAGS[plan.mode] });
  return {
    data: {
      book: slug,
      mode: plan.mode,
      model: plan.model.id,
      calibrated: true,
      requests: row.requests,
      input_factor: row.input_factor,
      output_factor: row.output_factor,
      resend_ratio: row.resend_ratio,
      cache_hit_rate: rate,
      spent_usd: spent,
    },
    findings: [done, ...cache, next, ...notes],
  };
}

/** 確認之後送出挑中的單位：即時一個接一個，批次送成批次，都帶快取（ADR-0135）。 */
function sendTrial(options: TrialOptions, host: LLMHost, only: ReadonlySet<string>, override: PlanOverride): Promise<PlanOutcome> {
  const { home, slug, mode } = options;
  const translate = { ...options, home, slug, host, retryFailed: false };
  const setup = { mode, confirm: false, refusePending: mode === 'realtime', trial: { only, override } };
  return withRun(translate, setup, async (run, findings) => {
    recover(run);
    announce(run, translate);
    const stop = mode === 'realtime' ? await drain(run) : await sendInBatches(run, translate);
    if (stop !== null) return { data: { book: slug, mode, calibrated: false }, findings: [stop, ...run.notes, ...findings] };
    return finish(run.store, run.plan, slug, [...run.notes, ...findings]);
  });
}

type Prepared = { readonly outcome: PlanOutcome } | { readonly only: ReadonlySet<string> };

/**
 * 不加 `--confirm` 只估價、記下這次的內容指紋；加了要跟上次顯示的估價相同才送，不同就重新估價、
 * 要再確認一次，比照 Pass 0（ADR-0118 第 8 項）。試翻的估價當成整個前綴都寫入快取，是上限。
 */
async function prepare(options: TrialOptions, override: PlanOverride): Promise<Prepared> {
  const { home, slug, mode, confirm, budget, today = new Date() } = options;
  const before = readBook(home, slug);
  const book = budget === undefined ? before : updateBook(home, before, { budget_usd: parseBudget(budget) });
  const store = openBookStore(home, slug);
  try {
    if (confirm && mode === 'realtime' && outstandingBatches(store) > 0) {
      return { outcome: { data: { book: slug }, findings: [finding('batch.pending', 'fail', { book: slug })] } };
    }
    const { plan, findings } = await planBook(home, book, store, mode, override);
    const warnings = [...findings, ...piiFindings(home)];
    if (plan === null) return { outcome: { data: { book: slug }, findings: warnings } };
    const model = plan.model.id;
    const calibrated = loadCalibration(store, model, mode);
    if (calibrated !== null) {
      const done = finding('trial.calibrated', 'info', { book: slug, requests: String(calibrated.requests) });
      return { outcome: { data: { book: slug, mode, model, calibrated: true }, findings: [done, ...warnings] } };
    }
    // 上次的試翻送出去還沒收回：加了 `--confirm` 才連網收回、做完、再校準，那次的確認已經涵蓋它；
    // 沒加就說怎麼收，不校準、也不清掉挑中的單位，收回的帳才會記成試翻（ADR-0135 第 3 項）。
    const unsettled = unsettledTrial(store);
    if (unsettled > 0) {
      if (confirm) return { only: trialUnitIds(store) };
      const out = finding('trial.in_flight', 'warn', { book: slug, count: String(unsettled), flags: CONFIRM_FLAGS[mode] });
      return { outcome: { data: { book: slug, mode, model, calibrated: false, in_flight: unsettled }, findings: [out, ...warnings] } };
    }
    const { requests, resumed } = trialRequests(store, plan);
    // 上次的試翻都做完了、只是還沒校準（例如批次由 `tome batch collect` 收回）：不用再送，直接校準。
    if (requests.length === 0 && resumed) return { outcome: finish(store, plan, slug, warnings) };
    const ids = unitIds(requests);
    const sized = requests.map((request) =>
      sizeRequest(request, {
        prefix: plan.prefix,
        terms: plan.terms,
        pack: plan.pack,
        recent: plan.recent,
        model: plan.model,
        provider: plan.provider.profile,
        mode,
        cache: plan.cache,
      }),
    );
    const estimate = sumEstimates(sized.map((item) => item.estimate));
    const fingerprint = sha256(JSON.stringify([plan.fingerprint, [...ids].sort(), mode]));
    const shown = stageFingerprint(store, TRIAL_ESTIMATE_STAGE);
    recordStage(store, TRIAL_ESTIMATE_STAGE, fingerprint);
    const spent = spentUsd(store);
    const limit = book.config.budget_usd;
    const data = {
      book: slug,
      mode,
      model,
      requests: requests.length,
      planned: plan.requests.length,
      units: ids.length,
      low_usd: estimate.low_usd,
      high_usd: estimate.high_usd,
      budget_usd: limit ?? null,
      spent_usd: spent,
      confirmed: false,
    };
    if (requests.length === 0) return { outcome: { data, findings: [finding('trial.nothing', 'info'), ...warnings] } };
    const stale = priceFinding(plan.provider.profile, today);
    const money = limit === undefined ? [] : [finding('estimate.budget', 'info', { budget: usd(limit), spent: usd(spent) })];
    const params = {
      requests: String(requests.length),
      planned: String(plan.requests.length),
      units: String(ids.length),
      model,
      low: usd(estimate.low_usd),
      high: usd(estimate.high_usd),
    };
    const shownFindings = [
      finding('trial.estimate', 'info', params),
      retentionFinding(mode, plan.provider.profile),
      ...money,
      ...warnings,
      ...(stale.level === 'warn' ? [stale] : []),
    ];
    const flags = CONFIRM_FLAGS[mode];
    if (!confirm) return { outcome: { data, findings: [...shownFindings, finding('trial.not_confirmed', 'info', { book: slug, flags })] } };
    if (limit === undefined) return { outcome: { data, findings: [...shownFindings, finding('trial.no_budget', 'fail')] } };
    if (shown !== fingerprint) {
      return { outcome: { data, findings: [...shownFindings, finding('trial.changed', 'fail', { book: slug, flags })] } };
    }
    const fits = checkBudget({ budget_usd: limit, spent_usd: spent, in_flight_usd: inFlightUsd(store), next_usd: estimate.high_usd });
    if (!fits.ok) {
      const over = finding('trial.over_budget', 'fail', { budget: usd(limit), spent: usd(spent), high: usd(estimate.high_usd) });
      return { outcome: { data, findings: [...shownFindings, over] } };
    }
    store.transaction(() => {
      for (const id of ids) store.run('INSERT OR IGNORE INTO trial_unit (unit_id, model, mode) VALUES (?, ?, ?)', id, model, mode);
    });
    // 確認過、要送出的估價，交付報告拿來對照實際花費；試翻自己不算 Q-6（ADR-0135）。
    const middle_usd = middleOf({ estimate, provider: plan.provider });
    recordEstimate(store, { stage: 'trial', mode, model, requests: requests.length, ...estimate, middle_usd, calibrated: false });
    return { only: trialUnitIds(store) };
  } finally {
    store.close();
  }
}

/** 鎖住之後的本體，`tome run --trial` 拿著鎖接著呼叫（ADR-0127、ADR-0135）。 */
export async function trialLocked(options: TrialOptions): Promise<PlanOutcome> {
  const override = { cache: { ttl: TRIAL_TTL[options.mode], hitRate: 0 } };
  const prepared = await prepare(options, override);
  if ('outcome' in prepared) return prepared.outcome;
  const { host } = options;
  if (host === undefined) throw new RangeError('trial --confirm needs a provider');
  return sendTrial(options, host, prepared.only, override);
}

/** `tome trial`。一本書同時只跑一個流程（ADR-0054）。 */
export function trialBook(options: TrialOptions): Promise<PlanOutcome> {
  return withBookLock(options.home, options.slug, () => trialLocked(options));
}
