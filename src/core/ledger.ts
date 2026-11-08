import { priceFor, type ProviderModel, type RequestMode } from './provider.ts';
import type { Store } from './store.ts';

// 費用帳本（ADR-0040、ADR-0081、ADR-0103）。供應商以請求計費，這裡依字元數分攤到單位。

const TOKENS_PER_PRICE_UNIT = 1_000_000;
const BATCH_DISCOUNT = 0.5;

export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
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
}

export function costOf(usage: Usage, model: ProviderModel, mode: RequestMode): number {
  const { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens } = usage;
  const price = priceFor(model, input_tokens + cache_read_tokens + cache_write_tokens);
  const batch = mode === 'batch';
  const cache = cache_read_tokens * price.cache_read + cache_write_tokens * price.cache_write_5m;
  const dollars =
    input_tokens * (batch ? price.batch_input : price.input) +
    output_tokens * (batch ? price.batch_output : price.output) +
    cache * (batch ? BATCH_DISCOUNT : 1);
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
  const { request_id, model, mode, usage, units, stop_reason, max_tokens } = record;
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
           cache_read_tokens, cache_write_tokens, cost_usd, created_at, stop_reason, max_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    });
  });
}

export interface EstimateRecord {
  /** `translate` 或 `scan`（Pass 0）。 */
  readonly stage: 'translate' | 'scan';
  readonly mode: RequestMode;
  readonly model: string;
  readonly requests: number;
  readonly low_usd: number;
  readonly high_usd: number;
}

/** 確認過的估價，交付報告拿來對照之後的實際花費（ADR-0123）。只有數字。 */
export function recordEstimate(store: Store, record: EstimateRecord): void {
  const { stage, mode, model, requests, low_usd, high_usd } = record;
  store.run(
    'INSERT INTO estimate (stage, mode, model, requests, low_usd, high_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    stage,
    mode,
    model,
    requests,
    low_usd,
    high_usd,
    new Date().toISOString(),
  );
}

/** 這本書已經花掉的，從第一筆付費呼叫算起（ADR-0081）。 */
export function spentUsd(store: Store): number {
  return store.get<{ spent: number | null }>('SELECT SUM(cost_usd) AS spent FROM ledger')?.spent ?? 0;
}
