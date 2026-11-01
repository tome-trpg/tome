import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { onTestFinished } from 'vitest';

// 假供應商（ADR-0062）：本機伺服器，說 Anthropic Messages，腳本化拒答、截斷、429 與 5xx。
// CI 不放金鑰，也不連外，流程的每條路都靠它走到。

export interface FakeRequest {
  readonly body: Readonly<Record<string, unknown>>;
  /** `user` 訊息的內容。 */
  readonly user: string;
  readonly model: string;
}

export type FakeReply =
  | {
      readonly text: string;
      readonly stop_reason?: string;
      readonly usage?: { readonly input_tokens: number; readonly output_tokens: number };
    }
  | { readonly refusal: true; readonly category?: string | null }
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

function reply(response: ServerResponse, scripted: FakeReply): void {
  if ('drop' in scripted) {
    response.socket?.destroy();
    return;
  }
  if ('status' in scripted) {
    const headers = scripted.retryAfter === undefined ? {} : { 'retry-after': String(scripted.retryAfter) };
    send(response, scripted.status, { type: 'error', error: { type: 'fake_error', message: 'scripted' } }, headers);
    return;
  }
  if ('refusal' in scripted) {
    send(response, 200, {
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: scripted.category ?? null, explanation: null },
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    return;
  }
  send(response, 200, {
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
      requests.push(seen);
      reply(response, script(seen, requests.length - 1));
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
