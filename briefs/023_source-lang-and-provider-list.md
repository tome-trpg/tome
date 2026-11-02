---
status: active
date: 2026-11-02
type: feature
wave: 18
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

# 023 — source_lang 進指紋與 tome provider list

## Intent

這個回合結束時，`book.yaml` 的 `source_lang` 改了就要重新確認估價，因為它決定 `<glossary>` 列哪些詞條，會改變實際送出的內容。`tome provider list` 能看到 TOME 知道怎麼呼叫哪些模型與價格，不連網，也不用金鑰。這兩件事都不需要 SDK，趁 `@anthropic-ai/sdk` 0.137.0 的冷卻期先做，順序變成 023、022、019、020（ADR-0106）。

## Negative Scope

- 不加 `@anthropic-ai/sdk`，不改 `package.json` 的相依。
- 不做 Anthropic 轉接層、`fast-sha256` 的例外、`tome provider test`、`tests/contract/`，這些留在 022。
- 不打真的 API，也不連網。
- 不改提示、規則包與 `providers/anthropic.yaml` 的內容。
- 不放商業書的內容，範例與測試都用合成文字。

## Not Empowered

- `tome provider list` 的欄位、輸出與 `--json` 形狀要等維護者回覆，寫在共用筆記，不自己定案。
- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。放進 PR 說明不算問。
- 其他程式不得自己連網（ADR-0039）。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，CI 全綠就回報 PR 連結與 attempt 1 的結果。

## Invariants

- [ ] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [ ] 新的測試先在舊行為上失敗過
- [ ] `specs`、`test` 在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [ ] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [ ] `tome provider list` 不連網，也不讀金鑰，有測試把關
- [ ] `package.json` 的相依沒有變

## Acceptance Criteria

- [ ] 只改 `source_lang` 就要重新確認估價，有測試
- [ ] `tome provider list` 依維護者回覆的形狀輸出，資料來自 `providers/anthropic.yaml`
- [ ] ADR-0106 修改 ADR-0104 第 1、41 項
- [ ] 白皮書的成熟度標籤、附錄 B、CHANGELOG 更新

## Measured

2026-11-02，Windows 參考機器。沒有連到本機以外的主機，沒有用到金鑰。
