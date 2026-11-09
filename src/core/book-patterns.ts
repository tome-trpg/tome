import type { BookPattern } from './book.ts';
import { finding, type Finding } from './findings.ts';
import { compiles, regexRisks } from './pack-lint.ts';
import type { ResolvedPack } from './pack.ts';

// 單書的額外遮蔽模式（ADR-0124）。書沒有 `tome system lint` 這一關，組單位前先查，
// 執行時跟規則包的模式一樣在 worker 裡限時（ADR-0049）。訊息只帶模式的 ID，不帶正規表示式。

/** 編不過與重複的 `id` 是 fail，編得過的模式有回溯風險只警告。問題一次列完。 */
export function checkBookPatterns(patterns: readonly BookPattern[]): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const { id, regex, flags } of patterns) {
    if (seen.has(id)) findings.push(finding('book.bad_pattern', 'fail', { pattern: id, reason: 'duplicate_id' }));
    seen.add(id);
    if (!compiles({ regex, flags })) {
      findings.push(finding('book.bad_pattern', 'fail', { pattern: id, reason: 'invalid_regex' }));
      continue;
    }
    for (const risk of regexRisks(regex)) {
      findings.push(finding('pack.risky_regex', 'warn', { pattern: id, risk }));
    }
  }
  return findings;
}

/**
 * 同一個 `id` 時書的蓋過規則包的；書的模式全部照順序排在前面，重疊時書的優先（ADR-0124）。
 * `chain` 不變，所以規則包的雜湊不變：估價的指紋靠遮蔽後的文字就知道模式改了。
 */
export function withBookPatterns(pack: ResolvedPack, patterns: readonly BookPattern[]): ResolvedPack {
  const replaced = new Set(patterns.map(({ id }) => id));
  return { ...pack, patterns: [...patterns, ...pack.patterns.filter(({ id }) => !replaced.has(id))] };
}
