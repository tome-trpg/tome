---
status: active
date: 2026-11-09
type: feature
wave: 41
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

# 040 — 人工譯文的檢查

## Intent

這個回合結束時，人工譯文跟模型譯文用同一套零 token 檢查（數字、鎖定譯名、字體、長度、用語、代名詞、機翻腔，加上遮蔽的原文還在），**只報告**：不改狀態、不重送、不擋 `tome assemble`。`tome sync` 查新回收的人工譯文，`tome verify` 查全部人工譯文；問題記在同一張 `issue` 表、全部是 `report` 等級，交付報告另開「人工譯文的檢查」一節，`tome report` 多一個數字。交付報告也列出「內含舊譯名的人工譯文」：產生報告時用實體卡的 `previous_target` 比，只認得最近一次改名。

細節由維護者在 2026-11-09 選定（共用筆記 `brief-040-questions.md`：第 2 項跑、只報告，第 4 項同表、報告另開一節，第 7 項用 `previous_target`，其餘照建議；`brief-040-details.md` 的 8 項全部照建議，包括程式放 `verify.ts`，因為放 `human.ts` 會循環匯入，前例是 ADR-0115 第 9 項），寫成 ADR-0126。

## Negative Scope

- 不自動替換人工譯文裡的舊譯名（ADR-0081 第 6 項），不加丟掉人工譯文的指令，不做 `tome run`（032）。
- 人工譯文的問題不改單位的狀態、不重送、不改結束碼、不擋輸出。
- 不加遷移、不加表；不改提示、語言設定檔、schema；`state.ts`、`memory.ts`、`mask.ts` 不動。
- 測試只用合成的文字；不量真書（book1 沒有人工譯文）。較大的性質測試次數只在 CI 跑。
- 不寫入維護者的工作區，不對真的 API 發請求。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。實作時冒出的新細節寫進共用筆記 `brief-040-details.md`。
- 寫給維護者的理由要先對照程式與 ADR 原文。
- 核心不放給人看的文字：訊息與報告的固定文字放訊息檔。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [x] 本機單一變異的小工具對改過的行跑過一輪（含 `verify.ts`），存活的補上測試或說明是等價變異
- [x] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] 訊息、`--json` 與紀錄都不含書本文字

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0126（`amends: [ADR-0113, ADR-0125]`）
- [x] 人工譯文跑零 token 檢查，只記 `report` 等級，不改狀態、不重送、不改結束碼
- [x] `tome sync` 查新回收的人工譯文，`tome verify` 查全部人工譯文，套回人工譯文時不清掉問題
- [x] 交付報告有「人工譯文的檢查」與「內含舊譯名的人工譯文」，`tome report` 多兩個數字
- [x] 白皮書與 CHANGELOG 更新

## Measured

2026-11-09（UTC+8），Windows 參考機器。這個回合沒有量真書：book1 沒有人工譯文，測試只用合成的文字。性質測試（人工譯文的檢查只有 `report` 等級）照測試檔的次數跑，本機沒有加大次數。

**本機單一變異的小工具**（不是 Stryker）：用 `@babel/parser` 對改過的行產生變異，一次套一個到複本，只跑對應的測試檔。`verify.ts` 拆成兩批：比文字的檢查用核心的測試，`tome verify` 的流程用 CLI 的測試。`human.ts` 只拿掉一行，沒有產生變異；`store.ts` 沒動。

| 檔案 | 測試檔 | 變異 | 殺掉 | 逾時 | 存活 | 等價 |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: |
| `src/core/verify.ts`（比文字的檢查、人工譯文的檢查、`checkHumans`） | `tests/core/verify.test.ts`、`tests/core/human.test.ts` | 45 | 44 | 0 | 0 | 1 |
| `src/core/verify.ts`（`tome verify` 查人工譯文） | `tests/cli/sync.test.ts`、`tests/cli/verify.test.ts` | 35 | 35 | 0 | 0 | 0 |
| `src/core/report.ts`（兩節、舊譯名、數字） | `tests/core/report.test.ts` | 119 | 116 | 0 | 0 | 3 |
| `src/core/sync.ts`（`tome sync` 查這次存的） | `tests/cli/sync.test.ts` | 19 | 17 | 0 | 0 | 2 |

第一輪存活 26 個，補了測試後殺掉 20 個：遮蔽內容在開頭、兩個都找不到；平常會重送的四個代碼進「人工譯文的檢查」；舊譯名在較長譯名的結尾、沒命中這張卡、別的卡目前就叫這個名字、還沒鎖定的卡的譯名、上一個譯名就是目前的譯名、有上一個譯名但沒有人工譯文用它；`verify.nothing`、`verify.done`、`human.flagged` 的等級與只有模型譯文時的發現。

等價的 6 個：

* `verify.ts` 的 1 個：遮蔽內容不見的問題裡的 `'report'`，最後一律換成 `report` 等級。
* `report.ts` 的 3 個：兩個是一定有譯文的單位的後備值（`?? ''`）；舊譯名那裡的 `card.target === null` 跟它後面的條件換成「而且」，命中卡的詞條存在時譯名一定不是空的，沒有上一個譯名時 `stale` 也不成立。
* `sync.ts` 的 2 個：沒有存人工譯文時的 `{ context: null, findings: [] }` 換成空物件，`checkHumans` 沒有單位可查，結果一樣；規則包的發現只在讀不全時放進結果，換成一律放進去也一樣，因為讀得全時 `loadBookPack` 沒有發現。

**PR 75 審查後的修改**：(1) 列進「內含舊譯名的人工譯文」的單位，`tome verify` 之後會記成 `term_missing`，在「人工譯文的檢查」又列一次；產生報告時拿掉同一張卡目前的譯名的那一筆，`human_checks` 跟著少算。(2) 遮蔽內容照順序拿第一個找到的，`1d6` 會切進 `11d6`，造成假的「找不到」與多出的數字；改成長的先拿，一樣長的照原本的順序。新的測試換回 23c4748 的 `report.ts` 或 `verify.ts` 都失敗。改過的行另跑單一變異：`verify.ts` 3 個全殺掉；`report.ts` 31 個殺掉 30 個，等價的 1 個是 `term_missing` 沒有 `target` 時的後備值 `?? ''`，鎖定卡的譯名不會是空的，換成別的字一樣對不上。

本機結果（審查後）：`npm test` 78 個測試檔通過、1 個跳過，2,073 個測試通過、5 個跳過；`npm run spec` 393 個斷言都成立，也都看過失敗；`npm run typecheck` 通過；`npm run licenses` 299 個套件沒有違規。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| 人工譯文的檢查（`tests/core/verify.test.ts`、`tests/core/human.test.ts`） | 舊的 `verify.ts` 沒有 `humanProblems`、`checkHumans`；換回 main（c74ec86）的 `human.ts`，「套回時不碰問題」失敗 |
| 交付報告（`tests/core/report.test.ts`） | 換回 main 的 `report.ts` 與訊息檔，數字與四個新的測試失敗 |
| `tome sync` 與 `tome verify`（`tests/cli/sync.test.ts`、`tests/cli/verify.test.ts`） | 換回 main 的 `sync.ts`，三個新的測試失敗；上面的單一變異都殺掉或列為等價 |
