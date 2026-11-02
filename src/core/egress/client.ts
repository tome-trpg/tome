import { createHash } from 'node:crypto';
import { TomeError } from '../errors.ts';
import type { Store } from '../store.ts';
import { hitCount, scanBody, type PiiHit, type PiiRules } from './gate.ts';

// 主程式唯一的對外路徑（ADR-0039）。其他程式不連網，要送東西就拿這裡的函式。

/** 外送紀錄。不放請求內容，也不放標頭：金鑰在標頭裡（ADR-0034）。 */
export interface EgressEntry {
  readonly content_hash: string;
  readonly provider: string;
  readonly model: string;
  readonly bytes: number;
}

export interface EgressOptions {
  /** 供應商設定的端點，只有它的網址能連。 */
  readonly endpoint: string;
  readonly provider: string;
  readonly rules: PiiRules;
  readonly record: (entry: EgressEntry) => void;
}

export type GuardedFetch = typeof fetch;

/** 個資閘門擋下的請求。這不是程式錯誤，呼叫端要把單位標成 `BLOCKED`。 */
export class EgressBlocked extends TomeError {
  readonly hits: readonly PiiHit[];

  constructor(hits: readonly PiiHit[]) {
    super('translate.blocked', { count: String(hitCount(hits)) });
    this.name = 'EgressBlocked';
    this.hits = hits;
  }
}

interface SentBody {
  readonly model?: unknown;
  /** 建立批次時，模型在每個請求的 `params` 裡。 */
  readonly requests?: readonly { readonly params?: { readonly model?: unknown } | null }[];
}

/** 批次裡有多種模型時用逗號連起來，沒有本文的查詢記成空字串（ADR-0107 第 20 項）。 */
function modelOf(body: string): string {
  try {
    const sent = JSON.parse(body) as SentBody | null;
    const requests = sent?.requests;
    const models = Array.isArray(requests) ? requests.map((request) => request.params?.model) : [sent?.model];
    return [...new Set(models.filter((model) => typeof model === 'string'))].join(',');
  } catch {
    return '';
  }
}

function entryFor(body: string, provider: string): EgressEntry {
  return {
    content_hash: createHash('sha256').update(body).digest('hex'),
    provider,
    model: modelOf(body),
    bytes: Buffer.byteLength(body),
  };
}

/**
 * 依序檢查主機、掃描個資、寫下紀錄，都過了才送。紀錄在送出之前寫：
 * 請求送到一半失敗時，內容可能已經離開這台機器。
 */
export function guardedFetch(options: EgressOptions): GuardedFetch {
  const allowed = new URL(options.endpoint).origin;
  return async (input, init = {}) => {
    const target = new URL(input instanceof Request ? input.url : input);
    const denied = new TomeError('egress.denied', { host: target.host });
    // `Request` 與串流的本文讀了才知道內容，沒看過的東西不送。
    if (input instanceof Request || target.origin !== allowed) throw denied;
    const body = init.body ?? '';
    if (typeof body !== 'string') throw denied;
    const hits = scanBody(body, options.rules);
    if (hits.length > 0) throw new EgressBlocked(hits);
    options.record(entryFor(body, options.provider));
    // 轉址會離開白名單，當成失敗。
    return fetch(target, { ...init, redirect: 'error' });
  };
}

/** 把外送紀錄寫進這本書的 `book.db`。 */
export function egressRecorder(store: Store): (entry: EgressEntry) => void {
  return (entry) => {
    store.run(
      'INSERT INTO egress (content_hash, provider, model, bytes, created_at) VALUES (?, ?, ?, ?, ?)',
      entry.content_hash,
      entry.provider,
      entry.model,
      entry.bytes,
      new Date().toISOString(),
    );
  };
}
