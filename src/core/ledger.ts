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

export function recordUsage(store: Store, { request_id, model, mode, usage, units }: UsageRecord): void {
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
           cache_read_tokens, cache_write_tokens, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    });
  });
}

/** 這本書已經花掉的，從第一筆付費呼叫算起（ADR-0081）。 */
export function spentUsd(store: Store): number {
  return store.get<{ spent: number | null }>('SELECT SUM(cost_usd) AS spent FROM ledger')?.spent ?? 0;
}
