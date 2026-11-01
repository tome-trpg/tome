import { execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// 子行程一律從這裡啟動，環境變數先過濾，金鑰才不會被繼承（ADR-0034）。
const SECRET_NAME = /api[_-]?key|secret|token|password|credential/i;
const STDERR_TAIL_BYTES = 4096;

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
  cwd?: string,
) => Promise<ToolResult | null>;

/** 找不到指令、逾時或失敗都回 null，由呼叫端決定算不算發現。 */
export const runTool: ToolRunner = (command, args, env, cwd) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { env: scrubEnv(env), timeout: 10_000, windowsHide: true, ...(cwd === undefined ? {} : { cwd }) },
      (error, stdout) => resolve(error ? null : { stdout }),
    );
  });

export interface StreamOptions {
  readonly cwd?: string;
  /** 過濾後才加上去，給引擎宣告的離線設定用。 */
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly onLine?: (line: string) => void;
  /** 這麼久沒有輸出一行就終止。 */
  readonly idleTimeoutMs?: number;
  /** 引擎的 stderr 可能帶書本文字，不留（ADR-0059）。uv 的錯誤要給人看，才留尾端。 */
  readonly keepStderr?: boolean;
}

export type StreamOutcome =
  | { readonly status: 'exited'; readonly code: number | null; readonly stderr: string }
  | { readonly status: 'timeout' }
  | { readonly status: 'not_found' };

export type StreamRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options?: StreamOptions,
) => Promise<StreamOutcome>;

/** 跑很久的子行程：stdout 一行一行交給呼叫端，不用等它結束。 */
export const runStream: StreamRunner = (command, args, env, options = {}) =>
  new Promise((resolve) => {
    const { cwd, extraEnv = {}, onLine, idleTimeoutMs, keepStderr = false } = options;
    const child = spawn(command, [...args], {
      env: { ...scrubEnv(env), ...extraEnv },
      stdio: ['ignore', 'pipe', keepStderr ? 'pipe' : 'ignore'],
      windowsHide: true,
      ...(cwd === undefined ? {} : { cwd }),
    });
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let stderr = '';
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const arm = (): void => {
      if (idleTimeoutMs === undefined) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, idleTimeoutMs);
    };
    const consume = (text: string): void => {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) onLine?.(line);
    };

    arm();
    child.stdout?.on('data', (chunk: Buffer) => {
      arm();
      consume(decoder.write(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(
        error.code === 'ENOENT' ? { status: 'not_found' } : { status: 'exited', code: null, stderr },
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      consume(decoder.end());
      if (pending !== '') onLine?.(pending);
      resolve(timedOut ? { status: 'timeout' } : { status: 'exited', code, stderr });
    });
  });
