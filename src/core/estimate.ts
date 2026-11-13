import { priceFor, type ProviderModel, type Provider, type RequestMode } from './provider.ts';

// 本機估價，不連網（ADR-0035）。比例都是提案：M3 的帳本補了每個單位的標籤、靜態前綴與重送的餘裕
// （ADR-0134），試翻再依書校準輸入與輸出，並量快取的命中率（ADR-0135）。

const TOKENS_PER_PRICE_UNIT = 1_000_000;
/** 批次的折扣也套在快取的讀寫上。 */
const BATCH_DISCOUNT = 0.5;

export interface RequestSize {
  /** 靜態前綴的字元：TOME 的提示加上全書提要，每個請求都送一次。 */
  readonly prefixChars: number;
  /** `user` 的字元：書本文字、詞條、上文與重送的回饋。 */
  readonly userChars: number;
  /** 要翻譯的字元，輸出的長度跟著它走。 */
  readonly sourceChars: number;
  /** 單位數。每個單位的 `<s id>` 標籤在輸入與輸出都吃 token（ADR-0134）。 */
  readonly units: number;
}

export interface Estimate {
  readonly low_usd: number;
  readonly high_usd: number;
}

/** 提示快取的存活時間（ADR-0135）。 */
export type CacheTtl = '5m' | '1h';

/** 請求帶 `cache_control` 時，估價照命中率算前綴的價錢（ADR-0135）。 */
export interface CacheSetting {
  readonly ttl: CacheTtl;
  /** 試翻量到的命中率，0 到 1；試翻自己的估價當成 0，整個前綴都寫入。 */
  readonly hitRate: number;
}

/** 試翻量到的兩個倍數：實際的 token ÷ 估價器的估計（ADR-0135）。 */
export interface Calibration {
  readonly input: number;
  readonly output: number;
}

export interface EstimateContext {
  readonly calibration?: Calibration | null;
  readonly cache?: CacheSetting | null;
}

/** 估價器估的 token，前綴另外算，快取只碰得到它（ADR-0135）。 */
export interface RequestTokens {
  readonly prefix: number;
  /** 前綴以外的輸入：`user` 與每個單位的標籤。 */
  readonly rest: number;
  readonly output: number;
}

/** 這個模式的單價，美元／百萬 token。批次連快取都打五折。 */
export interface ModePrices {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: Readonly<Record<CacheTtl, number>>;
}

export function modePrices(model: ProviderModel, mode: RequestMode, promptTokens: number): ModePrices {
  const price = priceFor(model, promptTokens);
  const batch = mode === 'batch';
  const cache = batch ? BATCH_DISCOUNT : 1;
  return {
    input: batch ? price.batch_input : price.input,
    output: batch ? price.batch_output : price.output,
    cacheRead: price.cache_read * cache,
    cacheWrite: { '5m': price.cache_write_5m * cache, '1h': price.cache_write_1h * cache },
  };
}

/** 命中率要多高，開快取才比不開便宜：（寫入價 − 輸入價）÷（寫入價 − 讀取價）（附錄 A、ADR-0135）。 */
export function breakEven(model: ProviderModel, mode: RequestMode, ttl: CacheTtl): number {
  const prices = modePrices(model, mode, 0);
  const write = prices.cacheWrite[ttl];
  return (write - prices.input) / (write - prices.cacheRead);
}

/** 預估的輸出 token，含關不掉的思考（ADR-0037）。不含單位的標籤，`max_tokens` 另外加（ADR-0114）。 */
export function outputTokens(provider: Provider, model: ProviderModel, sourceChars: number): number {
  const { chars_per_token, output_ratio } = provider.estimate;
  return (sourceChars / chars_per_token) * output_ratio * (model.thinking.output_factor ?? 1);
}

/**
 * 翻譯請求的 token（ADR-0134）。前綴與 `user` 各用自己的比例，每個單位的標籤在輸入與輸出另外加；
 * 標籤加在思考的倍數之外，跟 `max_tokens` 一樣（ADR-0114 第 2 項）。不含校準，試翻拿它跟實際比。
 */
export function requestTokens(
  provider: Provider,
  model: ProviderModel,
  { prefixChars, userChars, sourceChars, units }: RequestSize,
): RequestTokens {
  const { chars_per_token, prefix_chars_per_token, unit_input_tokens, unit_output_tokens } = provider.estimate;
  return {
    prefix: prefixChars / prefix_chars_per_token,
    rest: userChars / chars_per_token + unit_input_tokens * units,
    output: outputTokens(provider, model, sourceChars) + unit_output_tokens * units,
  };
}

function priced(
  provider: Provider,
  model: ProviderModel,
  tokens: RequestTokens,
  margin: number,
  mode: RequestMode,
  cache: CacheSetting | null,
): Estimate {
  const { low, high } = provider.estimate;
  const prices = modePrices(model, mode, tokens.prefix + tokens.rest);
  // 快取只碰得到前綴：命中付讀取價，沒命中付寫入價（ADR-0135）。
  const prefixPrice =
    cache === null ? prices.input : cache.hitRate * prices.cacheRead + (1 - cache.hitRate) * prices.cacheWrite[cache.ttl];
  const input = (tokens.prefix * prefixPrice + tokens.rest * prices.input) / TOKENS_PER_PRICE_UNIT;
  const paid = (tokens.output * prices.output) / TOKENS_PER_PRICE_UNIT;
  const middle = (input + paid) * (1 + margin);
  return { low_usd: middle * low, high_usd: middle * high };
}

/** 翻譯請求的估價：ADR-0134 的 token，乘上試翻的倍數，前綴照快取的命中率計價（ADR-0135）。 */
export function estimateRequest(
  provider: Provider,
  model: ProviderModel,
  size: RequestSize,
  mode: RequestMode,
  { calibration = null, cache = null }: EstimateContext = {},
): Estimate {
  const tokens = requestTokens(provider, model, size);
  const factors = calibration ?? { input: 1, output: 1 };
  const calibrated = {
    prefix: tokens.prefix * factors.input,
    rest: tokens.rest * factors.input,
    output: tokens.output * factors.output,
  };
  return priced(provider, model, calibrated, provider.estimate.retry_margin, mode, cache);
}

/** 含關不掉的思考的輸出 token，輸出另外算的請求用。 */
export function withThinking(model: ProviderModel, tokens: number): number {
  return tokens * (model.thinking.output_factor ?? 1);
}

/**
 * 輸出跟輸入的長度無關的請求，例如 Pass 0 每個候選詞回一張卡（ADR-0118）。`tokens` 是不含思考的輸出。
 * 整個提示照 `chars_per_token` 算，沒有單位的標籤；ADR-0134 第 1 到 4 項不套在這裡（第 6 項）。
 */
export function estimateFixedOutput(
  provider: Provider,
  model: ProviderModel,
  promptChars: number,
  tokens: number,
  mode: RequestMode,
): Estimate {
  const { chars_per_token, scan_retry_margin } = provider.estimate;
  const prompt = { prefix: 0, rest: promptChars / chars_per_token, output: withThinking(model, tokens) };
  return priced(provider, model, prompt, scan_retry_margin, mode, null);
}

export function sumEstimates(estimates: readonly Estimate[]): Estimate {
  return estimates.reduce(
    (total, { low_usd, high_usd }) => ({
      low_usd: total.low_usd + low_usd,
      high_usd: total.high_usd + high_usd,
    }),
    { low_usd: 0, high_usd: 0 },
  );
}
