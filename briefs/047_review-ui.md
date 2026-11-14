---
status: active
date: 2026-11-13
type: feature
wave: 51
affectedFiles:
  - CHANGELOG.md
  - README.en.md
  - README.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - src/cli/messages.ts
  - src/cli/messages/zh-TW.json
  - src/cli/review/**
  - src/cli/run.ts
  - src/core/entities.ts
  - src/core/extract.ts
  - src/core/findings.ts
  - src/core/glossary.ts
  - src/core/index.ts
  - src/core/pipeline.ts
  - src/core/rename.ts
  - src/core/status.ts
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
  - src/core/egress/**
  - src/core/process.ts
  - src/core/store.ts
  - stryker.config.mjs
  - systems/**
---

# 047 — 審定介面與下一步

## Intent

這個回合結束時，`tome glossary review <書> --web` 在本機開一個審實體卡的網頁：只聽 `127.0.0.1`、埠號由系統挑、每次啟動一個隨機權杖，前景執行、Ctrl+C 結束，經過 `src/core/process.ts` 打開預設瀏覽器。網頁手寫、不加相依，三個分頁照審定檔的三段，可以改欄位、就地驗證、鎖定與拒絕（鎖定記 `decided_by: human`），改已鎖定的譯名時做 S-16，有搜尋、篩選與鍵盤操作；書本文字只在本機連線上傳。YAML 審定檔照舊能用，`book.db` 是唯一的依據：網頁啟動時先讀回 YAML、結束時照 `book.db` 重寫。審定門檻不再把 `gender: none` 與跟類別預設相同的代名詞算成要人審。`tome status` 說下一步，`tome run` 停下時接著要跑的指令帶上這次的 `--trial` 與 `--realtime`。決定寫成 ADR-0138（ADR-0130 第 3 到 6、16 項與 045 實測找到的漏旗標）。M3 收尾審 332 筆改 YAML 花了約 2 小時，這是第一版每個使用者都要過的關卡。

## Negative Scope

* 不加任何相依；網頁不用框架、不用建置步驟。
* 不做校稿、報告、`overrides` 的介面，也不做一次鎖定全部。
* 伺服器不連外：只聽 `127.0.0.1`，不呼叫 `http.request`、`http.get`、`fetch`；`node:http` 只在 `src/cli/review/` 放行。
* 書本文字不寫進瀏覽器的儲存，不進訊息、`--json` 與紀錄。
* 不改 `package.json`、`package-lock.json` 與 workflow；靜態的 CSS 與 JS 放在 `src/cli/review/` 的程式裡，跟程式一起編譯、發佈。
* 不讀 `C:\Repos\tome-books` 的內文；門檻的量測只用 book1 的唯讀暫存複本、只印數字、量完刪掉。
* 不呼叫 LLM API，不花錢。

## Not Empowered

* 介面上的中文字樣在維護者審過之前不 commit。
* `src/core/process.ts`、`src/core/store.ts`、`src/core/egress/**`、提示、供應商設定、schema 與規則包；要改時先停下來問。
* 新相依；要加先問。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊程式上失敗過
- [x] ADR-0039 的斷言改成只對 `src/cli/review/` 放行 `node:http`，並有「只聽 `127.0.0.1`」「不呼叫 `http.request`、`http.get`」的斷言；ADR-0082 的斷言（`src` 的 `.ts` 沒有中文、核心不依賴 CLI、子行程只經過 `process.ts`）照舊成立
- [x] 沒有權杖、`Host` 不對、寫入的 `Origin` 不對的請求都被拒絕；回應有 CSP 與 `Cache-Control: no-store`
- [x] 訊息、`--json` 與紀錄只有數量與編號，沒有書本文字
- [x] 介面上的中文字樣經維護者審過
- [x] `mutation-lines` 跑過改過的行，存活的變異補上測試，或說明為什麼等價
- [x] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示

## Acceptance Criteria

- [x] ADR-0138 寫下維護者的 12 項回答、靜態檔怎麼發佈、book1 的門檻量測，成熟度照 ADR-0068 標
- [x] `tome glossary review <書> --web` 開得起來，`--no-open` 不開瀏覽器，Ctrl+C 結束時照 `book.db` 重寫 YAML 審定檔
- [x] 網頁上鎖定、拒絕、改欄位與 YAML 審定檔的結果相同（同一套驗證、`decided_by: human`、S-16）
- [x] 審定門檻照 ADR-0130 第 6 項，從下一次審定起套用到還在 `proposed` 的卡
- [x] `tome status` 印 `status.next`、`--json` 有 `next`，順序跟 `tome run` 的關卡相同
- [x] `run.stopped` 帶上這次的 `--trial` 與 `--realtime`，`--json` 也有
- [x] 白皮書、README、CHANGELOG 跟著改
