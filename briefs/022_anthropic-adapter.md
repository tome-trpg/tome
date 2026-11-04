---
status: active
date: 2026-11-03
type: feature
wave: 20
affectedFiles:
  - CHANGELOG.md
  - README.en.md
  - README.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - package-lock.json
  - package.json
  - src/**
  - tests/**
  - tools/check-licenses.ts
  - vitest.config.ts
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
  - prompts/**
  - providers/**
  - schemas/**
  - systems/**
---

# 022 — Anthropic 轉接層

## Intent

這個回合結束時，TOME 能用使用者自己的金鑰呼叫 Anthropic：`@anthropic-ai/sdk` 釘 0.137.0（ADR-0099 第 14 項），轉接層 `src/core/egress/anthropic.ts` 實作 018 與 019 定的 `LLMProvider`，即時請求與 Batches API 都走同一個轉接層。SDK 的重試關掉（`maxRetries: 0`），金鑰與端點明確傳入，請求都經過注入的 `guardedFetch`，個資閘門與白名單的錯誤從 SDK 的包裝裡解開再丟出，`translate.blocked` 才走得到。`tome translate`、`--realtime`、`--retry-failed` 與 `tome batch` 不再回 `translate.not_ready`，`tome --help` 列出這些指令（ADR-0104 第 45 項、ADR-0107 第 1 項）。`tome provider test` 確認金鑰可用與模型資料（ADR-0103 第 6 項），`tests/contract/` 沒有金鑰就跳過。`fast-sha256` 1.3.0 開綁版本的窄例外（ADR-0099 第 15 項）。即時模式收到 5xx 是否計費，查官方文件後寫進這個回合的 ADR。這個回合不對真的 API 發請求，轉接層只跟本機的假供應商跑過，第一次真實翻譯由維護者在合併之後執行。

細節由維護者在 2026-11-03 決定，寫在 ADR-0109：共用筆記 `brief-022-questions.md` 的 14 項全部照建議，`brief-022-details.md` 的 9 項除了第 6 項（回應本文讀到一半斷線）改成當成沒有收到回應，其餘照建議。實作時另外決定，刪除遠端資料收到 404 就當成已經刪除。

## Negative Scope

- 不對真的 API 發請求，CI 不放金鑰。`tests/contract/` 寫好但這個回合不執行。
- 不升 SDK 到 1.x，等 major 的 30 天冷卻期（ADR-0077、ADR-0099 第 14 項）。
- 不用伺服器端回退，不做跨供應商回退，不開提示快取。
- 不改重試的次數與秒數，即時模式 5xx 的計費查不到就列成 Open Question（維護者 2026-11-02 的決定）。
- 不做 `tome report`、交付報告與 vault，M3 才有。
- 不處理 020 的變異測試。
- 不放商業書的內容，範例與測試都用合成文字。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。放進 PR 說明不算問，實作時冒出的新決定也照樣寫進共用筆記。
- 寫給維護者的理由要先對照程式、SDK 原始碼與 ADR 原文。
- SDK 只能在 `src/core/egress/` 匯入（ADR-0039），其他程式不得自己連網。
- 金鑰不進紀錄、訊息、帳本與錯誤輸出（ADR-0034），紀錄檔不含書本文字（ADR-0059）。
- `fast-sha256` 以外的授權問題先問，不自己放行。
- 成熟度照實寫：轉接層只跟假供應商跑過，H-17 仍是假說（ADR-0068）。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [x] `specs`、`test` 在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] 訊息、紀錄與 `--json` 不含書本文字，也不列出命中的個資
- [x] 金鑰不進紀錄、訊息、帳本與錯誤輸出
- [x] 這個回合沒有連到本機以外的主機，有測試把關

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0109，`amends` 指向被修改的項目，Open Questions 列出即時模式 5xx 與逾時的計費、`results_url` 的主機與 H-17
- [x] `@anthropic-ai/sdk` 釘 0.137.0，只在 `src/core/egress/` 匯入，ADR-0099 第 14 項的斷言改成檢查版本
- [x] 轉接層實作 `LLMProvider` 的全部方法，`maxRetries: 0`、明確的 `apiKey`、`baseURL`、`timeout`，注入 `guardedFetch`，每個方法都跟本機的假供應商測過
- [x] SDK 包起來的 `EgressBlocked` 與 `egress.denied` 解開再丟出，即時與批次模式都走到 `translate.blocked`
- [x] `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_LOG`、`ANTHROPIC_CUSTOM_HEADERS` 改不了金鑰、端點、API 版本與 beta 功能，有測試把關
- [x] `tome translate`、`--realtime`、`--retry-failed` 與 `tome batch` 接上轉接層，沒有金鑰時回 `key.missing` 且不連網，`translate.not_ready` 拿掉
- [x] `tome --help` 列出翻譯、批次與 `tome provider test`
- [x] `tome provider test` 只用 Models API，對照模型資料，不消耗 token
- [x] `tests/contract/` 沒有金鑰就跳過，不在 `npm test` 裡
- [x] `fast-sha256` 1.3.0 綁版本的窄例外，版本或授權一變就擋下
- [x] 白皮書的成熟度標籤、附錄 B、§8.2、兩份 README 與 CHANGELOG 更新，ADR 對應項目的斷言補進「驗證」
- [x] 回應本文讀到一半斷線當成沒有收到回應，即時模式原地重試，批次再下載一次結果（實作時維護者決定，ADR-0109 第 20 項）
- [x] 刪除遠端資料收到 404 當成已經刪除，寫入 `deleted_at`，之後不再送刪除請求（實作時維護者決定，ADR-0109 第 24 項）

## Measured

2026-11-03（UTC），Windows 參考機器。沒有連到本機以外的主機，沒有用到金鑰，`tests/contract/` 沒有執行。轉接層只跟本機的假供應商跑過，沒有對真的 API 發過請求，H-17、`results_url` 的主機與即時模式 5xx 的計費都還沒確認。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| `tests/core/anthropic.test.ts` | `src/core/egress/anthropic.ts` 不存在時整個檔案載入失敗。`tests/helpers/fake-provider.ts` 匯入它，舊程式上用到假供應商的測試檔也一樣 |
| 解開錯誤、標頭白名單、`authToken: null`、`logLevel: 'off'`、`timeout`、`maxRetries: 0` | 六處一起拿掉，10 個失敗，再改回來 |
| `defaultHeaders` 明確帶金鑰與版本 | 只拿掉它，2 個失敗：環境變數的 `x-api-key` 與 `anthropic-version` 蓋過 TOME 給的，大小寫兩種寫法都是，再改回來 |
| 沒有金鑰回 `key.missing`、`tome provider test` 的 401 與思考參數、`fast-sha256` 的例外 | 故意改壞四處，8 個失敗，再改回來 |
| 本文讀到一半斷線（維護者決定之後加的） | 拿掉處理，4 個失敗：即時模式與批次收回，轉接層與 CLI 各兩個，再改回來 |
| 環境變數加的 `anthropic-beta`（審查 PR 56 後加的） | 拿掉 `defaultHeaders` 的 `'anthropic-beta': null`，2 個失敗：大小寫兩種寫法的 beta 都跟著即時與批次的請求送出，再改回來 |
| 刪除收到 404 當成已經刪除（維護者決定之後加的） | 拿掉處理，1 個失敗：`deleted_at` 沒有寫入，下次執行又送了刪除請求，再改回來。其他狀態碼照舊重試的測試在舊程式上本來就會過 |
| `npm run licenses` | 加進 SDK、開例外之前回報 `fast-sha256@1.3.0: Unlicense (license not allowed)` |
| 改寫的 `translate.not_ready` 測試（`translate`、`batch`、`estimate`） | 舊程式回 `translate.not_ready`，新的期待是 `key.missing` 且不連網 |
| `tome --help` 列出翻譯、批次與 `tome provider test` | 舊的 `usage` 沒有這幾行 |
