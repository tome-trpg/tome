import { describe, expect, it } from 'vitest';
import { BACKOFF_SECONDS, messageResult, sendWithRetry, type LLMProvider, type RequestResult } from '../../src/core/llm.ts';
import type { MessagesBody } from '../../src/core/request.ts';

const BODY: MessagesBody = { model: 'm', max_tokens: 1024, system: 's', messages: [{ role: 'user', content: 'u' }] };

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 };
const OK: RequestResult = { outcome: 'ok', requestId: 'msg_1', text: 'done', usage: USAGE };

function failure(status: number | null, retryAfter: number | null = null): RequestResult {
  return { outcome: 'error', status, retryAfter };
}

/** 依序回傳腳本的結果，最後一個一直重複。 */
function scripted(results: readonly RequestResult[]): { provider: LLMProvider; sent: () => number } {
  let sent = 0;
  const provider: LLMProvider = {
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
    const provider: LLMProvider = { id: 'fake', sdkVersion: '0.0.0', send: () => Promise.reject(blocked) };
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
