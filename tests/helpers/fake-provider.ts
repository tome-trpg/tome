import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { onTestFinished } from 'vitest';
import type { GuardedFetch } from '../../src/core/egress/client.ts';
import { TomeError } from '../../src/core/errors.ts';
import {
  batchItem,
  messageResult,
  remoteBatch,
  type ApiError,
  type BatchResultLine,
  type LLMHost,
  type LLMProvider,
  type MessageBatchReply,
  type MessageReply,
} from '../../src/core/llm.ts';
import { parseUnits } from '../../src/core/tags.ts';

// 假供應商（ADR-0062）：本機伺服器，說 Anthropic Messages 與 Message Batches，腳本化拒答、截斷、
// 429、5xx、批次的處理中、單筆錯誤、過期、取消與結果亂序（ADR-0104 第 24 項、ADR-0107）。
// CI 不放金鑰，也不連外，流程的每條路都靠它走到。批次的行為照 2026-11-02 讀的官方文件。

export interface FakeRequest {
  readonly body: Readonly<Record<string, unknown>>;
  /** `user` 訊息的內容。 */
  readonly user: string;
  readonly model: string;
  /** 批次裡的請求才有。 */
  readonly customId?: string;
  readonly batch?: string;
}

interface FakeUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export type FakeReply =
  | { readonly text: string; readonly stop_reason?: string; readonly usage?: FakeUsage }
  | { readonly refusal: true; readonly category?: string | null; readonly usage?: FakeUsage }
  /** 即時模式才用得到：HTTP 狀態碼與斷線。 */
  | { readonly status: number; readonly retryAfter?: number }
  | { readonly drop: true }
  /** 批次裡才用得到：單筆的結果。 */
  | { readonly errored: string }
  | { readonly expired: true }
  | { readonly canceled: true };

export type FakeScript = (request: FakeRequest, index: number) => FakeReply;

/** 批次的行為，測試中途可以改。 */
export interface FakeBatchOptions {
  /** 查幾次還在處理，之後才結束。 */
  polls: number;
  /** 結果倒過來給，跟送出的順序不同。 */
  reverse: boolean;
  /** 建立批次時回這個狀態碼，不建立。 */
  createStatus: number | null;
  /** 建立了批次卻不回應，模擬送出之後、記下遠端 ID 之前中斷。 */
  dropCreate: boolean;
  /** 查詢時回這個狀態碼。 */
  pollStatus: number | null;
  /** 刪除時回這個狀態碼，不刪除。 */
  deleteStatus: number | null;
  /** 結果已超過保留期限。 */
  archived: boolean;
  /** 取消時，前面這麼多個請求已經處理完，照樣有結果。 */
  keepOnCancel: number;
  /** `list` 每頁幾個。 */
  pageSize: number;
}

export interface FakeBatch {
  readonly id: string;
  readonly createdAt: string;
  readonly items: readonly { readonly customId: string; readonly reply: FakeReply }[];
  polls: number;
  canceled: boolean;
  deleted: boolean;
  /** 結果檔第一次下載時才定下來，之後每次下載都一樣，跟真的 API 相同。 */
  lines?: readonly string[];
}

export interface FakeProvider {
  readonly url: string;
  readonly requests: readonly FakeRequest[];
  readonly batches: readonly FakeBatch[];
  readonly batch: FakeBatchOptions;
  /** 別本書或別的程式送的批次，同一個工作區看得到。 */
  addForeignBatch(options: { readonly requests: number; readonly createdAt?: string; readonly polls?: number }): FakeBatch;
}

const DEFAULT_BATCH: FakeBatchOptions = {
  polls: 0,
  reverse: false,
  createStatus: null,
  dropCreate: false,
  pollStatus: null,
  deleteStatus: null,
  archived: false,
  keepOnCancel: 0,
  pageSize: 20,
};

const DAY_MS = 24 * 60 * 60 * 1000;
// 訊息 ID 在所有假供應商之間都不重複，跟真的 API 一樣：帳本以它判斷同一個請求記過帳沒有。
let messages = 0;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function send(response: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  send(response, status, { type: 'error', error: { type: 'fake_error', message: 'scripted' } }, headers);
}

function userOf(body: Readonly<Record<string, unknown>>): string {
  const messages = body['messages'] as readonly { content: string }[] | undefined;
  return messages?.[0]?.content ?? '';
}

/** 模型有回覆時的訊息本文。拒答也有 `usage`，部分類別要付費。 */
function message(scripted: Extract<FakeReply, { text: string } | { refusal: true }>): Readonly<Record<string, unknown>> {
  messages += 1;
  const id = `msg_${messages}`;
  if ('refusal' in scripted) {
    return {
      id,
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: scripted.category ?? null, explanation: null },
      usage: scripted.usage ?? { input_tokens: 10, output_tokens: 0 },
    };
  }
  return {
    id,
    content: [{ type: 'text', text: scripted.text }],
    stop_reason: scripted.stop_reason ?? 'end_turn',
    stop_details: null,
    usage: scripted.usage ?? { input_tokens: 100, output_tokens: 50 },
  };
}

function reply(response: ServerResponse, scripted: FakeReply): void {
  if ('drop' in scripted) {
    response.socket?.destroy();
    return;
  }
  if ('status' in scripted) {
    sendError(response, scripted.status, scripted.retryAfter === undefined ? {} : { 'retry-after': String(scripted.retryAfter) });
    return;
  }
  if ('text' in scripted || 'refusal' in scripted) {
    send(response, 200, message(scripted));
    return;
  }
  throw new RangeError('batch replies are not for the Messages API');
}

function ended(batch: FakeBatch): boolean {
  return batch.polls <= 0;
}

/** 單筆的結果。取消時已經處理完的照樣有結果（官方文件）。 */
function outcomeOf(batch: FakeBatch, index: number, options: FakeBatchOptions): FakeReply {
  const item = batch.items[index];
  if (item === undefined) throw new RangeError(`no item ${index}`);
  if (batch.canceled && index >= options.keepOnCancel) return { canceled: true };
  return item.reply;
}

function resultLine(customId: string, scripted: FakeReply): Readonly<Record<string, unknown>> {
  if ('text' in scripted || 'refusal' in scripted) {
    return { custom_id: customId, result: { type: 'succeeded', message: message(scripted) } };
  }
  if ('errored' in scripted) {
    const error = { type: 'error', error: { type: scripted.errored, message: 'scripted' }, request_id: null };
    return { custom_id: customId, result: { type: 'errored', error } };
  }
  if ('expired' in scripted) return { custom_id: customId, result: { type: 'expired' } };
  if ('canceled' in scripted) return { custom_id: customId, result: { type: 'canceled' } };
  throw new RangeError('scripted HTTP failures cannot be batch results');
}

/** `request_counts` 除了 `processing`，要等整批結束才有數字（官方文件）。 */
function batchObject(batch: FakeBatch, options: FakeBatchOptions): MessageBatchReply {
  const done = ended(batch);
  const counts = { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 };
  batch.items.forEach((_item, index) => {
    if (!done) {
      counts.processing += 1;
      return;
    }
    const scripted = outcomeOf(batch, index, options);
    if ('text' in scripted || 'refusal' in scripted) counts.succeeded += 1;
    else if ('errored' in scripted) counts.errored += 1;
    else if ('expired' in scripted) counts.expired += 1;
    else counts.canceled += 1;
  });
  const created = Date.parse(batch.createdAt);
  return {
    id: batch.id,
    processing_status: done ? 'ended' : batch.canceled ? 'canceling' : 'in_progress',
    request_counts: counts,
    created_at: batch.createdAt,
    expires_at: new Date(created + DAY_MS).toISOString(),
    ended_at: done ? new Date().toISOString() : null,
    archived_at: options.archived ? new Date(created + 29 * DAY_MS).toISOString() : null,
  };
}

/** 起一個只聽本機的伺服器，測試結束就關。 */
export async function startFakeProvider(script: FakeScript, options: Partial<FakeBatchOptions> = {}): Promise<FakeProvider> {
  const requests: FakeRequest[] = [];
  const batches: FakeBatch[] = [];
  const batch: FakeBatchOptions = { ...DEFAULT_BATCH, ...options };
  const live = (id: string): FakeBatch | undefined => batches.find((entry) => entry.id === id && !entry.deleted);

  const createBatch = (response: ServerResponse, body: Readonly<Record<string, unknown>>): void => {
    if (batch.createStatus !== null) {
      sendError(response, batch.createStatus);
      return;
    }
    const id = `msgbatch_${batches.length + 1}`;
    const sent = (body['requests'] ?? []) as readonly { custom_id: string; params: Readonly<Record<string, unknown>> }[];
    const items = sent.map(({ custom_id, params }) => {
      const seen = { body: params, user: userOf(params), model: String(params['model'] ?? ''), customId: custom_id, batch: id };
      const index = requests.length;
      requests.push(seen);
      return { customId: custom_id, reply: script(seen, index) };
    });
    const created: FakeBatch = { id, createdAt: new Date().toISOString(), items, polls: batch.polls, canceled: false, deleted: false };
    batches.push(created);
    if (batch.dropCreate) {
      response.socket?.destroy();
      return;
    }
    send(response, 200, batchObject(created, batch));
  };

  const results = (response: ServerResponse, found: FakeBatch): void => {
    if (!ended(found) || batch.archived) {
      sendError(response, batch.archived ? 404 : 400);
      return;
    }
    if (found.lines === undefined) {
      const lines = found.items.map(({ customId }, index) =>
        JSON.stringify(resultLine(customId, outcomeOf(found, index, batch))),
      );
      found.lines = batch.reverse ? lines.reverse() : lines;
    }
    response.writeHead(200, { 'content-type': 'application/x-jsonl' });
    response.end(found.lines.join('\n'));
  };

  const list = (response: ServerResponse, after: string | null): void => {
    const newest = batches.filter(({ deleted }) => !deleted).reverse();
    const start = after === null ? 0 : newest.findIndex(({ id }) => id === after) + 1;
    const page = newest.slice(start, start + batch.pageSize);
    const more = start + page.length < newest.length;
    send(response, 200, {
      data: page.map((entry) => batchObject(entry, batch)),
      has_more: more,
      first_id: page[0]?.id ?? null,
      last_id: page.at(-1)?.id ?? null,
    });
  };

  const batchRoute = (request: IncomingMessage, response: ServerResponse, url: URL, body: Readonly<Record<string, unknown>>): void => {
    const [, id, action] = /^\/v1\/messages\/batches(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(url.pathname) ?? [];
    if (id === undefined) {
      if (request.method === 'POST') createBatch(response, body);
      else list(response, url.searchParams.get('after_id') || null);
      return;
    }
    const found = live(id);
    if (found === undefined) {
      sendError(response, 404);
      return;
    }
    if (action === 'results') {
      results(response, found);
      return;
    }
    if (action === 'cancel') {
      found.canceled = true;
      send(response, 200, batchObject(found, batch));
      return;
    }
    if (request.method === 'DELETE') {
      if (batch.deleteStatus !== null || !ended(found)) {
        sendError(response, batch.deleteStatus ?? 400);
        return;
      }
      found.deleted = true;
      send(response, 200, { id, type: 'message_batch_deleted' });
      return;
    }
    if (batch.pollStatus !== null) {
      sendError(response, batch.pollStatus);
      return;
    }
    // 每查一次少一次「還在處理」。
    const shown = batchObject(found, batch);
    if (!ended(found)) found.polls -= 1;
    send(response, 200, shown);
  };

  const server = createServer((request, response) => {
    void readBody(request).then((text) => {
      const body = JSON.parse(text === '' ? '{}' : text) as Readonly<Record<string, unknown>>;
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/v1/messages/batches')) {
        batchRoute(request, response, url, body);
        return;
      }
      const seen = { body, user: userOf(body), model: String(body['model'] ?? '') };
      const index = requests.length;
      requests.push(seen);
      reply(response, script(seen, index));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  const addForeignBatch: FakeProvider['addForeignBatch'] = ({ requests: count, createdAt, polls = 0 }) => {
    const items = Array.from({ length: count }, (_unused, index) => ({
      customId: `foreign-${batches.length + 1}-${index + 1}`,
      reply: { text: '<s id="1">foreign</s>' },
    }));
    const foreign: FakeBatch = {
      id: `msgbatch_${batches.length + 1}`,
      createdAt: createdAt ?? new Date().toISOString(),
      items,
      polls,
      canceled: false,
      deleted: false,
    };
    batches.push(foreign);
    return foreign;
  };
  return { url: `http://127.0.0.1:${port}`, requests, batches, batch, addForeignBatch };
}

export interface FakeHost extends LLMHost {
  /** 退避與輪詢等了幾秒，測試不用真的等。 */
  readonly waits: readonly number[];
}

/**
 * 測試用的轉接層。真的轉接層在 brief 022 才有，這裡用同樣的 `fetch` 與判斷函式走完整條路。
 * `endpoint` 預設是假供應商，傳 null 就是正式的端點，這時連到本機會被白名單擋下。
 */
export function fakeHost(provider: FakeProvider, endpoint: string | null = provider.url): FakeHost {
  const waits: number[] = [];
  const connect = (fetcher: GuardedFetch): LLMProvider => {
    /** 連不上回 `error`，個資閘門與白名單的錯誤照樣丟出去。 */
    const call = async <T>(path: string, init: RequestInit, read: (response: Response) => Promise<T>): Promise<T | ApiError> => {
      let response: Response;
      try {
        response = await fetcher(`${provider.url}${path}`, init);
      } catch (error) {
        if (error instanceof TomeError) throw error;
        return { outcome: 'error', status: null, retryAfter: null };
      }
      if (response.ok) return read(response);
      const retryAfter = response.headers.get('retry-after');
      return { outcome: 'error', status: response.status, retryAfter: retryAfter === null ? null : Number(retryAfter) };
    };
    const batchOf = async (response: Response) => remoteBatch((await response.json()) as MessageBatchReply);
    return {
      id: 'fake',
      sdkVersion: '0.0.0-fake',
      send: (body) =>
        call('/v1/messages', { method: 'POST', body: JSON.stringify(body) }, async (response) =>
          messageResult((await response.json()) as MessageReply),
        ),
      submitBatch: (requests) => {
        const body = { requests: requests.map(({ customId, body: params }) => ({ custom_id: customId, params })) };
        return call('/v1/messages/batches', { method: 'POST', body: JSON.stringify(body) }, batchOf);
      },
      pollBatch: (id) => call(`/v1/messages/batches/${id}`, { method: 'GET' }, batchOf),
      collectBatch: (id) =>
        call(`/v1/messages/batches/${id}/results`, { method: 'GET' }, async (response) =>
          (await response.text())
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => batchItem(JSON.parse(line) as BatchResultLine)),
        ),
      cancelBatch: (id) => call(`/v1/messages/batches/${id}/cancel`, { method: 'POST' }, batchOf),
      deleteRemote: (id) => call(`/v1/messages/batches/${id}`, { method: 'DELETE' }, async () => null),
      listBatches: (after) =>
        call(`/v1/messages/batches${after === null ? '' : `?after_id=${after}`}`, { method: 'GET' }, async (response) => {
          const page = (await response.json()) as { data: MessageBatchReply[]; has_more: boolean; last_id: string | null };
          return { batches: page.data.map(remoteBatch), next: page.has_more ? page.last_id : null };
        }),
    };
  };
  const sleep = async (seconds: number): Promise<void> => void waits.push(seconds);
  return { connect, sleep, waits, ...(endpoint === null ? {} : { endpoint }) };
}

/** 把每個單位原樣翻回去，佔位符與數字都留著，一定過得了驗證。 */
export function translated(user: string): string {
  return parseUnits(user)
    .units.map(({ id, raw }) => `<s id="${id}">譯：${raw.slice(raw.indexOf('>') + 1, raw.lastIndexOf('</s>'))}</s>`)
    .join('\n');
}
