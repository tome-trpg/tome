import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { onTestFinished } from 'vitest';
import type { GuardedFetch } from '../../src/core/egress/client.ts';
import { TomeError } from '../../src/core/errors.ts';
import { messageResult, type LLMHost, type LLMProvider, type MessageReply } from '../../src/core/llm.ts';
import { parseUnits } from '../../src/core/tags.ts';

// 假供應商（ADR-0062）：本機伺服器，說 Anthropic Messages，腳本化拒答、截斷、429 與 5xx。
// CI 不放金鑰，也不連外，流程的每條路都靠它走到。

export interface FakeRequest {
  readonly body: Readonly<Record<string, unknown>>;
  /** `user` 訊息的內容。 */
  readonly user: string;
  readonly model: string;
}

interface FakeUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export type FakeReply =
  | { readonly text: string; readonly stop_reason?: string; readonly usage?: FakeUsage }
  | { readonly refusal: true; readonly category?: string | null; readonly usage?: FakeUsage }
  | { readonly status: number; readonly retryAfter?: number }
  | { readonly drop: true };

export type FakeScript = (request: FakeRequest, index: number) => FakeReply;

export interface FakeProvider {
  readonly url: string;
  readonly requests: readonly FakeRequest[];
}

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

function userOf(body: Readonly<Record<string, unknown>>): string {
  const messages = body['messages'] as readonly { content: string }[] | undefined;
  return messages?.[0]?.content ?? '';
}

function reply(response: ServerResponse, scripted: FakeReply, index: number): void {
  if ('drop' in scripted) {
    response.socket?.destroy();
    return;
  }
  if ('status' in scripted) {
    const headers = scripted.retryAfter === undefined ? {} : { 'retry-after': String(scripted.retryAfter) };
    send(response, scripted.status, { type: 'error', error: { type: 'fake_error', message: 'scripted' } }, headers);
    return;
  }
  const id = `msg_${index + 1}`;
  if ('refusal' in scripted) {
    send(response, 200, {
      id,
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: scripted.category ?? null, explanation: null },
      usage: scripted.usage ?? { input_tokens: 10, output_tokens: 0 },
    });
    return;
  }
  send(response, 200, {
    id,
    content: [{ type: 'text', text: scripted.text }],
    stop_reason: scripted.stop_reason ?? 'end_turn',
    stop_details: null,
    usage: scripted.usage ?? { input_tokens: 100, output_tokens: 50 },
  });
}

/** 起一個只聽本機的伺服器，測試結束就關。 */
export async function startFakeProvider(script: FakeScript): Promise<FakeProvider> {
  const requests: FakeRequest[] = [];
  const server = createServer((request, response) => {
    void readBody(request).then((text) => {
      const body = JSON.parse(text === '' ? '{}' : text) as Readonly<Record<string, unknown>>;
      const seen = { body, user: userOf(body), model: String(body['model'] ?? '') };
      const index = requests.length;
      requests.push(seen);
      reply(response, script(seen, index), index);
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
  return { url: `http://127.0.0.1:${port}`, requests };
}

export interface FakeHost extends LLMHost {
  /** 退避等了幾秒，測試不用真的等。 */
  readonly waits: readonly number[];
}

/**
 * 測試用的轉接層。真的轉接層在 brief 022 才有，這裡用同樣的 `fetch` 與判斷函式走完整條路。
 * `endpoint` 預設是假供應商，傳 null 就是正式的端點，這時連到本機會被白名單擋下。
 */
export function fakeHost(provider: FakeProvider, endpoint: string | null = provider.url): FakeHost {
  const waits: number[] = [];
  const connect = (fetcher: GuardedFetch): LLMProvider => ({
    id: 'fake',
    sdkVersion: '0.0.0-fake',
    send: async (body) => {
      let response: Response;
      try {
        response = await fetcher(`${provider.url}/v1/messages`, { method: 'POST', body: JSON.stringify(body) });
      } catch (error) {
        if (error instanceof TomeError) throw error;
        return { outcome: 'error', status: null, retryAfter: null };
      }
      if (response.ok) return messageResult((await response.json()) as MessageReply);
      const retryAfter = response.headers.get('retry-after');
      return { outcome: 'error', status: response.status, retryAfter: retryAfter === null ? null : Number(retryAfter) };
    },
  });
  const sleep = async (seconds: number): Promise<void> => void waits.push(seconds);
  return { connect, sleep, waits, ...(endpoint === null ? {} : { endpoint }) };
}

/** 把每個單位原樣翻回去，佔位符與數字都留著，一定過得了驗證。 */
export function translated(user: string): string {
  return parseUnits(user)
    .units.map(({ id, raw }) => `<s id="${id}">譯：${raw.slice(raw.indexOf('>') + 1, raw.lastIndexOf('</s>'))}</s>`)
    .join('\n');
}
