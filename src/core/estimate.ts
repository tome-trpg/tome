import { priceFor, type Provider, type ProviderModel, type RequestMode } from './provider.ts';

// 本機估價，不連網（ADR-0035）。比例都是提案：M3 的帳本補了每個單位的標籤、靜態前綴與重送的餘裕
// （ADR-0134），045 的試翻再依書校準（ADR-0103、ADR-0130 第 9 項）。

const TOKENS_PER_PRICE_UNIT = 1_000_000;

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

/** 預估的輸出 token，含關不掉的思考（ADR-0037）。不含單位的標籤，`max_tokens` 另外加（ADR-0114）。 */
export function outputTokens(provider: Provider, model: ProviderModel, sourceChars: number): number {
  const { chars_per_token, output_ratio } = provider.estimate;
  return (sourceChars / chars_per_token) * output_ratio * (model.thinking.output_factor ?? 1);
}

interface Tokens {
  readonly input: number;
  readonly output: number;
}

function priced(provider: Provider, model: ProviderModel, tokens: Tokens, margin: number, mode: RequestMode): Estimate {
  const { low, high } = provider.estimate;
  const price = priceFor(model, tokens.input);
  const batch = mode === 'batch';
  const input = (tokens.input * (batch ? price.batch_input : price.input)) / TOKENS_PER_PRICE_UNIT;
  const paid = (tokens.output * (batch ? price.batch_output : price.output)) / TOKENS_PER_PRICE_UNIT;
  const middle = (input + paid) * (1 + margin);
  return { low_usd: middle * low, high_usd: middle * high };
}

/**
 * 翻譯請求的估價（ADR-0134）。前綴與 `user` 各用自己的比例，每個單位的標籤在輸入與輸出另外加；
 * 標籤加在思考的倍數之外，跟 `max_tokens` 一樣（ADR-0114 第 2 項）。
 */
export function estimateRequest(
  provider: Provider,
  model: ProviderModel,
  { prefixChars, userChars, sourceChars, units }: RequestSize,
  mode: RequestMode,
): Estimate {
  const { chars_per_token, prefix_chars_per_token, unit_input_tokens, unit_output_tokens, retry_margin } =
    provider.estimate;
  const tokens = {
    input: prefixChars / prefix_chars_per_token + userChars / chars_per_token + unit_input_tokens * units,
    output: outputTokens(provider, model, sourceChars) + unit_output_tokens * units,
  };
  return priced(provider, model, tokens, retry_margin, mode);
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
  return priced(provider, model, { input: promptChars / chars_per_token, output: withThinking(model, tokens) }, scan_retry_margin, mode);
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
