import type { ErrorCode, Params } from '../core/errors.ts';
import type { FindingCode, FindingLevel } from '../core/findings.ts';
import catalog from './messages/zh-TW.json' with { type: 'json' };

function fill(template: string, params: Params): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole);
}

export const usageText = catalog.usage;
export const workspaceTemplate = catalog.template.workspace;

/** 審定檔的說明與段落標題（ADR-0119）。 */
/** vault 的固定文字（ADR-0113 第 17 項、ADR-0122）。 */
export const vaultTexts = catalog.template.vault;

export const glossaryReviewTexts = {
  header: catalog.template.glossary_review.header,
  sections: {
    review: catalog.template.glossary_review.review,
    locked: catalog.template.glossary_review.locked,
    skipped: catalog.template.glossary_review.skipped,
  },
};

/** `tome system new` 的骨架，檔名對應內容。 */
export function packTemplate(id: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(catalog.template.pack).map(([file, text]) => [file, fill(text, { id })]),
  );
}

export function promptText(key: keyof typeof catalog.prompt, params: Params): string {
  return fill(catalog.prompt[key], params);
}

export function progressText(key: keyof typeof catalog.progress, params: Params = {}): string {
  return fill(catalog.progress[key], params);
}

export function levelText(level: FindingLevel): string {
  return catalog.level[level];
}

export type ArgumentKey = keyof typeof catalog.argument;

/** 參數在 `--help` 裡的寫法，缺少參數時用同一個名稱。 */
export function argumentText(key: ArgumentKey): string {
  return catalog.argument[key];
}

export function flagText(value: boolean): string {
  return catalog.flag[value ? 'yes' : 'no'];
}

export function findingText(code: FindingCode, params: Params): string {
  return fill(catalog.finding[code], params);
}

export function errorText(code: ErrorCode, params: Params): string {
  return fill(catalog.error[code], params);
}
