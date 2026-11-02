import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { TomeError } from './errors.ts';
import { finding, type Finding } from './findings.ts';
import { validateProvider } from './schema.ts';
import { PROVIDERS } from './secrets.ts';

// 模型資料（ADR-0099、ADR-0103）。這不是預設模型，只是 TOME 知道怎麼呼叫的模型清單。

export const PROVIDER_SCHEMA = 'tome-provider/1';
/** 查證滿這麼多天就警告（ADR-0099 第 20 項）。 */
const PRICES_GO_STALE_DAYS = 60;
const DAY_MS = 86_400_000;

export type RequestMode = 'batch' | 'realtime';

export interface Price {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write_5m: number;
  readonly cache_write_1h: number;
  readonly batch_input: number;
  readonly batch_output: number;
}

export interface ProviderModel {
  readonly id: string;
  readonly effective: string;
  readonly price: Price;
  readonly long_prompt?: { readonly over_tokens: number; readonly price: Price };
  readonly thinking: {
    readonly mode: 'none' | 'between_tools' | 'disabled';
    readonly effort?: 'low' | 'medium' | 'high';
    readonly output_factor?: number;
  };
  readonly fallback: { readonly server: boolean };
}

export interface Provider {
  readonly schema: typeof PROVIDER_SCHEMA;
  readonly id: string;
  /** 對外出口的白名單（ADR-0039）。 */
  readonly endpoint: string;
  readonly verified: string;
  readonly retention_days: number;
  readonly estimate: {
    readonly chars_per_token: number;
    readonly output_ratio: number;
    readonly low: number;
    readonly high: number;
    readonly retry_margin: number;
  };
  readonly models: readonly ProviderModel[];
}

export interface LoadedProvider {
  readonly profile: Provider;
  /** 內容的雜湊，進內容指紋，價格一改就要重新確認（ADR-0056）。 */
  readonly hash: string;
}

export function loadProvider(id: string): LoadedProvider {
  // src 與 dist 到 repo 根目錄的深度相同。
  const url = new URL(`../../providers/${id}.yaml`, import.meta.url);
  let text: string;
  try {
    text = readFileSync(url, 'utf8');
  } catch {
    throw new TomeError('provider.unknown', { supported: PROVIDERS.join(', ') });
  }
  const checked = validateProvider(parse(text));
  if (!checked.ok) {
    throw new TomeError('config.bad_schema', { path: `providers/${id}.yaml`, expected: PROVIDER_SCHEMA });
  }
  return { profile: checked.value, hash: createHash('sha256').update(text).digest('hex') };
}

/** 不在表上的模型拒絕執行：思考參數送錯會回 400，估價也不準（ADR-0099 第 20 項）。 */
export function findModel(provider: Provider, id: string): ProviderModel {
  const model = provider.models.find((item) => item.id === id);
  if (model === undefined) {
    throw new TomeError('model.unknown', { model: id, known: provider.models.map((item) => item.id).join(', ') });
  }
  return model;
}

/** prompt 超過長度時，整個請求改用另一組價格，快取的 token 也算進長度。 */
export function priceFor(model: ProviderModel, promptTokens: number): Price {
  const { long_prompt: long } = model;
  return long !== undefined && promptTokens > long.over_tokens ? long.price : model.price;
}

export interface ThinkingParams {
  readonly thinking?: { readonly type: 'between_tools' | 'disabled' };
  readonly output_config?: { readonly effort: 'low' | 'medium' | 'high' };
}

/** 主翻譯預設關閉思考，能關的就關，不能關的用低 effort（ADR-0037、ADR-0103）。 */
export function thinkingParams({ thinking }: ProviderModel): ThinkingParams {
  if (thinking.mode !== 'none') return { thinking: { type: thinking.mode } };
  return thinking.effort === undefined ? {} : { output_config: { effort: thinking.effort } };
}

export function priceFinding(provider: Provider, today: Date): Finding {
  const { id, verified } = provider;
  const days = Math.floor((today.getTime() - Date.parse(verified)) / DAY_MS);
  return days >= PRICES_GO_STALE_DAYS
    ? finding('prices.stale', 'warn', { provider: id, verified, days: String(days) })
    : finding('prices.ok', 'info', { provider: id, verified });
}

/** 小數位數跟著金額走：便宜的模型一本書可能不到一美元。 */
export function usd(amount: number): string {
  return amount.toFixed(amount >= 0.01 || amount === 0 ? 2 : 6);
}

type ListedPrice = Pick<Price, 'input' | 'output' | 'batch_input' | 'batch_output'>;

interface ListedModel {
  readonly id: string;
  readonly effective: string;
  readonly price: ListedPrice;
  readonly long_prompt?: { readonly over_tokens: number; readonly price: ListedPrice };
}

export interface ListedProvider {
  readonly id: string;
  readonly endpoint: string;
  readonly verified: string;
  readonly retention_days: number;
  readonly models: readonly ListedModel[];
}

export interface ProviderListing {
  readonly data: { readonly providers: readonly ListedProvider[] };
  readonly findings: readonly Finding[];
}

function listedPrice({ input, output, batch_input, batch_output }: Price): ListedPrice {
  return { input, output, batch_input, batch_output };
}

/** 快取 M2 沒開，思考倍數沒量過，伺服器端回退 TOME 不用，都不列（ADR-0106 第 4 項）。 */
function listedModel({ id, effective, price, long_prompt: long }: ProviderModel): ListedModel {
  return {
    id,
    effective,
    price: listedPrice(price),
    ...(long === undefined ? {} : { long_prompt: { over_tokens: long.over_tokens, price: listedPrice(long.price) } }),
  };
}

function listedProvider({ id, endpoint, verified, retention_days, models }: Provider): ListedProvider {
  return { id, endpoint, verified, retention_days, models: models.map(listedModel) };
}

function priceParams({ input, output, batch_input, batch_output }: ListedPrice): Record<string, string> {
  return {
    input: usd(input),
    output: usd(output),
    batch_input: usd(batch_input),
    batch_output: usd(batch_output),
  };
}

function modelFindings({ id, price, long_prompt: long }: ListedModel): Finding[] {
  return [
    finding('provider.model', 'info', { model: id, ...priceParams(price) }),
    ...(long === undefined
      ? []
      : [
          finding('provider.long_prompt', 'info', {
            model: id,
            over: String(long.over_tokens),
            ...priceParams(long.price),
          }),
        ]),
  ];
}

/** `tome provider list`。只讀隨程式發送的資料，不連網，不碰金鑰，也不需要工作區（ADR-0106）。 */
export function listProviders(today: Date = new Date()): ProviderListing {
  const profiles = PROVIDERS.map((id) => loadProvider(id).profile);
  const providers = profiles.map(listedProvider);
  const findings = profiles.flatMap((profile) => {
    const { id, endpoint, retention_days, models } = profile;
    return [
      finding('provider.listed', 'info', { id, endpoint, retention: String(retention_days) }),
      ...models.map(listedModel).flatMap(modelFindings),
      priceFinding(profile, today),
    ];
  });
  return { data: { providers }, findings };
}
