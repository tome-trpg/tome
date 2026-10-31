import type { TomeError } from '../core/errors.ts';
import type { Finding } from '../core/findings.ts';
import { errorText, findingText, levelText } from './messages.ts';

// `--json` 的外層，對外介面，改動要換版本（ADR-0073）。
const CLI_SCHEMA = 'tome-cli/1';

export interface Envelope {
  readonly schema: typeof CLI_SCHEMA;
  readonly ok: boolean;
  readonly data: Readonly<Record<string, unknown>>;
  readonly findings: readonly {
    readonly code: string;
    readonly level: string;
    readonly message: string;
    readonly params: Readonly<Record<string, string>>;
  }[];
}

export function successEnvelope(
  ok: boolean,
  data: Readonly<Record<string, unknown>>,
  findings: readonly Finding[],
): Envelope {
  return {
    schema: CLI_SCHEMA,
    ok,
    data,
    findings: findings.map(({ code, level, params }) => ({
      code,
      level,
      params,
      message: findingText(code, params),
    })),
  };
}

export function errorEnvelope(error: TomeError): Envelope {
  return {
    schema: CLI_SCHEMA,
    ok: false,
    data: {},
    findings: [
      {
        code: error.code,
        level: 'error',
        params: error.params,
        message: errorText(error.code, error.params),
      },
    ],
  };
}

export function renderFinding({ code, level, params }: Finding): string {
  return `${levelText(level)}：${findingText(code, params)}\n`;
}
