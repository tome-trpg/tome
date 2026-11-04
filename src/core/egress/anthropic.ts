import Anthropic, { APIConnectionError, APIError } from '@anthropic-ai/sdk';
import { VERSION } from '@anthropic-ai/sdk/version';
import { TomeError } from '../errors.ts';
import {
  batchItem,
  isApiError,
  messageResult,
  remoteBatch,
  type ApiError,
  type BatchItem,
  type BatchResultLine,
  type LLMHost,
  type LLMProvider,
  type MessageBatchReply,
  type Sleep,
} from '../llm.ts';
import { modelFacts } from '../provider-test.ts';
import type { MessagesBody } from '../request.ts';
import type { GuardedFetch } from './client.ts';

// Anthropic 轉接層（ADR-0032、ADR-0109）。SDK 只在對外出口模組匯入（ADR-0039），
// 重試關掉，由 TOME 自己重試（ADR-0099 第 23 項）。

/** 跟 SDK 預設的 10 分鐘相同。明確設了，SDK 才不會因為 `max_tokens` 大就在送出前丟錯（ADR-0109 第 4 項）。 */
const TIMEOUT_MS = 600_000;
const API_VERSION = '2023-06-01';
/** `list` 每頁幾個（ADR-0109 第 8 項）。 */
const PAGE_SIZE = 20;
/** 帶這個 beta 標頭，Models API 才回 `allowed_fallback_models`。只讀資料，TOME 不用伺服器端回退。 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** 只轉送這些標頭。`ANTHROPIC_CUSTOM_HEADERS` 加的其他標頭不送（ADR-0109 第 2 項）。 */
const FORWARDED = /^(?:accept|content-type|user-agent|x-stainless-[a-z-]+|anthropic-version|anthropic-beta|x-api-key)$/;

/** `Headers` 列出的名稱都是小寫。 */
function forwarding(fetcher: GuardedFetch): GuardedFetch {
  return (input, init = {}) => {
    const headers = new Headers();
    for (const [name, value] of new Headers(init.headers)) {
      if (FORWARDED.test(name)) headers.set(name, value);
    }
    return fetcher(input, { ...init, headers });
  };
}

/**
 * 金鑰、端點與選項都明確傳，環境變數改不了金鑰、端點、API 版本與 beta 功能（ADR-0099 第 24 項、ADR-0109 第 2 項）。
 * `ANTHROPIC_CUSTOM_HEADERS` 關不掉，`defaultHeaders` 排在它後面，同名的標頭以這裡的為準，null 是拿掉。
 * `describeModel` 的 beta 標頭由那次請求自己帶，排在更後面，照樣送出。
 */
function client(key: string, fetcher: GuardedFetch, endpoint: string): Anthropic {
  return new Anthropic({
    apiKey: key,
    authToken: null,
    webhookKey: null,
    baseURL: endpoint,
    fetch: forwarding(fetcher),
    maxRetries: 0,
    timeout: TIMEOUT_MS,
    logLevel: 'off',
    openTelemetry: false,
    defaultHeaders: { 'X-Api-Key': key, 'anthropic-version': API_VERSION, 'anthropic-beta': null },
  });
}

function retryAfter(headers: Headers | undefined): number | null {
  const value = headers?.get('retry-after');
  if (value === null || value === undefined) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * SDK 把注入的 `fetch` 丟出的錯誤包成 `APIConnectionError`。個資閘門與白名單的錯誤要解開再丟，
 * 否則會被當成網路錯誤重試，`translate.blocked` 走不到（ADR-0109 第 1 項）。
 */
function failure(error: unknown): ApiError {
  if (error instanceof APIConnectionError) {
    if (error.cause instanceof TomeError) throw error.cause;
    return { outcome: 'error', status: null, retryAfter: null };
  }
  if (error instanceof APIError && error.status !== undefined) {
    return { outcome: 'error', status: error.status, retryAfter: retryAfter(error.headers) };
  }
  throw error;
}

const NO_RESPONSE: ApiError = { outcome: 'error', status: null, retryAfter: null };

/** SDK 送出的請求。本文由這裡自己讀，不交給 SDK 解析。 */
interface Call {
  asResponse(): Promise<Response>;
}

/**
 * SDK 收到標頭就交出回應，讀本文時斷線丟出的錯誤沒有包起來。這一步的錯誤當成沒有收到回應，
 * 交給 `withRetry`，跟 5xx 與逾時一樣（ADR-0109 第 20 項）。解析 JSON 與其他程式錯誤照樣丟出。
 */
async function bodyOf(call: Call): Promise<string | ApiError> {
  const response = await call.asResponse();
  try {
    return await response.text();
  } catch {
    return NO_RESPONSE;
  }
}

/** 讀本文、解析 JSON，再交給核心判斷。帳本的 `request_id` 是本文裡的訊息 ID，不靠標頭。 */
function reading<T, R>(call: () => Call, read: (reply: T) => R): Promise<R | ApiError> {
  return attempt(async () => {
    const text = await bodyOf(call());
    return isApiError(text) ? text : read(JSON.parse(text) as T);
  });
}

async function attempt<T>(call: () => Promise<T | ApiError>): Promise<T | ApiError> {
  try {
    return await call();
  } catch (error) {
    return failure(error);
  }
}

/** SDK 的型別要可變的陣列。 */
function params(body: MessagesBody): Anthropic.MessageCreateParamsNonStreaming {
  return { ...body, messages: [...body.messages] };
}

/** 結果檔一行一個 JSON（JSONL）。 */
function resultLines(text: string): BatchItem[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => batchItem(JSON.parse(line) as BatchResultLine));
}

function provider(api: Anthropic): LLMProvider {
  const { batches } = api.messages;
  return {
    id: 'anthropic',
    sdkVersion: VERSION,
    send: (body) => reading(() => api.messages.create(params(body)), messageResult),
    submitBatch: (requests) =>
      reading(
        () => batches.create({ requests: requests.map(({ customId, body }) => ({ custom_id: customId, params: params(body) })) }),
        remoteBatch,
      ),
    pollBatch: (id) => reading(() => batches.retrieve(id), remoteBatch),
    // 照文件從 `results_url` 下載，先查一次批次拿網址（ADR-0109 第 8 項）。
    collectBatch: (id) =>
      attempt(async () => {
        const found = await bodyOf(batches.retrieve(id));
        if (isApiError(found)) return found;
        const { results_url: url } = JSON.parse(found) as { readonly results_url?: string | null };
        if (typeof url !== 'string') throw new RangeError(`batch ${id} has no results_url`);
        const text = await bodyOf(api.get(url, { headers: { Accept: 'application/binary' } }));
        return isApiError(text) ? text : resultLines(text);
      }),
    cancelBatch: (id) => reading(() => batches.cancel(id), remoteBatch),
    deleteRemote: async (id) => {
      const result = await reading(() => batches.delete(id), () => null);
      return isApiError(result) ? result : null;
    },
    listBatches: (after) =>
      reading(
        () => batches.list({ limit: PAGE_SIZE, ...(after === null ? {} : { after_id: after }) }),
        (page: BatchListReply) => ({ batches: page.data.map(remoteBatch), next: page.has_more ? page.last_id : null }),
      ),
    describeModel: (id) => reading(() => api.beta.models.retrieve(id, { betas: [FALLBACK_BETA] }), modelFacts),
  };
}

/** `list` 的一頁，只列用得到的欄位。 */
interface BatchListReply {
  readonly data: readonly MessageBatchReply[];
  readonly has_more: boolean;
  readonly last_id: string | null;
}

export interface AnthropicOptions {
  /** 測試的本機伺服器才給。正式的端點在供應商設定檔，使用者改不了（ADR-0104 第 3 項）。 */
  readonly endpoint?: string;
  readonly sleep?: Sleep;
}

/** 用使用者的金鑰接 Anthropic（ADR-0034、ADR-0109 第 5 項）。 */
export function anthropicHost(key: string, options: AnthropicOptions = {}): LLMHost {
  return {
    connect: (fetcher, endpoint) => provider(client(key, fetcher, endpoint)),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  };
}
