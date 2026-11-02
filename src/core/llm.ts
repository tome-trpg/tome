import { setTimeout as delay } from 'node:timers/promises';
import type { GuardedFetch } from './egress/client.ts';
import type { Usage } from './ledger.ts';
import type { MessagesBody } from './request.ts';

// 轉接層介面與重試（白皮書 §5.7、ADR-0104）。轉接層不自己連網，只能用注入的 `fetch`。
// SDK 的重試關掉（ADR-0099 第 23 項），重試都在這裡，帳本與預算才算得準。

/** 重試幾次與每次等幾秒。是提案，等真實請求量過。 */
export const BACKOFF_SECONDS: readonly number[] = [1, 2, 4, 8, 16];

interface Answered {
  readonly requestId: string;
  readonly usage: Usage;
}

export type RequestResult =
  | (Answered & { readonly outcome: 'ok' | 'truncated'; readonly text: string })
  /** `category` 是供應商給的拒答類別，存進 `issue`。 */
  | (Answered & { readonly outcome: 'refused'; readonly category: string | null })
  /** `status` 是 null 表示沒有收到回應。`retryAfter` 的單位是秒。 */
  | { readonly outcome: 'error'; readonly status: number | null; readonly retryAfter: number | null };

export interface LLMProvider {
  readonly id: string;
  /** 存進翻譯記憶（ADR-0102）。 */
  readonly sdkVersion: string;
  /** 連線失敗回 `error`。個資閘門與白名單的錯誤照樣丟出來，那些不該重試。 */
  send(body: MessagesBody): Promise<RequestResult>;
}

export type Sleep = (seconds: number) => Promise<void>;

/** 轉接層由呼叫端提供（ADR-0104）。 */
export interface LLMHost {
  connect(fetcher: GuardedFetch): LLMProvider;
  /** 測試的本機伺服器才給。正式的端點在供應商設定檔，使用者改不了（ADR-0104 第 3 項）。 */
  readonly endpoint?: string;
  readonly sleep?: Sleep;
}

function retryable(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

function wait(seconds: number): Promise<void> {
  return delay(seconds * 1000);
}

/** 只重試 429、5xx 與網路錯誤，有 `retry-after` 時用它（ADR-0104 第 11 項）。 */
export async function sendWithRetry(
  provider: LLMProvider,
  body: MessagesBody,
  sleep: Sleep = wait,
): Promise<RequestResult> {
  for (const seconds of BACKOFF_SECONDS) {
    const result = await provider.send(body);
    if (result.outcome !== 'error' || !retryable(result.status)) return result;
    await sleep(result.retryAfter ?? seconds);
  }
  return provider.send(body);
}

export interface MessageReply {
  readonly id: string;
  readonly stop_reason: string | null;
  readonly stop_details?: { readonly category?: string | null } | null;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_read_input_tokens?: number | null;
    readonly cache_creation_input_tokens?: number | null;
  };
}

/**
 * 判斷 Anthropic 回應的結果。即時與 Batch 共用：Batch 回 `succeeded` 時也可能是拒答，
 * 所以一律看 `stop_reason`（白皮書 §5.7）。
 */
export function messageResult({ id, stop_reason, stop_details, content, usage }: MessageReply): RequestResult {
  const answered = {
    requestId: id,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
    },
  };
  if (stop_reason === 'refusal') {
    return { ...answered, outcome: 'refused', category: stop_details?.category ?? null };
  }
  const text = content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');
  return { ...answered, outcome: stop_reason === 'max_tokens' ? 'truncated' : 'ok', text };
}
