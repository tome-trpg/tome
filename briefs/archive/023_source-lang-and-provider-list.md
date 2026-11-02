---
status: archived
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
integrity: sha256-34ae3e0bdc0f53a29c3f144d6d7c42673bdecc864d16340ecfae4b4ff0b80ff7
---

<!-- spec-brief:banner -->
> **Archived 2026-11-02.**
> Merged in pull request [#51](https://github.com/tome-trpg/tome/pull/51).
> Recorded at commit `7082917`: 14 files changed, +478 −14.
> The body below describes the tree before execution and is not maintained.
<!-- /spec-brief:banner -->

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

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過
- [x] `specs`、`test` 在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] `tome provider list` 不連網，也不讀金鑰，有測試把關
- [x] `package.json` 的相依沒有變

## Acceptance Criteria

- [x] 只改 `source_lang` 就要重新確認估價，有測試
- [x] `tome provider list` 依維護者回覆的形狀輸出，資料來自 `providers/anthropic.yaml`
- [x] ADR-0106 修改 ADR-0104 第 1、41 項
- [x] 白皮書的成熟度標籤、附錄 B、CHANGELOG 更新

## Measured

2026-11-02，Windows 參考機器。沒有連到本機以外的主機，沒有用到金鑰。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| 只改 `source_lang` 要重新確認 | 舊程式上失敗，`confirmed` 還是 `true` |
| `tests/cli/provider.test.ts` | 指令不存在時 18 個失敗 |
| 不列的欄位 7 個、不收參數 1 個 | 指令不存在時也會過，故意把整份設定檔放進 `data`、改成收參數後失敗，再改回來 |
