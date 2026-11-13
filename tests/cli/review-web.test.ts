import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { Envelope } from '../../src/cli/output.ts';
import { browserCommand } from '../../src/cli/review/web.ts';
import { run, type Io } from '../../src/cli/run.ts';
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
        expect(refused.status).toBe(421);
        expect(refused.body).not.toContain('Salt Marsh');
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
      expect((await web.post(`cards/${id}/lock`, { target: 'x'.repeat(70_000) })).status).toBe(413);
      expect((await web.post(`cards/${id}/promote`, fields)).status).toBe(404);
      expect(card(lib.home, 'Salt Marsh')).toMatchObject({ target: '鹽沼', status: 'proposed' });
    } finally {
      await web.stop();
    }
  });

  it('locks a card as human with the checks of the review file, and moves on to the next card', async () => {
    const lib = await book();
    const web = await openWeb(lib);
    const marsh = idOf(lib.home, 'Salt Marsh');
    try {
      const locked = await web.post(`cards/${marsh}/lock`, lockForm({ target: ' 鹽澤 ', class: 'place', roles: ['paragraph'] }));
      expect(locked.status).toBe(303);
      const location = new URL(locked.headers.location ?? '', web.url);
      expect(location.pathname).toBe(new URL(web.url).pathname);
      expect(Object.fromEntries(location.searchParams)).toEqual({ tab: 'review', done: 'lock', id: String(marsh), focus: String(idOf(lib.home, 'Harrow Gate')) });
      expect(card(lib.home, 'Salt Marsh')).toMatchObject({ target: '鹽澤', status: 'locked', decided_by: 'human', match: '{"roles":["paragraph"]}' });

      const page = await call(location.toString());
      expect(page.body).toContain(`data-focus`);
      expect(page.body).toMatch(new RegExp(`id="card-${idOf(lib.home, 'Harrow Gate')}" tabindex="0" data-focus`));
      expect(page.body).toContain(`#${marsh}`);
      expect(articles(page.body)).toBe(2);

      // 大小寫與整個詞沒勾，就是不比；沒帶表單標記時照預設值。
      const warden = idOf(lib.home, 'Grey Warden');
      await web.post(`cards/${warden}/lock`, { form: 'card', target: '灰衣守望者', class: 'person', gender: 'female', pronoun: '她' });
      expect(card(lib.home, 'Grey Warden')).toMatchObject({ match: '{"case_sensitive":false,"whole_word":false}', decided_by: 'human' });
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
      // 已拒絕的卡不在三段裡，再送一次是找不到。
      const again = await web.post(`cards/${warden}/lock`, lockForm({ target: '灰衣守望者' }));
      expect(again.status).toBe(404);
      expect(again.body).toContain('role="status"');
      expect((await web.post('cards/999999/reject', { tab: 'review' })).status).toBe(404);
    } finally {
      await web.stop();
    }
  });

  it('marks the field a person got wrong, keeps what they typed, and applies nothing', async () => {
    const lib = await book();
    const web = await openWeb(lib);
    const marsh = idOf(lib.home, 'Salt Marsh');
    try {
      const wrong = await web.post(`cards/${marsh}/lock`, lockForm({ target: '鹽澤', class: 'swamp', register: 'archaic' }));
      expect(wrong.status).toBe(422);
      expect(wrong.body).toContain('<select name="class" aria-invalid="true"');
      expect(wrong.body).toContain('<option value="swamp" selected>swamp</option>');
      expect(wrong.body).toContain('value="archaic"');
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
    try {
      expect(card(lib.home, 'Old Ferry')).toMatchObject({ status: 'locked', decided_by: 'auto' });
      const changed = await web.post(`cards/${ferry}/lock`, lockForm({ tab: 'locked', target: '舊渡口', class: 'place' }));
      const location = new URL(changed.headers.location ?? '', web.url);
      expect(Object.fromEntries(location.searchParams)).toMatchObject({ tab: 'locked', replaced: '0', resend: '0', reset: '0', in_flight: '0' });
      expect(card(lib.home, 'Old Ferry')).toMatchObject({ target: '舊渡口', previous_target: '老渡口', decided_by: 'human' });
      const page = await call(location.toString());
      expect(page.body).toMatch(/role="status">[^<]*#\d+[^<]*tome estimate book/u);
    } finally {
      await web.stop();
    }
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
      await web.post('view', { tab: 'review', q: '', kind: '-', proposal: 'without' });
      const none = (await call(web.url)).body;
      expect(articles(none)).toBe(1);
      expect(none).toContain('Harrow Gate');
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
    expect(output.findings.at(-1)?.params).toMatchObject({ locked: '1', rejected: '1', review: '1' });
    expect(output.data).toMatchObject({ web: { locked: 1, rejected: 1, rewritten: true }, entities: { review: 1, human: 1, auto: 1 } });
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

describe('browserCommand', () => {
  it('uses the opener of each platform, without a shell on Windows', () => {
    const url = 'http://127.0.0.1:1/t/';
    expect(browserCommand(url, 'win32')).toEqual({ command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] });
    expect(browserCommand(url, 'darwin')).toEqual({ command: 'open', args: [url] });
    expect(browserCommand(url, 'linux')).toEqual({ command: 'xdg-open', args: [url] });
    expect(browserCommand(url, 'freebsd')).toEqual({ command: 'xdg-open', args: [url] });
  });
});
