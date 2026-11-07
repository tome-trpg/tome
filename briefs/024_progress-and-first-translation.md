---
status: active
date: 2026-11-07
type: feature
wave: 22
affectedFiles:
  - CHANGELOG.md
  - README.en.md
  - README.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - languages/target/zh-TW.yaml
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
  - languages/source/**
  - package-lock.json
  - package.json
  - prompts/**
  - providers/**
  - schemas/**
  - stryker.config.mjs
  - systems/**
---

# 024 — 長時間指令的進度提示與第一次翻譯的回饋

## Intent

這個回合結束時，跑得久的指令不再長時間沒有輸出：`tome extract` 啟動引擎前先說明、頁的進度依時間回報、引擎很久沒有事件時說它仍在執行、組裝文件前也說一聲；`tome add` 與 `tome probe` 開始探測時說要探測幾頁；`tome translate` 開始時說要送出幾個請求；連到供應商遇到重試時說幾秒後重試。第一次真實翻譯冒出的三個問題也修好：`zh-TW` 的長度下限從 0.3 改成 0.2，估價與翻譯的單位數用同一套說法、寫出不需翻譯的數量，翻譯完成時提示用 `tome preview` 看譯文。進度一律走 stderr，`--json` 不受影響，引擎協定不改。

細節由維護者在 2026-11-07 決定，寫在 ADR-0111：共用筆記 `brief-024-questions.md` 的 11 項，第 5 項改成 0.2，其餘照建議。

## Negative Scope

- 不改 `tome-engine/1` 與 Docling 引擎，不加 `ready` 事件。
- 不處理 `term_suspect` 的誤報，另開回合設計。
- 不處理書籤只取單層與閱讀順序的問題。
- 不在維護者的電腦上跑引擎、真書或任何吃滿 CPU 的量測。
- 不放商業書的內容，範例與測試都用合成文字。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。放進 PR 說明不算問，實作時冒出的新決定也照樣寫進共用筆記。
- 寫給維護者的理由要先對照程式與 ADR 原文。
- 核心不放給人看的文字，訊息照 ADR-0086、ADR-0089。
- 成熟度照實寫：長度下限只有一本書、一個模型的數據（ADR-0068）。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [ ] `specs`、`test`、`mutation` 在 CI 第一次跑就通過，沒有靠重跑
- [ ] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] 進度只走 stderr，`--json` 的 stdout 不變，也不含書本文字

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0111，長度下限的依據與限制寫明，`term_suspect` 的誤報列在 Open Questions
- [x] `tome extract` 啟動引擎前印一行，頁的進度依時間印（第一頁、滿 5 秒、最後一頁），30 秒沒有事件印一行，組裝前印一行
- [x] `tome add`、`tome probe` 開始探測時印要探測幾頁
- [x] `tome translate` 開始時印模式與請求數，重試前印狀態碼、秒數與第幾次
- [x] `zh-TW` 的 `min_length_ratio` 是 0.2，`too_short` 照舊重送
- [x] 估價、翻譯完成與 `tome status` 都寫出不需翻譯的單位數，兩邊對得起來
- [x] 翻譯完成的訊息提示用 `tome preview` 看譯文
- [x] 白皮書 §5.6、§6.4、CHANGELOG 更新，ADR 對應項目的斷言補進「驗證」
- [x] 實作時多出的 7 項細節照實作的做法定案，寫進 ADR-0111：`tome status` 從 `source` 與 `placeholders` 重算、`--json` 加 `kept`、「仍在執行」每秒檢查、沒跑的步驟不印、裝置寫小寫、完成訊息帶書名、`tome provider test` 也印重試（實作時 Manager 同意，共用筆記 `brief-024-details.md`）

## Measured

2026-11-07（UTC），Windows 參考機器。沒有跑引擎、真書或變異測試，進度只跟測試裡的假引擎與假時鐘跑過，重試只跟本機的假供應商跑過。

本機結果：`npm test` 59 個測試檔通過、1 個跳過，1,441 個測試通過、5 個跳過；`npm run spec` 219 個斷言都成立，也都看過失敗；`npm run licenses` 299 個套件沒有違規。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| 長度下限 0.2（`tests/core/verify.test.ts`） | `min_length_ratio` 改回 0.3，2 個失敗：邊界的例子與比例 0.27 的自然譯文都被判成 `too_short`，再改回來 |
| 重試前印一行（`translate`、`batch`、`provider` 的 CLI 測試） | 拿掉 `withRetry` 的通知，4 個失敗：即時請求、批次建立、`tome batch status`、`tome provider test`，再改回來 |
| 組裝前印一行（`tests/cli/engine.test.ts`） | 拿掉 `onAssemble` 的呼叫，1 個失敗，再改回來 |
| 最後一頁一定印、30 秒沒有事件印一行（`tests/cli/progress.test.ts`） | 拿掉最後一頁的條件、把等待改成 60 秒，3 個失敗，再改回來 |
| `tome status` 的不需翻譯數量（`tests/cli/batch.test.ts`） | 把重算的結果改成 0，1 個失敗，再改回來 |
| 估價、試算、翻譯完成的不需翻譯數量與 `tome preview` 的提示 | 舊程式的 `data` 沒有 `kept`，訊息也沒有這幾句 |
| 啟動引擎、探測與開始翻譯的那一行 | 舊程式不印這幾行；舊的頁進度每 10 頁才印，3 頁的書只印最後一頁 |
| `needsLlm` 跟原本的判斷相同（`tests/core/mask.test.ts`） | fast-check 比對新舊兩種判斷，舊程式沒有 `needsLlm`，整個測試載入失敗 |
