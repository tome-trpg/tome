---
status: active
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

這個回合結束時，翻譯流程能用批次跑完一本書：相鄰章節併到字元上限組成一批，每批送出前檢查預算與個資閘門，先寫意圖紀錄再送出，輪詢到結束後收回結果、驗證、刪除遠端資料。被拒、截斷、驗證失敗與出錯的請求由 TOME 自己放進下一批重送，規則跟即時模式相同（ADR-0099 第 6 項、ADR-0104 第 13 項）。中斷後再執行一次就從 `book.db` 接著做：已經送出的批次認回來收結果，不重送已經付費的請求，當機注入測試確認已驗證的單位不重付（Q-7）。`tome status` 在本機顯示進度與花費（ADR-0099 第 2 項），`tome batch status|collect|cancel` 查詢、收回、取消批次。呼叫 Batches API 的轉接層要等 brief 022 的 SDK，這個回合比照 018 的 `LLMProvider` 定 Batch 的介面，只用假供應商寫完、測完，批次流程在 022 之前沒有對真的 API 跑過，使用者看到的仍是 `translate.not_ready`。

細節由維護者在 2026-11-02 決定，寫在 ADR-0107：一批 100,000 字元原文、一次一批、三個 `tome batch` 指令都做，其他照共用筆記 `brief-019-questions.md` 的建議。字元上限、輪詢間隔與時鐘差是提案，H-17 是假說。審查時維護者另外決定，建立批次時收到 5xx 不重試，跟沒有收到回應一樣留給下次執行去認，寫在 ADR-0108。

## Negative Scope

- 不加 `@anthropic-ai/sdk`，ADR-0099 第 14 項的 `@assert-absence` 不動，022 才改。
- 不寫呼叫 Batches API 的轉接層，022 才有。不打真的 API，CI 也不放金鑰。
- 不用伺服器端回退，不做跨供應商回退。
- 不開提示快取。
- 不做 `tome report` 與交付報告，M3 才有。
- 不處理 ADR-0106 的 Open Question（指紋輸入沒有測試抓漏列）。
- 不併發送出多批，不把對半拆的狀態存進 `book.db`，不依處理時間調整輪詢間隔（ADR-0107）。
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

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [x] `specs`、`test` 在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] 訊息、紀錄與 `--json` 不含書本文字，也不列出命中的個資
- [x] 金鑰不進紀錄、訊息與帳本
- [x] 這個回合沒有連到本機以外的主機，有測試把關

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0107，`amends` 指向被修改的項目
- [x] Batch 的介面定好，假供應商模擬還在處理、部分成功、單筆錯誤、單筆被拒、截斷、過期、取消、結果順序跟送出順序不同
- [x] 相鄰章節併到字元上限，過大才拆，每批送出前檢查預算
- [x] 送出前先寫意圖紀錄，取得遠端 ID 後才更新，送出與記下遠端 ID 之間中斷時，續跑能認回批次或確認沒有送出
- [x] 個資閘門掃描整批序列化後的請求，命中就整批不送並停下
- [x] 拒答、截斷、驗證失敗由 TOME 放進下一批重送，帳本用批次價格，被拒與截斷照樣記帳
- [x] 結果收回並驗證後呼叫刪除，刪除失敗下次再試
- [x] 當機注入：在流程的每一步中斷再續跑，已驗證的單位不重付（Q-7）
- [x] 有沒收回的批次時，`--realtime` 停下回報，同一段不付兩次
- [x] `tome status` 在本機顯示進度與花費，不連網
- [x] `tome batch status|collect|cancel` 查詢、收回、取消這本書沒收回的批次
- [x] 白皮書的成熟度標籤、附錄 B、CHANGELOG 更新，ADR 對應項目的斷言補進「驗證」

## Measured

2026-11-02，Windows 參考機器。沒有連到本機以外的主機，沒有用到金鑰。批次流程只跑過假供應商，沒有對真的 Batches API 發過請求，一批 100,000 字元、輪詢 60 秒、時鐘差 10 分鐘都是提案，H-17 仍是假說。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| `tests/cli/batch.test.ts` | `src/core/batch.ts` 不存在時整個檔案載入失敗 |
| `tests/core/request.test.ts`、`tests/core/llm.test.ts`、`tests/core/ledger.test.ts` 新增的分批、批次結果、重試、帳本只記一次 | 舊程式上 19 個失敗 |
| `tests/core/egress.test.ts` 的批次模型名稱 | 舊程式上 1 個失敗，記成空字串 |
| `tests/cli/crash.test.ts` 的批次模式與 H-17 那一點 | 舊程式上 2 個失敗 |
| `tests/cli/crash.test.ts` 的即時模式 | 舊程式上本來就會過。故意讓續跑把 `RECEIVED` 放回佇列，第 29 次寫入中斷時失敗，再改回來 |
| 帳本同一個請求只記一次 | 拿掉之後批次的當機注入在第 21 次寫入時失敗（同一筆費用記兩次），帳本的測試也失敗，再改回來 |
| 收回時跳過已經套用的請求 | 拿掉之後批次的當機注入在第 24 次寫入時失敗，再改回來 |
| 閘門掃描整批內容 | 舊程式上本來就會過。故意讓建立批次的本文不掃描，1 個失敗，再改回來 |
| `tests/cli/translate.test.ts` 改寫的兩個 `translate.not_ready` | 舊程式上本來就會過，它們擋的是 022 之前對使用者開放 |
| 本機時間加時差、六個數字對應 9 種狀態（細節決定之後加的） | 在第一個 commit `4c162a7` 上 8 個失敗 |
| `tome status` 六個數字加總等於 `total` | 在 `4c162a7` 上本來就會過。故意從 `left` 拿掉 `RECEIVED`、`STALE`，3 個失敗，再改回來 |
| 收回之前，請求中間的單位從計畫消失或文字改了（審查後加的） | 在 `abffed5` 上 2 個失敗：消失時最後一個單位拿到中間單位的譯文，文字改了時指令出錯結束 |
| 建立批次時收到 5xx 不重試，下次執行認回或重送（ADR-0108） | 在 `abffed5` 上 3 個失敗，舊程式原地重試了 5 次 |

當機注入在合成書上即時模式有 39 個中斷點、批次模式有 58 個，每一點中斷後續跑，已驗證或已付費存下的單位都沒有再送出。
