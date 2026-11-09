---
status: active
date: 2026-11-09
type: feature
wave: 42
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

# 032 — tome run

## Intent

這個回合結束時，`tome run <書>` 從已經加入的書一路跑到下一個要人點頭的地方：解析、Pass 0（有要送的就顯示估價停下，請跑 `tome scan-terms --confirm`）、關卡一審定（還有待審的卡就停）、關卡二確認估價（沒有確認或估價變了就停）、翻譯（含驗證與重送，批次會等到結束）、輸出 vault。停下時結束碼 0、`run.stopped` 警告，`--json` 寫停在哪與下一個指令；整條跑完是 `run.done`。某一步沒做完就停在那裡；做完了但有單位沒翻成，照樣輸出 vault，結束碼照翻譯那一步。整條拿一次書的鎖，各步的指令照樣能單獨跑。

細節由維護者在 2026-11-09 選定（共用筆記 `brief-032-questions.md`：第 2 項停下來確認 Pass 0，第 3 項結束碼 0 加警告，第 6 項分兩種，其餘照建議；`brief-032-details.md` 第 1 項更正問題第 6 項的例子：個資閘門第一次擋下時翻譯就停了，維護者選「停在翻譯」，不輸出 vault，之前就被擋下的單位照樣輸出；其餘照建議），寫成 ADR-0127。

## Negative Scope

- 不做試翻（`tome trial`、`--trial`，M4）、`tome add`、`tome sync`、`tome status` 的下一步。
- `tome run` 不收 `--confirm` 與 `--dry-run`；兩個關卡與 Pass 0 的確認都用各自的指令。
- 不改各步指令原本的行為與訊息；不加遷移；`state.ts`、`memory.ts`、`mask.ts`、`verify.ts` 不動。
- 測試只用假的引擎與假的供應商，不對真的 API 發請求，不在維護者的電腦上跑長時間的解析；較大的性質測試次數只在 CI 跑。
- 不寫入維護者的工作區。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。實作時冒出的新細節寫進共用筆記 `brief-032-details.md`。
- 寫給維護者的理由要先對照程式與 ADR 原文。
- 核心不放給人看的文字：訊息放訊息檔。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [x] 本機單一變異的小工具對改過的行跑過一輪，存活的補上測試或說明是等價變異
- [ ] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑
- [ ] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] 訊息、`--json` 與紀錄都不含書本文字

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0127（`amends: [ADR-0055, ADR-0113]`）
- [x] `tome run <書>` 依序跑解析、Pass 0、審定、確認估價、翻譯、輸出，停在 Pass 0 的確認與兩個關卡
- [x] 停下時結束碼 0、`run.stopped`，`--json` 有 `stopped_at` 與下一個指令；跑完是 `run.done`
- [x] 沒做完的步驟停下，有單位沒翻成照樣輸出 vault
- [x] 白皮書與 CHANGELOG 更新

## Measured

2026-11-09（UTC+8），Windows 參考機器。只用假的引擎與假的供應商，沒有對真的 API 發請求，沒有在本機跑真書的解析；M3 收尾（034）會用 `tome run` 跑公有領域的文本與規則書一章。

**本機單一變異的小工具**（不是 Stryker）：用 `@babel/parser` 對改過的行產生變異，一次套一個到複本，只跑 `tests/cli/tome-run.test.ts`。各步匯出的本體與翻譯拆出的 `translateLocked`、`translateInBatchesLocked` 只是搬動，原本的測試照樣涵蓋；`request.ts` 新的 `saveSettings` 只有呼叫，沒有產生變異。

| 檔案 | 變異 | 殺掉 | 逾時 | 存活 | 等價或拿掉 |
| :--- | ---: | ---: | ---: | ---: | ---: |
| `src/core/pipeline.ts` | 109 | 100 | 0 | 0 | 9 |
| `src/cli/run.ts`（`tome run` 指令） | 25 | 25 | 0 | 0 | 0 |

第一輪存活 23 個，補了測試後殺掉 14 個：待審的卡數（proposed 與 failed 才算）、確認估價那一步失敗（書的模式壞掉）、沒有金鑰時那一步的資料、遭拒答的單位不再送（`retryFailed` 是 false）、`--chapter-level`、沒給書名、沒解析過的書真的跑引擎（進度、組裝）。

等價或拿掉的 9 個：7 個是步驟名稱的陣列，只用來定型別，改成型別別名後拿掉了；2 個是 Pass 0 那一步有 `fail` 時停下的分支，目前到不了：規則包讀不全時探測就先失敗，停在解析（`scan-terms` 沒加 `--confirm` 時只有規則包會讓它失敗，沒設 `scanner_model` 是丟錯）。分支留著，之後 Pass 0 有別的失敗也照「沒做完就停」。

**PR 76 審查後的修改**：加 `run` 那兩行時，`--help` 的 `probe <名稱>` 少了一個空白，說明比其他行左移一格；補回去，並加一個測試：全形字算兩格時，指令與選項兩段的說明各自對齊在同一欄（換回 b818f05 的訊息檔，這個測試失敗）。

本機結果（審查後）：`npm test` 79 個測試檔通過、1 個跳過，2,085 個測試通過、5 個跳過；`npm run spec` 400 個斷言都成立，也都看過失敗；`npm run typecheck` 通過；`npm run licenses` 299 個套件沒有違規。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| `tome run`（`tests/cli/tome-run.test.ts`） | main（03d55a2）沒有 `tome run`，回 `cli.unknown_command`；上面的單一變異都殺掉或列為等價 |
| 範圍寫進 `book.yaml` | 第一版只在確認估價那一步寫，停在 Pass 0 時 `chapters` 沒存，這個測試先失敗，改成解析之後就寫（細節第 8 項） |
| 個資閘門擋下、有單位沒翻成 | 「`translate.done` 以外的 `fail` 就停」那一行的單一變異都被殺掉：擋下時往下輸出、或遭拒答時不輸出，測試都會失敗（細節第 1 項，維護者選「停在翻譯」） |
