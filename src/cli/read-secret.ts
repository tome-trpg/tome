import { TomeError } from '../core/errors.ts';

export interface SecretInput extends AsyncIterable<Buffer | string> {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const DELETE = '\u007f';
const BACKSPACE = '\b';

function readHidden(input: SecretInput & { setRawMode(mode: boolean): unknown }): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (settle: () => void): void => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      settle();
    };
    function onData(chunk: Buffer | string): void {
      for (const character of String(chunk)) {
        if (character === '\r' || character === '\n' || character === CTRL_D) {
          finish(() => resolve(value));
          return;
        }
        if (character === CTRL_C) {
          finish(() => reject(new TomeError('cli.cancelled')));
          return;
        }
        if (character === DELETE || character === BACKSPACE) value = value.slice(0, -1);
        else value += character;
      }
    }
    input.setRawMode(true);
    input.on('data', onData);
    input.resume();
  });
}

async function readPiped(input: SecretInput): Promise<string> {
  let value = '';
  for await (const chunk of input) value += String(chunk);
  return value;
}

/** 金鑰只從這裡進來，沒有旗標參數，才不會留在 shell 歷史（ADR-0082）。 */
export function readSecret(input: SecretInput, prompt: () => void): Promise<string> {
  if (input.isTTY && input.setRawMode) {
    prompt();
    return readHidden(input as SecretInput & { setRawMode(mode: boolean): unknown });
  }
  return readPiped(input);
}
