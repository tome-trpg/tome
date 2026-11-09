---
status: active
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
---

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

- [ ] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [ ] 新的測試先在舊行為上失敗過
- [ ] 本機單一變異的小工具對改過的行跑過一輪，存活的補上測試或說明是等價變異
- [ ] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑
- [ ] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [ ] ADR、白皮書、PR 與共用筆記都不含書本文字與商業書的書名

## Acceptance Criteria

- [ ] 正負號緊接數字時，跟漢字之間不留空白，所有譯文都適用
- [ ] 維護者跑完兩本書，數字寫進共用筆記 `m3-closeout-facts.md`
- [ ] ADR-0129 記下兩本書的數字、M3 結束，以及 43 項 Open Questions 的分類；已經定案的在原 ADR 打勾
- [ ] 白皮書的路線圖與 CHANGELOG 更新
