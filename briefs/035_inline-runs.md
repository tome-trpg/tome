---
status: active
date: 2026-11-08
type: feature
wave: 25
affectedFiles:
  - CHANGELOG.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
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
  - prompts/**
  - providers/**
  - schemas/**
  - stryker.config.mjs
  - systems/**
---

# 035 — 行內樣式

## Intent

這個回合結束時，組裝 `document` 層會替段落類的區塊產生 `runs`：粗體、斜體依 pdf.js 的字型名稱判斷，連結依 PDF 的連結方框，由 TOME 自己把 pdf.js 的文字對到區塊的文字，對上的字母數字少於 95% 的區塊不給樣式。翻譯時有樣式的文字用 `<pc id="n">` 包起來送出，整個單位同一種樣式時不送 `<pc>`、譯文整段套用；驗證照舊要求 `<pc>` 一個不少，還原時記下每個 `<pc>` 在譯文裡的位置，存進 `book.db`。`tome preview` 用 Markdown 標出原文與譯文的粗體、斜體。ADR-0099 第 9 項「`<pc>` 等 M3 才產生」的斷言改成檢查它存在。

細節由維護者在 2026-11-08 照建議選定（共用筆記 `brief-035-questions.md` 的 13 項），寫成 ADR-0116。範圍照 ADR-0113 第 4 項與 ADR-0115 第 1 項。

## Negative Scope

- 不做表格儲存格的 `runs`、小型大寫與 `ruby`。
- 不做 vault 的連結（030），也不做 Pass 0 用粗體找候選詞（027）。
- 不改 Docling 轉接器與 `tome-engine/1`，不改 `prompts/`：`<pc>` 的規則已經在提示裡。
- 不改 IR 的 schema：`runs` 已經在裡面。
- 不跑變異測試，Manager 合併後在 `main` 跑。
- 不寫入維護者的工作區，不在他的電腦上跑整本解析；本機的 `tests/engine` 只跑一次，只用合成 PDF。
- 不放商業書的內容，範例與測試都用合成文字；量到的數字不寫書名，不印字型名稱與字詞。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。實作時冒出的新細節寫進共用筆記 `brief-035-details.md`。
- 寫給維護者的理由要先對照程式與 ADR 原文。
- 核心不放給人看的文字；訊息照 ADR-0086、ADR-0089。
- 成熟度照實寫：字型名稱的規則與 95% 的門檻只用維護者的書量過，只寫數字（ADR-0068、ADR-0092 第 7 項）。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過，`tests/engine` 在本機跑過一次
- [x] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [x] `specs`、`test`、`engine` 在 CI 第一次跑就通過，沒有靠重跑

  `29d543e` 的 `specs`、`test` 與 `engine`（Docling）在 Windows 與 Ubuntu 都是第一次跑就通過。
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示

  `CodeQL` 是 success、0 個 annotation。三個 `Analyze` 工作各有 1 個 notice，是 `ubuntu-latest` 要換成 Ubuntu 26 的執行環境通知，不是程式掃描的警示。
- [x] 訊息、`--json` 與紀錄都不含書本文字，`<pc>` 只帶編號，連結目標不送給模型

  沒有新的訊息代碼；`tests/cli/translate.test.ts` 確認送出的內容有 `<pc id="1">`、沒有樣式名稱。

## Acceptance Criteria

- [x] 維護者的決定與 `book1` 複本量到的對齊率寫成 ADR-0116
- [x] 組裝時產生 `runs`，接段與 `overrides` 的 `merge`、`split`、`redact` 跟著調整，`ASSEMBLY_VERSION` 加 1
- [x] 遮蔽時產生 `<pc>`，編號跟 `<ph>` 分開，沒有樣式的單位送出的內容不變
- [x] 還原時記下 `<pc>` 在譯文裡的位置，`book.db` 遷移加欄位，翻譯記憶命中也有樣式
- [x] `tome preview` 標出粗體與斜體
- [x] ADR-0099 第 9 項的斷言原地改成檢查 `<pc>` 存在，白皮書與 CHANGELOG 更新

  ADR-0115 檢查 `ASSEMBLY_VERSION = 2` 的斷言也照同一個前例原地改成版本不小於 2；ADR-0114 的 `max_tokens` 算式那行照舊成立，沒有改。
- [x] 實作時多出的細節先問 Manager（共用筆記 `brief-035-details.md`），寫進 ADR-0116

  11 項由 Manager 照建議同意，第 1 項改了問題清單第 7 項的欄位，理由寫在 ADR-0116 第 14 項；第 11 項改完後在 `book1` 複本重量，兩次的數字都寫進 ADR-0116。

## Measured

2026-11-08（UTC），Windows 參考機器。

**字型的量測**：pdf.js 開 `fontExtraProperties` 讀 `C:\Repos\tome-books` 的 8 個 PDF，1 個加密的照 PC-3 跳過，7 本只印比例與數量，不印字型名稱、字詞與書名，每次約 1 分 40 秒，數字寫在 ADR-0116。

**`book1` 複本的對齊**：在暫存資料夾複製 `source` 層，pdf.js 開 `fontStyles` 讀版面，程序內對齊與重新組裝，只印數量，約 5 秒，跑完刪掉複本，沒有寫入維護者的工作區：1,608 個段落類區塊有 1.4% 對上的不到 95%；1,723 個區塊裡 947 個有 `runs`；會翻譯的 1,199 個段落類區塊裡 306 個整段同一樣式、418 個帶 `<pc>`。

**`tests/engine`**：`npm run build`，暫存工作區 `init` 與 `engine add docling`（CPU 版 2.140.0），`TOME_ENGINE_HOME` 指向它跑 `tests/engine`：1 個測試檔、2 個測試通過，只用合成 PDF。跑完刪掉暫存工作區與 `dist`。

本機結果：`npm test` 62 個測試檔通過、1 個跳過，1,598 個測試通過、5 個跳過；`npm run spec` 269 個斷言都成立，也都看過失敗；`npm run licenses` 299 個套件沒有違規。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| 對齊、詞的邊界、連結、`runs` 的位移（`tests/core/runs.test.ts`） | 舊程式沒有 `runs.ts`；拿掉「只放在完整的詞上」，`runs.test.ts` 與 `extract.test.ts` 的首字放大各 1 個失敗，再改回來 |
| 字型名稱與 `fontStyles`（`tests/core/pdf.test.ts`） | 舊程式沒有 `fontStyle`；`fontExtraProperties` 寫死成 false，`pdf.test.ts` 1 個失敗、`extract.test.ts` 的標題樣式失敗，再改回來 |
| `<pc>` 的遮蔽與還原（`tests/core/mask.test.ts`） | 舊程式的 `maskText` 不收 `runs`；拿掉「蓋到一部分 `<ph>` 時縮小」，2 個失敗，其中一個是隨機產生文字、範圍與樣式的往返測試，再改回來 |
| 譯後排版看進 `<pc>`（`tests/core/format.test.ts`） | 拿掉看進 `<pc>` 的那一行，1 個失敗，再改回來 |
| 樣式變了保留狀態、不送 LLM 的單位（`tests/core/units.test.ts`） | `syncUnits` 不更新 `formats`，2 個失敗，再改回來 |
| `max_tokens` 的 `<pc>` 額度（`tests/core/request.test.ts`） | 額度乘 0，1 個失敗，再改回來 |
| 組裝、`overrides`、遷移、驗證、翻譯記憶、翻譯與預覽 | 舊程式沒有 `runs`、`formats`、`translation_pc` 與 `paired` |
