---
status: archived
date: 2026-11-08
type: feature
wave: 24
affectedFiles:
  - CHANGELOG.md
  - README.en.md
  - README.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - languages/source/**
  - schemas/tome-book-1.schema.json
  - schemas/tome-engine-1.schema.json
  - schemas/tome-lang-1.schema.json
  - schemas/tome-overrides-1.schema.json
  - schemas/tome-probe-1.schema.json
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
  - languages/target/**
  - package-lock.json
  - package.json
  - prompts/**
  - providers/**
  - schemas/tome-ir-1.schema.json
  - schemas/tome-pack-1.schema.json
  - stryker.config.mjs
  - systems/**
integrity: sha256-27687c61e1727fdb3ce5a08d86d7d0d1b1cd4067c1c2fbee18857a5589e54034
---

<!-- spec-brief:banner -->
> **Archived 2026-11-08.**
> Merged in pull request [#64](https://github.com/tome-trpg/tome/pull/64).
> Recorded at commit `a4f91e8`: 35 files changed, +1229 −112.
> The body below describes the tree before execution and is not maintained.
<!-- /spec-brief:banner -->

# 026 — 文件結構

## Intent

這個回合結束時，組裝 `document` 層會自動把書末索引判成 `index`、把版權頁上帶版權記號的區塊判成 `credits`，兩者都不送翻譯，判錯或判不出來時照舊用 `overrides` 的 `role` 修正。巢狀書籤可以依層級選章節：`book.yaml` 的 `chapter_level` 與 `tome estimate --chapter-level`，第 N 層是深度 N 以內的書籤依閱讀順序攤平，`--chapters`、`tome preview`、`tome status` 與翻譯都跟著它。頁面類型 `scan` 改名成 `full_image`。`tome-overrides/1` 多一個放行操作 `accept`，讓未通過字元守恆的頁進入翻譯，預設仍是失敗。

細節由維護者在 2026-11-08 照建議選定（共用筆記 `brief-026-questions.md` 的 11 項），寫成 ADR-0115。行內 `runs` 與 `<pc>` 拆到回合 035。

## Negative Scope

- 不做行內 `runs` 與 `<pc>`，那是回合 035。
- 不做平的書籤清單怎麼分章、`heading` 層級推斷（ADR-0113 第 7 項）。
- 不做 `overrides.yaml` 的編輯指令（ADR-0113 第 6 項）。
- 不做交付報告，放行的頁在 030 才列進報告。
- 不改 Docling 引擎與 `tome-engine/1` 的事件，只改頁面類型的名稱。
- 不寫入維護者的工作區，不在他的電腦上跑整本解析；本機的 `tests/engine` 只跑一次，只用合成 PDF。
- 不放商業書的內容，範例與測試都用合成文字；量到的數字不寫書名。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。實作時冒出的新細節寫進共用筆記 `brief-026-details.md`。
- 寫給維護者的理由要先對照程式與 ADR 原文。
- 核心不放給人看的文字，也不放語言相關的字詞；訊息照 ADR-0086、ADR-0089。
- 成熟度照實寫：判定規則只用維護者的書量過，只寫數字（ADR-0068、ADR-0092 第 7 項）。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過，`tests/engine` 在本機跑過一次
- [x] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [x] `specs`、`test`、`engine` 在 CI 第一次跑就通過，沒有靠重跑

  `6ba5cbd` 的 `specs`、`test` 與 `engine`（Docling）在 Windows 與 Ubuntu 都是第一次跑就通過。
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示

  `CodeQL` 是 success、0 個 annotation。三個 `Analyze` 工作各有 1 個 notice，是 `ubuntu-latest` 要換成 Ubuntu 26 的執行環境通知，不是程式掃描的警示。
- [x] 訊息、`--json` 與紀錄都不含書本文字，章名只印數量

## Acceptance Criteria

- [x] 維護者的決定與量測的數字寫成 ADR-0115，記下 `runs` 拆到 035
- [x] 組裝時判定 `index` 與 `credits`，`overrides` 的 `role` 照樣蓋過，`ASSEMBLY_VERSION` 加 1
- [x] `chapter_level` 與 `--chapter-level`，第 N 層是深度 N 以內的書籤攤平，內容指紋含層級
- [x] `scan` 改名成 `full_image`，`PROBE_VERSION` 加 1
- [x] `tome-overrides/1` 的 `accept` 讓失敗頁進入翻譯，`reason` 是 `accepted`
- [x] 白皮書與 CHANGELOG 更新，ADR-0115 的斷言補進「驗證」
- [x] 實作時多出的細節兩輪都先問 Manager（共用筆記 `brief-026-details.md` 第 1–16 項），`index` 的門檻由維護者改成 90%，其餘照建議，寫進 ADR-0115

## Measured

2026-11-08（UTC），Windows 參考機器。

**規則的量測**：pdf.js 讀 `C:\Repos\tome-books` 的 8 個 PDF，1 個加密的照 PC-3 跳過，7 本只印頁次、位置與數量，約 10 秒，數字寫在 ADR-0115，不寫書名。

**`book1` 複本的組裝**：在暫存資料夾複製 `source` 層，程序內重新組裝，只印數量，跑完刪掉複本：區塊數前後都是 1,723，`index` 0 個，`credits` 1 個區塊（第 2 頁）。沒有寫入維護者的工作區。

**`tests/engine`**：`npm run build`，暫存工作區 `init` 與 `engine add docling`（CPU 版 2.140.0），`TOME_ENGINE_HOME` 指向它跑 `tests/engine`：1 個測試檔、2 個測試通過，只用合成 PDF。跑完刪掉暫存工作區與 `dist`。

本機結果：`npm test` 60 個測試檔通過、1 個跳過，1,524 個測試通過、5 個跳過；`npm run spec` 251 個斷言都成立，也都看過失敗；`npm run licenses` 299 個套件沒有違規。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| 索引只判書末、夾頁也算（`tests/core/assemble.test.ts`） | 位置門檻改成 0、拿掉夾頁的條件，2 個失敗：開頭的目錄被判成索引、夾在中間的頁沒有判到，再改回來 |
| 版權頁的範圍、記號與字詞（`tests/core/assemble.test.ts`） | 範圍改成前 7 頁、記號加上 `™`、不讀 `credits_phrases`，5 個失敗，再改回來 |
| 放行（`tests/core/assemble.test.ts`、`tests/core/extract.test.ts`） | 不看放行的頁，2 個失敗，再改回來 |
| 書籤的層級（`tests/core/chapters.test.ts`、`tests/cli/estimate.test.ts`、`tests/cli/preview.test.ts`） | 攤平只取頂層，7 個失敗；拿掉「換層級要給 `--chapters`」的檢查，1 個失敗，再改回來 |
| `full_image`（`tests/core/probe.test.ts`） | 舊程式的頁面類型是 `scan`，`PROBE_VERSION` 是 4 |
| 判出索引、版權頁時印的那兩行（`tests/core/extract.test.ts`） | 舊程式沒有這兩個代碼 |
| 頁碼清單的判斷（`tests/core/assemble.test.ts`） | 舊程式沒有 `endsWithPageNumbers`；長行的測試確認 500 毫秒內讀完 |
