import { describe, expect, it } from 'vitest';
import { anthropicHost } from '../../src/core/egress/anthropic.ts';
import { guardedFetch } from '../../src/core/egress/client.ts';
import { isApiError, sleepSeconds, type BatchItem, type LLMProvider, type RemoteBatch } from '../../src/core/llm.ts';
import { testProvider } from '../../src/core/provider-test.ts';
import { loadProvider } from '../../src/core/provider.ts';
import type { MessagesBody } from '../../src/core/request.ts';

// 對真的 Anthropic API 的契約測試（ADR-0062、ADR-0099 第 26 項、ADR-0109 第 10 項）。
// `npm test` 不跑，CI 也不跑。要執行時設 `TOME_ANTHROPIC_API_KEY`，再跑 `npm run test:contract`，
// 沒有金鑰就整個跳過。內容都是合成文字，不放書本文字。即時請求約 300 個 token，用 Haiku 5.5，
// 不到 0.001 美元。批次可能要等很久，另外設 `TOME_CONTRACT_BATCH=1` 才跑。

const key = process.env['TOME_ANTHROPIC_API_KEY'];
const { profile } = loadProvider('anthropic');
const MODEL = 'claude-haiku-5-5';
const BATCH_POLL_SECONDS = 60;

function body(): MessagesBody {
  return {
    model: MODEL,
    max_tokens: 64,
    system: 'Reply with the single word ok.',
    messages: [{ role: 'user', content: 'This is a synthetic contract test of TOME.' }],
  };
}

function connect(secret: string): LLMProvider {
  const fetcher = guardedFetch({
    endpoint: profile.endpoint,
    provider: profile.id,
    rules: { pii: [], exceptions: [] },
    record: () => undefined,
  });
  return anthropicHost(secret).connect(fetcher, profile.endpoint);
}

describe.skipIf(key === undefined || key === '')('the Anthropic API, for real', () => {
  const secret = key ?? '';

  it('agrees with the model list, and spends no token', async () => {
    const { findings } = await testProvider(anthropicHost(secret));
    expect(findings.filter(({ level }) => level === 'fail')).toEqual([]);
  });

  it('answers a small request the way the core reads it', async () => {
    const result = await connect(secret).send(body());
    expect(result).toMatchObject({ outcome: 'ok' });
    if (result.outcome === 'ok') expect(result.usage.input_tokens).toBeGreaterThan(0);
  });

  it.runIf(process.env['TOME_CONTRACT_BATCH'] === '1')(
    'creates, collects and deletes a small batch',
    async () => {
      const llm = connect(secret);
      const created = await llm.submitBatch([
        { customId: 'tome-contract-1', body: body() },
        { customId: 'tome-contract-2', body: body() },
      ]);
      if (isApiError(created)) throw new Error(`create failed: ${created.status ?? '-'}`);
      let batch: RemoteBatch = created;
      while (batch.status !== 'ended') {
        await sleepSeconds(BATCH_POLL_SECONDS);
        const polled = await llm.pollBatch(created.id);
        if (isApiError(polled)) throw new Error(`poll failed: ${polled.status ?? '-'}`);
        batch = polled;
      }
      const items = (await llm.collectBatch(created.id)) as readonly BatchItem[];
      expect(items.map(({ customId }) => customId).sort()).toEqual(['tome-contract-1', 'tome-contract-2']);
      expect(await llm.deleteRemote(created.id)).toBeNull();
    },
    24 * 60 * 60 * 1000,
  );
});
