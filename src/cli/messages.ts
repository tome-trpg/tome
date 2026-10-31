import type { ErrorCode, Params } from '../core/errors.ts';
import type { FindingCode, FindingLevel } from '../core/findings.ts';
import catalog from './messages/zh-TW.json' with { type: 'json' };

function fill(template: string, params: Params): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole);
}

export const usageText = catalog.usage;
export const workspaceTemplate = catalog.template.workspace;

export function promptText(key: keyof typeof catalog.prompt, params: Params): string {
  return fill(catalog.prompt[key], params);
}

export function levelText(level: FindingLevel): string {
  return catalog.level[level];
}

export function findingText(code: FindingCode, params: Params): string {
  return fill(catalog.finding[code], params);
}

export function errorText(code: ErrorCode, params: Params): string {
  return fill(catalog.error[code], params);
}
