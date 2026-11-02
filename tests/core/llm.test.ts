import { describe, expect, it } from 'vitest';
import {
  BACKOFF_SECONDS,
  RETRYABLE_BATCH_ERRORS,
  batchItem,
  isApiError,
  messageResult,
  remoteBatch,
  retryableSubmit,
  sendWithRetry,
  withRetry,
  type LLMProvider,
  type RequestResult,
} from '../../src/core/llm.ts';
import type { MessagesBody } from '../../src/core/request.ts';

const BODY: MessagesBody = { model: 'm', max_tokens: 1024, system: 's', messages: [{ role: 'user', content: 'u' }] };

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 };
const OK: RequestResult = { outcome: 'ok', requestId: 'msg_1', text: 'done', usage: USAGE };

function failure(status: number | null, retryAfter: number | null = null): RequestResult {
  return { outcome: 'error', status, retryAfter };
}

const unused = (): Promise<never> => Promise.reject(new Error('not used'));

/** 這裡只測即時的請求，Batch 的方法用不到。 */
const NO_BATCH = {
  submitBatch: unused,
  pollBatch: unused,
  collectBatch: unused,
  cancelBatch: unused,
  deleteRemote: unused,
  listBatches: unused,
};

/** 依序回傳腳本的結果，最後一個一直重複。 */
function scripted(results: readonly RequestResult[]): { provider: LLMProvider; sent: () => number } {
  let sent = 0;
  const provider: LLMProvider = {
    ...NO_BATCH,
    id: 'fake',
    sdkVersion: '0.0.0',
    send: async () => {
      sent += 1;
      const result = results[Math.min(sent, results.length) - 1];
      if (result === undefined) throw new Error('the script is empty');
      return result;
    },
  };
  return { provider, sent: () => sent };
}

function clock(): { sleep: (seconds: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { waits, sleep: async (seconds) => void waits.push(seconds) };
}

describe('sendWithRetry (ADR-0104)', () => {
  it('sends once when the first answer is good', async () => {
    const { provider, sent } = scripted([OK]);
    const { sleep, waits } = clock();
    expect(await sendWithRetry(provider, BODY, sleep)).toEqual(OK);
    expect(sent()).toBe(1);
    expect(waits).toEqual([]);
  });

  it.each([[429], [500], [503], [529], [null]])('retries status %s', async (status) => {
    const { provider, sent } = scripted([failure(status), OK]);
    const { sleep, waits } = clock();
    expect(await sendWithRetry(provider, BODY, sleep)).toEqual(OK);
    expect(sent()).toBe(2);
    expect(waits).toEqual([1]);
  });

  it.each([[400], [401], [403], [404], [413]])('gives up on status %s at once', async (status) => {
    const { provider, sent } = scripted([failure(status)]);
    const { sleep, waits } = clock();
    expect(await sendWithRetry(provider, BODY, sleep)).toEqual(failure(status));
    expect(sent()).toBe(1);
    expect(waits).toEqual([]);
  });

  it('backs off 1, 2, 4, 8 and 16 seconds, then gives up', async () => {
    const { provider, sent } = scripted([failure(429)]);
    const { sleep, waits } = clock();
    expect(await sendWithRetry(provider, BODY, sleep)).toEqual(failure(429));
    expect(waits).toEqual([1, 2, 4, 8, 16]);
    expect(BACKOFF_SECONDS).toEqual(waits);
    expect(sent()).toBe(6);
  });

  it('takes the wait from retry-after when the provider gives one', async () => {
    const { provider } = scripted([failure(429, 30), failure(503), OK]);
    const { sleep, waits } = clock();
    await sendWithRetry(provider, BODY, sleep);
    expect(waits).toEqual([30, 2]);
  });

  it('does not retry a refusal, which is not a failure of the connection', async () => {
    const refused: RequestResult = { outcome: 'refused', requestId: 'msg_2', category: null, usage: USAGE };
    const { provider, sent } = scripted([refused]);
    expect(await sendWithRetry(provider, BODY, clock().sleep)).toEqual(refused);
    expect(sent()).toBe(1);
  });

  it('lets an error of the gate through, as nothing went out', async () => {
    const blocked = new Error('blocked');
    const provider: LLMProvider = { ...NO_BATCH, id: 'fake', sdkVersion: '0.0.0', send: () => Promise.reject(blocked) };
    await expect(sendWithRetry(provider, BODY, clock().sleep)).rejects.toBe(blocked);
  });
});

describe('messageResult (ADR-0104)', () => {
  const usage = { input_tokens: 10, output_tokens: 5 };

  it('joins the text and leaves thinking out', () => {
    const result = messageResult({
      id: 'msg_1',
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking' },
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ],
      usage,
    });
    expect(result).toEqual({ outcome: 'ok', requestId: 'msg_1', text: 'onetwo', usage: USAGE });
  });

  it('counts the cache tokens', () => {
    const result = messageResult({
      id: 'msg_1',
      stop_reason: 'end_turn',
      content: [],
      usage: { ...usage, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
    });
    expect(result).toMatchObject({ usage: { ...USAGE, cache_read_tokens: 7, cache_write_tokens: 3 } });
  });

  it('calls a cut-off reply truncated', () => {
    const result = messageResult({ id: 'msg_1', stop_reason: 'max_tokens', content: [], usage });
    expect(result.outcome).toBe('truncated');
  });

  // Batch 回 `succeeded` 的結果也是這個形狀，要看 `stop_reason`（白皮書 §5.7）。
  it('sees a refusal in a reply that otherwise looks successful', () => {
    const result = messageResult({
      id: 'msg_1',
      stop_reason: 'refusal',
      stop_details: { category: 'general_harms' },
      content: [{ type: 'text', text: 'partial' }],
      usage,
    });
    expect(result).toEqual({ outcome: 'refused', requestId: 'msg_1', category: 'general_harms', usage: USAGE });
  });

  it('keeps a refusal that names no category', () => {
    const result = messageResult({ id: 'msg_1', stop_reason: 'refusal', stop_details: null, content: [], usage });
    expect(result).toMatchObject({ outcome: 'refused', category: null });
  });
});

// 批次的結果與物件照 2026-11-02 讀的官方文件。
describe('batchItem (ADR-0107 item 19)', () => {
  const usage = { input_tokens: 10, output_tokens: 5 };

  it('reads a refusal that the batch calls succeeded', () => {
    const item = batchItem({
      custom_id: 'tome-0123456789abcdef-1',
      result: { type: 'succeeded', message: { id: 'msg_1', stop_reason: 'refusal', stop_details: { category: 'bio' }, content: [], usage } },
    });
    expect(item).toEqual({
      customId: 'tome-0123456789abcdef-1',
      result: { outcome: 'refused', requestId: 'msg_1', category: 'bio', usage: USAGE },
    });
  });

  it('reads a reply and a cut-off reply the same way as realtime', () => {
    const message = { id: 'msg_1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage };
    expect(batchItem({ custom_id: 'c', result: { type: 'succeeded', message } }).result).toEqual(OK);
    const cut = { ...message, stop_reason: 'max_tokens' };
    expect(batchItem({ custom_id: 'c', result: { type: 'succeeded', message: cut } }).result.outcome).toBe('truncated');
  });

  it('takes the kind of an error from the error inside the error', () => {
    const error = { type: 'error', error: { type: 'overloaded_error', message: 'busy' }, request_id: null };
    expect(batchItem({ custom_id: 'c', result: { type: 'errored', error } }).result).toEqual({
      outcome: 'errored',
      type: 'overloaded_error',
    });
    expect(batchItem({ custom_id: 'c', result: { type: 'errored' } }).result).toEqual({ outcome: 'errored', type: 'unknown' });
  });

  it('keeps expired and canceled apart', () => {
    expect(batchItem({ custom_id: 'c', result: { type: 'expired' } }).result).toEqual({ outcome: 'expired' });
    expect(batchItem({ custom_id: 'c', result: { type: 'canceled' } }).result).toEqual({ outcome: 'canceled' });
  });

  it('retries only the kinds of errors that may pass next time', () => {
    expect(RETRYABLE_BATCH_ERRORS).toEqual(['rate_limit_error', 'timeout_error', 'api_error', 'overloaded_error']);
  });
});

describe('remoteBatch', () => {
  it('turns the batch of the provider into ours', () => {
    const counts = { processing: 0, succeeded: 2, errored: 1, canceled: 0, expired: 0 };
    const batch = remoteBatch({
      id: 'msgbatch_1',
      processing_status: 'ended',
      request_counts: counts,
      created_at: '2026-11-05T10:12:00Z',
      expires_at: '2026-11-06T10:12:00Z',
      ended_at: '2026-11-05T10:40:00Z',
    });
    expect(batch).toEqual({
      id: 'msgbatch_1',
      status: 'ended',
      counts,
      createdAt: '2026-11-05T10:12:00Z',
      expiresAt: '2026-11-06T10:12:00Z',
      endedAt: '2026-11-05T10:40:00Z',
      archivedAt: null,
    });
  });
});

describe('withRetry for a batch (ADR-0107 items 8 and 12)', () => {
  function calls(results: readonly unknown[]): { call: () => Promise<unknown>; count: () => number } {
    let count = 0;
    return {
      call: async () => results[Math.min((count += 1), results.length) - 1],
      count: () => count,
    };
  }

  it('retries a poll that got no reply', async () => {
    const { call, count } = calls([failure(null), { id: 'msgbatch_1' }]);
    const { sleep, waits } = clock();
    expect(await withRetry(call, sleep)).toEqual({ id: 'msgbatch_1' });
    expect(count()).toBe(2);
    expect(waits).toEqual([1]);
  });

  it('does not create a batch again when no reply came, which may have made one', async () => {
    const { call, count } = calls([failure(null), { id: 'msgbatch_1' }]);
    expect(await withRetry(call, clock().sleep, retryableSubmit)).toEqual(failure(null));
    expect(count()).toBe(1);
  });

  it('creates it again after a 429 or 5xx, which made nothing', async () => {
    const { call, count } = calls([failure(429), failure(503), { id: 'msgbatch_1' }]);
    expect(await withRetry(call, clock().sleep, retryableSubmit)).toEqual({ id: 'msgbatch_1' });
    expect(count()).toBe(3);
  });

  it('takes null, an empty list and a batch as success', () => {
    expect(isApiError(null)).toBe(false);
    expect(isApiError([])).toBe(false);
    expect(isApiError({ id: 'msgbatch_1' })).toBe(false);
    expect(isApiError(failure(500))).toBe(true);
  });
});
