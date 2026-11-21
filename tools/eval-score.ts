import { randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redirectTo, startLocalServer, type LocalApp, type LocalReply, type ReviewServer } from '../src/cli/review/server.ts';
import { STYLE } from '../src/cli/review/assets.ts';
import { escapeHtml, pick, prng, seedOf, shuffled, type PassageFile } from './eval-select.ts';
import { Q8_VARIANT, type OutputFile } from './eval-run.ts';
import texts from './eval/texts.json' with { type: 'json' };

// 人評（ADR-0139 第 7 到 9 項；2026-11-21 第 16 項改成只評 B 組抽出的段落）。從挑好的段落用同一個種子再抽，
// 每本書照比例、書裡照角色分層；之前的盲評裡 B 已經評過的段落沿用那個分數。只評一組，評分頁寫明是哪個模型，不是盲評。
// 另外挑 5 段在後面再出現一次，檢查前後一不一致。抽樣存在 `sample.json`，分數每存一次寫進 `sample-scores.json`，可以分次評完。

export const SAMPLE_FILE = 'sample.json';
export const SAMPLE_SCORE_FILE = 'sample-scores.json';
/** 之前的盲評（6 組並排）留下的檔案，只讀來沿用 B 的分數。 */
export const BLIND_FILE = 'blind.json';
export const SCORE_FILE = 'scores.json';
/** 淘汰率超過這個比例的組不評，記成不及格（ADR-0139 第 7 項）。 */
export const DROP_RATE = 0.1;
/** 重複出現的段數（ADR-0139 第 9、16 項）。 */
export const REPEATS = 5;

export type PageTexts = typeof texts;

/** 之前盲評的一則譯文：一字不差的合併成一則，`variants` 是譯成這一則的組。 */
export interface BlindItem {
  readonly hash: string;
  readonly variants: readonly string[];
}

export interface BlindPassage {
  readonly id: string;
  readonly items: readonly BlindItem[];
}

export interface BlindSlot {
  readonly slot: number;
  readonly passage: string;
  readonly round: 1 | 2;
  /** 畫面上 A、B、C… 依序是哪幾則（`items` 的索引）。 */
  readonly order: readonly number[];
}

/** 之前盲評的 `blind.json`，只讀。 */
export interface BlindFile {
  readonly dropped: readonly string[];
  readonly rates: Readonly<Record<string, number>>;
  readonly passages: readonly BlindPassage[];
  readonly slots: readonly BlindSlot[];
}

/** 之前盲評的 `scores.json`：`slot` → `item` 的索引 → 分數。 */
export type BlindScores = Readonly<Record<string, Readonly<Record<string, number>>>>;

export interface Slot {
  readonly slot: number;
  readonly passage: string;
  /** 2 是重複出現的那一次。 */
  readonly round: 1 | 2;
}

export interface SampleFile {
  /** 評的組，就是 Q-8 用的那一組。 */
  readonly code: string;
  /** 跟挑段落同一個種子。 */
  readonly seed: number;
  /** 這一組在全部段落的淘汰率。 */
  readonly rate: number;
  /** 淘汰率超過一成，不評。 */
  readonly dropped: boolean;
  /** 抽中的段號，照書裡的順序。 */
  readonly passages: readonly string[];
  /** 抽中、但這一組沒翻成的段落，不評。 */
  readonly failed: readonly string[];
  /** 之前的盲評裡已經評過的段落：段號 → 分數。不再評，直接算進平均。 */
  readonly reused: Readonly<Record<string, number>>;
  /** 這次要評的：沒沿用的段落各一次，加上重複出現的。 */
  readonly slots: readonly Slot[];
}

/** `slot` → 分數。 */
export type SampleScores = Readonly<Record<string, number>>;

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

/** 之前的盲評裡，這一組在每段第一次出現時拿到的分數；一字不差合併顯示的，那一則的分數也是它的。 */
export function previousScores(blind: BlindFile, scores: BlindScores, code: string): Map<string, number> {
  const passages = new Map(blind.passages.map((passage) => [passage.id, passage]));
  const found = new Map<string, number>();
  for (const slot of blind.slots) {
    if (slot.round !== 1) continue;
    const item = passages.get(slot.passage)?.items.findIndex(({ variants }) => variants.includes(code)) ?? -1;
    const score = item === -1 ? undefined : scores[String(slot.slot)]?.[String(item)];
    if (score !== undefined) found.set(slot.passage, score);
  }
  return found;
}

/**
 * 從挑好的段落再抽：每本書照 `quotas`，書裡照角色分層（跟挑段落同一套），種子跟挑段落同一個、換一個標籤。
 * 抽中哪幾段只看段落與種子，跟有沒有沿用的分數、這一組翻成了沒有都無關；`random` 只決定評分的順序。
 * 重複題先從這次要評的段落挑，前後兩次都在同一種頁面上評；不夠才從沿用的段落補，第一次就是沿用的分數。
 */
export function buildSample(
  outputs: OutputFile,
  file: PassageFile,
  quotas: Readonly<Record<string, number>>,
  previous: ReadonlyMap<string, number>,
  random: () => number,
  code: string = Q8_VARIANT,
): SampleFile {
  const rate = eliminationRates(outputs, [code])[code] ?? 0;
  const dropped = rate > DROP_RATE;
  const chosen = new Set(
    file.books.flatMap(({ label }) =>
      pick(
        file.passages.filter(({ book }) => book === label),
        quotas[label] ?? 0,
        prng(seedOf(file.seed, `sample:${label}`)),
      ).map(({ id }) => id),
    ),
  );
  const passages = file.passages.filter(({ id }) => chosen.has(id)).map(({ id }) => id);
  const translated = (id: string): boolean => {
    const output = outputs[code]?.passages[id];
    return output?.status === 'done' && output.text !== null;
  };
  const failed = passages.filter((id) => !translated(id));
  if (dropped) return { code, seed: file.seed, rate, dropped, passages, failed, reused: {}, slots: [] };
  const scorable = passages.filter(translated);
  const reused: Record<string, number> = {};
  for (const id of scorable) {
    const score = previous.get(id);
    if (score !== undefined) reused[id] = score;
  }
  const fresh = scorable.filter((id) => reused[id] === undefined);
  const first: { passage: string; round: 1 | 2 }[] = shuffled(fresh, random).map((passage) => ({ passage, round: 1 }));
  const half = Math.ceil(first.length / 2);
  const carried = scorable.filter((id) => reused[id] !== undefined);
  for (const passage of [...shuffled(fresh, random), ...shuffled(carried, random)].slice(0, REPEATS)) {
    const at = first.findIndex((slot) => slot.passage === passage);
    const from = Math.max(at + 1, half);
    const index = from + Math.floor(random() * (first.length - from + 1));
    first.splice(index, 0, { passage, round: 2 });
  }
  return { code, seed: file.seed, rate, dropped, passages, failed, reused, slots: first.map((slot, index) => ({ ...slot, slot: index + 1 })) };
}

/** 評分的順序用作業系統的亂數，不是種子。 */
export function secretRandom(): number {
  return randomInt(0, 2 ** 32) / 2 ** 32;
}

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null;
}

export function readBlind(dir: string): BlindFile | null {
  return readJson<BlindFile>(join(dir, BLIND_FILE));
}

export function readBlindScores(dir: string): BlindScores {
  return readJson<BlindScores>(join(dir, SCORE_FILE)) ?? {};
}

export function readSample(dir: string): SampleFile | null {
  return readJson<SampleFile>(join(dir, SAMPLE_FILE));
}

export function readSampleScores(dir: string): SampleScores {
  return readJson<SampleScores>(join(dir, SAMPLE_SCORE_FILE)) ?? {};
}

export function fill(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole);
}

export interface ScoreModel {
  readonly base: string;
  readonly slot: Slot;
  readonly total: number;
  readonly scored: number;
  readonly code: string;
  readonly model: string;
  readonly source: string;
  readonly text: string;
  readonly given: number | undefined;
  readonly notice: string | null;
  readonly missing: boolean;
}

/** 一段一頁：上面原文，下面這一組的譯文。只評一組，頁面寫明是哪個模型。 */
export function renderScorePage(model: ScoreModel, page: PageTexts = texts): string {
  const { base, slot, total } = model;
  const title = fill(page.title, { slot: String(slot.slot), total: String(total) });
  const choices = [1, 2, 3, 4, 5]
    .map((score) => `<label class="check"><input type="radio" name="score" value="${score}"${model.given === score ? ' checked' : ''}><span>${score}</span></label>`)
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
    `<header class="top"><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(fill(page.only, { code: model.code, model: model.model }))}</p>`,
    `<p class="muted">${escapeHtml(page.privacy)}</p><p class="muted">${escapeHtml(page.keys)}</p>`,
    `<p class="muted">${escapeHtml(fill(page.progress, { scored: String(model.scored), total: String(total) }))}</p><ul class="muted">${scale}</ul></header>`,
    notice,
    missing,
    `<section class="card"><h2>${escapeHtml(page.source)}</h2><p class="text">${escapeHtml(model.source)}</p></section>`,
    `<form method="post" action="${base}slots/${slot.slot}">`,
    `<article class="card" tabindex="0"><header><h2>${escapeHtml(fill(page.item, { code: model.code }))}</h2></header>`,
    `<p class="text">${escapeHtml(model.text)}</p><fieldset class="roles">${choices}</fieldset></article>`,
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
  readonly sample: SampleFile;
  readonly outputs: OutputFile;
  /** 段落的原文（一組多個單位時一行一個）。 */
  readonly sources: ReadonlyMap<string, string>;
  /** 評的那一組用的模型，寫在頁面上。 */
  readonly model: string;
  readonly page?: PageTexts;
}

/** 評分頁掛在 047 的本機伺服器上，安全的檢查照 047（ADR-0138、ADR-0139 第 8 項）。 */
export function scoreApp({ dir, sample, outputs, sources, model, page = texts }: ScoreServerOptions): LocalApp {
  let scores: Record<string, number> = { ...readSampleScores(dir) };
  const total = sample.slots.length;
  const done = (slot: Slot): boolean => scores[String(slot.slot)] !== undefined;
  const scored = (): number => sample.slots.filter(done).length;
  const firstOpen = (): Slot | undefined => sample.slots.find((slot) => !done(slot));
  const pageOf = (base: string, slot: Slot, status: number, notice: string | null, missing: boolean): LocalReply => ({
    status,
    body: renderScorePage(
      {
        base,
        slot,
        total,
        scored: scored(),
        code: sample.code,
        model,
        source: sources.get(slot.passage) ?? '',
        text: outputs[sample.code]?.passages[slot.passage]?.text ?? '',
        given: scores[String(slot.slot)],
        notice,
        missing,
      },
      page,
    ),
  });
  return {
    rejected: page.rejected,
    get: (path, query, base) => {
      if (path === 'app.css') return { status: 200, type: 'text/css; charset=utf-8', body: STYLE };
      if (path === 'app.js') return { status: 200, type: 'text/javascript; charset=utf-8', body: SCORE_SCRIPT };
      if (path !== '') return null;
      const asked = sample.slots.find((slot) => String(slot.slot) === query.get('slot'));
      const saved = query.get('saved');
      const notice = saved === null ? null : fill(page.saved, { slot: saved });
      const slot = asked ?? firstOpen();
      if (slot === undefined) return { status: 200, body: renderDonePage(base, total, page) };
      return pageOf(base, slot, 200, notice, false);
    },
    post: async (path, form, base) => {
      const found = /^slots\/(\d{1,6})$/.exec(path);
      const slot = found === null ? undefined : sample.slots.find((item) => item.slot === Number(found[1]));
      if (slot === undefined) return null;
      const value = Number(form.get('score'));
      if (!Number.isInteger(value) || value < 1 || value > 5) return pageOf(base, slot, 422, null, true);
      scores = { ...scores, [String(slot.slot)]: value };
      writeFileSync(join(dir, SAMPLE_SCORE_FILE), `${JSON.stringify(scores, null, 2)}\n`);
      const next = sample.slots.find((item) => item.slot > slot.slot && !done(item)) ?? firstOpen();
      return next === undefined ? redirectTo(base, { saved: String(slot.slot) }) : redirectTo(base, { slot: String(next.slot), saved: String(slot.slot) });
    },
  };
}

export function startScoreServer(options: ScoreServerOptions): Promise<ReviewServer> {
  return startLocalServer(scoreApp(options));
}
