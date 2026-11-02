---
status: draft
date: 2026-11-02
type: feature
wave: 19
affectedFiles:
  - CHANGELOG.md
  - README.en.md
  - README.md
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
  - systems/**
---

# 019 — Batch 與續跑

## Intent

這個回合結束時，翻譯流程能用批次跑完一本書：相鄰章節併到字元上限組成一批，每批送出前檢查預算與個資閘門，先寫意圖紀錄再送出，輪詢到結束後收回結果、驗證、刪除遠端資料。被拒、截斷、驗證失敗與出錯的請求由 TOME 自己放進下一批重送，規則跟即時模式相同（ADR-0099 第 6 項、ADR-0104 第 13 項）。中斷後再執行一次就從 `book.db` 接著做：已經送出的批次認回來收結果，不重送已經付費的請求，當機注入測試確認已驗證的單位不重付（Q-7）。`tome status` 在本機顯示進度與花費（ADR-0099 第 2 項）。呼叫 Batches API 的轉接層要等 brief 022 的 SDK，這個回合比照 018 的 `LLMProvider` 定 Batch 的介面，只用假供應商寫完、測完，批次流程在 022 之前沒有對真的 API 跑過。

細節等維護者決定，問題列在共用筆記 `brief-019-questions.md`，決定後寫進新的 ADR，再把這份 brief 改成 `active`。

## Negative Scope

- 不加 `@anthropic-ai/sdk`，ADR-0099 第 14 項的 `@assert-absence` 不動，022 才改。
- 不寫呼叫 Batches API 的轉接層，022 才有。不打真的 API，CI 也不放金鑰。
- 不用伺服器端回退，不做跨供應商回退。
- 不開提示快取。
- 不做 `tome report` 與交付報告，M3 才有。
- 不處理 ADR-0106 的 Open Question（指紋輸入沒有測試抓漏列），除非維護者決定放進來。
- 不放商業書的內容，範例與測試都用合成文字。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。放進 PR 說明不算問，實作時冒出的新決定也照樣寫進共用筆記。
- 寫給維護者的理由要先對照程式與 ADR 原文。
- 其他程式不得自己連網（ADR-0039）。請求都經過 `guardedFetch`，個資閘門掃描序列化後的完整請求。
- 成熟度照實寫：批次流程只跑過假供應商，H-17 仍是假說（ADR-0068）。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，CI 全綠就回報 PR 連結與 attempt 1 的結果。

## Invariants

- [ ] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [ ] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [ ] `specs`、`test` 在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [ ] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [ ] 訊息、紀錄與 `--json` 不含書本文字，也不列出命中的個資
- [ ] 金鑰不進紀錄、訊息與帳本
- [ ] 這個回合沒有連到本機以外的主機，有測試把關

## Acceptance Criteria

- [ ] 維護者對 `brief-019-questions.md` 的決定寫成 ADR，`amends` 指向被修改的項目
- [ ] Batch 的介面定好，假供應商模擬還在處理、部分成功、單筆錯誤、單筆被拒、截斷、過期、取消、結果順序跟送出順序不同
- [ ] 相鄰章節併到字元上限，過大才拆，每批送出前檢查預算
- [ ] 送出前先寫意圖紀錄，取得遠端 ID 後才更新，送出與記下遠端 ID 之間中斷時，續跑能認回批次或確認沒有送出
- [ ] 個資閘門掃描整批序列化後的請求，命中就整批不送並停下
- [ ] 拒答、截斷、驗證失敗由 TOME 放進下一批重送，帳本用批次價格，被拒與截斷照樣記帳
- [ ] 結果收回並驗證後呼叫刪除，刪除失敗下次再試
- [ ] 當機注入：在流程的每一步中斷再續跑，已驗證的單位不重付（Q-7）
- [ ] `tome status` 在本機顯示進度與花費，不連網
- [ ] 白皮書的成熟度標籤、附錄 B、CHANGELOG 更新，ADR 對應項目的斷言補進「驗證」
