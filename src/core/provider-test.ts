import { guardedFetch } from './egress/client.ts';
import { finding, type Finding } from './findings.ts';
import { isApiError, sleepSeconds, withRetry, type ApiError, type LLMHost, type ModelFacts, type OnRetry } from './llm.ts';
import { loadProvider, type ProviderModel } from './provider.ts';

// `tome provider test`（ADR-0103 第 6 項、ADR-0109 第 9 項）：用 Models API 對照模型資料，
// 不送 Messages 請求，不消耗 token。對不上只警告，設定檔要等維護者看過結果、走 PR 才改。

/** Models API 的模型物件，只列用得到的欄位。 */
export interface ModelReply {
  readonly id: string;
  readonly allowed_fallback_models?: readonly string[] | null;
  readonly deprecated_at?: string | null;
  readonly capabilities?: {
    readonly batch?: { readonly supported: boolean } | null;
    readonly thinking?: {
      readonly types?: {
        readonly disabled?: { readonly supported: boolean } | null;
        readonly between_tools?: { readonly supported: boolean } | null;
      } | null;
    } | null;
  } | null;
}

/** 判斷 Models API 的回應，即時的轉接層與假供應商共用。 */
export function modelFacts({ id, allowed_fallback_models: allowed, deprecated_at, capabilities }: ModelReply): ModelFacts {
  const types = capabilities?.thinking?.types;
  return {
    id,
    batch: capabilities?.batch?.supported ?? null,
    thinking:
      types === undefined || types === null
        ? null
        : { disabled: types.disabled?.supported ?? false, between_tools: types.between_tools?.supported ?? false },
    fallback: allowed === undefined || allowed === null ? null : allowed.length > 0,
    deprecatedAt: deprecated_at ?? null,
  };
}

/** 能關思考的就要能關，不能關的就兩種都不接受（ADR-0103 第 5 項）。 */
function thinkingMatches({ thinking }: ProviderModel, reported: NonNullable<ModelFacts['thinking']>): boolean {
  switch (thinking.mode) {
    case 'none':
      return !reported.disabled && !reported.between_tools;
    case 'between_tools':
      return reported.between_tools;
    case 'disabled':
      return reported.disabled;
  }
}

function differences(model: ProviderModel, facts: ModelFacts): Finding[] {
  const params = { model: model.id };
  const { batch, thinking, fallback, deprecatedAt } = facts;
  return [
    ...(batch === false ? [finding('provider.no_batch', 'warn', params)] : []),
    ...(thinking !== null && !thinkingMatches(model, thinking) ? [finding('provider.thinking_mismatch', 'warn', params)] : []),
    ...(fallback !== null && fallback !== model.fallback.server ? [finding('provider.fallback_mismatch', 'warn', params)] : []),
    ...(deprecatedAt === null ? [] : [finding('provider.deprecated', 'warn', params)]),
  ];
}

interface TestedModel {
  readonly id: string;
  readonly available: boolean;
  readonly batch: boolean | null;
  readonly thinking: ModelFacts['thinking'];
  readonly fallback: boolean | null;
  readonly deprecated_at: string | null;
}

function unavailable(id: string): TestedModel {
  return { id, available: false, batch: null, thinking: null, fallback: null, deprecated_at: null };
}

/** 401 是金鑰的問題，其他錯誤每個模型都會一樣，都不用再查下去。404 只是這個組織用不了這個模型。 */
function stopOn(error: ApiError): Finding | null {
  if (error.status === 404) return null;
  if (error.status === 401) return finding('key.rejected', 'fail', { provider: 'anthropic' });
  return finding('provider.test_failed', 'fail', { status: String(error.status ?? '-') });
}

/** 這個指令沒有書，請求也沒有本文，所以不寫外送紀錄，白名單照樣檢查（ADR-0109 第 9 項）。 */
const NO_PII = { pii: [], exceptions: [] };

export async function testProvider(host: LLMHost, onRetry?: OnRetry): Promise<{ data: Record<string, unknown>; findings: Finding[] }> {
  const { profile } = loadProvider('anthropic');
  const endpoint = host.endpoint ?? profile.endpoint;
  const fetcher = guardedFetch({ endpoint, provider: profile.id, rules: NO_PII, record: () => undefined });
  const llm = host.connect(fetcher, endpoint);
  const models: TestedModel[] = [];
  const findings: Finding[] = [];
  for (const model of profile.models) {
    const facts = await withRetry(() => llm.describeModel(model.id), host.sleep ?? sleepSeconds, undefined, onRetry);
    if (isApiError(facts)) {
      const stop = stopOn(facts);
      if (stop !== null) return { data: { provider: profile.id, models }, findings: [...findings, stop] };
      models.push(unavailable(model.id));
      findings.push(finding('provider.model_unavailable', 'warn', { model: model.id }));
      continue;
    }
    const { batch, thinking, fallback, deprecatedAt } = facts;
    models.push({ id: model.id, available: true, batch, thinking, fallback, deprecated_at: deprecatedAt });
    const found = differences(model, facts);
    findings.push(...(found.length === 0 ? [finding('provider.tested', 'info', { model: model.id })] : found));
  }
  return { data: { provider: profile.id, models }, findings };
}
