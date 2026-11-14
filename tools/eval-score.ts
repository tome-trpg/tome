import { createHash, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redirectTo, startLocalServer, type LocalApp, type LocalReply, type ReviewServer } from '../src/cli/review/server.ts';
import { STYLE } from '../src/cli/review/assets.ts';
import { escapeHtml, shuffled, type PassageFile } from './eval-select.ts';
import type { OutputFile } from './eval-run.ts';
import texts from './eval/texts.json' with { type: 'json' };

// 盲評的評分（ADR-0139 第 5 到 7 項）。淘汰率超過一成的組整組不評；每段一字不差的譯文合併顯示一次；
// 每段重新隨機排序，用 A、B、C… 標，看不出是哪一組。另外挑 10 段在後面再出現一次，檢查前後一不一致。
// 組別的對照存在 `blind.json`，評完出報告時才拿來對；分數每存一次寫進 `scores.json`，可以分次評完。

export const BLIND_FILE = 'blind.json';
export const SCORE_FILE = 'scores.json';
/** 淘汰率超過這個比例的組整組不評，記成不及格（ADR-0139 第 5 項）。 */
export const DROP_RATE = 0.1;
/** 重複出現的段數（ADR-0139 第 7 項）。 */
export const REPEATS = 10;
export const LETTERS = 'ABCDEFGHIJ';

export type PageTexts = typeof texts;

export interface BlindItem {
  /** 譯文的 SHA-256，報告只用它，不放譯文。 */
  readonly hash: string;
  /** 譯成這一則的組。 */
  readonly variants: readonly string[];
}

export interface BlindPassage {
  readonly id: string;
  readonly items: readonly BlindItem[];
}

export interface Slot {
  readonly slot: number;
  readonly passage: string;
  /** 2 是重複出現的那一次。 */
  readonly round: 1 | 2;
  /** 畫面上 A、B、C… 依序是哪幾則（`items` 的索引）。 */
  readonly order: readonly number[];
}

export interface BlindFile {
  readonly dropped: readonly string[];
  readonly rates: Readonly<Record<string, number>>;
  readonly passages: readonly BlindPassage[];
  readonly slots: readonly Slot[];
}

/** `slot` → `item` 的索引 → 分數。 */
export type ScoreFile = Readonly<Record<string, Readonly<Record<string, number>>>>;

export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 淘汰率：沒翻成的段落占這一組翻過的段落多少。還有沒翻完的組不能評。 */
export function eliminationRates(outputs: OutputFile, codes: readonly string[]): Record<string, number> {
  return Object.fromEntries(
    codes.map((code) => {
      const passages = Object.values(outputs[code]?.passages ?? {});
      if (passages.length === 0 || passages.some(({ status }) => status === 'missing')) throw new Error(`variant ${code} has not finished`);
      return [code, passages.filter(({ status }) => status === 'failed').length / passages.length];
    }),
  );
}

/**
 * 組出評分的順序。`random` 決定排列；正式跑用不可預測的亂數，維護者猜不到哪個字母是哪一組。
 * 重複的段落插在後半段、而且在第一次之後。
 */
export function buildBlind(outputs: OutputFile, file: PassageFile, codes: readonly string[], random: () => number): BlindFile {
  const rates = eliminationRates(outputs, codes);
  const dropped = codes.filter((code) => (rates[code] ?? 0) > DROP_RATE);
  const kept = codes.filter((code) => !dropped.includes(code));
  const passages: BlindPassage[] = file.passages.map(({ id }) => {
    const items = new Map<string, string[]>();
    for (const code of kept) {
      const output = outputs[code]?.passages[id];
      if (output?.status !== 'done' || output.text === null) continue;
      const hash = textHash(output.text);
      items.set(hash, [...(items.get(hash) ?? []), code]);
    }
    return { id, items: [...items].map(([hash, variants]) => ({ hash, variants })) };
  });
  const scorable = passages.filter(({ items }) => items.length > 0);
  const order = (passage: BlindPassage): number[] => shuffled(passage.items.map((_, index) => index), random);
  const first: { passage: string; round: 1 | 2; order: number[] }[] = shuffled(scorable, random).map((passage) => ({ passage: passage.id, round: 1, order: order(passage) }));
  const half = Math.ceil(first.length / 2);
  for (const passage of shuffled(scorable, random).slice(0, Math.min(REPEATS, scorable.length))) {
    const at = first.findIndex((slot) => slot.passage === passage.id);
    const from = Math.max(at + 1, half);
    const index = from + Math.floor(random() * (first.length - from + 1));
    first.splice(index, 0, { passage: passage.id, round: 2, order: order(passage) });
  }
  return { dropped, rates, passages, slots: first.map((slot, index) => ({ ...slot, slot: index + 1 })) };
}

/** 正式跑的亂數：作業系統的亂數，不是種子，維護者推不出組別。 */
export function secretRandom(): number {
  return randomInt(0, 2 ** 32) / 2 ** 32;
}

export function readBlind(dir: string): BlindFile | null {
  const path = join(dir, BLIND_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as BlindFile) : null;
}

export function readScores(dir: string): ScoreFile {
  const path = join(dir, SCORE_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ScoreFile) : {};
}

/** 這一段每一則都評了。 */
export function complete(slot: Slot, scores: ScoreFile): boolean {
  const given = scores[String(slot.slot)] ?? {};
  return slot.order.every((item) => given[String(item)] !== undefined);
}

export function fill(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole);
}

export interface ScoreModel {
  readonly base: string;
  readonly slot: Slot;
  readonly total: number;
  readonly scored: number;
  readonly source: string;
  /** 依畫面順序的譯文。 */
  readonly shown: readonly string[];
  readonly given: Readonly<Record<string, number>>;
  readonly notice: string | null;
  readonly missing: boolean;
}

/** 一段一頁：原文顯示一次，譯文依這一段的隨機順序，用字母標，不顯示組別。 */
export function renderScorePage(model: ScoreModel, page: PageTexts = texts): string {
  const { base, slot, total } = model;
  const title = fill(page.title, { slot: String(slot.slot), total: String(total) });
  const items = slot.order
    .map((item, position) => {
      const letter = LETTERS[position] ?? String(position + 1);
      const choices = [1, 2, 3, 4, 5]
        .map((score) => {
          const checked = model.given[String(item)] === score ? ' checked' : '';
          return `<label class="check"><input type="radio" name="i${item}" value="${score}"${checked}><span>${score}</span></label>`;
        })
        .join('');
      return [
        `<article class="card" tabindex="0" data-item="${item}">`,
        `<header><h2>${escapeHtml(fill(page.item, { letter }))}</h2></header>`,
        `<p class="text">${escapeHtml(model.shown[position] ?? '')}</p>`,
        `<fieldset class="roles">${choices}</fieldset>`,
        '</article>',
      ].join('');
    })
    .join('');
  const scale = Object.values(page.scale).map((line) => `<li>${escapeHtml(line)}</li>`).join('');
  const notice = model.notice === null ? '' : `<p class="notice" role="status">${escapeHtml(model.notice)}</p>`;
  const missing = model.missing ? `<p class="error" role="alert">${escapeHtml(page.missing)}</p>` : '';
  const previous = slot.slot > 1 ? `<a href="${base}?slot=${slot.slot - 1}">${escapeHtml(page.previous)}</a>` : '';
  const next = slot.slot < total ? `<a href="${base}?slot=${slot.slot + 1}">${escapeHtml(page.next)}</a>` : '';
  return [
    '<!doctype html>',
    '<html lang="zh-Hant-TW">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<link rel="stylesheet" href="${base}app.css"><script type="module" src="${base}app.js"></script></head>`,
    '<body>',
    `<header class="top"><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(page.privacy)}</p><p class="muted">${escapeHtml(page.keys)}</p>`,
    `<p class="muted">${escapeHtml(fill(page.progress, { scored: String(model.scored), total: String(total) }))}</p><ul class="muted">${scale}</ul></header>`,
    notice,
    missing,
    `<section class="card"><h2>${escapeHtml(page.source)}</h2><p class="text">${escapeHtml(model.source)}</p></section>`,
    `<form method="post" action="${base}slots/${slot.slot}">`,
    items,
    `<div class="actions"><button type="submit">${escapeHtml(page.save)}</button>${previous}${next}</div>`,
    '</form>',
    '</body>',
    '</html>',
  ].join('\n');
}

export function renderDonePage(base: string, total: number, page: PageTexts = texts): string {
  const said = fill(page.done, { total: String(total) });
  return [
    '<!doctype html>',
    '<html lang="zh-Hant-TW">',
    `<head><meta charset="utf-8"><title>${escapeHtml(said)}</title><link rel="stylesheet" href="${base}app.css"></head>`,
    `<body><p class="notice" role="status">${escapeHtml(said)}</p><p><a href="${base}?slot=1">${escapeHtml(page.previous)}</a></p></body>`,
    '</html>',
  ].join('\n');
}

/** 評分頁的鍵盤：1 到 5 評目前這一則並跳到下一則，↑ ↓ 換一則，Enter 儲存。不連網、不存東西。 */
export const SCORE_SCRIPT = `
const items = () => [...document.querySelectorAll('article.card')];
function current() {
  const active = document.activeElement;
  return active instanceof Element ? active.closest('article.card') : null;
}
function show(card) {
  if (!card) return;
  card.focus();
  card.scrollIntoView({ block: 'center' });
}
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
  const list = items();
  const card = current();
  const index = card ? list.indexOf(card) : -1;
  if (event.key >= '1' && event.key <= '5') {
    const target = card ?? list[0];
    const radio = target ? target.querySelector('input[value="' + event.key + '"]') : null;
    if (radio) {
      event.preventDefault();
      radio.checked = true;
      show(list[list.indexOf(target) + 1] ?? target);
    }
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    show(list[Math.min(index + 1, list.length - 1)]);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    show(list[Math.max(index - 1, 0)]);
  } else if (event.key === 'Enter') {
    const form = document.querySelector('form');
    if (form) {
      event.preventDefault();
      form.requestSubmit();
    }
  }
});
show(items()[0]);
`;

export interface ScoreServerOptions {
  readonly dir: string;
  readonly blind: BlindFile;
  readonly outputs: OutputFile;
  /** 段落的原文（一組多個單位時一行一個）。 */
  readonly sources: ReadonlyMap<string, string>;
  readonly page?: PageTexts;
}

/** 評分頁掛在 047 的本機伺服器上，安全的檢查照 047（ADR-0138、ADR-0139 第 6 項）。 */
export function scoreApp({ dir, blind, outputs, sources, page = texts }: ScoreServerOptions): LocalApp {
  let scores: Record<string, Record<string, number>> = { ...readScores(dir) };
  const total = blind.slots.length;
  const passages = new Map(blind.passages.map((passage) => [passage.id, passage]));
  const textOf = (passage: BlindPassage, item: number): string => {
    const code = passage.items[item]?.variants[0] ?? '';
    return outputs[code]?.passages[passage.id]?.text ?? '';
  };
  const scored = (): number => blind.slots.filter((slot) => complete(slot, scores)).length;
  const firstOpen = (): Slot | undefined => blind.slots.find((slot) => !complete(slot, scores));
  const pageOf = (base: string, slot: Slot, status: number, notice: string | null, missing: boolean, given = scores[String(slot.slot)] ?? {}): LocalReply => {
    const passage = passages.get(slot.passage);
    const shown = slot.order.map((item) => (passage === undefined ? '' : textOf(passage, item)));
    return {
      status,
      body: renderScorePage({ base, slot, total, scored: scored(), source: sources.get(slot.passage) ?? '', shown, given, notice, missing }, page),
    };
  };
  return {
    rejected: page.rejected,
    get: (path, query, base) => {
      if (path === 'app.css') return { status: 200, type: 'text/css; charset=utf-8', body: STYLE };
      if (path === 'app.js') return { status: 200, type: 'text/javascript; charset=utf-8', body: SCORE_SCRIPT };
      if (path !== '') return null;
      const asked = blind.slots.find((slot) => String(slot.slot) === query.get('slot'));
      const saved = query.get('saved');
      const notice = saved === null ? null : fill(page.saved, { slot: saved });
      const slot = asked ?? firstOpen();
      if (slot === undefined) return { status: 200, body: renderDonePage(base, total, page) };
      return pageOf(base, slot, 200, notice, false);
    },
    post: async (path, form, base) => {
      const found = /^slots\/(\d{1,6})$/.exec(path);
      const slot = found === null ? undefined : blind.slots.find((item) => item.slot === Number(found[1]));
      if (slot === undefined) return null;
      const given: Record<string, number> = {};
      for (const item of slot.order) {
        const value = Number(form.get(`i${item}`));
        if (Number.isInteger(value) && value >= 1 && value <= 5) given[String(item)] = value;
      }
      if (slot.order.some((item) => given[String(item)] === undefined)) return pageOf(base, slot, 422, null, true, given);
      scores = { ...scores, [String(slot.slot)]: given };
      writeFileSync(join(dir, SCORE_FILE), `${JSON.stringify(scores, null, 2)}\n`);
      const next = blind.slots.find((item) => item.slot > slot.slot && !complete(item, scores)) ?? firstOpen();
      return next === undefined ? redirectTo(base, { saved: String(slot.slot) }) : redirectTo(base, { slot: String(next.slot), saved: String(slot.slot) });
    },
  };
}

export function startScoreServer(options: ScoreServerOptions): Promise<ReviewServer> {
  return startLocalServer(scoreApp(options));
}
