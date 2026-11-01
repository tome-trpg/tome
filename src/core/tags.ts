// 標籤協定（白皮書 §5.6、ADR-0099、ADR-0100）。書本文字是資料，進標籤前 MUST 跳脫，
// 所以書裡寫什麼都關不掉 `<s>`，也開不了新的標籤。標記模型對齊 XLIFF 的 `ph`、`pc`。

export type Segment =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'ph'; readonly id: string }
  | { readonly type: 'pc'; readonly id: string; readonly children: readonly Segment[] }
  | { readonly type: 'new-term'; readonly source: string; readonly children: readonly Segment[] }
  | { readonly type: 'flag'; readonly reason: string; readonly children: readonly Segment[] };

export interface ParsedUnit {
  readonly id: string;
  readonly segments: readonly Segment[];
}

export type TagIssueCode =
  | 'bad_nesting'
  | 'bad_tag'
  | 'missing_attribute'
  | 'unbalanced_tag'
  | 'unknown_tag';

/** 只有代碼與單位編號，不帶書本文字（ADR-0059）。 */
export interface TagIssue {
  readonly code: TagIssueCode;
  readonly unit: string | null;
}

export interface ParsedReply {
  readonly units: readonly ParsedUnit[];
  readonly issues: readonly TagIssue[];
}

type ContainerName = 's' | 'pc' | 'new-term' | 'flag';

interface Frame {
  readonly name: ContainerName;
  /** `s`、`pc` 的 `id`，`new-term` 的 `source`，`flag` 的 `reason`。缺了就是 undefined。 */
  readonly value: string | undefined;
  readonly segments: Segment[];
}

const REQUIRED_ATTRIBUTE: Readonly<Record<ContainerName | 'ph', string>> = {
  s: 'id',
  ph: 'id',
  pc: 'id',
  'new-term': 'source',
  flag: 'reason',
};

const TAG = /<(\/?)([A-Za-z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>/y;
const ATTRIBUTE = /([\w-]+)="([^"]*)"/g;
const ENTITY = /&(amp|lt|gt|quot);/g;
const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"' };

export function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function escapeAttribute(text: string): string {
  return escapeText(text).replaceAll('"', '&quot;');
}

/** 一次掃過，只還原一層。其他的 `&` 當成字面字元：LLM 常不跳脫，重送要花錢（ADR-0100）。 */
export function unescapeText(text: string): string {
  return text.replace(ENTITY, (_whole, name: string) => ENTITIES[name] ?? '');
}

export function placeholderTag(id: number, kind: string): string {
  return `<ph id="${id}" kind="${escapeAttribute(kind)}"/>`;
}

/** `masked` 已經跳脫過，見 `maskText`。 */
export function unitTag(id: string, role: string, masked: string): string {
  return `<s id="${escapeAttribute(id)}" role="${escapeAttribute(role)}">${masked}</s>`;
}

function isContainer(name: string): name is ContainerName {
  return name === 's' || name === 'pc' || name === 'new-term' || name === 'flag';
}

function attributeOf(raw: string, wanted: string): string | undefined {
  for (const [, name, value] of raw.matchAll(ATTRIBUTE)) {
    if (name === wanted) return unescapeText(value ?? '');
  }
  return undefined;
}

class ReplyParser {
  readonly #reply: string;
  readonly #stack: Frame[] = [];
  readonly #units: ParsedUnit[] = [];
  readonly #issues: TagIssue[] = [];

  constructor(reply: string) {
    this.#reply = reply;
  }

  parse(): ParsedReply {
    let index = 0;
    while (index < this.#reply.length) {
      const next = this.#reply.indexOf('<', index);
      if (next < 0) {
        this.#addText(this.#reply.slice(index));
        break;
      }
      this.#addText(this.#reply.slice(index, next));
      TAG.lastIndex = next;
      const match = TAG.exec(this.#reply);
      if (match === null) {
        this.#report('bad_tag');
        this.#addText('<');
        index = next + 1;
        continue;
      }
      index = TAG.lastIndex;
      const [, slash, name = '', attributes = '', selfClosing] = match;
      if (name !== 'ph' && !isContainer(name)) this.#report('unknown_tag');
      else if (slash === '/') this.#close(name);
      else if (name === 'ph') this.#placeholder(attributes, selfClosing === '/');
      else this.#open(name, attributes, selfClosing === '/');
    }
    // 沒收尾的單位不算數，驗證會當成缺單位。
    while (this.#stack.length > 0) {
      this.#report('unbalanced_tag');
      this.#stack.pop();
    }
    return { units: this.#units, issues: this.#issues };
  }

  #report(code: TagIssueCode): void {
    this.#issues.push({ code, unit: this.#stack[0]?.value ?? null });
  }

  /** 單位之外的文字不屬於任何單位，略過。 */
  #addText(text: string): void {
    if (text !== '') this.#stack.at(-1)?.segments.push({ type: 'text', text: unescapeText(text) });
  }

  #placeholder(attributes: string, selfClosing: boolean): void {
    const top = this.#stack.at(-1);
    if (top === undefined || !selfClosing) {
      this.#report('bad_nesting');
      return;
    }
    const id = attributeOf(attributes, REQUIRED_ATTRIBUTE.ph);
    if (id === undefined) this.#report('missing_attribute');
    else top.segments.push({ type: 'ph', id });
  }

  #open(name: ContainerName, attributes: string, selfClosing: boolean): void {
    // `<s>` 只能在最外層，其他標籤只能在 `<s>` 裡。
    const inUnit = this.#stack.length > 0;
    if (selfClosing || (name === 's') === inUnit) {
      this.#report('bad_nesting');
      return;
    }
    const value = attributeOf(attributes, REQUIRED_ATTRIBUTE[name]);
    if (value === undefined) this.#report('missing_attribute');
    this.#stack.push({ name, value, segments: [] });
  }

  #close(name: string): void {
    const frame = this.#stack.at(-1);
    if (frame?.name !== name) {
      this.#report('unbalanced_tag');
      return;
    }
    this.#stack.pop();
    const { value = '', segments: children } = frame;
    const parent = this.#stack.at(-1);
    if (parent === undefined) {
      if (frame.value !== undefined) this.#units.push({ id: value, segments: children });
    } else if (frame.name === 'pc') {
      parent.segments.push({ type: 'pc', id: value, children });
    } else if (frame.name === 'new-term') {
      parent.segments.push({ type: 'new-term', source: value, children });
    } else {
      parent.segments.push({ type: 'flag', reason: value, children });
    }
  }
}

/** 解析 LLM 的回應。問題全部回報，能讀的單位照常回傳，由驗證決定要不要重送。 */
export function parseUnits(reply: string): ParsedReply {
  return new ReplyParser(reply).parse();
}
