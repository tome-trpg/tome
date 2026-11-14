import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { glossaryReviewTexts, reviewPageTexts } from '../../src/cli/messages.ts';
import type { Envelope } from '../../src/cli/output.ts';
import { fill } from '../../src/cli/review/page.ts';
import { browserCommand } from '../../src/cli/review/web.ts';
import { run, untilInterrupted, type Io } from '../../src/cli/run.ts';
import { reviewOnWeb, type ReviewCard, type ReviewChoices, type ReviewSection } from '../../src/core/glossary.ts';
import type { ToolRunner } from '../../src/core/process.ts';
import { openBookStore, type Store } from '../../src/core/store.ts';
import { library, MODEL, type Library } from '../helpers/library.ts';

// `tome glossary review --web`（ADR-0138）：對真的本機伺服器送請求。文字都是這裡編的。

function block(id: string, text: string): Record<string, unknown> {
  return {
    id,
    content_hash: createHash('sha256').update(text).digest('hex'),
    role: 'paragraph',
    flow: 'main',
    spans: [{ page: 0, bbox: [0, 0, 10, 10] }],
    text,
    raw: text,
    lang: 'en',
    writing_mode: 'horizontal-tb',
    provenance: { engine: 'fake', version: '1', config_hash: 'b'.repeat(64) },
  };
}

const BLOCKS = [
  block('p0000-aaaaa1', 'The Grey Warden keeps the Salt Marsh. She counts the tide stones each night.'),
  block('p0000-aaaaa2', 'Travellers meet the Grey Warden at the Old Ferry, near the Salt Marsh.'),
];

function withStore<T>(home: string, action: (store: Store) => T): T {
  const store = openBookStore(home, 'book');
  try {
    return action(store);
  } finally {
    store.close();
  }
}

/** 要人審：Salt Marsh、Grey Warden、Harrow Gate。自動鎖定：Old Ferry。略過：Each Night。 */
async function book(): Promise<Library> {
  const lib = await library({ config: `scanner_model: ${MODEL}\ntranslator_model: ${MODEL}\n` });
  const path = join(lib.home, 'books', 'book', 'ir', 'document.json');
  const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...document, sections: [], blocks: BLOCKS }));
  await run(['status', 'book'], lib.session().io);
  withStore(lib.home, (store) => {
    const add = (source: string, target: string | null, status: string, occurrences: number, kind: string | null, gender: string | null, pronoun: string | null): void => {
      store.run(
        `INSERT INTO entity (source, target, status, origin, sources, occurrences, class, gender, pronoun, created_at, updated_at)
         VALUES (?, ?, ?, 'pass0', '["caps"]', ?, ?, ?, ?, 't', 't')`,
        source,
        target,
        status,
        occurrences,
        kind,
        gender,
        pronoun,
      );
    };
    add('Salt Marsh', '鹽沼', 'proposed', 6, 'place', null, null);
    add('Grey Warden', '灰色守望者', 'proposed', 2, 'person', 'female', '她');
    add('Old Ferry', '老渡口', 'proposed', 1, 'place', null, null);
    add('Harrow Gate', null, 'failed', 3, null, null, null);
    add('Each Night', null, 'skipped', 1, null, null, null);
  });
  return lib;
}

function idOf(home: string, source: string): number {
  return withStore(home, (store) => store.get<{ id: number }>('SELECT id FROM entity WHERE source = ?', source)?.id ?? 0);
}

function card(home: string, source: string): Record<string, unknown> {
  return withStore(home, (store) =>
    store.get<Record<string, unknown>>('SELECT target, class, status, decided_by, previous_target, match FROM entity WHERE source = ?', source) ?? {},
  );
}

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** 用 node:http 送，Host 與 Origin 才能隨意設；測試不在 ADR-0039 的斷言範圍內。 */
function call(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const sent = request(url, { method: options.method ?? 'GET', headers: options.headers ?? {} }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    sent.on('error', reject);
    sent.end(options.body);
  });
}

interface Web {
  readonly url: string;
  readonly origin: string;
  readonly calls: readonly (readonly [string, readonly string[]])[];
  readonly stderr: () => string;
  post(path: string, fields: Record<string, string | readonly string[]>, headers?: Record<string, string>): Promise<Reply>;
  stop(): Promise<{ readonly exit: number; readonly output: Envelope; readonly text: string }>;
}

async function waitFor<T>(probe: () => T | undefined): Promise<T> {
  for (let tries = 0; tries < 500; tries += 1) {
    const found = probe();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

function encode(fields: Record<string, string | readonly string[]>): string {
  const form = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of typeof value === 'string' ? [value] : value) form.append(name, item);
  }
  return form.toString();
}

async function openWeb(lib: Library, extra: readonly string[] = ['--no-open'], overrides: Partial<Io> = {}): Promise<Web> {
  let finish = (): void => undefined;
  const stopped = new Promise<void>((resolve) => (finish = resolve));
  const calls: (readonly [string, readonly string[]])[] = [];
  const tool: ToolRunner = async (command, args) => {
    calls.push([command, args]);
    return { stdout: '' };
  };
  const { io, stdout, stderr } = lib.session({ interrupted: () => stopped, tool, ...overrides });
  const done = run(['glossary', 'review', 'book', '--web', ...extra, '--json'], io);
  const url = await waitFor(() => /http:\/\/127\.0\.0\.1:\d+\/[\w-]+\//.exec(stderr())?.[0]);
  const origin = new URL(url).origin;
  return {
    url,
    origin,
    calls,
    stderr,
    post: (path, fields, headers = { origin, 'content-type': 'application/x-www-form-urlencoded' }) =>
      call(new URL(path, url).toString(), { method: 'POST', headers, body: encode(fields) }),
    stop: async () => {
      finish();
      const exit = await done;
      return { exit, output: JSON.parse(stdout()) as Envelope, text: stdout() };
    },
  };
}

/** 跟頁面上的表單一樣：勾選框打勾才送。 */
function lockForm(fields: Record<string, string | readonly string[]>): Record<string, string | readonly string[]> {
  return { form: 'card', tab: 'review', case_sensitive: '1', whole_word: '1', ...fields };
}

function codes(output: Envelope): string[] {
  return output.findings.map(({ code }) => code);
}

function articles(body: string): number {
  return body.match(/<article /g)?.length ?? 0;
}

describe('tome glossary review --web (ADR-0138)', () => {
  it('serves the page to the token and the right Host only, with no cache, a tight CSP and no CORS', async () => {
    const lib = await book();
    const web = await openWeb(lib);
    try {
      const page = await call(web.url);
      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.headers['content-security-policy']).toMatch(/^default-src 'self'/);
      expect(page.headers['access-control-allow-origin']).toBeUndefined();
      expect(page.headers['x-content-type-options']).toBe('nosniff');
      // no-referrer 會讓瀏覽器在表單的 Origin 送 null，自己的表單就被擋下（在瀏覽器裡實際點過才找到）。
      expect(page.headers['referrer-policy']).toBe('same-origin');
      expect(page.body).toContain('Salt Marsh');
      expect(articles(page.body)).toBe(3);

      const port = new URL(web.url).port;
      const token = new URL(web.url).pathname.split('/')[1] ?? '';
      expect(token.length).toBeGreaterThanOrEqual(32);
      expect((await call(`http://127.0.0.1:${port}/`)).status).toBe(404);
      expect((await call(`http://127.0.0.1:${port}/${token.slice(1)}x/`)).status).toBe(404);
      for (const host of [`localhost:${port}`, 'attacker.example', `127.0.0.1:${Number(port) + 1}`]) {
        const refused = await call(web.url, { headers: { host } });
        expect(refused).toMatchObject({ status: 421, body: reviewPageTexts.rejected });
        expect(refused.headers['content-type']).toBe('text/plain; charset=utf-8');
        expect(refused.headers['cache-control']).toBe('no-store');
      }
      expect((await call(web.url, { method: 'PUT' })).status).toBe(405);
    } finally {
      await web.stop();
    }
  });

  it('serves its own style and script, and the script never reaches the network', async () => {
    const lib = await book();
    const web = await openWeb(lib);
    try {
      const style = await call(new URL('app.css', web.url).toString());
      expect(style).toMatchObject({ status: 200, headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' } });
      expect(style.body).toContain('[aria-invalid="true"]');
      expect(style.body).toContain('prefers-color-scheme: dark');
      const script = await call(new URL('app.js', web.url).toString());
      expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(script.body).toContain('requestSubmit');
      expect(script.body).not.toMatch(/\b(fetch|WebSocket|EventSource|XMLHttpRequest|localStorage|sessionStorage|indexedDB)\b/);
      expect((await call(new URL('nothing.js', web.url).toString())).status).toBe(404);
    } finally {
      await web.stop();
    }
  });

  it('refuses a write from another origin, without an origin, or not sent as a form, and changes nothing', async () => {
    const lib = await book();
    const web = await openWeb(lib);
    const id = idOf(lib.home, 'Salt Marsh');
    try {
      const fields = lockForm({ target: '鹽澤', class: 'place' });
      const form = { 'content-type': 'application/x-www-form-urlencoded' };
      expect((await web.post(`cards/${id}/lock`, fields, form)).status).toBe(403);
      expect((await web.post(`cards/${id}/lock`, fields, { ...form, origin: 'http://attacker.example' })).status).toBe(403);
      expect((await web.post(`cards/${id}/lock`, fields, { ...form, origin: `http://localhost:${new URL(web.url).port}` })).status).toBe(403);
      expect((await web.post(`cards/${id}/lock`, fields, { origin: web.origin, 'content-type': 'application/json' })).status).toBe(415);
      expect((await web.post(`cards/${id}/lock`, fields, { origin: web.origin })).status).toBe(415);
      expect((await web.post(`cards/${id}/lock`, { target: 'x'.repeat(70_000) })).status).toBe(413);
      // 路徑要整段對上，編號可以很多位數；對不上的是 404 的純文字，找不到卡的是 404 的頁面。
      for (const path of [`cards/${id}/promote`, `xcards/${id}/lock`, `cards/${id}/lockx`, `cards/${id}x/lock`]) {
        expect(await web.post(path, fields)).toMatchObject({ status: 404, body: reviewPageTexts.rejected });
      }
      const missing = await web.post('cards/123456789/lock', fields);
      expect(missing.status).toBe(404);
      expect(missing.body).toContain(reviewPageTexts.error['id']);
      expect(card(lib.home, 'Salt Marsh')).toMatchObject({ target: '鹽沼', status: 'proposed' });
    } finally {
      await web.stop();
    }
  });

  it('reads the form type the way browsers write it, and takes a body of exactly 64 KiB', async () => {
    const lib = await book();
    const web = await openWeb(lib);
    try {
      const fields = { tab: 'review', q: '' };
      for (const type of ['Application/X-WWW-Form-Urlencoded', 'application/x-www-form-urlencoded ; charset=UTF-8']) {
        expect((await web.post('view', fields, { origin: web.origin, 'content-type': type })).status).toBe(303);
      }
      const limit = 64 * 1024;
      const exact = await web.post('view', { q: 'x'.repeat(limit - 'q='.length) });
      expect(exact.status).toBe(303);
      expect((await web.post('view', { q: 'x'.repeat(limit - 'q='.length + 1) })).status).toBe(413);
    } finally {
      await web.stop();
    }
  });

  it('listens on the loopback address only, and stops listening at the end', async () => {
    const lib = await book();
    const web = await openWeb(lib);
    const port = new URL(web.url).port;
    const outside = Object.values(networkInterfaces())
      .flat()
      .find((address) => address !== undefined && address.family === 'IPv4' && !address.internal);
    try {
      // 別的網路介面連不到；這台機器沒有別的介面時，只確認本機連得到。
      if (outside !== undefined) await expect(call(`http://${outside.address}:${port}/`)).rejects.toThrow();
      expect((await call(web.url)).status).toBe(200);
    } finally {
      await web.stop();
    }
    await expect(call(web.url)).rejects.toThrow();
  });

  it('locks a card as human with the checks of the review file, and moves on to the next card', async () => {
    const lib = await book();
    const web = await openWeb(lib);
    const marsh = idOf(lib.home, 'Salt Marsh');
    try {
      const locked = await web.post(`cards/${marsh}/lock`, lockForm({ target: ' 鹽澤 ', class: 'place', roles: ['paragraph'] }));
      expect(locked).toMatchObject({ status: 303, body: '' });
      expect(locked.headers['content-type']).toBe('text/plain; charset=utf-8');
      const location = new URL(locked.headers.location ?? '', web.url);
      expect(location.pathname).toBe(new URL(web.url).pathname);
      expect(Object.fromEntries(location.searchParams)).toEqual({ tab: 'review', done: 'lock', id: String(marsh), focus: String(idOf(lib.home, 'Harrow Gate')) });
      expect(card(lib.home, 'Salt Marsh')).toMatchObject({ target: '鹽澤', status: 'locked', decided_by: 'human', match: '{"roles":["paragraph"]}' });

      const page = await call(location.toString());
      expect(page.body).toMatch(new RegExp(`id="card-${idOf(lib.home, 'Harrow Gate')}" tabindex="0" data-focus`));
      // 沒有改到已鎖定的譯名，提示只有一句。
      expect(page.body).toContain(`<p class="notice" role="status">${fill(reviewPageTexts.done.lock, { id: String(marsh) })}</p>`);
      expect(articles(page.body)).toBe(2);

      // 大小寫與整個詞沒勾，就是不比；沒帶表單標記時照預設值。
      const warden = idOf(lib.home, 'Grey Warden');
      await web.post(`cards/${warden}/lock`, { form: 'card', target: '灰衣守望者', class: 'person', gender: 'male', pronoun: '他', keep_source: '1' });
      expect(card(lib.home, 'Grey Warden')).toMatchObject({ match: '{"case_sensitive":false,"whole_word":false}', decided_by: 'human' });
      expect(withStore(lib.home, (store) => store.get('SELECT gender, pronoun, keep_source FROM entity WHERE id = ?', warden))).toEqual({
        gender: 'male',
        pronoun: '他',
        keep_source: 1,
      });
      const gate = idOf(lib.home, 'Harrow Gate');
      await web.post(`cards/${gate}/lock`, { target: '哈洛門' });
      expect(card(lib.home, 'Harrow Gate')).toMatchObject({ match: null, status: 'locked' });
    } finally {
      await web.stop();
    }
  });

  it('rejects a card, and focuses the one before when it was the last', async () => {
    const lib = await book();
    const web = await openWeb(lib);
    const gate = idOf(lib.home, 'Harrow Gate');
    const warden = idOf(lib.home, 'Grey Warden');
    try {
      const rejected = await web.post(`cards/${warden}/reject`, { form: 'card', tab: 'review' });
      expect(rejected.status).toBe(303);
      const location = new URL(rejected.headers.location ?? '', web.url);
      expect(location.searchParams.get('focus')).toBe(String(gate));
      expect(card(lib.home, 'Grey Warden')).toMatchObject({ status: 'rejected', decided_by: 'human' });
      expect((await call(location.toString())).body).toContain(`role="status">${fill(reviewPageTexts.done.reject, { id: String(warden) })}</p>`);
      // 已拒絕的卡不在三段裡，再送一次是找不到。
      const again = await web.post(`cards/${warden}/lock`, lockForm({ target: '灰衣守望者' }));
      expect(again.status).toBe(404);
      expect(again.body).toContain(`role="status">${reviewPageTexts.error['id']}</p>`);
    } finally {
      await web.stop();
    }
  });

  it('decides a card that is not on the tab it came from, and focuses nothing when it was the only one', async () => {
    const lib = await book();
    const web = await openWeb(lib);
    try {
      // 不是專有名詞的卡也能決定。從別的分頁送來的，聚焦在那個分頁的第一張。
      const night = await web.post(`cards/${idOf(lib.home, 'Each Night')}/lock`, lockForm({ tab: 'review', target: '每晚' }));
      expect(new URL(night.headers.location ?? '', web.url).searchParams.get('focus')).toBe(String(idOf(lib.home, 'Salt Marsh')));
      expect(card(lib.home, 'Each Night')).toMatchObject({ status: 'locked', decided_by: 'human' });
      await web.post('view', { tab: 'review', q: 'marsh' });
      const only = await web.post(`cards/${idOf(lib.home, 'Salt Marsh')}/reject`, { tab: 'review' });
      expect(Object.fromEntries(new URL(only.headers.location ?? '', web.url).searchParams)).toEqual({
        tab: 'review',
        done: 'reject',
        id: String(idOf(lib.home, 'Salt Marsh')),
      });
      // 沒有編號的提示照樣填，看不懂的提示不印，S-16 的數量缺一個就不說 S-16。
      expect((await call(`${web.url}?done=reject`)).body).toContain(`role="status">${fill(reviewPageTexts.done.reject, { id: '' })}</p>`);
      expect((await call(`${web.url}?done=other&id=1`)).body).not.toContain('role="status"');
      const partial = (await call(`${web.url}?done=lock&id=3&replaced=0&resend=0&reset=0`)).body;
      expect(partial).toContain(`role="status">${fill(reviewPageTexts.done.lock, { id: '3' })}</p>`);
    } finally {
      await web.stop();
    }
  });

  it('hands the page every field of each card from the core, and the choices the checks allow', async () => {
    const lib = await book();
    withStore(lib.home, (store) =>
      store.run(`UPDATE entity SET keep_source = 1, register = 'formal', match = '{"roles":["heading"]}' WHERE source = 'Salt Marsh'`),
    );
    let cards: Readonly<Record<ReviewSection, readonly ReviewCard[]>> | null = null;
    let choices: ReviewChoices | null = null;
    await reviewOnWeb({
      home: lib.home,
      slug: 'book',
      texts: glossaryReviewTexts,
      serve: async (session) => {
        cards = session.cards();
        choices = session.choices;
      },
    });
    const review = (cards as unknown as Record<ReviewSection, readonly ReviewCard[]>).review;
    expect(review.find(({ source }) => source === 'Salt Marsh')).toEqual({
      id: idOf(lib.home, 'Salt Marsh'),
      source: 'Salt Marsh',
      target: '鹽沼',
      class: 'place',
      gender: null,
      pronoun: null,
      register: 'formal',
      keep_source: true,
      case_sensitive: true,
      whole_word: true,
      roles: ['heading'],
      count: 6,
      origin: 'pass0',
      decided_by: null,
      seen_in: ['The Grey Warden keeps the Salt Marsh.', 'She counts the tide stones each night.'],
    });
    expect(review.find(({ source }) => source === 'Harrow Gate')).toMatchObject({ target: null, keep_source: false, roles: [], case_sensitive: true, whole_word: true });
    const allowed = choices as unknown as ReviewChoices;
    expect(allowed.classes).toEqual(['creature', 'deity', 'item', 'organization', 'person', 'place', 'skill', 'spell']);
    expect(allowed.genders).toEqual(['female', 'male', 'none']);
    expect(allowed.pronouns).toEqual((parse(readFileSync('languages/target/zh-TW.yaml', 'utf8')) as { pronouns: string[] }).pronouns);
    expect(allowed.roles).toEqual([...allowed.roles].sort());
    expect(allowed.roles).toEqual(expect.arrayContaining(['heading', 'paragraph']));
  });

  it('ends a request still being sent when Ctrl+C comes', async () => {
    const lib = await book();
    const web = await openWeb(lib);
    const pending = request(new URL('view', web.url), {
      method: 'POST',
      headers: { origin: web.origin, 'content-type': 'application/x-www-form-urlencoded', 'content-length': '100' },
    });
    const ended = new Promise((resolve) => {
      pending.on('error', resolve);
      pending.on('response', resolve);
    });
    pending.write('q=half');
    await new Promise((resolve) => setTimeout(resolve, 200));
    // 沒把還在送的連線關掉，伺服器會一直等它送完，結束不了。
    const { exit } = await web.stop();
    expect(exit).toBe(0);
    await ended;
  });

  it('waits for Ctrl+C itself when the caller gives no way to stop', async () => {
    const lib = await book();
    const before = process.rawListeners('SIGINT');
    const { io, stderr } = lib.session();
    const done = run(['glossary', 'review', 'book', '--web', '--no-open', '--json'], io);
    await waitFor(() => (stderr().includes('127.0.0.1') ? true : undefined));
    // 不真的送 SIGINT 給測試的行程：只叫這次加上的那一個。
    const added = process.rawListeners('SIGINT').filter((listener) => !before.includes(listener));
    expect(added).toHaveLength(1);
    for (const listener of added) (listener as () => void)();
    expect(await done).toBe(0);
  });

  it('shows what book.db holds for each card, with the choices the checks allow', async () => {
    const lib = await book();
    withStore(lib.home, (store) =>
      store.run(`UPDATE entity SET keep_source = 1, match = '{"case_sensitive":false,"roles":["heading"]}' WHERE source = 'Salt Marsh'`),
    );
    const web = await openWeb(lib);
    try {
      const body = (await call(web.url)).body;
      const marsh = body.slice(body.indexOf(`id="card-${idOf(lib.home, 'Salt Marsh')}"`), body.indexOf(`id="card-${idOf(lib.home, 'Harrow Gate')}"`));
      const gate = body.slice(body.indexOf(`id="card-${idOf(lib.home, 'Harrow Gate')}"`), body.indexOf(`id="card-${idOf(lib.home, 'Grey Warden')}"`));
      expect(gate).toContain('<input type="checkbox" name="keep_source" value="1">');
      expect(marsh).toContain('<input type="checkbox" name="keep_source" value="1" checked>');
      expect(marsh).toContain('<input type="checkbox" name="case_sensitive" value="1">');
      expect(marsh).toContain('<input type="checkbox" name="whole_word" value="1" checked>');
      expect(marsh).toContain('<input type="checkbox" name="roles" value="heading" checked>');
      expect(marsh).toContain('<input type="checkbox" name="roles" value="paragraph">');
      const options = (name: string): string[] => {
        const start = marsh.indexOf(`<select name="${name}"`);
        const select = marsh.slice(start, marsh.indexOf('</select>', start));
        return [...select.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1] ?? '');
      };
      expect(options('class')).toEqual(['', 'creature', 'deity', 'item', 'organization', 'person', 'place', 'skill', 'spell']);
      expect(options('gender')).toEqual(['', 'female', 'male', 'none']);
      expect(options('pronoun')).toEqual(['', ...(parse(readFileSync('languages/target/zh-TW.yaml', 'utf8')) as { pronouns: string[] }).pronouns]);
      const roles = [...marsh.matchAll(/name="roles" value="([^"]*)"/g)].map((match) => match[1] ?? '');
      expect(roles).toEqual([...roles].sort());
      expect(roles).toContain('paragraph');
      // 已鎖定的卡也看得到出現的句子。
      const locked = (await call(`${web.url}?tab=locked`)).body;
      expect(locked).toContain('<li>Travellers meet the Grey Warden at the Old Ferry, near the Salt Marsh.</li>');
    } finally {
      await web.stop();
    }
  });

  it('marks the field a person got wrong, keeps what they typed, and applies nothing', async () => {
    const lib = await book();
    const web = await openWeb(lib);
    const marsh = idOf(lib.home, 'Salt Marsh');
    try {
      // 只看驗證沒過的那張卡：別的卡的勾選框照預設值，會混在一起。
      const cardOf = (body: string): string => body.slice(body.indexOf(`id="card-${marsh}"`), body.indexOf('</article>', body.indexOf(`id="card-${marsh}"`)));
      const typed = { form: 'card', tab: 'review', target: '鹽澤', class: 'swamp', register: 'archaic', keep_source: '1', whole_word: '1' };
      const wrong = await web.post(`cards/${marsh}/lock`, { ...typed, gender: 'male', pronoun: '他' });
      expect(wrong.status).toBe(422);
      const shown = cardOf(wrong.body);
      expect(shown).toContain('<select name="class" aria-invalid="true"');
      expect(shown).toContain('<option value="swamp" selected>swamp</option>');
      expect(shown).toContain('value="archaic"');
      expect(shown).toContain('<option value="male" selected>');
      expect(shown).toContain('<option value="他" selected>');
      expect(shown).toContain('<input type="checkbox" name="keep_source" value="1" checked>');
      expect(shown).toContain('<input type="checkbox" name="case_sensitive" value="1">');
      expect(shown).toContain('<input type="checkbox" name="whole_word" value="1" checked>');
      const flipped = cardOf((await web.post(`cards/${marsh}/lock`, { form: 'card', tab: 'review', target: '鹽澤', class: 'swamp', case_sensitive: '1' })).body);
      expect(flipped).toContain('<input type="checkbox" name="keep_source" value="1">');
      expect(flipped).toContain('<input type="checkbox" name="case_sensitive" value="1" checked>');
      expect(flipped).toContain('<input type="checkbox" name="whole_word" value="1">');
      expect(wrong.body).toContain(`id="error-${marsh}" role="alert"`);
      // 這一頁是在 cards/<id>/lock 送回來的，網址都要從權杖寫起，樣式、腳本與表單才找得到。
      const base = new URL(web.url).pathname;
      expect(wrong.body).toContain(`src="${base}app.js"`);
      expect(wrong.body).toContain(`action="${base}cards/${marsh}/lock"`);
      const simplified = await web.post(`cards/${marsh}/lock`, lockForm({ target: String.fromCodePoint(0x95e8) }));
      expect(simplified.status).toBe(422);
      expect(simplified.body).toContain(`name="target" value="${String.fromCodePoint(0x95e8)}"`);
      expect(simplified.body).toMatch(/name="target"[^>]*aria-invalid="true"/);
      expect((await web.post(`cards/${marsh}/lock`, lockForm({ target: '鹽澤', roles: ['nowhere'] }))).status).toBe(422);
      expect(card(lib.home, 'Salt Marsh')).toMatchObject({ target: '鹽沼', status: 'proposed', decided_by: null });
    } finally {
      await web.stop();
    }
  });

  it('runs S-16 when a locked card gets a new target, and says so on the page', async () => {
    const lib = await book();
    const web = await openWeb(lib);
    const ferry = idOf(lib.home, 'Old Ferry');
    expect(card(lib.home, 'Old Ferry')).toMatchObject({ status: 'locked', decided_by: 'auto' });
    const changed = await web.post(`cards/${ferry}/lock`, lockForm({ tab: 'locked', target: '舊渡口', class: 'place' }));
    const location = new URL(changed.headers.location ?? '', web.url);
    const counts = { replaced: '0', resend: '0', reset: '0', in_flight: '0' };
    expect(Object.fromEntries(location.searchParams)).toEqual({ tab: 'locked', done: 'lock', id: String(ferry), ...counts });
    expect(card(lib.home, 'Old Ferry')).toMatchObject({ target: '舊渡口', previous_target: '老渡口', decided_by: 'human' });
    const said = `${fill(reviewPageTexts.done.lock, { id: String(ferry) })}${fill(reviewPageTexts.renamed, { book: 'book', ...counts })}`;
    expect((await call(location.toString())).body).toContain(`role="status">${said}</p>`);
    await web.post(`cards/${ferry}/lock`, lockForm({ tab: 'locked', target: '老渡頭', class: 'place' }));
    // 結束時把每次的 S-16 加起來印一次。
    const { output } = await web.stop();
    expect(output.data['web']).toEqual({ locked: 2, rejected: 0, rewritten: true, renamed: { replaced: 0, resend: 0, reset: 0, in_flight: 0 } });
    expect(codes(output)).toEqual(['glossary.reviewed', 'glossary.web_done', 'glossary.renamed']);
  });

  it('filters by search, class and proposal, and never puts the search in the address', async () => {
    const lib = await book();
    const web = await openWeb(lib);
    try {
      const searched = await web.post('view', { tab: 'review', q: 'MARSH', kind: '', proposal: 'all' });
      expect(searched.status).toBe(303);
      expect(searched.headers.location).not.toMatch(/marsh/i);
      expect(articles((await call(web.url)).body)).toBe(1);
      await web.post('view', { tab: 'review', q: '守望', kind: 'person', proposal: 'with' });
      expect(articles((await call(web.url)).body)).toBe(1);
      // 篩選列裡的選項：卡片的類別選單也有同樣的 option，只看篩選的表單。
      const filters = (body: string): string => body.slice(body.indexOf('<form class="filters"'), body.indexOf('</form>', body.indexOf('<form class="filters"')));
      await web.post('view', { tab: 'review', kind: 'place' });
      const place = (await call(web.url)).body;
      expect(articles(place)).toBe(1);
      expect(filters(place)).toContain('<option value="place" selected>place</option>');
      expect(filters(place)).toContain('<option value="person">person</option>');
      await web.post('view', { tab: 'review', proposal: 'with' });
      expect(articles((await call(web.url)).body)).toBe(2);
      await web.post('view', { tab: 'review', proposal: 'maybe' });
      const maybe = (await call(web.url)).body;
      expect(articles(maybe)).toBe(3);
      expect(filters(maybe)).toContain('<option value="all" selected>');
      const kept = await web.post('view', { tab: 'locked', proposal: 'without' });
      expect(new URL(kept.headers.location ?? '', web.url).search).toBe('?tab=locked');
      const none = (await call(web.url)).body;
      expect(articles(none)).toBe(1);
      expect(none).toContain('Harrow Gate');
      expect(none).toContain('<option value="without" selected>');
      await web.post('view', { tab: 'review', q: 'nothing', kind: 'place', proposal: 'all' });
      expect(articles((await call(web.url)).body)).toBe(0);
      await web.post('view', { tab: 'review', clear: '1', q: 'nothing' });
      expect(articles((await call(web.url)).body)).toBe(3);
      expect(articles((await call(`${web.url}?tab=skipped`)).body)).toBe(1);
      expect(articles((await call(`${web.url}?tab=locked`)).body)).toBe(1);
    } finally {
      await web.stop();
    }
  });

  it('rewrites the review file from book.db at the end, and prints counts only', async () => {
    const lib = await book();
    const web = await openWeb(lib);
    await web.post(`cards/${idOf(lib.home, 'Salt Marsh')}/lock`, lockForm({ target: '鹽澤', class: 'place' }));
    await web.post(`cards/${idOf(lib.home, 'Grey Warden')}/reject`, { tab: 'review' });
    const { exit, output, text } = await web.stop();
    expect(exit).toBe(0);
    expect(codes(output)).toEqual(['glossary.reviewed', 'glossary.web_done']);
    expect(output.findings.at(-1)).toMatchObject({ level: 'info', params: { locked: '1', rejected: '1', review: '1' } });
    expect(output.findings[0]).toMatchObject({ level: 'info' });
    expect(output.data['web']).toEqual({ locked: 1, rejected: 1, rewritten: true });
    expect(output.data).toMatchObject({ entities: { review: 1, human: 1, auto: 1 } });
    const file = parse(readFileSync(join(lib.home, 'books', 'book', 'glossary-review.yaml'), 'utf8')) as Record<string, { source: string; decided_by?: string; target?: string }[]>;
    expect(file['review']?.map(({ source }) => source)).toEqual(['Harrow Gate']);
    expect(file['locked']?.find(({ source }) => source === 'Salt Marsh')).toMatchObject({ target: '鹽澤', decided_by: 'human' });
    for (const word of ['Salt Marsh', '鹽澤', 'Grey Warden', 'tide stones']) {
      expect(text).not.toContain(word);
      expect(web.stderr()).not.toContain(word);
    }
    expect(web.stderr()).toContain('Ctrl+C');
  });

  it('reads the review file and applies its decisions before the page opens', async () => {
    const lib = await book();
    await run(['glossary', 'review', 'book'], lib.session().io);
    const path = join(lib.home, 'books', 'book', 'glossary-review.yaml');
    const file = parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>[]>;
    for (const entry of file['review'] ?? []) {
      if (entry['source'] === 'Salt Marsh') Object.assign(entry, { decision: 'lock' });
      if (entry['source'] === 'Grey Warden') Object.assign(entry, { target: '灰衣守望者' });
    }
    writeFileSync(path, JSON.stringify(file));
    const web = await openWeb(lib);
    const locked = (await call(`${web.url}?tab=locked`)).body;
    expect(locked).toContain('Salt Marsh');
    const { output } = await web.stop();
    expect(output.data).toMatchObject({ applied: { locked: 1 } });
    // 人填了、還沒決定的修改照樣留在審定檔裡。
    const after = parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>[]>;
    expect(after['review']?.find(({ source }) => source === 'Grey Warden')).toMatchObject({ target: '灰衣守望者' });
  });

  it('drops what the file still held for a card decided on the page, as the page decided later', async () => {
    const lib = await book();
    await run(['glossary', 'review', 'book'], lib.session().io);
    const path = join(lib.home, 'books', 'book', 'glossary-review.yaml');
    const file = parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>[]>;
    for (const entry of file['review'] ?? []) {
      if (entry['source'] === 'Grey Warden') Object.assign(entry, { target: '灰衣守望者' });
    }
    writeFileSync(path, JSON.stringify(file));
    const web = await openWeb(lib);
    await web.post(`cards/${idOf(lib.home, 'Grey Warden')}/lock`, lockForm({ target: '灰袍守望者', class: 'person', gender: 'female', pronoun: '她' }));
    await web.stop();
    const after = parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>[]>;
    expect(after['locked']?.find(({ source }) => source === 'Grey Warden')).toMatchObject({ target: '灰袍守望者', decided_by: 'human' });
  });

  it('leaves the review file alone when a person changed it while the page was open', async () => {
    const lib = await book();
    const web = await openWeb(lib);
    const path = join(lib.home, 'books', 'book', 'glossary-review.yaml');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n# edited\n`);
    const edited = readFileSync(path, 'utf8');
    const { exit, output } = await web.stop();
    expect(exit).toBe(0);
    expect(output.findings.at(-1)).toMatchObject({ code: 'glossary.web_file_changed', level: 'warn', params: { book: 'book', path } });
    expect(output.data).toMatchObject({ web: { rewritten: false } });
    expect(readFileSync(path, 'utf8')).toBe(edited);
  });

  it('holds the book lock while the page is open, and lets go at the end', async () => {
    const lib = await book();
    const web = await openWeb(lib);
    const busy = lib.session();
    expect(await run(['glossary', 'review', 'book', '--json'], busy.io)).toBe(2);
    expect(codes(JSON.parse(busy.stdout()) as Envelope)).toEqual(['book.busy']);
    const status = lib.session();
    expect(await run(['status', 'book'], status.io)).toBe(0);
    await web.stop();
    expect(await run(['glossary', 'review', 'book'], lib.session().io)).toBe(0);
  });

  it('does not open the page when it cannot read the review file', async () => {
    const lib = await book();
    await run(['glossary', 'review', 'book'], lib.session().io);
    writeFileSync(join(lib.home, 'books', 'book', 'glossary-review.yaml'), 'review: [unclosed\n');
    const { io, stdout, stderr } = lib.session({ interrupted: () => new Promise(() => undefined) });
    const exit = await run(['glossary', 'review', 'book', '--web', '--json'], io);
    expect(exit).toBe(1);
    expect(codes(JSON.parse(stdout()) as Envelope)).toEqual(['glossary.file_invalid']);
    expect(stderr()).not.toContain('127.0.0.1');
  });

  it('opens the default browser through the tool runner, unless told not to', async () => {
    const lib = await book();
    const opened = await openWeb(lib, [], { platform: 'win32' });
    await waitFor(() => (opened.calls.length > 0 ? true : undefined));
    expect(opened.calls).toEqual([['rundll32', ['url.dll,FileProtocolHandler', opened.url]]]);
    await opened.stop();
    expect(opened.stderr()).not.toContain('手動開啟上面的網址');
    const quiet = await openWeb(lib, ['--no-open']);
    await quiet.stop();
    expect(quiet.calls).toEqual([]);
  });

  it('says to open the address by hand when no browser opens', async () => {
    const lib = await book();
    const web = await openWeb(lib, [], { tool: async () => null });
    await waitFor(() => (web.stderr().includes('手動開啟上面的網址') ? true : undefined));
    await web.stop();
  });
});

describe('the command line', () => {
  it('asks for the book', async () => {
    const lib = await book();
    const { io, stdout } = lib.session();
    expect(await run(['glossary', 'review', '--web', '--json'], io)).toBe(2);
    const output = JSON.parse(stdout()) as Envelope;
    expect(codes(output)).toEqual(['cli.missing_argument']);
    expect(output.findings[0]?.params).toEqual({ argument: '<名稱>' });
  });

  it('waits for Ctrl+C by default', async () => {
    const source = new EventEmitter();
    let done = false;
    const waiting = untilInterrupted(source as unknown as NodeJS.Process).then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    source.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    source.emit('SIGINT');
    await waiting;
    expect(done).toBe(true);
    expect(source.listenerCount('SIGINT')).toBe(0);
  });
});

describe('browserCommand', () => {
  it('uses the opener of each platform, without a shell on Windows', () => {
    const url = 'http://127.0.0.1:1/t/';
    expect(browserCommand(url, 'win32')).toEqual({ command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] });
    expect(browserCommand(url, 'darwin')).toEqual({ command: 'open', args: [url] });
    expect(browserCommand(url, 'linux')).toEqual({ command: 'xdg-open', args: [url] });
    expect(browserCommand(url, 'freebsd')).toEqual({ command: 'xdg-open', args: [url] });
  });
});
