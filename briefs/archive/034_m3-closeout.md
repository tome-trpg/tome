---
status: archived
date: 2026-11-10
type: feature
wave: 44
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
integrity: sha256-5151b704ae985f49e2fe3eb36100c1443d774a5d7ce8e676b5d7df0c1fe0299e
---

<!-- spec-brief:banner -->
> **Archived 2026-11-11.**
> Merged in pull request [#78](https://github.com/tome-trpg/tome/pull/78).
> Recorded at commit `3a44ffd`: 10 files changed, +252 −9.
> The body below describes the tree before execution and is not maintained.
<!-- /spec-brief:banner -->

# 034 — M3 收尾

## Intent

這個回合結束時，M3 照 ADR-0113 第 20 項收尾：維護者用自己的金鑰，在自己的電腦上用 `tome run` 把公有領域的 The Call of Cthulhu（即時模式）與規則書 `book1` 的 PDF 第 3–108 頁（批次模式）跑到 vault，執行 session 從唯讀的複本量出花費、估價誤差、重送、拒答、`FAILED_QA`、Pass 0 與實體卡、vault 的數字，寫成 ADR-0129，只寫數字與代號，不寫書名與內文。M3 留下的 43 項 Open Questions 分類列表，已經定案的在原 ADR 打勾。另外，正負號緊接數字時跟數字一樣，跟漢字之間不留空白（`韌性−1`，跟 `韌性12` 一致），所有譯文都適用。

細節由維護者在 2026-11-10 選定（共用筆記 `brief-034-questions.md`：第 2 項維護者自己跑、Docling CPU 版，第 3 項備份後刪掉重來，第 4 項跟 M2 同範圍，第 5 項 Sonnet 5.5、一本批次一本即時，第 8 項照真的使用者審，第 13 項緊接數字時拿掉空白，其餘照建議）。

## Negative Scope

- 執行 session 不呼叫 API、拿不到金鑰；不在維護者的電腦上解析或翻譯真書，也不跑長時間的工作。真實的翻譯由維護者照共用筆記 `m3-closeout-steps.md` 自己跑。
- 不讀書本文字：只讀維護者工作區資料庫與 document 層的唯讀複本，只印數字，量完刪掉；不開 PDF、`ir/source/` 與 vault 的檔。
- 跑的時候發現的程式問題，除了正負號的空白，不在這個回合修，列進 ADR-0129 的 Open Questions。
- 不裝新的引擎，不加相依，不加遷移，不動變異測試的模組。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。
- 寫給維護者的理由要先對照程式與 ADR 原文。
- 核心不放給人看的文字。
- 公開文件寫「維護者」，不寫人名；ADR、白皮書與 PR 只寫數字與代號 `book1`。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過
- [x] 本機單一變異的小工具對改過的行跑過一輪，存活的補上測試或說明是等價變異
- [x] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] ADR、白皮書與 PR 都不含書本文字與商業書的書名（共用筆記 `m3-closeout-steps.md` 照 Manager 的要求寫了規則書 PDF 的路徑，只在 repo 外的共用筆記；量測的共用筆記只有數字）

## Acceptance Criteria

- [x] 正負號緊接數字時，跟漢字之間不留空白，所有譯文都適用
- [x] 維護者跑完兩本書，數字寫進共用筆記 `m3-closeout-facts.md`
- [x] ADR-0129 記下兩本書的數字、M3 結束，以及 43 項 Open Questions 的分類；已經定案的在原 ADR 打勾
- [x] 白皮書的路線圖與 CHANGELOG 更新

## Measured

2026-11-09 到 2026-11-11（UTC+8），Windows 參考機器。

**收尾的真實翻譯**：維護者照共用筆記 `m3-closeout-steps.md`，用自己的金鑰在 `main` 的 `acef6c3` 上跑完兩本書；執行 session 沒有呼叫 API。數字由執行 session 從維護者 `book.db`、`series.db` 與 M2 備份的唯讀複本算出（scratchpad 的小工具，只印數字，量完刪掉複本），寫在共用筆記 `m3-closeout-facts.md` 與 ADR-0129。`--chapters 1-172` 也是從 `document.json` 的唯讀複本用 TOME 自己的 `chapterMap` 算的，只印章號與頁碼。

| | 公有領域（即時） | `book1`（批次） |
| :--- | ---: | ---: |
| 單位 | 127 | 2,578 |
| `FAILED_QA` | 8 | 139 |
| 翻譯的花費／估價 | $0.5061／$0.3315–$0.5386 | $1.8383／$0.8194–$1.3315 |
| 第一次送出／重送 | $0.3956／$0.1105 | $1.1529／$0.6853 |
| 請求 | 18 | 399（估價 191） |
| Pass 0 的花費／估價 | $0.0437／$0.0438–$0.0712 | $0.1713／$0.1786–$0.2902 |
| 待人審／審定時間 | 28／約 20 分鐘 | 332／約 2 小時 |

**正負號的空白**（`src/core/format.ts`）：新的測試在舊的 `format.ts`（`acef6c3`）上跑，7 個失敗（含合成測試規則包的 `signs_ranges_and_thousands`），新的 `format.ts` 都通過。本機單一變異的小工具對改過的行產生 26 個變異，跑 `tests/core/format.test.ts` 與 `tests/core/fields.test.ts`：第一輪存活 9 個，補了兩個測試（`<pc>` 前後的空白各看第一個與最後一個字、`<pc>` 裡數字後面還有字），並把 `` `${first}${second ?? ''}` `` 改成 `slice(0, 2)`，最後殺掉 22 個、等價 4 個：`isSignedNumber` 的兩個 `?? ''`（換成別的字串，`Set` 與正規表示式照樣不認），與 `neighbor` 裡給空字串片段用的兩個預設值（標籤的剖析不會產生空的文字片段，`tags.ts` 只在 `text !== ''` 時才放進去）。

本機結果：`npm test` 81 個測試檔通過、1 個跳過，2,116 個測試通過、5 個跳過（第一次跑時 `tests/tools/fixtures.test.ts` 失敗：改了 `stat-fixture` 的案例檔，`tests/fixtures/SOURCES.yaml` 的雜湊沒跟著改；更新雜湊後重跑整套都通過）；`npm run spec` 416 個斷言都成立，也都看過失敗；`npm run typecheck` 通過；`npm run licenses` 299 個套件沒有違規。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| 正負號緊接數字（`tests/core/format.test.ts`、`stat-fixture` 的案例） | 在 `acef6c3` 的 `format.ts` 上跑，7 個失敗；變異都殺掉或列為等價 |
