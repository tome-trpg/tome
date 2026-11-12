---
status: active
date: 2026-11-12
type: feature
wave: 48
affectedFiles:
  - CHANGELOG.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - providers/anthropic.yaml
  - schemas/tome-provider-1.schema.json
  - src/core/estimate.ts
  - src/core/provider.ts
  - src/core/request.ts
  - tests/**
protectedFiles:
  - .github/**
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CLAUDE.md
  - docs/research/**
  - engines/**
  - languages/**
  - package-lock.json
  - package.json
  - prompts/**
  - src/core/budget.ts
  - stryker.config.mjs
  - systems/**
---

# 044 — 估價器的已知缺口

## Intent

這個回合結束時，翻譯的估價補上三個已知缺口：

* 每個單位的標籤 token：輸出每個單位 12 個，輸入每個單位 6 個。
* 靜態前綴的比例：每 2.4 個字元一個 token，`user` 照舊用 `chars_per_token`。
* 重送的餘裕：`retry_margin` 從 0.1 改成 0.25。

三個數字都放在 `providers/anthropic.yaml` 的 `estimate`，schema 跟著加欄位。Pass 0（`tome scan`）的估價數字不變。

依據是 ADR-0129 第 7 項的量測，加上這次用 M3 當時的程式重建第一次送出的請求、逐個對照帳本的擬合（共用筆記 `brief-044-questions.md` 事實 B 到 D）。現在的估價在 M3 的兩本書上，第一次送出低估 19.3% 與 4.8%；連重送一起算，低估 29.5% 與 18.1%。三項都補上之後，套回同樣的數據，含重送的總花費都在估價中間值 ±1% 以內。數據只有兩本書、一個模型，數字都是提案，045 的試翻再依書校準（ADR-0130 第 9 項）。

細節由維護者在 2026-11-12 全部照建議選定（`brief-044-questions.md` 的 6 項），寫成 ADR-0134，`amends` ADR-0103 與 ADR-0114。

## Negative Scope

- 不改 `chars_per_token`、`output_ratio`、`low`、`high`，這些留給 045 校準。
- 不改 `max_tokens` 的 `UNIT_OUTPUT_TOKENS`（16）：它是上限，要寬一點。
- 不改 `budget.ts`：它只用估價的結果。
- Pass 0 的估價數字不變：它的實際花費已經在估價下限附近。
- 不改提示、請求的組法與重送的規則。
- 不讀書本內容。量測只用工作區的唯讀暫存複本、只印數字，量完刪掉。測試只用合成的文字。
- 本機不跑變異測試。改過的行在回合分支上 dispatch `mutation-lines`。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。實作時冒出的新細節寫進共用筆記 `brief-044-details.md`。
- 寫給維護者的理由要先對照程式與量測的原文。
- 核心不放給人看的文字。
- 主張要帶成熟度，沒量測的不能寫成已實作（ADR-0068）。文件只寫數字，不寫書名與內文（ADR-0059）。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠、變異測試跑完就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過

  2215 個測試通過，449 個斷言都成立，299 個套件、0 違規。
- [x] 新的測試先在舊行為上失敗過

  新的測試放在改估價器之前的程式（`85c1568`）上跑，18 個失敗：估價器 12 個、schema 4 個、請求的估價 2 個。維護者選定 `scan_retry_margin` 之後補的「Pass 0 用自己的餘裕」在舊程式上也會失敗（舊程式讀 `retry_margin`）。Pass 0 另外兩個測試是護欄，在舊程式上也會通過，用來確認 Pass 0 的估價不變；schema 拒絕打錯的欄位與不合理的值，在舊程式上也會通過。為了殺掉 `withThinking` 的存活變異補的 Opus 5.5 Pass 0 測試，在舊程式上也會通過：那一行的行為沒變，它守的是思考的倍數。
- [x] `mutation-lines` 跑過改過的行，存活的變異補上測試，或說明為什麼等價

  run 43228582368（`2e94949`）：整個 `estimate.ts` 加上 `request.ts:447-452`，42 個殺掉 41 個。存活的 `estimate.ts:66`（`withThinking` 的 `*` 換成 `/`）補了 Opus 5.5 的 Pass 0 測試，重跑那一行（run 43230612464，`e8f90af`）2 個都殺掉。結果寫在 ADR-0134 第 8 項。
- [x] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑

  PR 83 的每次推送（`2e94949`、`e8f90af`）都是 attempt 1 通過，兩個 OS 都是；`e8f90af` 是 run 43230622248（specs）、43230622095（test）。
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示

  `e8f90af` 的 `CodeQL` 是 success、0 個 annotation；三個 Analyze 各一個 annotation，都是原本就有的 ubuntu-latest 說明。
- [x] Pass 0 的估價跟改之前相同

  `tests/core/estimate.test.ts`：用隨附的設定檔算 Pass 0，結果跟改之前的算式（乘 1.1 的餘裕）相同；前綴的比例與單位的標籤不影響 Pass 0。

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0134（`amends: [ADR-0103, ADR-0114]`），白皮書 §9 的索引加一列
- [x] `providers/anthropic.yaml` 的 `estimate` 加上 `unit_output_tokens: 12`、`unit_input_tokens: 6`、`prefix_chars_per_token: 2.4`，`retry_margin` 改成 0.25；schema 加這三個欄位

  Pass 0 照舊用 0.1 的餘裕，放在新欄位 `scan_retry_margin`，schema 一共加四個欄位（ADR-0134 第 6 項）。
- [x] 翻譯的估價：輸入是前綴字元 ÷ `prefix_chars_per_token`，加 `user` 字元 ÷ `chars_per_token`，加單位數 × `unit_input_tokens`；輸出另加單位數 × `unit_output_tokens`

  輸出的標籤加在思考的倍數之外，跟 `max_tokens` 相同（ADR-0134 第 2 項）。
- [x] 測試用合成的請求，分別改單位數、前綴長度與 `user` 長度，看估價怎麼動
- [x] 白皮書與 CHANGELOG 更新，寫明已確認的估價要重新 `tome estimate --confirm`，預算檢查會比較早停下
