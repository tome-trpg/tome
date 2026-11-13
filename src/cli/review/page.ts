import type { ReviewCard, ReviewChoices, ReviewSection } from '../../core/glossary.ts';

// 審定網頁的 HTML（ADR-0138）。伺服器端組好整頁，瀏覽器不另外連線：搜尋、篩選與決定都用表單送回本機的伺服器。
// 給人看的文字都從訊息檔帶進來，這裡只有結構。書本文字一律跳脫後才放進頁面。

export interface PageTexts {
  readonly title: string;
  readonly privacy: string;
  readonly keys: string;
  readonly tabs: Readonly<Record<ReviewSection, string>>;
  readonly tab_count: string;
  readonly filter: {
    readonly search: string;
    readonly class: string;
    readonly class_all: string;
    readonly class_none: string;
    readonly proposal: string;
    readonly proposal_all: string;
    readonly proposal_with: string;
    readonly proposal_without: string;
    readonly apply: string;
    readonly clear: string;
    readonly shown: string;
  };
  readonly field: {
    readonly target: string;
    readonly class: string;
    readonly gender: string;
    readonly pronoun: string;
    readonly register: string;
    readonly keep_source: string;
    readonly match: string;
    readonly case_sensitive: string;
    readonly whole_word: string;
    readonly roles: string;
  };
  readonly unset: string;
  readonly gender: Readonly<Record<string, string>>;
  readonly card: { readonly count: string; readonly seen_in: string; readonly no_context: string };
  readonly origin: Readonly<Record<string, string>>;
  readonly decided_by: Readonly<Record<string, string>>;
  readonly action: { readonly lock: string; readonly reject: string };
  readonly done: { readonly lock: string; readonly reject: string };
  readonly renamed: string;
  readonly error: Readonly<Record<string, string>> & { readonly other: string };
  readonly empty: string;
  readonly rejected: string;
}

/** 篩選的條件，存在伺服器的記憶體裡，不放進網址：搜尋的字可能是書本文字，網址會留在瀏覽紀錄。 */
export interface ViewState {
  readonly q: string;
  /** 空字串是全部類別，`-` 是沒有類別。 */
  readonly kind: string;
  readonly proposal: 'all' | 'with' | 'without';
}

export const NO_CLASS = '-';
export const ALL_CARDS: ViewState = { q: '', kind: '', proposal: 'all' };

/** 表單送回來的欄位，驗證沒過時照人填的樣子放回去。 */
export interface FormInput {
  readonly target: string;
  readonly class: string;
  readonly gender: string;
  readonly pronoun: string;
  readonly register: string;
  readonly keep_source: boolean;
  readonly case_sensitive: boolean;
  readonly whole_word: boolean;
  readonly roles: readonly string[];
}

export interface PageModel {
  /**
   * 網址的開頭（`/<權杖>/`）。頁面裡的網址都從這裡寫起：驗證沒過的頁面是在 `cards/<id>/lock` 送回來的，
   * 相對的網址會接在那後面。
   */
  readonly base: string;
  readonly book: string;
  readonly tab: ReviewSection;
  readonly cards: Readonly<Record<ReviewSection, readonly ReviewCard[]>>;
  readonly choices: ReviewChoices;
  readonly view: ViewState;
  /** 要聚焦的卡。 */
  readonly focus: number | null;
  /** 已經填好參數的提示。 */
  readonly notice: string | null;
  /** 驗證沒過的那張卡、欄位與人填的內容。 */
  readonly invalid: { readonly id: number; readonly field: string; readonly input: FormInput } | null;
}

export const SECTION_ORDER: readonly ReviewSection[] = ['review', 'locked', 'skipped'];

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

export function fill(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole);
}

/** 搜尋不分大小寫，比原文與譯名（沒填搜尋時每張都包含空字串）；類別與有沒有提議照篩選。 */
export function visible(cards: readonly ReviewCard[], view: ViewState): ReviewCard[] {
  const query = view.q.trim().toLowerCase();
  return cards.filter((card) => {
    if (!card.source.toLowerCase().includes(query) && !(card.target ?? '').toLowerCase().includes(query)) return false;
    if (view.kind === NO_CLASS && card.class !== null) return false;
    if (view.kind !== '' && view.kind !== NO_CLASS && card.class !== view.kind) return false;
    if (view.proposal === 'with' && card.target === null) return false;
    if (view.proposal === 'without' && card.target !== null) return false;
    return true;
  });
}

function inputOf(card: ReviewCard): FormInput {
  return {
    target: card.target ?? '',
    class: card.class ?? '',
    gender: card.gender ?? '',
    pronoun: card.pronoun ?? '',
    register: card.register ?? '',
    keep_source: card.keep_source,
    case_sensitive: card.case_sensitive,
    whole_word: card.whole_word,
    roles: card.roles,
  };
}

function attribute(name: string, on: boolean): string {
  return on ? ` ${name}` : '';
}

function options(values: readonly string[], chosen: string, labelOf: (value: string) => string, unset: string): string {
  // 規則包改過之後，卡上的值可能不在清單裡，照樣列出來，驗證時才擋。
  const all = chosen === '' || values.includes(chosen) ? values : [...values, chosen];
  return [
    `<option value=""${attribute('selected', chosen === '')}>${escapeHtml(unset)}</option>`,
    ...all.map((value) => `<option value="${escapeHtml(value)}"${attribute('selected', value === chosen)}>${escapeHtml(labelOf(value))}</option>`),
  ].join('');
}

interface FieldContext {
  readonly id: number;
  readonly invalid: string | null;
  readonly focus: boolean;
}

/** 有問題的欄位標出來，說明接在旁邊；聚焦在它上面，改完直接按 Enter。 */
function marks(name: string, context: FieldContext): string {
  if (context.invalid !== name) return '';
  return ` aria-invalid="true" aria-describedby="error-${context.id}"${attribute('data-focus', context.focus)}`;
}

function select(name: string, label: string, body: string, context: FieldContext): string {
  return `<label class="field"><span>${escapeHtml(label)}</span><select name="${name}"${marks(name, context)}>${body}</select></label>`;
}

function checkbox(name: string, label: string, checked: boolean, value: string, context: FieldContext): string {
  return `<label class="check"><input type="checkbox" name="${name}" value="${escapeHtml(value)}"${attribute('checked', checked)}${marks(name, context)}><span>${escapeHtml(label)}</span></label>`;
}

function cardMeta(card: ReviewCard, tab: ReviewSection, texts: PageTexts): string {
  const parts = [
    fill(texts.card.count, { count: String(card.count) }),
    texts.origin[card.origin] ?? card.origin,
    ...(tab === 'locked' && card.decided_by !== null ? [texts.decided_by[card.decided_by] ?? card.decided_by] : []),
    `#${card.id}`,
  ];
  return parts.map((part) => `<span>${escapeHtml(part)}</span>`).join('');
}

function contexts(card: ReviewCard, tab: ReviewSection, texts: PageTexts): string {
  const body =
    card.seen_in.length === 0
      ? `<p class="muted">${escapeHtml(texts.card.no_context)}</p>`
      : `<ul>${card.seen_in.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
  return `<details class="seen"${attribute('open', tab !== 'locked')}><summary>${escapeHtml(texts.card.seen_in)}</summary>${body}</details>`;
}

function renderCard(card: ReviewCard, model: PageModel, texts: PageTexts): string {
  const invalid = model.invalid !== null && model.invalid.id === card.id ? model.invalid : null;
  const input = invalid?.input ?? inputOf(card);
  const focusCard = model.focus === card.id && invalid === null;
  const context: FieldContext = { id: card.id, invalid: invalid?.field ?? null, focus: invalid !== null };
  const { choices } = model;
  const error =
    invalid === null
      ? ''
      : `<p class="error" id="error-${card.id}" role="alert">${escapeHtml(texts.error[invalid.field] ?? texts.error.other)}</p>`;
  const roles = choices.roles.map((role) => checkbox('roles', role, input.roles.includes(role), role, context)).join('');
  return [
    `<article class="card" id="card-${card.id}" tabindex="0"${attribute('data-focus', focusCard)}>`,
    `<form method="post" action="${model.base}cards/${card.id}/lock">`,
    '<input type="hidden" name="form" value="card">',
    `<input type="hidden" name="tab" value="${model.tab}">`,
    `<header><h2>${escapeHtml(card.source)}</h2><p class="meta">${cardMeta(card, model.tab, texts)}</p></header>`,
    error,
    '<div class="fields">',
    `<label class="field wide"><span>${escapeHtml(texts.field.target)}</span><input type="text" name="target" value="${escapeHtml(input.target)}" required autocomplete="off"${marks('target', context)}></label>`,
    select('class', texts.field.class, options(choices.classes, input.class, (value) => value, texts.unset), context),
    select('gender', texts.field.gender, options(choices.genders, input.gender, (value) => texts.gender[value] ?? value, texts.unset), context),
    select('pronoun', texts.field.pronoun, options(choices.pronouns, input.pronoun, (value) => value, texts.unset), context),
    `<label class="field"><span>${escapeHtml(texts.field.register)}</span><input type="text" name="register" value="${escapeHtml(input.register)}" autocomplete="off"${marks('register', context)}></label>`,
    checkbox('keep_source', texts.field.keep_source, input.keep_source, '1', context),
    '</div>',
    `<details class="match"${attribute('open', invalid?.field === 'roles')}><summary>${escapeHtml(texts.field.match)}</summary>`,
    checkbox('case_sensitive', texts.field.case_sensitive, input.case_sensitive, '1', context),
    checkbox('whole_word', texts.field.whole_word, input.whole_word, '1', context),
    `<fieldset class="roles"><legend>${escapeHtml(texts.field.roles)}</legend>${roles}</fieldset>`,
    '</details>',
    contexts(card, model.tab, texts),
    '<div class="actions">',
    `<button type="submit" data-action="lock">${escapeHtml(texts.action.lock)}</button>`,
    `<button type="submit" formaction="${model.base}cards/${card.id}/reject" formnovalidate data-action="reject" class="secondary">${escapeHtml(texts.action.reject)}</button>`,
    '</div>',
    '</form>',
    '</article>',
  ].join('');
}

function tabs(model: PageModel, texts: PageTexts): string {
  const links = SECTION_ORDER.map((section) => {
    const label = fill(texts.tab_count, { name: texts.tabs[section], count: String(model.cards[section].length) });
    return `<a href="${model.base}?tab=${section}"${section === model.tab ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
  });
  return `<nav class="tabs">${links.join('')}</nav>`;
}

function filters(model: PageModel, texts: PageTexts): string {
  const { view, choices } = model;
  const kinds = [
    `<option value=""${attribute('selected', view.kind === '')}>${escapeHtml(texts.filter.class_all)}</option>`,
    `<option value="${NO_CLASS}"${attribute('selected', view.kind === NO_CLASS)}>${escapeHtml(texts.filter.class_none)}</option>`,
    ...choices.classes.map((kind) => `<option value="${escapeHtml(kind)}"${attribute('selected', view.kind === kind)}>${escapeHtml(kind)}</option>`),
  ].join('');
  const proposals = (['all', 'with', 'without'] as const)
    .map((value) => `<option value="${value}"${attribute('selected', view.proposal === value)}>${escapeHtml(texts.filter[`proposal_${value}` as const])}</option>`)
    .join('');
  return [
    `<form class="filters" method="post" action="${model.base}view">`,
    `<input type="hidden" name="tab" value="${model.tab}">`,
    `<label class="field wide"><span>${escapeHtml(texts.filter.search)}</span><input type="search" id="search" name="q" value="${escapeHtml(view.q)}" autocomplete="off"></label>`,
    `<label class="field"><span>${escapeHtml(texts.filter.class)}</span><select name="kind">${kinds}</select></label>`,
    `<label class="field"><span>${escapeHtml(texts.filter.proposal)}</span><select name="proposal">${proposals}</select></label>`,
    `<button type="submit">${escapeHtml(texts.filter.apply)}</button>`,
    `<button type="submit" name="clear" value="1" class="secondary">${escapeHtml(texts.filter.clear)}</button>`,
    '</form>',
  ].join('');
}

export function renderPage(model: PageModel, texts: PageTexts): string {
  const all = model.cards[model.tab];
  const shown = visible(all, model.view);
  const title = fill(texts.title, { book: model.book });
  const notice = model.notice === null ? '' : `<p class="notice" role="status">${escapeHtml(model.notice)}</p>`;
  const list = shown.length === 0 ? `<p class="muted">${escapeHtml(texts.empty)}</p>` : shown.map((card) => renderCard(card, model, texts)).join('');
  return [
    '<!doctype html>',
    '<html lang="zh-Hant-TW">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<link rel="stylesheet" href="${model.base}app.css"><script type="module" src="${model.base}app.js"></script></head>`,
    '<body>',
    `<header class="top"><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(texts.privacy)}</p><p class="muted">${escapeHtml(texts.keys)}</p></header>`,
    tabs(model, texts),
    filters(model, texts),
    notice,
    `<p class="muted">${escapeHtml(fill(texts.filter.shown, { shown: String(shown.length), total: String(all.length) }))}</p>`,
    `<main>${list}</main>`,
    '</body>',
    '</html>',
  ].join('\n');
}
