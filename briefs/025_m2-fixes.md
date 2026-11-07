---
status: active
date: 2026-11-08
type: feature
wave: 23
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

# 025 — M2 的修正

## Intent

這個回合結束時，規則書的短格子不再讓請求被截斷：`max_tokens` 除了依原文字元預估，還加上每個單位的額度，每個請求最多 40 個單位，同一組照舊不拆。回覆的 `stop_reason` 與請求的 `max_tokens` 存進 `book.db` 的帳本，之後分得出截斷與漏段。`tome translate`、`tome batch collect` 完成的訊息與 `tome status` 改成範圍內的數字，跟估價對得起來，範圍外沒完成的單位另印一行，不再被算成「尚未完成」。指令收到多餘的參數時說清楚收到幾個、只接受幾個，並提醒路徑有空格要加引號，不回顯參數的值。白皮書過時的文字一起改。

M2 的重送其實是 `max_tokens` 截斷：維護者 `book.db` 的帳本裡，10 個請求的輸出 token 剛好等於重算的 `max_tokens`，回覆裡沒有段落（共用筆記 `brief-025-questions.md`）。細節由維護者在 2026-11-08 照建議選定，寫成 ADR-0114。

## Negative Scope

- 不改估價的比例、`BATCH_CHARS`、重試的次數與退避。
- `tome status` 與報告不顯示 `stop_reason` 的統計，只存下來。
- 不處理 `too_short`、`script_mixed` 的原因、`term_suspect` 的誤報、平的書籤清單。
- `cli.bad_args` 的其他用法（選項缺值、`--dry-run` 配 `--retry-failed`）照舊。
- 不在維護者的電腦上重翻規則書，修正只跟假供應商跑；不再讀維護者的 `book.db`。
- 不放商業書的內容，範例與測試都用合成文字。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。放進 PR 說明不算問，實作時冒出的新細節寫進共用筆記 `brief-025-details.md`。
- 寫給維護者的理由要先對照程式與 ADR 原文。
- 核心不放給人看的文字，訊息照 ADR-0086、ADR-0089。
- 成熟度照實寫：截斷的判定從帳本推算，一本規則書、一篇小說、一個模型、批次（ADR-0068）。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [x] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑

  `f836555` 與 `40b4cd6` 的 `specs`、`test` 在 Windows 與 Ubuntu 都是第一次跑就通過。這個 PR 不會觸發 `engine` 與 `mutation`。
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示

  兩個 commit 的 `CodeQL` 都是 success、0 個 annotation。三個 `Analyze` 工作各有 1 個 notice，是 `ubuntu-latest` 要換成 Ubuntu 26 的執行環境通知，不是程式掃描的警示。
- [x] 訊息、`--json` 與帳本都不含書本文字，多餘參數的值不回顯

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0114，寫明它推翻 ADR-0112「無法確定是截斷還是漏段」，ADR-0112 的 Open Question 1 由它結案
- [x] `book.db` 遷移到第 7 版，`ledger` 多了 `stop_reason` 與 `max_tokens`，即時與批次都寫入
- [x] `max_tokens` 加上每個單位 16 token 的額度，估價不變
- [x] 每個請求最多 40 個單位，同一組超過時自成一個請求，重送也一樣
- [x] 完成訊息與 `tome status` 是範圍內的數字，範圍外沒完成的另印 `scope.outside`，`--json` 有對應的欄位
- [x] 多餘參數回 `cli.extra_arguments` 或 `cli.no_arguments`，不回顯值
- [x] 白皮書 §5.6、§5.7、§6.3、§6.4、§8.1 與 CHANGELOG 更新，ADR-0114 的斷言補進「驗證」
- [x] 實作時多出的 8 項細節寫進共用筆記 `brief-025-details.md` 先問 Manager，也寫進 ADR-0114：批次收回時重算 `max_tokens`、進度也是範圍內、範圍外卡住的單位不讓翻譯回 1、`scope.outside` 的字句、`tome status` 遇到對不上的範圍、名稱、`scope.chapters`、`{command}` 的寫法

## Measured

2026-11-08（UTC），Windows 參考機器。沒有跑引擎、真書或變異測試，修正只跟本機的假供應商跑過。截斷的分析唯讀維護者的兩個 `book.db`，腳本只印數字，數字寫在 ADR-0114 的脈絡。

本機結果：`npm test` 59 個測試檔通過、1 個跳過，1,469 個測試通過、5 個跳過；`npm run spec` 235 個斷言都成立，也都看過失敗；`npm run licenses` 299 個套件沒有違規。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| 每個單位 16 token 的額度（`tests/core/request.test.ts`） | `UNIT_OUTPUT_TOKENS` 改成 0，2 個失敗：40 個短格子的 `max_tokens` 掉回 1,024 的下限，3,000 字元的例子少了 16，再改回來 |
| 每個請求最多 40 個單位（`tests/core/request.test.ts`） | 單位數的條件改成永遠不成立，4 個失敗：41 個單位、整組移到下一個請求、超過 40 的一組、重送，再改回來 |
| 帳本存 `stop_reason`（`translate`、`batch` 的 CLI 測試） | `charge` 改存 NULL，3 個失敗：即時的完整回覆與截斷、批次的截斷，再改回來 |
| 批次單位不全時存 NULL（`tests/cli/batch.test.ts`） | 改成一律重算，中間有單位離開計畫的那個測試失敗，再改回來 |
| 範圍內的數字（`tests/cli/translate.test.ts`） | 計數改成每個單位都在範圍內，3 個失敗：範圍外另印一行、範圍外的分隔線、範圍外舊的拒答，再改回來 |
| `tome status` 的範圍（`tests/cli/batch.test.ts`） | 範圍的判定改成一律照整本書，範圍內的測試失敗；`document.json` 不見時改成丟出錯誤，那個測試失敗，再改回來 |
| 多餘參數的訊息（`tests/cli/run.test.ts`） | 改回 `cli.bad_args`，5 個失敗，含不回顯金鑰的測試，再改回來 |
| 帳本的遷移、`stopReason` 的原值（`tests/core/store.test.ts`、`tests/core/llm.test.ts`） | 舊程式沒有這兩欄，也沒有 `stopReason` |
