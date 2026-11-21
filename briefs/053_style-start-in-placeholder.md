---
status: active
date: 2026-11-21
type: defect
wave: 54
affectedFiles:
  - CHANGELOG.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - src/core/mask.ts
  - tests/**
protectedFiles:
  - .github/**
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CLAUDE.md
  - engines/**
  - languages/**
  - package-lock.json
  - package.json
  - prompts/**
  - providers/**
  - schemas/**
  - src/core/egress/**
  - src/core/process.ts
  - src/core/store.ts
  - systems/**
  - tools/**
  - vitest.config.ts
---

# 053 — 樣式的起點落進佔位符

## Intent

這個回合結束時，佔位符從空白開始、又被一段行內樣式（粗體、斜體、連結）蓋住時，遮蔽後的 `<pc>` 包住整個 `<ph>`，還原時樣式的位置跟原文記下的一致，ADR-0116 的性質測試不會再因為這種輸入失敗。原因在 `src/core/mask.ts`：`planFormats` 先把樣式對齊佔位符的邊界（`shrink`），再去掉頭尾空白（`trimmed`），起點就可能落進佔位符裡；`maskText` 輸出時游標已經在佔位符後面，`<pc>` 只能接在它後面，變成空的。記下的位置（去掉空白後的）照 ADR-0116 第 13 項本來就對，錯的是 `<pc>` 開頭放的地方。反例先寫成固定的測試，在舊程式上失敗，再修。決定寫成 ADR-0141，寫清楚影響範圍：內建規則包碰不到、自訂規則包可能會，文字不會掉、只有樣式變空。名稱（`053_style-start-in-placeholder`、標題「樣式的起點落進佔位符」）是提案，等維護者確認。

## Negative Scope

* 不改 ADR-0116 定下的規則：`<pc>` 攤平不巢狀、記下的位置不含兩端的空白、驗證要求每個 `<pc>` 恰好一次。
* 不改提示、規則包、schema 與 `book.db` 的結構；已存的 `formats.paired` 不用重算。
* 不動 052 的分支與 PR 98；不動 vitest、Anthropic SDK、docling 的版本。
* 不在維護者的筆電上跑變異測試；`mutation-lines` 在 runner 上跑。

## Not Empowered

* `src/core/store.ts`、`src/core/process.ts`、`src/core/egress/**`、`prompts/**`、`systems/**`、`schemas/**`、`tools/**`。
* `package.json`、`package-lock.json`、`vitest.config.ts`、workflow；要改時先停下來問。

## Invariants

- [ ] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [ ] 反例寫成固定的測試，先在舊程式上失敗過
- [ ] 改過的行跑 `mutation-lines`，存活的變異補上測試，或說明為什麼等價
- [ ] ADR-0141 寫下原因、修法與影響範圍（內建規則包碰不到、自訂規則包可能會、文字不會掉、只有樣式變空）
- [ ] `specs`、`test` 在 CI 第一次跑就通過，Windows 與 Ubuntu 都過，沒有靠重跑
- [ ] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示

## The Defect, Measured

PR 98 的 `35b75f2`（只改 ADR-0140 的文字）在 2026-11-21 的 CI attempt 1，`test (ubuntu-24.04)`（job 136861826717）失敗；同樣程式的 `767cc32` 兩個平台都過。

* 失敗的測試：`tests/core/mask.test.ts:314`「gets the text and every <pc> back for any text, ranges and styles」（ADR-0116 的性質測試，fast-check 每次用新的亂數）。`Property failed after 9 tests`，seed 1914687504，path `8:81:6:4:6:6`。
* 反例：文字 `"\rf\u{10fff7}umen"`、骰子的範圍 0–2、粗體 0–2。預期 `<pc>` 在 1–2，還原後是 2–2。

執行 session 在本機用 `maskText`、`parseUnits`、`restoreSegments` 重現（2026-11-21，`origin/main` 在 `47cd1ac`），結果固定：

| 文字 | 佔位符 | 樣式 | 遮蔽後 | 記下的位置 | 還原後 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `"\rfumen"` | 0–2 | 0–2 | `<ph/><pc></pc>umen` | 1–2 | 2–2，不一致 |
| `"\nfumen"` | 0–2 | 0–2 | `<ph/><pc></pc>umen` | 1–2 | 2–2，不一致 |
| `"ab \r1D6 cd"` | 3–7 | 2–8 | `ab <ph/><pc></pc> cd` | 4–7 | 7–7，不一致 |
| `"umenf\r"` | 4–6 | 4–6 | `umen<pc><ph/></pc>` | 4–5 | 4–5 |
| `" 1D6 x"` | 1–4 | 0–4 | ` <pc><ph/></pc> x` | 1–4 | 1–4 |
| `"xfumen"` | 0–2 | 0–2 | `<pc><ph/></pc>umen` | 0–2 | 0–2 |

* 補充平面的字元不相干。要佔位符的範圍從空白開始、樣式的起點跟著落進去才會錯；結尾落進佔位符時，`<pc>` 本來就接在佔位符後面，結果剛好對。
* 文字都照樣還原，錯的只有 `<pc>` 的位置：那段樣式在佔位符上變成空的。
