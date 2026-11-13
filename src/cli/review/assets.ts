// 審定網頁的樣式與鍵盤操作（ADR-0138）。寫成程式裡的字串，跟程式一起編譯、隨套件發佈，不必改 `package.json`
// 的 `files`，也沒有建置步驟。網頁不連外：腳本只處理鍵盤與聚焦，表單照常送回本機的伺服器，不用任何連網的 API。
// 這兩段不放給人看的文字，說明在頁面上，從訊息檔帶進來。

export const STYLE = `
:root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --bg: #ffffff; --card: #f6f8fa;
  --accent: #0969da; --bad: #cf222e; --ok: #1a7f37; font-family: system-ui, sans-serif; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --bg: #0d1117; --card: #151b23; --accent: #4493f8;
    --bad: #f85149; --ok: #3fb950; }
}
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 64rem; padding: 1rem; color: var(--fg); background: var(--bg); line-height: 1.5; }
h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.15rem; margin: 0; }
.muted { color: var(--muted); margin: 0.25rem 0; }
.tabs { display: flex; gap: 0.5rem; margin: 1rem 0 0.5rem; border-bottom: 1px solid var(--line); }
.tabs a { padding: 0.4rem 0.8rem; color: var(--accent); text-decoration: none; border: 1px solid transparent; border-bottom: 0; }
.tabs a[aria-current="page"] { color: var(--fg); border-color: var(--line); background: var(--card); font-weight: 600; }
.filters, .fields { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: flex-end; }
.filters { margin: 0.5rem 0; }
.field { display: flex; flex-direction: column; gap: 0.15rem; font-size: 0.9rem; }
.field.wide { flex: 1 1 16rem; }
.check { display: inline-flex; gap: 0.3rem; align-items: center; margin-right: 1rem; font-size: 0.9rem; }
input[type="text"], input[type="search"], select { font: inherit; padding: 0.3rem 0.4rem; color: var(--fg); background: var(--bg);
  border: 1px solid var(--line); border-radius: 4px; }
[aria-invalid="true"] { border-color: var(--bad); outline: 2px solid var(--bad); }
button { font: inherit; padding: 0.35rem 0.9rem; border-radius: 4px; border: 1px solid var(--accent); background: var(--accent);
  color: #ffffff; cursor: pointer; }
button.secondary { background: transparent; color: var(--fg); border-color: var(--line); }
.notice { padding: 0.5rem 0.75rem; border-left: 4px solid var(--ok); background: var(--card); }
.error { color: var(--bad); margin: 0.25rem 0; font-weight: 600; }
.card { margin: 0.75rem 0; padding: 0.75rem 1rem; border: 1px solid var(--line); border-radius: 6px; background: var(--card); }
.card:focus, .card:focus-within { outline: 3px solid var(--accent); outline-offset: 2px; }
.card header { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; align-items: baseline; margin-bottom: 0.5rem; }
.meta { margin: 0; display: flex; gap: 0.75rem; color: var(--muted); font-size: 0.85rem; }
details { margin: 0.5rem 0; }
summary { cursor: pointer; color: var(--muted); }
.seen ul { margin: 0.25rem 0; padding-left: 1.25rem; }
.roles { border: 0; padding: 0; margin: 0.25rem 0 0; }
.roles legend { font-size: 0.9rem; color: var(--muted); }
.actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
`;

export const SCRIPT = `
const editing = (element) =>
  element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;
const cards = () => [...document.querySelectorAll('article.card')];

function show(card) {
  if (!card) return;
  card.focus();
  card.scrollIntoView({ block: 'center' });
}

function submit(card, action) {
  const form = card ? card.querySelector('form') : null;
  const button = card ? card.querySelector('[data-action="' + action + '"]') : null;
  if (form && button) form.requestSubmit(button);
}

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
  const active = document.activeElement;
  if (editing(active)) {
    if (event.key === 'Escape') {
      event.preventDefault();
      const card = active.closest('article.card');
      if (card) card.focus();
      else active.blur();
    }
    return;
  }
  const card = active instanceof Element ? active.closest('article.card') : null;
  const list = cards();
  const index = card ? list.indexOf(card) : -1;
  switch (event.key) {
    case 'j':
    case 'ArrowDown':
      event.preventDefault();
      show(list[Math.min(index + 1, list.length - 1)]);
      break;
    case 'k':
    case 'ArrowUp':
      event.preventDefault();
      show(list[Math.max(index - 1, 0)]);
      break;
    case 'l':
      event.preventDefault();
      submit(card, 'lock');
      break;
    case 'x':
      event.preventDefault();
      submit(card, 'reject');
      break;
    case 'e': {
      const target = card ? card.querySelector('[name="target"]') : null;
      if (target) {
        event.preventDefault();
        target.focus();
        target.select();
      }
      break;
    }
    case '/': {
      const search = document.getElementById('search');
      if (search) {
        event.preventDefault();
        search.focus();
      }
      break;
    }
    default:
      break;
  }
});

const focused = document.querySelector('[data-focus]');
if (focused) {
  focused.focus();
  focused.scrollIntoView({ block: 'center' });
}
`;
