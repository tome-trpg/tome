import type { Book } from './book.ts';
import { entityCards, type EntityCard } from './entities.ts';
import { loadTargetLanguage } from './language.ts';
import type { Placeholder } from './mask.ts';
import { memoryKey, remember, replaceTarget, type MemoryEntry } from './memory.ts';
import { loadPhraseCheck } from './opencc.ts';
import { termsFor, type LocalizedTerm, type ResolvedPack } from './pack.ts';
import type { UnitState } from './state.ts';
import { openSeriesStore, type Store } from './store.ts';
import { bookTerms, hitTerms, recordProblems, settle, verifyFragment, type VerifyContext } from './verify.ts';
import { workspaceTargetLang } from './workspace.ts';

// S-16：改了已鎖定的實體卡，不重翻全書（白皮書 §5.6、ADR-0026 第 7 項、ADR-0120）。
// `tome glossary review` 與 `import` 改卡的當下做：比對指令開始前後的鎖定卡，譯名改了就替換已翻的譯文與
// 翻譯記憶、重新驗證；性別、代名詞、語域改了，命中的單位回到待翻，估價會列出來。人工譯文在回合 031。

export interface RenameCounts {
  /** 改用新譯名、驗證通過的單位。 */
  readonly replaced: number;
  /** 找不到舊譯名或驗證沒過、要重送的單位。 */
  readonly resend: number;
  /** 性別、代名詞或語域改了，回到待翻的單位。 */
  readonly reset: number;
  /** 還在批次裡、這次沒動的單位，收回時用新的詞條驗證。 */
  readonly in_flight: number;
}

/** 翻過、有回應的單位。`RECEIVED`、`STALE` 也是用舊的卡翻的。 */
const TRANSLATED: ReadonlySet<UnitState> = new Set(['DONE', 'FAILED_QA', 'RECEIVED', 'STALE']);

interface UnitRow {
  readonly unit_id: string;
  readonly role: string;
  readonly source: string;
  readonly masked: string;
  readonly placeholders: string;
  readonly state: UnitState;
  readonly attempts: number;
}

interface Renamed {
  readonly term: LocalizedTerm;
  readonly before: string;
}

function isLocked(card: EntityCard): boolean {
  return card.status === 'locked' && card.target !== null;
}

/** 一張卡自己的詞條，用來找命中的單位。 */
function termOf(card: EntityCard): LocalizedTerm | undefined {
  return bookTerms([], [card])[0];
}

interface Changes {
  readonly renamed: readonly Renamed[];
  readonly reworded: readonly LocalizedTerm[];
}

/** 指令前後都鎖定的卡，哪些改了譯名、哪些改了性別、代名詞或語域。後者要重翻，不必再替換。 */
function changesOf(before: readonly EntityCard[], after: readonly EntityCard[]): Changes {
  const was = new Map(before.filter(isLocked).map((card) => [card.id, card]));
  const renamed: Renamed[] = [];
  const reworded: LocalizedTerm[] = [];
  for (const card of after.filter(isLocked)) {
    const old = was.get(card.id);
    const term = termOf(card);
    if (old === undefined || old.target === null || term === undefined) continue;
    if (old.gender !== card.gender || old.pronoun !== card.pronoun || old.register !== card.register) reworded.push(term);
    else if (old.target !== card.target) renamed.push({ term, before: old.target });
  }
  return { renamed, reworded };
}

/** 回到待翻，譯文與問題清掉，重試額度歸零。批次收回時鍵不同的單位也用這個（ADR-0123）。 */
export function resetUnit(store: Store, unitId: string): void {
  store.run("UPDATE unit SET state = 'PENDING', attempts = 0, translation = NULL, translation_pc = NULL WHERE unit_id = ?", unitId);
  recordProblems(store, unitId, []);
}

export interface RenameOptions {
  readonly home: string;
  readonly book: Book;
  readonly store: Store;
  readonly pack: ResolvedPack;
  /** 指令開始前的實體卡（`entityCards`）。 */
  readonly before: readonly EntityCard[];
}

/** 沒有鎖定卡改動時是 null，什麼都不做，也不載入片語表。 */
export async function applyRenames({ home, book, store, pack, before }: RenameOptions): Promise<RenameCounts | null> {
  const after = entityCards(store);
  const { renamed, reworded } = changesOf(before, after);
  if (renamed.length === 0 && reworded.length === 0) return null;
  const units = store.all<UnitRow>('SELECT unit_id, role, source, masked, placeholders, state, attempts FROM unit ORDER BY seq');
  const inFlight = new Set<string>();
  const touched = (terms: readonly LocalizedTerm[]): UnitRow[] =>
    units.filter((unit) => {
      if (terms.length === 0 || hitTerms(unit, terms).length === 0) return false;
      if (unit.state === 'IN_FLIGHT') inFlight.add(unit.unit_id);
      return TRANSLATED.has(unit.state);
    });

  const redo = touched(reworded);
  store.transaction(() => {
    for (const unit of redo) resetUnit(store, unit.unit_id);
  });
  const done = new Set(redo.map(({ unit_id }) => unit_id));
  const swap = touched(renamed.map(({ term }) => term)).filter(({ unit_id }) => !done.has(unit_id));
  if (swap.length === 0) return { replaced: 0, resend: 0, reset: redo.length, in_flight: inFlight.size };

  const packTerms = termsFor(pack, book.config.source_lang);
  const oldTerms = bookTerms(packTerms, before);
  const terms = bookTerms(packTerms, after);
  const targetLang = workspaceTargetLang(home);
  const { profile: language } = loadTargetLanguage(targetLang);
  const context: VerifyContext = { language, terms, phraseCheck: await loadPhraseCheck(language) };
  const longer = terms.map(({ term }) => term.target);
  const previous = new Map(units.flatMap(({ unit_id }, index) => {
    const prior = units[index - 1];
    return prior === undefined ? [] : [[unit_id, prior.masked] as const];
  }));
  const series = openSeriesStore(home, book.slug);
  let replaced = 0;
  let resend = 0;
  try {
    for (const unit of swap) {
      const reply = store.get<{ text: string; model: string }>(
        'SELECT text, model FROM response WHERE id = (SELECT MAX(id) FROM response WHERE unit_id = ?)',
        unit.unit_id,
      );
      if (reply === undefined) continue;
      let fragment = reply.text;
      let count = 0;
      for (const { term, before: old } of renamed) {
        if (hitTerms(unit, [term]).length === 0) continue;
        const result = replaceTarget(fragment, old, term.term.target, longer);
        fragment = result.fragment;
        count += result.count;
      }
      const verifiable = { ...unit, placeholders: JSON.parse(unit.placeholders) as Placeholder[] };
      const state = store.transaction(() => {
        if (count > 0) {
          store.run(
            'INSERT INTO response (unit_id, attempt, text, model, created_at) VALUES (?, ?, ?, ?, ?)',
            unit.unit_id,
            unit.attempts,
            fragment,
            reply.model,
            new Date().toISOString(),
          );
        }
        return settle(store, unit, verifyFragment(verifiable, fragment, context));
      });
      if (state !== 'DONE') {
        resend += 1;
        continue;
      }
      if (count === 0) continue;
      replaced += 1;
      // 舊的那筆用改之前的詞條算鍵找出來，換好的片段用新的鍵存；舊的不刪，鍵含舊譯名，不會再命中。
      const style = pack.roles.find(({ pack: owner, name }) => `${owner}:${name}` === unit.role)?.style;
      const prior = previous.get(unit.unit_id) ?? null;
      const oldKey = memoryKey(unit, prior, { terms: oldTerms, targetLang, style });
      const entry = series.get<MemoryEntry>(
        'SELECT fragment, model, prompt_hash, pack_hash, sdk_version, book FROM memory WHERE key = ?',
        oldKey,
      );
      if (entry === undefined) continue;
      remember(series, memoryKey(unit, prior, { terms, targetLang, style }), { ...entry, fragment }, verifiable, context);
    }
  } finally {
    series.close();
  }
  return { replaced, resend, reset: redo.length, in_flight: inFlight.size };
}
