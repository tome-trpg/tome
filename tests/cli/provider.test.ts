import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findingText } from '../../src/cli/messages.ts';
import type { Envelope } from '../../src/cli/output.ts';
import { run } from '../../src/cli/run.ts';
import type { ModelReply } from '../../src/core/provider-test.ts';
import { loadProvider, type ProviderModel } from '../../src/core/provider.ts';
import type { SecretStore } from '../../src/core/secrets.ts';
import { adapterHost, startFakeProvider, type FakeHost, type FakeProvider } from '../helpers/fake-provider.ts';
import { capture, MemorySecretStore, tempDir, type Captured } from '../helpers.ts';

// 價格從 `providers/anthropic.yaml` 讀，查證時改了價格，這裡不用跟著改。

const { profile } = loadProvider('anthropic');

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** 碰到憑證庫就失敗：這個指令用不到金鑰。 */
const NO_KEYS: SecretStore = {
  get: () => Promise.reject(new Error('read a key')),
  set: () => Promise.reject(new Error('wrote a key')),
  delete: () => Promise.reject(new Error('deleted a key')),
};

function session(env: NodeJS.ProcessEnv = {}): Captured {
  return capture({ env, secrets: NO_KEYS });
}

async function list(): Promise<{ exit: number; output: Envelope; text: string }> {
  const { io, stdout } = session();
  const exit = await run(['provider', 'list', '--json'], io);
  return { exit, output: JSON.parse(stdout()) as Envelope, text: stdout() };
}

function messages(output: Envelope): string[] {
  return output.findings.map(({ message }) => message);
}

interface ListedProvider {
  readonly id: string;
  readonly models: readonly Record<string, unknown>[];
}

function listed(output: Envelope): ListedProvider[] {
  return output.data['providers'] as ListedProvider[];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('tome provider list (ADR-0106)', () => {
  it('says what it is first, and that the list is no recommendation', async () => {
    const { exit, output } = await list();
    expect(exit).toBe(0);
    expect(messages(output)[0]).toBe(
      `anthropic：端點 ${profile.endpoint}，批次資料最多在供應商端保留 ${profile.retention_days} 天。以下是 TOME 知道怎麼呼叫的模型，不是推薦，尚未經過盲評。`,
    );
  });

  it('has one line for each model, in the order of the file', async () => {
    const { output } = await list();
    const lines = output.findings.filter(({ code }) => code === 'provider.model').map(({ params }) => params['model']);
    expect(lines).toEqual(profile.models.map(({ id }) => id));
    expect(lines.length).toBeGreaterThan(0);
  });

  it.each(profile.models.map(({ id, price }) => [id, price] as const))('prices %s', async (id, price) => {
    const { output } = await list();
    expect(messages(output)).toContain(
      `${id}：即時 ${money(price.input)}／${money(price.output)}，批次 ${money(price.batch_input)}／${money(price.batch_output)}（每百萬 token，輸入／輸出）。`,
    );
  });

  it('says when a long prompt moves to another price, right after that model', async () => {
    const { output } = await list();
    const model = profile.models.find(({ long_prompt }) => long_prompt !== undefined);
    const long = model?.long_prompt;
    if (model === undefined || long === undefined) throw new Error('no model has a long prompt price');
    const { price } = long;
    const lines = messages(output);
    const line = `${model.id} 的 prompt 超過 ${long.over_tokens} token 時，改為即時 ${money(price.input)}／${money(price.output)}，批次 ${money(price.batch_input)}／${money(price.batch_output)}。`;
    expect(lines).toContain(line);
    expect(lines[lines.indexOf(line) - 1]?.startsWith(`${model.id}：`)).toBe(true);
  });

  it('prints a line only for the models that have a long prompt price', async () => {
    const { output } = await list();
    const lines = output.findings.filter(({ code }) => code === 'provider.long_prompt').map(({ params }) => params['model']);
    expect(lines).toEqual(profile.models.filter((model) => model.long_prompt !== undefined).map(({ id }) => id));
  });

  it('ends with the day the prices were read', async () => {
    const { output } = await list();
    expect(output.findings.at(-1)).toMatchObject({ code: 'prices.ok', level: 'info' });
    expect(messages(output).at(-1)).toBe(`anthropic 的價目表查證日為 ${profile.verified}。`);
  });

  it('warns about old prices, and still exits 0', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(profile.verified) + 90 * 86_400_000 });
    const { exit, output } = await list();
    expect(exit).toBe(0);
    expect(output.findings.at(-1)).toMatchObject({ code: 'prices.stale', level: 'warn' });
  });

  it('prints the same words without --json', async () => {
    const { io, stdout } = session();
    expect(await run(['provider', 'list'], io)).toBe(0);
    const model = profile.models[0];
    if (model === undefined) throw new Error('no models');
    const { price } = model;
    expect(stdout()).toContain(
      findingText('provider.model', {
        model: model.id,
        input: price.input.toFixed(2),
        output: price.output.toFixed(2),
        batch_input: price.batch_input.toFixed(2),
        batch_output: price.batch_output.toFixed(2),
      }),
    );
  });

  it('takes no arguments', async () => {
    expect(await run(['provider', 'list', 'anthropic'], session().io)).toBe(2);
  });

  it('is in --help', async () => {
    const { io, stdout } = session();
    await run(['--help'], io);
    expect(stdout()).toContain('provider list');
  });

  it('lists translation, the batch commands and provider test in --help now (ADR-0109 item 7)', async () => {
    const { io, stdout } = session();
    await run(['--help'], io);
    for (const line of ['provider test', 'translate <名稱>   ', '[--realtime] [--retry-failed]', 'batch status <名稱>', 'batch collect <名稱>', 'batch cancel <名稱>']) {
      expect(stdout()).toContain(line);
    }
  });
});

describe('the data of tome provider list (ADR-0106)', () => {
  it('has the provider and its models', async () => {
    const { output } = await list();
    const [provider] = listed(output);
    expect(Object.keys(output.data)).toEqual(['providers']);
    expect(provider).toMatchObject({
      id: 'anthropic',
      endpoint: profile.endpoint,
      verified: profile.verified,
      retention_days: profile.retention_days,
    });
    expect(Object.keys(provider ?? {}).sort()).toEqual(['endpoint', 'id', 'models', 'retention_days', 'verified']);
    expect(provider?.models.map(({ id }) => id)).toEqual(profile.models.map(({ id }) => id));
  });

  it('keeps batch in the names of the keys', async () => {
    const { output } = await list();
    const [model] = profile.models;
    const [first] = listed(output)[0]?.models ?? [];
    expect(first).toEqual({
      id: model?.id,
      effective: model?.effective,
      price: {
        input: model?.price.input,
        output: model?.price.output,
        batch_input: model?.price.batch_input,
        batch_output: model?.price.batch_output,
      },
    });
  });

  it('has long_prompt only where the model has one', async () => {
    const { output } = await list();
    for (const model of listed(output)[0]?.models ?? []) {
      const known = profile.models.find(({ id }) => id === model['id']);
      expect('long_prompt' in model).toBe(known?.long_prompt !== undefined);
    }
    const long = listed(output)[0]?.models.find((model) => 'long_prompt' in model)?.['long_prompt'];
    expect(Object.keys((long as { price: object }).price).sort()).toEqual([
      'batch_input',
      'batch_output',
      'input',
      'output',
    ]);
  });

  // 快取 M2 沒開，思考倍數與估價比例沒量過，伺服器端回退還沒確認，TOME 也不用它。
  it.each([
    'cache_read',
    'cache_write',
    'thinking',
    'output_factor',
    'fallback',
    'chars_per_token',
    'retry_margin',
    'unit_input_tokens',
    'unit_output_tokens',
  ])(
    'leaves %s out',
    async (key) => {
      const { text } = await list();
      expect(text).not.toContain(key);
    },
  );
});

describe('what tome provider list needs (ADR-0106)', () => {
  it('needs no network', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect((await list()).exit).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('needs no key, and never opens the key store', async () => {
    const { exit } = await list();
    expect(exit).toBe(0);
  });

  it('needs no workspace, and makes none', async () => {
    const home = join(tempDir(), 'none');
    const { io } = session({ TOME_HOME: home });
    expect(await run(['provider', 'list'], io)).toBe(0);
    expect(existsSync(home)).toBe(false);
  });
});

/** 供應商回報的資料跟設定檔一致。 */
function matching(model: ProviderModel): ModelReply {
  const { mode } = model.thinking;
  return {
    id: model.id,
    allowed_fallback_models: model.fallback.server ? ['claude-opus-5'] : [],
    deprecated_at: null,
    capabilities: {
      batch: { supported: true },
      thinking: { types: { disabled: { supported: mode === 'disabled' }, between_tools: { supported: mode === 'between_tools' } } },
    },
  };
}

async function tested(change: (provider: FakeProvider) => void = () => undefined): Promise<{
  exit: number;
  output: Envelope;
  progress: string;
  provider: FakeProvider;
  host: FakeHost;
}> {
  const provider = await startFakeProvider(() => ({ status: 500 }));
  for (const model of profile.models) provider.models.set(model.id, matching(model));
  change(provider);
  const host = adapterHost(provider);
  const { io, stdout, stderr } = capture({ env: {}, secrets: NO_KEYS, llm: host });
  const exit = await run(['provider', 'test', '--json'], io);
  return { exit, output: JSON.parse(stdout()) as Envelope, progress: stderr(), provider, host };
}

function codes(output: Envelope): string[] {
  return output.findings.map(({ code }) => code);
}

describe('tome provider test (ADR-0103 item 6, ADR-0109 item 9)', () => {
  it('checks every model on the list against the Models API, and spends no token', async () => {
    const { exit, output, provider } = await tested();
    expect(exit).toBe(0);
    expect(codes(output)).toEqual(profile.models.map(() => 'provider.tested'));
    expect(output.findings.map(({ params }) => params['model'])).toEqual(profile.models.map(({ id }) => id));
    expect(provider.requests).toHaveLength(0);
    expect(provider.calls.map(({ path }) => path)).toEqual(profile.models.map(({ id }) => `/v1/models/${id}`));
  });

  it('gives what the provider said, model by model', async () => {
    const { output } = await tested();
    const [first] = output.data['models'] as Record<string, unknown>[];
    expect(output.data['provider']).toBe('anthropic');
    expect(Object.keys(first ?? {}).sort()).toEqual(['available', 'batch', 'deprecated_at', 'fallback', 'id', 'thinking']);
  });

  it('warns where the provider and the list part ways, and changes no file', async () => {
    const [opus, sonnet, haiku, fable] = profile.models.map(({ id }) => id);
    const { exit, output } = await tested((provider) => {
      const of = (id: string | undefined): ModelReply => provider.models.get(id ?? '') as ModelReply;
      provider.models.set(opus ?? '', { ...of(opus), allowed_fallback_models: [] });
      provider.models.set(sonnet ?? '', { ...of(sonnet), capabilities: { ...of(sonnet).capabilities, batch: { supported: false } } });
      provider.models.set(haiku ?? '', {
        ...of(haiku),
        capabilities: { ...of(haiku).capabilities, thinking: { types: { disabled: { supported: false }, between_tools: { supported: false } } } },
      });
      provider.models.set(fable ?? '', { ...of(fable), deprecated_at: '2026-11-01T00:00:00Z' });
    });
    expect(exit).toBe(0);
    // 第五個是 Fable 5.2（ADR-0139），回覆照清單，照常是對過。
    expect(codes(output)).toEqual([
      'provider.fallback_mismatch',
      'provider.no_batch',
      'provider.thinking_mismatch',
      'provider.deprecated',
      'provider.tested',
    ]);
    expect(output.findings.slice(0, 4).every(({ level }) => level === 'warn')).toBe(true);
  });

  it('warns when a model that cannot turn thinking off says it can', async () => {
    const opus = profile.models.find(({ thinking }) => thinking.mode === 'none');
    const { output } = await tested((provider) => {
      const reply = provider.models.get(opus?.id ?? '') as ModelReply;
      provider.models.set(opus?.id ?? '', {
        ...reply,
        capabilities: { ...reply.capabilities, thinking: { types: { disabled: { supported: true }, between_tools: { supported: false } } } },
      });
    });
    expect(output.findings.find(({ params }) => params['model'] === opus?.id)?.code).toBe('provider.thinking_mismatch');
  });

  it('goes on past a model the account cannot use', async () => {
    const [opus] = profile.models.map(({ id }) => id);
    const { exit, output } = await tested((provider) => provider.models.set(opus ?? '', 404));
    expect(exit).toBe(0);
    expect(codes(output)[0]).toBe('provider.model_unavailable');
    expect((output.data['models'] as { available: boolean }[]).map(({ available }) => available)).toEqual([false, true, true, true, true]);
  });

  it('stops at a key the provider refused', async () => {
    const { exit, output, provider } = await tested((fake) => {
      for (const { id } of profile.models) fake.models.set(id, 401);
    });
    expect(exit).toBe(1);
    expect(codes(output)).toEqual(['key.rejected']);
    expect(provider.calls).toHaveLength(1);
  });

  it('retries like everything else, then stops with the status', async () => {
    const { exit, output, progress, host } = await tested((fake) => {
      for (const { id } of profile.models) fake.models.set(id, 503);
    });
    expect(exit).toBe(1);
    expect(output.findings.at(-1)).toMatchObject({ code: 'provider.test_failed', params: { status: '503' } });
    expect(host.waits).toEqual([1, 2, 4, 8, 16]);
    // 每次重試前一行（ADR-0111）。
    expect(progress.match(/後重試/g)).toHaveLength(5);
    expect(progress).toContain('（狀態碼 503，- 表示沒有收到回應），8 秒後重試（第 4 次，最多 5 次）。\n');
  });

  it('asks for a key first, and connects nowhere without one', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const { io, stdout } = capture({ env: {}, secrets: new MemorySecretStore() });
    expect(await run(['provider', 'test', '--json'], io)).toBe(1);
    expect(codes(JSON.parse(stdout()) as Envelope)).toEqual(['key.missing']);
    expect(spy).not.toHaveBeenCalled();
  });

  it('needs no workspace, and makes none', async () => {
    const home = join(tempDir(), 'none');
    const provider = await startFakeProvider(() => ({ status: 500 }));
    const { io } = capture({ env: { TOME_HOME: home }, secrets: NO_KEYS, llm: adapterHost(provider) });
    await run(['provider', 'test'], io);
    expect(existsSync(home)).toBe(false);
  });
});
