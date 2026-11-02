---
status: archived
date: 2026-11-02
type: feature
wave: 17
affectedFiles:
  - CHANGELOG.md
  - README.en.md
  - README.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - prompts/**
  - providers/**
  - schemas/**
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
  - systems/**
integrity: sha256-061613ab6a2b50950dc94a1917af8396ac6d8387f3145aa9d66fe26277bb777f
---

<!-- spec-brief:banner -->
> **Archived 2026-11-02.**
> Merged in pull request [#49](https://github.com/tome-trpg/tome/pull/49).
> Recorded at commit `23da938`: 40 files changed, +3501 −109.
> The body below describes the tree before execution and is not maintained.
<!-- /spec-brief:banner -->

# 018 — 對外出口與即時模式

## Intent

這個回合結束時，主程式對外的路徑只有 `src/core/egress/` 一條：主機要在白名單內，請求送出前掃描個資，每次送出都留下紀錄。翻譯流程能一個請求一個請求跑完一本書：預算檢查、個資閘門、送出、收回、驗證、翻譯記憶、費用帳本，遇到 429 會退避，遇到拒答會對半拆、再換模型，中斷後能續跑。假供應商讓這些路徑不用金鑰就測得到。`tome preview` 產生原文與譯文對照。SDK 要到 2026-11-03 22:23 UTC 才能加，所以這個回合不接真的 API，轉接層與 `tome provider list`、`tome provider test` 在 brief 022（ADR-0104）。

## Negative Scope

- 不加 `@anthropic-ai/sdk`，不打真的 API，CI 也不放金鑰。
- 不做 Batch，019 才有。
- 不做跨供應商回退，不用伺服器端回退。
- 不開提示快取。
- 不放商業書的內容，範例與測試都用合成文字。

## Not Empowered

- ADR-0099、ADR-0104 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。放進 PR 說明不算問。
- 提示只改維護者審過的那幾句，其他文字不動。
- 其他程式不得自己連網（ADR-0039）。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，CI 全綠就回報 PR 連結與 attempt 1 的結果。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過
- [x] `specs`、`test` 在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] 訊息與 `--json` 不含書本文字，也不列出命中的個資
- [x] 金鑰不進紀錄、訊息與帳本
- [x] 這個回合沒有連到本機以外的主機，有測試把關

## Acceptance Criteria

- [x] 連到端點白名單以外的主機時失敗，有測試
- [x] 個資閘門掃描序列化後的完整請求，命中就不送，單位標成 `BLOCKED`
- [x] 每次送出都留下外送紀錄，只有雜湊、供應商、模型、大小與時間
- [x] 429、5xx 與網路錯誤會退避重試，其他 4xx 不重試
- [x] 拒答依序對半拆、換 `fallback_model`，都不行才是 `REFUSED`，Batch 回 `succeeded` 的情況也算得到
- [x] 回應被截斷時對半拆重送
- [x] 重送附上原因，同組的其他單位當上下文帶上
- [x] 預算超過就停，保留進度
- [x] 估價模式跟實際模式一致，模式進指紋，換模式要重新確認
- [x] 中斷後續跑，已驗證的單位不重付
- [x] `tome preview` 產生對照，`BLOCKED` 的單位不放原文
- [x] 白皮書 §5.7 的拒答計費照官方改，寫明不用伺服器端回退
- [x] 白皮書的成熟度標籤、附錄 B、CHANGELOG 更新，ADR-0099 的斷言補進「驗證」

## Measured

2026-11-02，Windows 參考機器。沒有連到本機以外的主機，沒有用到金鑰。流程只跑過假供應商，沒有對真的 API 發過請求，重試次數與退避秒數都是提案。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| `tests/core/egress.test.ts`、`tests/core/llm.test.ts` | 模組不存在時失敗 |
| `tests/core/request.test.ts` 新增的同組上下文、對半拆、重送原因 | 舊行為上 9 個失敗 |
| `tests/cli/translate.test.ts` | 舊行為上 55 個失敗 |
| `tests/cli/estimate.test.ts` 的 `--realtime` 與閘門 | 舊行為上 5 個失敗 |
| `tome preview`、`pii.too_short`、`fallback_model` 進指紋 | 測試在實作之後才寫，故意改壞程式後 6 個失敗，再改回來 |
| `prompts/feedback.yaml` 進指紋、`tome preview` 只刪自己的檔案 | 改程式之前 2 個失敗 |
| 截斷的回應算進預算、截斷的單位不留在 `RECEIVED` | 程式本來就符合，故意改壞後失敗，再改回來 |
| 個資例外只免除完整蓋住的命中（審查時抓到） | 舊程式上 7 個失敗。例外 `Forged`、清單 `Forged Buyer` 時 `scanText` 回 `[]`，全名會送出去 |
| 規則包進指紋（審查時抓到） | 舊程式上 2 個失敗。只改詞條譯名或角色風格時 `confirmed` 還是 `true` |

護欄測試在舊行為上本來就會過：閘門命中不動單位狀態、尊重 `pii_exceptions`、同組單位不重複出現、`--retry-failed` 只動選定的章節、沒有存回應的 `RECEIVED` 會重送。它們擋的是之後的退化。
