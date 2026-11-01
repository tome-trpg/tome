---
status: active
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
---

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

- [ ] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [ ] 新的測試先在舊行為上失敗過
- [ ] `specs`、`test` 在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [ ] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [ ] 訊息與 `--json` 不含書本文字，也不列出命中的個資
- [ ] 金鑰不進紀錄、訊息與帳本
- [ ] 這個回合沒有連到本機以外的主機，有測試把關

## Acceptance Criteria

- [ ] 連到端點白名單以外的主機時失敗，有測試
- [ ] 個資閘門掃描序列化後的完整請求，命中就不送，單位標成 `BLOCKED`
- [ ] 每次送出都留下外送紀錄，只有雜湊、供應商、模型、大小與時間
- [ ] 429、5xx 與網路錯誤會退避重試，其他 4xx 不重試
- [ ] 拒答依序對半拆、換 `fallback_model`，都不行才是 `REFUSED`，Batch 回 `succeeded` 的情況也算得到
- [ ] 回應被截斷時對半拆重送
- [ ] 重送附上原因，同組的其他單位當上下文帶上
- [ ] 預算超過就停，保留進度
- [ ] 估價模式跟實際模式一致，模式進指紋，換模式要重新確認
- [ ] 中斷後續跑，已驗證的單位不重付
- [ ] `tome preview` 產生對照，`BLOCKED` 的單位不放原文
- [ ] 白皮書 §5.7 的拒答計費照官方改，寫明不用伺服器端回退
- [ ] 白皮書的成熟度標籤、附錄 B、CHANGELOG 更新，ADR-0099 的斷言補進「驗證」

## Measured

2026-11-02，Windows 參考機器。沒有連到本機以外的主機，沒有用到金鑰。
