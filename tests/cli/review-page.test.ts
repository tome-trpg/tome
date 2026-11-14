import { describe, expect, it } from 'vitest';
import { reviewPageTexts } from '../../src/cli/messages.ts';
import { ALL_CARDS, escapeHtml, renderPage, visible, type PageModel } from '../../src/cli/review/page.ts';
import { formInput } from '../../src/cli/review/server.ts';
import type { ReviewCard } from '../../src/core/glossary.ts';
import { GOLDEN_MODELS } from './review-golden.ts';

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

  it('looks at the target only where there is one, in lower case too', () => {
    const more = [card(4, { source: 'Gate' }), card(5, { source: 'Bog', target: 'Salt MARSH' })];
    expect(visible(more, { ...ALL_CARDS, q: 'here' })).toEqual([]);
    expect(visible(more, { ...ALL_CARDS, q: 'marsh' }).map(({ id }) => id)).toEqual([5]);
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

// 整頁逐字比對：標籤、屬性與欄位的順序都釘住，改版面時這裡跟著改（`tests/cli/review-golden.ts` 的兩個頁面）。
describe('renderPage, word for word', () => {
  const HEAD = [
    '<!doctype html>',
    '<html lang="zh-Hant-TW">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>實體卡審定：book</title>',
    '<link rel="stylesheet" href="/t0ken/app.css"><script type="module" src="/t0ken/app.js"></script></head>',
    '<body>',
    '<header class="top"><h1>實體卡審定：book</h1><p class="muted">此頁含有書籍內容，只在這台電腦上顯示，不會存進瀏覽器。審完請回到終端機按 Ctrl+C 結束，審定檔會依資料庫重寫。</p><p class="muted">鍵盤：j 或 ↓ 下一張、k 或 ↑ 上一張、l 鎖定、x 拒絕、e 編輯譯名、/ 搜尋。在欄位中按 Enter 鎖定，按 Esc 離開欄位。</p></header>',
  ];
  const TAIL = ['</body>', '</html>'];
  const fields = (target: string, kind: string, gender: string, pronoun: string): string =>
    `<div class="fields"><label class="field wide"><span>譯名</span><input type="text" name="target" value="${target}" required autocomplete="off"></label>` +
    `<label class="field"><span>類別</span><select name="class">${kind}</select></label>` +
    `<label class="field"><span>性別</span><select name="gender">${gender}</select></label>` +
    `<label class="field"><span>代名詞</span>${pronoun}</label>` +
    '<label class="field"><span>語域</span><input type="text" name="register" value="" autocomplete="off"></label>' +
    '<label class="check"><input type="checkbox" name="keep_source" value="1"><span>保留原文</span></label></div>';
  const match = (wholeWord: string, heading: string, paragraph: string): string =>
    '<details class="match"><summary>比對條件</summary>' +
    '<label class="check"><input type="checkbox" name="case_sensitive" value="1" checked><span>區分大小寫</span></label>' +
    `<label class="check"><input type="checkbox" name="whole_word" value="1"${wholeWord}><span>只比對整個詞</span></label>` +
    '<fieldset class="roles"><legend>只在這些區塊角色中比對（都不勾表示不限）</legend>' +
    `<label class="check"><input type="checkbox" name="roles" value="heading"${heading}><span>heading</span></label>` +
    `<label class="check"><input type="checkbox" name="roles" value="paragraph"${paragraph}><span>paragraph</span></label></fieldset></details>`;
  const actions = (id: number): string =>
    '<div class="actions"><button type="submit" data-action="lock">鎖定</button>' +
    `<button type="submit" formaction="/t0ken/cards/${id}/reject" formnovalidate data-action="reject" class="secondary">拒絕</button></div></form></article>`;
  const opening = (id: number, focus: string, tab: string): string =>
    `<article class="card" id="card-${id}" tabindex="0"${focus}><form method="post" action="/t0ken/cards/${id}/lock">` +
    `<input type="hidden" name="form" value="card"><input type="hidden" name="tab" value="${tab}">`;
  const unset = '<option value="" selected>（未填）</option>';
  const genders = '<option value="female">女性</option><option value="male">男性</option><option value="none">無性別</option>';

  it('draws the review tab with a card that failed a check, an empty card and a notice', () => {
    const [model] = GOLDEN_MODELS;
    const first =
      opening(3, '', 'review') +
      '<header><h2>Grey &lt;Warden&gt;</h2><p class="meta"><span>出現 6 次</span><span>翻譯回報的新詞</span><span>#3</span></p></header>' +
      '<p class="error" id="error-3" role="alert">代名詞必須在目標語言的代名詞清單中。</p>' +
      fields(
        '灰衣',
        '<option value="">（未填）</option><option value="person" selected>person</option><option value="place">place</option>',
        '<option value="">（未填）</option><option value="female">女性</option><option value="male" selected>男性</option><option value="none">無性別</option>',
        '<select name="pronoun" aria-invalid="true" aria-describedby="error-3" data-focus><option value="">（未填）</option><option value="她">她</option><option value="他">他</option><option value="祂" selected>祂</option></select>',
      ) +
      match('', '', ' checked') +
      '<details class="seen" open><summary>出現的句子</summary><ul><li>The &quot;Grey &lt;Warden&gt;&quot; waits &amp; watches.</li><li>She counts stones.</li></ul></details>' +
      actions(3);
    const second =
      opening(7, ' data-focus', 'review') +
      '<header><h2>Harrow Gate</h2><p class="meta"><span>出現 1 次</span><span>匯入</span><span>#7</span></p></header>' +
      fields(
        '',
        `${unset}<option value="person">person</option><option value="place">place</option>`,
        `${unset}${genders}`,
        `<select name="pronoun">${unset}<option value="她">她</option><option value="他">他</option></select>`,
      ) +
      match(' checked', '', '') +
      '<details class="seen" open><summary>出現的句子</summary><p class="muted">在會翻譯的文字中找不到這個詞。</p></details>' +
      actions(7);
    const expected = [
      ...HEAD,
      '<nav class="tabs"><a href="/t0ken/?tab=review" aria-current="page">待人審（2）</a><a href="/t0ken/?tab=locked">已鎖定（1）</a><a href="/t0ken/?tab=skipped">不是專有名詞（0）</a></nav>',
      '<form class="filters" method="post" action="/t0ken/view"><input type="hidden" name="tab" value="review"><label class="field wide"><span>搜尋原文或譯名</span><input type="search" id="search" name="q" value="" autocomplete="off"></label><label class="field"><span>類別</span><select name="kind"><option value="" selected>全部類別</option><option value="-">沒有類別</option><option value="person">person</option><option value="place">place</option></select></label><label class="field"><span>提議</span><select name="proposal"><option value="all" selected>全部</option><option value="with">有提議</option><option value="without">沒有提議</option></select></label><button type="submit">篩選</button><button type="submit" name="clear" value="1" class="secondary">清除條件</button></form>',
      '<p class="notice" role="status">已鎖定 #1。</p>',
      '<p class="muted">顯示 2 筆，共 2 筆。</p>',
      `<main>${first}${second}</main>`,
      ...TAIL,
    ].join('\n');
    expect(renderPage(model as PageModel, reviewPageTexts)).toBe(expected);
  });

  it('draws the locked tab with every filter set, two cards left and their sentences folded', () => {
    const model = GOLDEN_MODELS[1];
    const plain = (target: string): string =>
      fields(
        target,
        `${unset}<option value="person">person</option><option value="place">place</option>`,
        `${unset}${genders}`,
        `<select name="pronoun">${unset}<option value="她">她</option><option value="他">他</option></select>`,
      ) + match(' checked', '', '');
    const ferry =
      opening(9, '', 'locked') +
      '<header><h2>Old Ferry</h2><p class="meta"><span>出現 1 次</span><span>unknown</span><span>人審</span><span>#9</span></p></header>' +
      plain('老渡口') +
      '<details class="seen"><summary>出現的句子</summary><ul><li>At the Old Ferry.</li></ul></details>' +
      actions(9);
    const bell =
      opening(12, '', 'locked') +
      '<header><h2>Ferry Bell</h2><p class="meta"><span>出現 1 次</span><span>Pass 0 提議</span><span>#12</span></p></header>' +
      plain('渡口鐘') +
      '<details class="seen"><summary>出現的句子</summary><p class="muted">在會翻譯的文字中找不到這個詞。</p></details>' +
      actions(12);
    const expected = [
      ...HEAD,
      '<nav class="tabs"><a href="/t0ken/?tab=review">待人審（0）</a><a href="/t0ken/?tab=locked" aria-current="page">已鎖定（3）</a><a href="/t0ken/?tab=skipped">不是專有名詞（1）</a></nav>',
      '<form class="filters" method="post" action="/t0ken/view"><input type="hidden" name="tab" value="locked"><label class="field wide"><span>搜尋原文或譯名</span><input type="search" id="search" name="q" value=" FERRY " autocomplete="off"></label><label class="field"><span>類別</span><select name="kind"><option value="">全部類別</option><option value="-" selected>沒有類別</option><option value="person">person</option><option value="place">place</option></select></label><label class="field"><span>提議</span><select name="proposal"><option value="all">全部</option><option value="with" selected>有提議</option><option value="without">沒有提議</option></select></label><button type="submit">篩選</button><button type="submit" name="clear" value="1" class="secondary">清除條件</button></form>',
      '',
      '<p class="muted">顯示 2 筆，共 3 筆。</p>',
      `<main>${ferry}${bell}</main>`,
      ...TAIL,
    ].join('\n');
    expect(renderPage(model as PageModel, reviewPageTexts)).toBe(expected);
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
