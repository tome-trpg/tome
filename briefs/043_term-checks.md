---
status: active
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
---

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

- [ ] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [ ] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [ ] `mutation.yml` 在回合分支上跑過，`mutation-lines` 跑過其他改過的行，存活的補上測試或說明是等價變異
- [ ] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑
- [ ] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [ ] 訊息、`--json` 與紀錄都不含書本文字

## Acceptance Criteria

- [ ] 維護者的決定寫成 ADR-0133（`amends: [ADR-0102, ADR-0120]`），白皮書 §9 的索引加一列
- [ ] `hitTerms` 照 `chooseRanges` 做最長比對，`keep_source` 的卡參加比對但不回傳；`chooseRanges` 匯出給兩邊共用
- [ ] 驗證、`<glossary>`、`<recent>`、翻譯記憶的鍵跟著用最長比對
- [ ] S-16（`rename.ts`）與交付報告的 `unusedOf`、`oldNamesOf` 改成先用整份詞條算命中、再看那張卡在不在
- [ ] 回合開頭：`batch.ts`、`scan.ts` 不給進度回呼也跑得完的測試；估價區間寬度 0 時用不帶百分比的說法
- [ ] 白皮書與 CHANGELOG 更新，寫明翻譯記憶的鍵會變、已翻的書跑一次 `tome verify`
- [ ] PR 說明寫清楚合併後維護者的步驟，每個指令一個區塊
