// 代碼用英文，訊息由 CLI 查資料檔（ADR-0027）。核心不放給人看的文字。
export const ERROR_CODES = [
  'book.busy',
  'book.not_found',
  'book.pdf_changed',
  'book.pdf_missing',
  'budget.invalid',
  'chapter_level.invalid',
  'chapter_level.needs_chapters',
  'chapters.invalid',
  'cli.bad_args',
  'cli.cancelled',
  'cli.extra_arguments',
  'cli.internal',
  'cli.missing_argument',
  'cli.no_arguments',
  'cli.unknown_command',
  'cli.unknown_option',
  'config.bad_schema',
  'config.invalid_yaml',
  'document.missing',
  'egress.denied',
  'engine.not_found',
  'file.corrupt',
  'glossary.csv_missing',
  'language.unknown',
  'language.unknown_target',
  'model.missing',
  'model.unknown',
  'pack.bad_id',
  'pack.not_found',
  'pdf.not_found',
  'pdf.unreadable',
  'provider.unknown',
  'scanner_model.missing',
  'secret.invalid',
  'store.bad_id',
  'store.busy',
  'store.corrupt',
  'store.too_new',
  'store.wrong_kind',
  'translate.blocked',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type Params = Readonly<Record<string, string>>;

/** 結果不可信，結束碼 2（ADR-0059）。params MUST NOT 含金鑰或書本文字。 */
export class TomeError extends Error {
  readonly code: ErrorCode;
  readonly params: Params;

  constructor(code: ErrorCode, params: Params = {}) {
    super(code);
    this.name = 'TomeError';
    this.code = code;
    this.params = params;
  }
}
