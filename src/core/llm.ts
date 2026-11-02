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

/** 沒有完成的 API 呼叫。即時的請求與批次的查詢、下載、取消、刪除、列出共用。 */
export type ApiError = Extract<RequestResult, { readonly outcome: 'error' }>;

/** 模型有回覆：譯文、截斷或拒答。 */
export type Answer = Exclude<RequestResult, ApiError>;

/** 供應商的 `request_counts`，除了 `processing`，要等整批結束才有數字。 */
export interface BatchCounts {
  readonly processing: number;
  readonly succeeded: number;
  readonly errored: number;
  readonly canceled: number;
  readonly expired: number;
}

export type BatchStatus = 'in_progress' | 'canceling' | 'ended';

/** 供應商那邊的一批。時間都是 ISO 8601。 */
export interface RemoteBatch {
  readonly id: string;
  readonly status: BatchStatus;
  readonly counts: BatchCounts;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly endedAt: string | null;
  /** 結果超過保留期限、下載不到之後才有。 */
  readonly archivedAt: string | null;
}

export interface BatchRequest {
  readonly customId: string;
  readonly body: MessagesBody;
}

/** 一個請求在批次裡的結果。`succeeded` 跟即時模式一樣判斷拒答與截斷。 */
export type BatchOutcome =
  | Answer
  /** `type` 是供應商的錯誤種類，例如 `api_error`。 */
  | { readonly outcome: 'errored'; readonly type: string }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'canceled' };

export interface BatchItem {
  readonly customId: string;
  readonly result: BatchOutcome;
}

export interface BatchPage {
  readonly batches: readonly RemoteBatch[];
  /** 下一頁從哪裡開始，沒有了是 null。 */
  readonly next: string | null;
}

export interface LLMProvider {
  readonly id: string;
  /** 存進翻譯記憶（ADR-0102）。 */
  readonly sdkVersion: string;
  /** 連線失敗回 `error`。個資閘門與白名單的錯誤照樣丟出來，那些不該重試。 */
  send(body: MessagesBody): Promise<RequestResult>;
  /** Batch 的方法由 brief 022 的轉接層實作，019 只有測試注入（ADR-0107 第 19 項）。 */
  submitBatch(requests: readonly BatchRequest[]): Promise<RemoteBatch | ApiError>;
  pollBatch(id: string): Promise<RemoteBatch | ApiError>;
  /** 一次下載整批的結果，順序不一定跟送出時相同。 */
  collectBatch(id: string): Promise<readonly BatchItem[] | ApiError>;
  cancelBatch(id: string): Promise<RemoteBatch | ApiError>;
  deleteRemote(id: string): Promise<ApiError | null>;
  /** 從最新的開始列。 */
  listBatches(after: string | null): Promise<BatchPage | ApiError>;
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

/** 真的等。測試注入自己的 `Sleep`，不用真的等。 */
export function sleepSeconds(seconds: number): Promise<void> {
  return delay(seconds * 1000);
}

export function isApiError(value: unknown): value is ApiError {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as ApiError).outcome === 'error';
}

/**
 * 只重試 429、5xx 與網路錯誤，有 `retry-after` 時用它（ADR-0104 第 11 項、ADR-0107 第 12 項）。
 * `again` 換掉哪些狀態要重試，建立批次時用得到。
 */
export async function withRetry<T>(
  call: () => Promise<T>,
  sleep: Sleep = sleepSeconds,
  again: (status: number | null) => boolean = retryable,
): Promise<T> {
  for (const seconds of BACKOFF_SECONDS) {
    const result = await call();
    if (!isApiError(result) || !again(result.status)) return result;
    await sleep(result.retryAfter ?? seconds);
  }
  return call();
}

/**
 * 建立批次時，沒有收到回應就不知道建立了沒有，再送一次可能多付一整批，所以不重試，
 * 留給意圖紀錄去認（ADR-0107 第 8 項）。有收到 429 或 5xx 代表沒有建立，可以重試。
 */
export function retryableSubmit(status: number | null): boolean {
  return status !== null && retryable(status);
}

export function sendWithRetry(provider: LLMProvider, body: MessagesBody, sleep: Sleep = sleepSeconds): Promise<RequestResult> {
  return withRetry(() => provider.send(body), sleep);
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
export function messageResult({ id, stop_reason, stop_details, content, usage }: MessageReply): Answer {
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

/** Anthropic 的批次物件，只列用得到的欄位。 */
export interface MessageBatchReply {
  readonly id: string;
  readonly processing_status: BatchStatus;
  readonly request_counts: BatchCounts;
  readonly created_at: string;
  readonly expires_at: string;
  readonly ended_at?: string | null;
  readonly archived_at?: string | null;
}

export function remoteBatch(reply: MessageBatchReply): RemoteBatch {
  return {
    id: reply.id,
    status: reply.processing_status,
    counts: reply.request_counts,
    createdAt: reply.created_at,
    expiresAt: reply.expires_at,
    endedAt: reply.ended_at ?? null,
    archivedAt: reply.archived_at ?? null,
  };
}

/** 結果檔的一行。`errored` 的錯誤是一般錯誤回應的形狀，種類在 `error.error.type`。 */
export interface BatchResultLine {
  readonly custom_id: string;
  readonly result:
    | { readonly type: 'succeeded'; readonly message: MessageReply }
    | { readonly type: 'errored'; readonly error?: { readonly error?: { readonly type?: string } | null } | null }
    | { readonly type: 'canceled' | 'expired' };
}

/** 判斷一行批次結果。`succeeded` 也可能是拒答或截斷，跟即時模式走同一個函式（ADR-0104 第 39 項）。 */
export function batchItem({ custom_id, result }: BatchResultLine): BatchItem {
  switch (result.type) {
    case 'succeeded':
      return { customId: custom_id, result: messageResult(result.message) };
    case 'errored':
      return { customId: custom_id, result: { outcome: 'errored', type: result.error?.error?.type ?? 'unknown' } };
    default:
      return { customId: custom_id, result: { outcome: result.type } };
  }
}

/** 這些錯誤重送就可能成功，其他種類重送也會一樣失敗（ADR-0107 第 13 項）。 */
export const RETRYABLE_BATCH_ERRORS: readonly string[] = ['rate_limit_error', 'timeout_error', 'api_error', 'overloaded_error'];
