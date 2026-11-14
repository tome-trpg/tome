import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ReviewDecision, ReviewSection, ReviewSession } from '../../core/glossary.ts';
import { STYLE, SCRIPT } from './assets.ts';
import { ALL_CARDS, fill, renderPage, SECTION_ORDER, visible, type FormInput, type PageModel, type PageTexts, type ViewState } from './page.ts';

// 審定網頁的本機伺服器（ADR-0138，修改 ADR-0039 的斷言）。只聽 127.0.0.1、埠號由系統挑，每次啟動一個隨機權杖，
// 放在網址的路徑裡；Host 不對、權杖不對的請求都擋下，寫入的請求還要 Origin 對。不開 CORS，不連外：
// 這個模組只用 node:http 的 createServer，不呼叫 request、get。書本文字只在這條本機連線上傳，
// 回應都不快取，頁面不載入外部的東西。

const HOST = '127.0.0.1';
/** 一張卡的表單不到幾 KB，超過就是不對的請求。 */
const BODY_LIMIT = 64 * 1024;
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  // 不能用 no-referrer：瀏覽器照 Fetch 的規定，表單的 Origin 就送 null，下面的 Origin 檢查會擋下自己的表單。
  // same-origin 只對本機的這個伺服器送，網址裡的權杖不會送到別處（頁面也不連外）。
  'Referrer-Policy': 'same-origin',
};

export interface ReviewServer {
  /** 帶著權杖的網址，只印在終端機。 */
  readonly url: string;
  close(): Promise<void>;
}

export interface ReviewServerOptions {
  readonly book: string;
  readonly session: ReviewSession;
  readonly texts: PageTexts;
}

class Refused extends Error {
  readonly status: number;
  constructor(status: number) {
    super(String(status));
    this.status = status;
  }
}

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const type = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') throw new Refused(415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const piece = chunk as Buffer;
    size += piece.length;
    if (size > BODY_LIMIT) throw new Refused(413);
    chunks.push(piece);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function sectionOf(value: string | null): ReviewSection {
  return SECTION_ORDER.find((section) => section === value) ?? 'review';
}

/** 表單沒帶標記時，勾選框沒送不代表取消勾選，交給驗證的預設值。 */
export function formInput(form: URLSearchParams): Readonly<Record<string, unknown>> & { readonly display: FormInput } {
  const ours = form.get('form') === 'card';
  const flag = (name: string): boolean | undefined => (form.has(name) ? true : ours ? false : undefined);
  const text = (name: string): string => form.get(name) ?? '';
  const display: FormInput = {
    target: text('target'),
    class: text('class'),
    gender: text('gender'),
    pronoun: text('pronoun'),
    register: text('register'),
    keep_source: form.has('keep_source'),
    case_sensitive: form.has('case_sensitive'),
    whole_word: form.has('whole_word'),
    roles: form.getAll('roles'),
  };
  return {
    target: display.target,
    class: display.class,
    gender: display.gender,
    pronoun: display.pronoun,
    register: display.register,
    keep_source: flag('keep_source'),
    case_sensitive: flag('case_sensitive'),
    whole_word: flag('whole_word'),
    roles: display.roles,
    display,
  };
}

function viewOf(form: URLSearchParams): ViewState {
  if (form.get('clear') !== null) return ALL_CARDS;
  const proposal = form.get('proposal');
  return {
    q: form.get('q') ?? '',
    kind: form.get('kind') ?? '',
    proposal: proposal === 'with' || proposal === 'without' ? proposal : 'all',
  };
}

/** 決定之後聚焦在下一張；最後一張就往前一張。不在這一頁的（`indexOf` 是 -1）就是第一張。 */
function nextAfter(ids: readonly number[], id: number): number | null {
  const index = ids.indexOf(id);
  return ids[index + 1] ?? ids[index - 1] ?? null;
}

/** 頁面回給瀏覽器的東西。 */
export interface LocalReply {
  readonly status: number;
  /** 沒寫是 HTML。 */
  readonly type?: string;
  readonly body: string;
  /** 轉址（303）的去處，從 `base` 寫起。 */
  readonly location?: string;
}

/**
 * 掛在本機伺服器上的頁面：審定網頁，以及評測的評分頁（`tools/eval/`，ADR-0139）。伺服器先擋下 Host、權杖、
 * Origin 與格式不對的請求，剩下的才交給它；`path` 是權杖之後的路徑，`base` 是 `/<權杖>/`。回 null 是 404。
 */
export interface LocalApp {
  get(path: string, query: URLSearchParams, base: string): LocalReply | null;
  post(path: string, form: URLSearchParams, base: string): Promise<LocalReply | null>;
  /** 擋下的請求的內文。 */
  readonly rejected: string;
}

/** 轉址回頁面，帶著查詢字串。 */
export function redirectTo(base: string, query: Readonly<Record<string, string>>): LocalReply {
  return { status: 303, type: 'text/plain; charset=utf-8', body: '', location: `${base}?${new URLSearchParams(query).toString()}` };
}

export async function startReviewServer({ book, session, texts }: ReviewServerOptions): Promise<ReviewServer> {
  let view: ViewState = ALL_CARDS;
  // 一次只做一個決定：S-16 要比對決定前後的卡，兩個請求交錯就比錯了。
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };

  const page = (base: string, status: number, model: Omit<PageModel, 'base' | 'book' | 'cards' | 'choices' | 'view'>): LocalReply => {
    const full: PageModel = { ...model, base, book, cards: session.cards(), choices: session.choices, view };
    return { status, body: renderPage(full, texts) };
  };

  const decide = async (base: string, id: number, action: 'lock' | 'reject', form: URLSearchParams): Promise<LocalReply> => {
    const tab = sectionOf(form.get('tab'));
    const ids = visible(session.cards()[tab], view).map((card) => card.id);
    const input = formInput(form);
    const result: ReviewDecision = await serial(() => (action === 'lock' ? session.lock(id, input) : session.reject(id)));
    if (!result.ok) {
      if (result.field === 'id') return page(base, 404, { tab, focus: null, notice: texts.error['id'] ?? texts.error.other, invalid: null });
      return page(base, 422, { tab, focus: id, notice: null, invalid: { id, field: result.field, input: input.display } });
    }
    const next = nextAfter(ids, id);
    const renamed = result.renamed === null ? {} : {
      replaced: String(result.renamed.replaced),
      resend: String(result.renamed.resend),
      reset: String(result.renamed.reset),
      in_flight: String(result.renamed.in_flight),
    };
    return redirectTo(base, { tab, done: action, id: String(id), ...(next === null ? {} : { focus: String(next) }), ...renamed });
  };

  const notice = (query: URLSearchParams): string | null => {
    const done = query.get('done');
    const id = query.get('id') ?? '';
    if (done !== 'lock' && done !== 'reject') return null;
    const said = fill(texts.done[done], { id });
    const counts = ['replaced', 'resend', 'reset', 'in_flight'].map((name) => [name, query.get(name)] as const);
    if (counts.some(([, value]) => value === null)) return said;
    return `${said}${fill(texts.renamed, { book, ...Object.fromEntries(counts.map(([name, value]) => [name, value ?? ''])) })}`;
  };

  return startLocalServer({
    rejected: texts.rejected,
    get: (path, query, base) => {
      if (path === '') {
        return page(base, 200, {
          tab: sectionOf(query.get('tab')),
          // 卡的編號都是正整數，看不懂的值（0、NaN）不會對到任何一張。
          focus: Number(query.get('focus')),
          notice: notice(query),
          invalid: null,
        });
      }
      if (path === 'app.css') return { status: 200, type: 'text/css; charset=utf-8', body: STYLE };
      if (path === 'app.js') return { status: 200, type: 'text/javascript; charset=utf-8', body: SCRIPT };
      return null;
    },
    post: async (path, form, base) => {
      if (path === 'view') {
        view = viewOf(form);
        return redirectTo(base, { tab: sectionOf(form.get('tab')) });
      }
      const decision = /^cards\/(\d{1,15})\/(lock|reject)$/.exec(path);
      if (decision === null) return null;
      return decide(base, Number(decision[1]), decision[2] as 'lock' | 'reject', form);
    },
  });
}

/** 只聽本機位址的伺服器，安全的檢查都在這裡，頁面只管內容（ADR-0138、ADR-0139）。 */
export async function startLocalServer(app: LocalApp): Promise<ReviewServer> {
  const token = randomBytes(24).toString('base64url');
  let port = 0;
  const base = `/${token}/`;

  const send = (response: ServerResponse, reply: LocalReply): void => {
    const location = reply.location === undefined ? {} : { Location: reply.location };
    response.writeHead(reply.status, { ...SECURITY_HEADERS, 'Content-Type': reply.type ?? 'text/html; charset=utf-8', ...location });
    response.end(reply.body);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // 別台機器連不到；本機的其他網站改了 DNS 指到這裡（DNS rebinding）時 Host 對不上。
    if (request.headers.host !== `${HOST}:${port}`) throw new Refused(421);
    const url = new URL(request.url ?? '/', `http://${HOST}:${port}`);
    const [, given = '', ...rest] = url.pathname.split('/');
    if (!sameToken(given, token)) throw new Refused(404);
    const path = rest.join('/');
    if (request.method === 'GET') {
      const reply = app.get(path, url.searchParams, base);
      if (reply === null) throw new Refused(404);
      send(response, reply);
      return;
    }
    if (request.method !== 'POST') throw new Refused(405);
    // 別的網站在瀏覽器裡代送的表單，Origin 是那個網站。
    if (request.headers.origin !== `http://${HOST}:${port}`) throw new Refused(403);
    const form = await readForm(request);
    const reply = await app.post(path, form, base);
    if (reply === null) throw new Refused(404);
    send(response, reply);
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const status = error instanceof Refused ? error.status : 500;
      if (!response.headersSent) send(response, { status, type: 'text/plain; charset=utf-8', body: app.rejected });
      else response.end();
      // 讀不完的請求不留著。
      request.resume();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  // 聽 TCP 的埠，address() 一定是有 port 的物件。
  port = (server.address() as { readonly port: number }).port;
  return {
    url: `http://${HOST}:${port}/${token}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
