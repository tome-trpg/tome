import { modePrices, type CacheTtl } from './estimate.ts';
import type { ProviderModel, RequestMode } from './provider.ts';
import type { Store } from './store.ts';

// 費用帳本（ADR-0040、ADR-0081、ADR-0103）。供應商以請求計費，這裡依字元數分攤到單位。

const TOKENS_PER_PRICE_UNIT = 1_000_000;

export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  /** `cache_write_tokens` 裡有多少是 1 小時的，價錢不同；沒有就不給（ADR-0135）。 */
  readonly cache_write_1h_tokens?: number;
}

export interface UsageRecord {
  readonly request_id: string;
  readonly model: ProviderModel;
  readonly mode: RequestMode;
  readonly usage: Usage;
  readonly units: readonly { readonly unit_id: string; readonly chars: number }[];
  /** 供應商回的原值，同一個請求的每一列都一樣（ADR-0114）。 */
  readonly stop_reason: string | null;
  /** 請求的上限，算不出來時是 null（ADR-0114）。 */
  readonly max_tokens: number | null;
  /** 試翻的請求，Q-6 不算它，校準只看它（ADR-0135）。 */
  readonly trial?: boolean;
}

/** 寫入照實際的 TTL 計價：1 小時的比 5 分鐘的貴（ADR-0135）。 */
export function costOf(usage: Usage, model: ProviderModel, mode: RequestMode): number {
  const { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens } = usage;
  const prices = modePrices(model, mode, input_tokens + cache_read_tokens + cache_write_tokens);
  const hour = usage.cache_write_1h_tokens ?? 0;
  const writes: Readonly<Record<CacheTtl, number>> = { '5m': cache_write_tokens - hour, '1h': hour };
  const dollars =
    input_tokens * prices.input +
    output_tokens * prices.output +
    cache_read_tokens * prices.cacheRead +
    writes['5m'] * prices.cacheWrite['5m'] +
    writes['1h'] * prices.cacheWrite['1h'];
  return dollars / TOKENS_PER_PRICE_UNIT;
}

/** 依權重分攤，無條件捨去，最後一份拿餘數，加起來一定等於總數。 */
function split(total: number, weights: readonly number[], sum: number): number[] {
  let given = 0;
  return weights.map((weight, index) => {
    const even = sum === 0 ? 0 : Math.floor((total * weight) / sum);
    const share = index === weights.length - 1 ? total - given : even;
    given += share;
    return share;
  });
}

/**
 * 同一個 `request_id` 只記一次。批次收回到一半中斷時會再下載一次結果，
 * 同一筆費用不能記兩次（ADR-0107）。即時模式每次送出的 ID 都不同。
 */
export function recordUsage(store: Store, record: UsageRecord): void {
  const { request_id, model, mode, usage, units, stop_reason, max_tokens, trial = false } = record;
  if (store.get('SELECT 1 FROM ledger WHERE request_id = ? LIMIT 1', request_id) !== undefined) return;
  const weights = units.map(({ chars }) => chars);
  const sum = weights.reduce((total, weight) => total + weight, 0);
  const inputs = split(usage.input_tokens, weights, sum);
  const outputs = split(usage.output_tokens, weights, sum);
  const reads = split(usage.cache_read_tokens, weights, sum);
  const writes = split(usage.cache_write_tokens, weights, sum);
  const now = new Date().toISOString();
  const total = costOf(usage, model, mode);
  store.transaction(() => {
    units.forEach(({ unit_id }, index) => {
      const chars = weights[index] ?? 0;
      const share = sum === 0 ? (index === units.length - 1 ? 1 : 0) : chars / sum;
      store.run(
        `INSERT INTO ledger (request_id, unit_id, model, mode, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, cost_usd, created_at, stop_reason, max_tokens, trial)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        request_id,
        unit_id,
        model.id,
        mode,
        inputs[index] ?? 0,
        outputs[index] ?? 0,
        reads[index] ?? 0,
        writes[index] ?? 0,
        total * share,
        now,
        stop_reason,
        max_tokens,
        trial ? 1 : 0,
      );
    });
  });
}

export interface EstimateRecord {
  /** `translate`、`scan`（Pass 0）或 `trial`（試翻，ADR-0135）。 */
  readonly stage: 'translate' | 'scan' | 'trial';
  readonly mode: RequestMode;
  readonly model: string;
  readonly requests: number;
  readonly low_usd: number;
  readonly high_usd: number;
  /** 估價的中間值，Q-6 拿它比（ADR-0135）。沒給是 null。 */
  readonly middle_usd?: number;
  /** 依試翻校準過（ADR-0135）。 */
  readonly calibrated?: boolean;
}

/** 確認過的估價，交付報告拿來對照之後的實際花費（ADR-0123）。只有數字。 */
export function recordEstimate(store: Store, record: EstimateRecord): void {
  const { stage, mode, model, requests, low_usd, high_usd, middle_usd = null, calibrated = false } = record;
  store.run(
    `INSERT INTO estimate (stage, mode, model, requests, low_usd, high_usd, created_at, middle_usd, calibrated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    stage,
    mode,
    model,
    requests,
    low_usd,
    high_usd,
    new Date().toISOString(),
    middle_usd,
    calibrated ? 1 : 0,
  );
}

/** 一本書、一個模型、一個模式的校準（ADR-0135）。 */
export interface CalibrationRow {
  readonly model: string;
  readonly mode: RequestMode;
  readonly input_factor: number;
  readonly output_factor: number;
  /** 拿來校準的請求：試翻第一次送出、用主翻譯模型的請求。 */
  readonly requests: number;
  /** 試翻的重送花費 ÷ 第一次送出的花費，只顯示，不改估價的餘裕。 */
  readonly resend_ratio: number;
  readonly cache_ttl: CacheTtl | null;
  /** 快取讀取 ÷（讀取 ＋ 寫入）；沒有快取的讀寫是 null。 */
  readonly cache_hit_rate: number | null;
  readonly created_at: string;
}

export function loadCalibration(store: Store, model: string, mode: RequestMode): CalibrationRow | null {
  return store.get<CalibrationRow>('SELECT * FROM calibration WHERE model = ? AND mode = ?', model, mode) ?? null;
}

/** 同一個模型與模式只留最新的一筆。 */
export function saveCalibration(store: Store, row: CalibrationRow): void {
  store.run(
    `INSERT OR REPLACE INTO calibration
       (model, mode, input_factor, output_factor, requests, resend_ratio, cache_ttl, cache_hit_rate, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.model,
    row.mode,
    row.input_factor,
    row.output_factor,
    row.requests,
    row.resend_ratio,
    row.cache_ttl,
    row.cache_hit_rate,
    row.created_at,
  );
}

/** 這本書已經花掉的，從第一筆付費呼叫算起（ADR-0081）。 */
export function spentUsd(store: Store): number {
  return store.get<{ spent: number | null }>('SELECT SUM(cost_usd) AS spent FROM ledger')?.spent ?? 0;
}
