import type { ReviewSession } from '../../core/glossary.ts';
import type { ToolRunner } from '../../core/process.ts';
import type { PageTexts } from './page.ts';
import { startReviewServer } from './server.ts';

// `tome glossary review --web` 的外層（ADR-0138）：開伺服器、在終端機印網址、打開預設瀏覽器，等 Ctrl+C。
// 瀏覽器經過 `src/core/process.ts` 打開（ADR-0034），這裡不碰子行程。

/** 各平台打開預設瀏覽器的指令。Windows 不經過 cmd，網址裡的符號才不會被當成指令。 */
export function browserCommand(url: string, platform: NodeJS.Platform): { readonly command: string; readonly args: readonly string[] } {
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

export interface WebOptions {
  readonly book: string;
  readonly texts: PageTexts;
  /** `--no-open` 時是 false。 */
  readonly open: boolean;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly tool: ToolRunner;
  /** 網址與提示，走 stderr。 */
  readonly say: (key: 'review_web' | 'review_no_browser' | 'review_closing', params?: Readonly<Record<string, string>>) => void;
  /** 使用者按 Ctrl+C 時完成。 */
  readonly stopped: () => Promise<void>;
}

export async function serveOnWeb(session: ReviewSession, options: WebOptions): Promise<void> {
  const server = await startReviewServer({ book: options.book, session, texts: options.texts });
  try {
    options.say('review_web', { url: server.url });
    if (options.open) {
      const { command, args } = browserCommand(server.url, options.platform);
      // 不等它：有些平台的瀏覽器開著就不回來。打不開時說一聲，網址已經印了。
      void options.tool(command, args, options.env).then((result) => {
        if (result === null) options.say('review_no_browser');
      });
    }
    await options.stopped();
    options.say('review_closing');
  } finally {
    await server.close();
  }
}
