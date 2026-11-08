---
status: archived
date: 2026-11-08
type: feature
wave: 37
affectedFiles:
  - CHANGELOG.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - prompts/translate.md
  - src/**
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
  - prompts/feedback.yaml
  - prompts/scan-terms.md
  - prompts/summary.md
  - providers/**
  - schemas/**
  - stryker.config.mjs
  - systems/**
integrity: sha256-2b2c12144e74e64b7c9085333d431bf9925037cec3e4fe6a292c7658e0095bb0
---

<!-- spec-brief:banner -->
> **Archived 2026-11-08.**
> Merged in pull request [#69](https://github.com/tome-trpg/tome/pull/69).
> Recorded at commit `0fbcfad`: 23 files changed, +1339 −43.
> The body below describes the tree before execution and is not maintained.
<!-- /spec-brief:banner -->

# 037 — 實體卡進翻譯

## Intent

這個回合結束時，鎖定的實體卡跟規則包的詞條一起進翻譯：同一個原文以實體卡優先，命中的卡在 `<glossary>` 帶著性別、代名詞與語域，請求之前 5 個區塊出現過、有代名詞的卡放在 `<recent>`，全書提要放在靜態前綴最後的 `<book>`；`keep_source` 的卡遮蔽；翻譯記憶的鍵加上卡的屬性，只有規則包詞條時鍵不變；譯名驗證涵蓋實體卡。`prompts/translate.md` 照維護者逐字審過的草稿接上。改了已鎖定的譯名時，`tome glossary review` 與 `import` 當下做 S-16：替換已翻的譯文與翻譯記憶、重新驗證；代名詞、性別、語域改了，命中的單位回到待翻。

細節由維護者在 2026-11-08 選定（共用筆記 `brief-037-questions.md` 的 17 項，全部照建議，第 4 項的提示照草稿），寫成 ADR-0120。

## Negative Scope

- 不做代名詞與實體卡不符的檢查（030）、交付報告與人工譯文（030、031）、規則包詞條的 S-16。
- 不做系列詞庫與跨書共用、`tome glossary why`。
- 不改 `prompts/scan-terms.md`、`summary.md`、`feedback.yaml`，不改 `state.ts`、schema 與語言設定檔。
- `prompts/translate.md` 只放維護者審過的全文，要改字就是新的提示審查。
- 不放商業書的內容，測試只用合成的詞；訊息、`--json` 與紀錄只印數量。
- 不寫入維護者的工作區，不對真的 API 發請求，不在本機跑 Stryker。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。實作時冒出的新細節寫進共用筆記 `brief-037-details.md`。
- 寫給維護者的理由要先對照程式與 ADR 原文。
- 核心不放給人看的文字。
- 成熟度照實寫：活躍實體的數字是提案。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [x] 本機單一變異的小工具對改過的函式跑過一輪，存活的補上測試或說明是等價變異

  三個檔案 153 個變異，最後都殺掉或逾時，沒有存活、沒有等價（見 Measured）。
- [x] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑

  `cf4a7c6`、`f824cae` 的 `specs`、`test` 在 Windows 與 Ubuntu 都是第一次跑就通過。
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示

  兩個 commit 的 `CodeQL` 都是 success、0 個 annotation，三個 `Analyze` 都在 attempt 1 通過；notice 只有 `ubuntu-latest` 要換成 Ubuntu 26 的執行環境通知。
- [x] 訊息、`--json` 與紀錄都不含書本文字

  `tests/cli/entities.test.ts` 確認 S-16 與待審提醒的輸出不含原文與譯名。

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0120（`amends: [ADR-0103]`）
- [x] 鎖定的實體卡與規則包詞條合併，實體卡優先，只用 `locked` 的卡
- [x] `<glossary>` 帶卡的屬性、`<recent>` 的活躍實體、靜態前綴的 `<book>`，`prompts/translate.md` 照審過的全文

  `prompts/translate.md` 用小工具比對過，跟問題清單第 4 項的草稿逐位元組相同。
- [x] `keep_source` 的卡遮蔽，翻譯記憶的鍵加上卡的屬性，只有規則包詞條時鍵不變

  `tests/core/memory.test.ts` 釘住一個照 037 之前的算法在測試外算好的鍵。
- [x] 譯名驗證涵蓋實體卡，估價的指紋含鎖定的卡與提要
- [x] S-16：改譯名時替換譯文與翻譯記憶並重新驗證，改代名詞、性別、語域時命中的單位回到待翻
- [x] 還有要審的卡時，估價與翻譯印 warn
- [x] `book1` 複本量到的 `<glossary>`、`<recent>` 大小寫進 ADR-0120
- [x] 白皮書與 CHANGELOG 更新

  實作時多出的 18 項細節寫在共用筆記 `brief-037-details.md`，維護者全部照建議選定，寫進 ADR-0120；第 1 項「比對指令前後的卡」的代價寫在 ADR-0120 的後果。

## Measured

2026-11-08（UTC），Windows 參考機器。

**請求的大小**：`book1` 的 `document.json` 複本，744 個候選詞全當成鎖定的卡（上限），只印數字，跑完刪掉複本，沒有寫入維護者的工作區。194 個請求；卡沒有屬性時 `<glossary>` 平均 14.3 行、617.5 字元，占請求平均 8.5%（最多 34.7%）；每張卡都有性別與代名詞時加上 `<recent>` 占平均 13.4%（最多 46.4%），`<recent>` 只出現在 15 個請求。數字寫在 ADR-0120。

**本機單一變異的小工具**（不是 Stryker）：用 `@babel/parser` 對改過的行產生變異，一次套一個到複本，只跑對應的測試檔，不吃滿 CPU。

| 檔案 | 變異 | 殺掉 | 逾時（算偵測到） | 存活 | 等價 |
| :--- | ---: | ---: | ---: | ---: | ---: |
| `src/core/verify.ts`（`bookTerms` 與詞條的讀法） | 46 | 46 | 0 | 0 | 0 |
| `src/core/memory.ts`（鍵與 `replaceTarget`） | 51 | 46 | 5 | 0 | 0 |
| `src/core/request.ts`（`<term>` 的一行、活躍實體，不在變異測試名單） | 56 | 56 | 0 | 0 | 0 |

第一輪存活 9 個，都補了測試：`verify.ts` 1 個是 `loadBookPack` 的回傳，`verify.test.ts` 沒呼叫它，由 `tests/cli/entities.test.ts` 殺掉；`memory.ts` 4 個是位置在 0、沒有標籤的文字、較長譯名的結尾剛好是舊譯名；`request.ts` 4 個是兩行以上時的換行與沒有單位的請求。`mask.ts` 沒有改。

本機結果：`npm test` 68 個測試檔通過、1 個跳過，1,737 個測試通過、5 個跳過；`npm run spec` 326 個斷言都成立，也都看過失敗；`npm run licenses` 299 個套件沒有違規。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| 詞條合併、翻譯記憶的鍵、替換、活躍實體、`<term>` 的一行 | 舊程式沒有這些函式；上面的單一變異都殺掉 |
| 提示的雜湊（`tests/core/prompt.test.ts`） | 改了 `prompts/translate.md`，舊的雜湊失敗 |
| S-16 的翻譯記憶（`tests/cli/entities.test.ts`） | 用舊的鍵存，1 個失敗，再改回來 |
| S-16 不動批次中的單位 | 把 `IN_FLIGHT` 算成已翻，1 個失敗，再改回來 |
| 只改代名詞也重翻 | 拿掉代名詞的比較，2 個失敗（原本的測試同時改性別與代名詞，抓不到，補成每個屬性各一個），再改回來 |
