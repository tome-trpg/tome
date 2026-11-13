import { describe, expect, it } from 'vitest';
import { reviewPageTexts } from '../../src/cli/messages.ts';
import { ALL_CARDS, escapeHtml, renderPage, visible, type PageModel } from '../../src/cli/review/page.ts';
import { formInput } from '../../src/cli/review/server.ts';
import type { ReviewCard } from '../../src/core/glossary.ts';

// 審定網頁的 HTML 與篩選（ADR-0138）。卡片的文字是這裡編的。

function card(id: number, fields: Partial<ReviewCard> = {}): ReviewCard {
  return {
    id,
    source: `Term ${id}`,
    target: null,
    class: null,
    gender: null,
    pronoun: null,
    register: null,
    keep_source: false,
    case_sensitive: true,
    whole_word: true,
    roles: [],
    count: 1,
    origin: 'pass0',
    decided_by: null,
    seen_in: [],
    ...fields,
  };
}

function model(cards: readonly ReviewCard[], extra: Partial<PageModel> = {}): PageModel {
  return {
    base: '/t0ken/',
    book: 'book',
    tab: 'review',
    cards: { review: cards, locked: [], skipped: [] },
    choices: { classes: ['person', 'place'], genders: ['female', 'male', 'none'], pronouns: ['她', '他'], roles: ['heading', 'paragraph'] },
    view: ALL_CARDS,
    focus: null,
    notice: null,
    invalid: null,
    ...extra,
  };
}

describe('escapeHtml', () => {
  it('escapes the five characters that can break out of text or an attribute', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});

describe('visible', () => {
  const cards = [
    card(1, { source: 'Salt Marsh', target: '鹽沼', class: 'place' }),
    card(2, { source: 'Grey Warden', target: '灰色守望者', class: 'person' }),
    card(3, { source: 'Harrow Gate' }),
  ];
  const ids = (view: Partial<typeof ALL_CARDS>): number[] => visible(cards, { ...ALL_CARDS, ...view }).map(({ id }) => id);

  it('matches the source or the target, ignoring case and the spaces around the search', () => {
    expect(ids({ q: '  marsh ' })).toEqual([1]);
    expect(ids({ q: '守望' })).toEqual([2]);
    expect(ids({ q: 'a' })).toEqual([1, 2, 3]);
    expect(ids({ q: '' })).toEqual([1, 2, 3]);
  });

  it('filters by class, no class, and whether there is a proposal', () => {
    expect(ids({ kind: 'place' })).toEqual([1]);
    expect(ids({ kind: '-' })).toEqual([3]);
    expect(ids({ proposal: 'with' })).toEqual([1, 2]);
    expect(ids({ proposal: 'without' })).toEqual([3]);
    expect(ids({ kind: 'person', proposal: 'without' })).toEqual([]);
  });
});

describe('renderPage', () => {
  it('escapes the book text it shows', () => {
    const html = renderPage(model([card(1, { source: '<script>alert(1)</script>', target: '"x"', seen_in: ['a < b & c'] })]), reviewPageTexts);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('value="&quot;x&quot;"');
    expect(html).toContain('<li>a &lt; b &amp; c</li>');
  });

  it('loads only its own style and script, and writes no inline script or style', () => {
    const html = renderPage(model([card(1)]), reviewPageTexts);
    expect(html).toContain('<link rel="stylesheet" href="/t0ken/app.css"><script type="module" src="/t0ken/app.js"></script>');
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toMatch(/ style=|<style|https?:\/\//);
  });

  // 驗證沒過的頁面是在 `cards/<id>/lock` 送回來的，相對的網址會接錯地方（在瀏覽器裡實際點過才找到）。
  it('writes every address from the base, so the page works wherever it was served', () => {
    const html = renderPage(model([card(7)]), reviewPageTexts);
    const addresses = [...html.matchAll(/\s(?:href|src|action|formaction)="([^"]*)"/g)].map((match) => match[1] ?? '');
    expect(addresses.length).toBeGreaterThan(5);
    for (const address of addresses) expect(address.startsWith('/t0ken/')).toBe(true);
    expect(html).toContain('action="/t0ken/cards/7/lock"');
    expect(html).toContain('formaction="/t0ken/cards/7/reject"');
    expect(html).toContain('action="/t0ken/view"');
  });

  it('counts each tab and marks the one shown', () => {
    const html = renderPage(model([card(1), card(2)], { tab: 'review' }), reviewPageTexts);
    expect(html).toContain('<a href="/t0ken/?tab=review" aria-current="page">待人審（2）</a>');
    expect(html).toContain('<a href="/t0ken/?tab=locked">已鎖定（0）</a>');
  });

  it('focuses the card asked for, and the field with a problem instead when there is one', () => {
    const focused = renderPage(model([card(1), card(2)], { focus: 2 }), reviewPageTexts);
    expect(focused).toContain('id="card-2" tabindex="0" data-focus>');
    expect(focused).toContain('id="card-1" tabindex="0">');
    const input = { target: 'x', class: 'swamp', gender: '', pronoun: '', register: '', keep_source: true, case_sensitive: false, whole_word: true, roles: ['paragraph'] };
    const invalid = renderPage(model([card(1), card(2)], { focus: 2, invalid: { id: 2, field: 'class', input } }), reviewPageTexts);
    expect(invalid).toContain('id="card-2" tabindex="0">');
    expect(invalid).toContain('<select name="class" aria-invalid="true" aria-describedby="error-2" data-focus>');
    expect(invalid).toContain('<option value="swamp" selected>swamp</option>');
    expect(invalid).toContain('<input type="checkbox" name="keep_source" value="1" checked>');
    expect(invalid).toContain('<input type="checkbox" name="case_sensitive" value="1">');
    expect(invalid).toContain('<input type="checkbox" name="roles" value="paragraph" checked>');
    expect(invalid).toContain(reviewPageTexts.error['class']);
  });

  it('opens the match settings when the roles were wrong, and the sentences outside the locked tab', () => {
    const input = { target: 'x', class: '', gender: '', pronoun: '', register: '', keep_source: false, case_sensitive: true, whole_word: true, roles: [] };
    const roles = renderPage(model([card(1)], { invalid: { id: 1, field: 'roles', input } }), reviewPageTexts);
    expect(roles).toContain('<details class="match" open>');
    expect(roles).toContain('<details class="seen" open>');
    const locked = renderPage({ ...model([]), tab: 'locked', cards: { review: [], locked: [card(1, { decided_by: 'auto', target: 'y' })], skipped: [] } }, reviewPageTexts);
    expect(locked).toContain('<details class="match">');
    expect(locked).toContain('<details class="seen">');
    expect(locked).toContain(reviewPageTexts.decided_by['auto']);
  });

  it('says so when no card is shown', () => {
    expect(renderPage(model([]), reviewPageTexts)).toContain(reviewPageTexts.empty);
  });
});

describe('formInput', () => {
  it('reads an unticked box of the page form as off, and leaves it to the defaults otherwise', () => {
    const ours = formInput(new URLSearchParams('form=card&target=x&roles=a&roles=b&keep_source=1'));
    expect(ours).toMatchObject({ target: 'x', keep_source: true, case_sensitive: false, whole_word: false, roles: ['a', 'b'] });
    const bare = formInput(new URLSearchParams('target=x'));
    expect(bare).toMatchObject({ keep_source: undefined, case_sensitive: undefined, whole_word: undefined, roles: [], class: '' });
  });
});
