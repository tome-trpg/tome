---
status: archived
date: 2026-11-12
type: feature
wave: 47
affectedFiles:
  - CHANGELOG.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - src/cli/messages/zh-TW.json
  - src/core/findings.ts
  - src/core/mask.ts
  - src/core/rename.ts
  - src/core/report.ts
  - src/core/verify.ts
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
integrity: sha256-e88e83f21409e3c37d158fe0074b75be2ba01a57d0c7843a3e3337b720295d35
---

<!-- spec-brief:banner -->
> **Archived 2026-11-12.**
> Merged in pull request [#82](https://github.com/tome-trpg/tome/pull/82).
> Recorded at commit `4f7735c`: 18 files changed, +405 −24.
> The body below describes the tree before execution and is not maintained.
<!-- /spec-brief:banner -->

# 043 — 譯名的驗證用最長比對

## Intent

這個回合結束時，譯名的命中改成最長比對：一處原文只算一張卡，跟 `keep_source` 的遮蔽用同一條規則（`mask.ts` 的 `chooseRanges`：起點較前的優先、同起點取較長的、互不重疊）。長的鎖定卡包住短的時，驗證不再要求短詞的譯名也出現，`<glossary>` 與 `<recent>` 不再同時給長、短兩張卡，翻譯記憶的鍵、S-16 與交付報告也用同一個比對。

M3 的規則書有 139 個 `FAILED_QA`，量測顯示其中 86 個只是這個誤判，修好後 `tome verify` 不花 token 就會轉成完成；重送花費約六成也來自它（共用筆記 `brief-043-questions.md` 事實 B）。剩下真的 `term_missing` 照舊重送 3 次，上限與提示都不改，修好後先量再決定。

回合開頭另外處理 042 留下的兩件事：`mutation-lines` 跑出的 3 個存活變異只用測試補；估價區間寬度是 0 時，`tome report` 不再印「在估價區間內（-% 處）」。

細節由維護者在 2026-11-12 全部照建議選定（`brief-043-questions.md` 的 7 項），寫成 ADR-0133。

## Negative Scope

- 不改譯文那一邊的比對：照樣逐字。
- 不改重送的上限（3 次）、不改提示（`prompts/**`）、不改重送的組法（請求不跨章）、不加遷移。
- 不做「送出前把鎖定譯名換成標記」；不改審定的門檻（047）。
- 不讀書本內容；量測只用工作區的唯讀暫存複本、只印數字，量完刪掉。測試只用合成的文字。
- 本機不跑變異測試：`verify.ts`、`mask.ts` 改完在回合分支上 dispatch `mutation.yml`，其他改過的行用 `mutation-lines`。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。實作時冒出的新細節寫進共用筆記 `brief-043-details.md`。
- 寫給維護者的理由要先對照程式與量測的原文。
- 核心不放給人看的文字：訊息放訊息檔，核心只回代碼與數字（ADR-0082 第 9 項）。
- 主張要帶成熟度，沒量測的不能寫成已實作（ADR-0068）；文件只寫數字，不寫書名與內文（ADR-0059）。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠、變異測試跑完就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過

  2191 個測試通過，441 個斷言都成立，299 個套件、0 違規。
- [x] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗

  把新的測試放到 `5e0b527`（改命中之前）的複本上跑，11 個失敗。護欄有兩個：「短詞另外單獨出現時照樣要求」與「不適用的角色不參加比對」，在舊程式上也會過，改壞最長比對時會失敗。回合開頭補的兩個「不給進度回呼」也是護欄，殺不殺得掉 042 的存活變異由 `mutation-lines` 確認。
- [x] `mutation.yml` 在回合分支上跑過，`mutation-lines` 跑過其他改過的行，存活的補上測試或說明是等價變異

  `mutation.yml` run 43188869711：驗證 94.90、遮蔽還原 91.95，存活清單跟 041 時相同，`hitTerms` 新寫的行全部殺掉。`mutation-lines` run 43188875208：60 個殺掉 55，042 留下的三處都殺掉；`rename.ts:141` 存活，補測試後重跑（run 43195435876）殺掉；其餘 4 個是等價或走不到，理由寫在 ADR-0133 第 8 項。
- [x] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑

  PR 82 的每次推送（`2dfef7b`、`d2d7289`、`78b53ea`）都是 attempt 1 通過，兩個 OS 都是；`78b53ea` 是 run 43196363165（specs）、43196363161（test）。
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示

  `78b53ea` 的 `CodeQL` 是 success、0 個 annotation；三個 Analyze 各一個 annotation，都是原本就有的 ubuntu-latest 說明。
- [x] 訊息、`--json` 與紀錄都不含書本文字

  新的代碼 `report.estimate_unknown` 只帶金額；命中的改動不碰訊息。量測只印數字。

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0133（`amends: [ADR-0102, ADR-0120]`），白皮書 §9 的索引加一列
- [x] `hitTerms` 照 `chooseRanges` 做最長比對，`keep_source` 的卡參加比對但不回傳；`chooseRanges` 匯出給兩邊共用
- [x] 驗證、`<glossary>`、`<recent>`、翻譯記憶的鍵跟著用最長比對
- [x] S-16（`rename.ts`）與交付報告的 `unusedOf`、`oldNamesOf` 改成先用整份詞條算命中、再看那張卡在不在

  報告拿不到規則包的詞條，只比實體卡（ADR-0133 第 2 項與 Open Questions）。
- [x] 回合開頭：`batch.ts`、`scan.ts` 不給進度回呼也跑得完的測試；估價區間寬度 0 時用不帶百分比的說法
- [x] 白皮書與 CHANGELOG 更新，寫明翻譯記憶的鍵會變、已翻的書跑一次 `tome verify`
- [x] PR 說明寫清楚合併後維護者的步驟，每個指令一個區塊

  PR 82 的「合併之後（維護者）」：`verify book1`、`report book1`、要的話 `translate book1 --retry-failed`、`assemble book1`，各一個區塊。
