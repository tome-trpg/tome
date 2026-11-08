import { priceFor, type Provider, type ProviderModel, type RequestMode } from './provider.ts';

// 本機估價，不連網（ADR-0035）。比例都是提案，沒有量過，M4 的 tome trial 才校準（ADR-0103）。

const TOKENS_PER_PRICE_UNIT = 1_000_000;

export interface RequestSize {
  /** 送出去的全部字元：靜態前綴加上 `user`。 */
  readonly promptChars: number;
  /** 要翻譯的字元，輸出的長度跟著它走。 */
  readonly sourceChars: number;
}

export interface Estimate {
  readonly low_usd: number;
  readonly high_usd: number;
}

/** 預估的輸出 token，含關不掉的思考（ADR-0037）。 */
export function outputTokens(provider: Provider, model: ProviderModel, sourceChars: number): number {
  const { chars_per_token, output_ratio } = provider.estimate;
  return (sourceChars / chars_per_token) * output_ratio * (model.thinking.output_factor ?? 1);
}

function priced(provider: Provider, model: ProviderModel, promptChars: number, output: number, mode: RequestMode): Estimate {
  const { chars_per_token, low, high, retry_margin } = provider.estimate;
  const inputTokens = promptChars / chars_per_token;
  const price = priceFor(model, inputTokens);
  const batch = mode === 'batch';
  const input = (inputTokens * (batch ? price.batch_input : price.input)) / TOKENS_PER_PRICE_UNIT;
  const paid = (output * (batch ? price.batch_output : price.output)) / TOKENS_PER_PRICE_UNIT;
  const middle = (input + paid) * (1 + retry_margin);
  return { low_usd: middle * low, high_usd: middle * high };
}

export function estimateRequest(
  provider: Provider,
  model: ProviderModel,
  { promptChars, sourceChars }: RequestSize,
  mode: RequestMode,
): Estimate {
  return priced(provider, model, promptChars, outputTokens(provider, model, sourceChars), mode);
}

/** 含關不掉的思考的輸出 token，輸出另外算的請求用。 */
export function withThinking(model: ProviderModel, tokens: number): number {
  return tokens * (model.thinking.output_factor ?? 1);
}

/**
 * 輸出跟輸入的長度無關的請求，例如 Pass 0 每個候選詞回一張卡（ADR-0118）。`tokens` 是不含思考的輸出。
 */
export function estimateFixedOutput(
  provider: Provider,
  model: ProviderModel,
  promptChars: number,
  tokens: number,
  mode: RequestMode,
): Estimate {
  return priced(provider, model, promptChars, withThinking(model, tokens), mode);
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
