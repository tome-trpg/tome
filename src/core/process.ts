import { execFile } from 'node:child_process';

// 子行程一律從這裡啟動，環境變數先過濾，金鑰才不會被繼承（ADR-0034）。
const SECRET_NAME = /api[_-]?key|secret|token|password|credential/i;

export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_NAME.test(name)));
}

export interface ToolResult {
  readonly stdout: string;
}

export type ToolRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<ToolResult | null>;

/** 找不到指令、逾時或失敗都回 null，由呼叫端決定算不算發現。 */
export const runTool: ToolRunner = (command, args, env) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { env: scrubEnv(env), timeout: 10_000, windowsHide: true },
      (error, stdout) => resolve(error ? null : { stdout }),
    );
  });
