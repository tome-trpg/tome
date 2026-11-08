import { scriptViolations, type ScriptCheck } from './language.ts';
import { attributeOf, unescapeText } from './tags.ts';

// Pass 0 的回覆（ADR-0118）：`<card>`、`<skip>` 與 `<brief>`，跟翻譯一樣用文字標籤（S-4）。
// 這裡吃的是 LLM 的回應，掃描耗時要跟長度成正比，不用會回溯的正規表示式。

const TAG = /<(\/?)([A-Za-z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>/y;
const GENDERS: ReadonlySet<string> = new Set(['female', 'male', 'none']);
const BRIEF_PARTS = ['era', 'tone', 'factions'] as const;

export interface CardReply {
  readonly kind: 'card';
  readonly id: string;
  /** 回應裡這個元素的原文，存進 `response`。 */
  readonly raw: string;
  readonly target: string;
  readonly attributes: string;
}

export interface SkipReply {
  readonly kind: 'skip';
  readonly id: string;
  readonly raw: string;
}

export type TermReply = CardReply | SkipReply;

export interface ParsedCards {
  /** 依 `id`。同一個 `id` 出現兩次時取第一個。 */
  readonly replies: ReadonlyMap<string, TermReply>;
  /** 壞掉的標籤、`<card>` 裡還有標籤、沒收尾，這些地方的 `id` 都不算收到。 */
  readonly broken: ReadonlySet<string>;
}

/** 解析 Pass 0 的回應。`<card>` 裡只能有文字。 */
export function parseCards(reply: string): ParsedCards {
  const replies = new Map<string, TermReply>();
  const broken = new Set<string>();
  let open: { id: string; attributes: string; start: number; content: number } | null = null;
  let index = 0;
  while (index < reply.length) {
    const next = reply.indexOf('<', index);
    if (next < 0) break;
    TAG.lastIndex = next;
    const match = TAG.exec(reply);
    if (match === null) {
      if (open !== null) broken.add(open.id);
      index = next + 1;
      continue;
    }
    index = TAG.lastIndex;
    const [, slash, name = '', attributes = '', selfClosing] = match;
    if (open !== null) {
      if (slash === '/' && name === 'card') {
        const raw = reply.slice(open.start, index);
        const target = unescapeText(reply.slice(open.content, next)).trim();
        if (!replies.has(open.id)) replies.set(open.id, { kind: 'card', id: open.id, raw, target, attributes: open.attributes });
      } else {
        broken.add(open.id);
      }
      open = null;
      continue;
    }
    const id = attributeOf(attributes, 'id');
    if (id === undefined || slash === '/') continue;
    if (name === 'skip' && selfClosing === '/') {
      if (!replies.has(id)) replies.set(id, { kind: 'skip', id, raw: reply.slice(next, index) });
    } else if (name === 'card' && selfClosing !== '/') {
      open = { id, attributes, start: next, content: index };
    }
  }
  if (open !== null) broken.add(open.id);
  for (const id of broken) replies.delete(id);
  return { replies, broken };
}

export interface ProposedCard {
  readonly target: string;
  readonly class?: string;
  readonly gender?: string;
  readonly pronoun?: string;
  readonly register?: string;
  readonly keep_source: boolean;
}

export interface CardRules {
  /** 規則包宣告的類別。 */
  readonly classes: ReadonlySet<string>;
  /** 目標語言設定檔的代名詞。 */
  readonly pronouns: ReadonlySet<string>;
  readonly script: ScriptCheck;
}

export type CardCheck =
  | { readonly ok: true; readonly card: ProposedCard; readonly dropped: readonly string[] }
  | { readonly ok: false; readonly reason: 'empty' | 'script_mixed' };

/**
 * 確定是錯的才重送：譯名是空的、混入簡體字（ADR-0102）。類別、代名詞、性別不在清單裡就拿掉並列報告，
 * 不重送（ADR-0118 第 6 項）。
 */
export function checkCard(reply: CardReply, rules: CardRules): CardCheck {
  if (reply.target === '') return { ok: false, reason: 'empty' };
  if (scriptViolations(rules.script, reply.target).length > 0) return { ok: false, reason: 'script_mixed' };
  const dropped: string[] = [];
  const pick = (name: string, allowed: ReadonlySet<string> | null): string | undefined => {
    const value = attributeOf(reply.attributes, name)?.trim();
    if (value === undefined || value === '') return undefined;
    if (allowed !== null && !allowed.has(value)) {
      dropped.push(name);
      return undefined;
    }
    return value;
  };
  const kind = pick('class', rules.classes);
  const gender = pick('gender', GENDERS);
  const pronoun = pick('pronoun', rules.pronouns);
  const register = pick('register', null);
  return {
    ok: true,
    card: {
      target: reply.target,
      ...(kind === undefined ? {} : { class: kind }),
      ...(gender === undefined ? {} : { gender }),
      ...(pronoun === undefined ? {} : { pronoun }),
      ...(register === undefined ? {} : { register }),
      keep_source: attributeOf(reply.attributes, 'keep') === 'source',
    },
    dropped,
  };
}

export interface Brief {
  readonly era: string;
  readonly tone: string;
  readonly factions: string;
}

function between(text: string, name: string): string | null {
  const open = `<${name}>`;
  const close = `</${name}>`;
  const start = text.indexOf(open);
  if (start < 0) return null;
  const end = text.indexOf(close, start + open.length);
  return end < 0 ? null : text.slice(start + open.length, end);
}

/** `<brief>` 裡的三段，少一段或是空的就不算（ADR-0118）。 */
export function parseBrief(reply: string): { readonly brief: Brief; readonly raw: string } | null {
  const inner = between(reply, 'brief');
  if (inner === null) return null;
  const parts = BRIEF_PARTS.map((name) => unescapeText(between(inner, name) ?? '').trim());
  if (parts.some((part) => part === '')) return null;
  const [era = '', tone = '', factions = ''] = parts;
  const start = reply.indexOf('<brief>');
  const end = reply.indexOf('</brief>') + '</brief>'.length;
  return { brief: { era, tone, factions }, raw: reply.slice(start, end) };
}
