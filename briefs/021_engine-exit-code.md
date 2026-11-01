---
status: active
date: 2026-11-02
type: defect
wave: 14
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
  - schemas/**
  - systems/**
---

# 021 — 引擎的結束碼

## Intent

這個回合結束時，引擎非正常結束時回報得出它怎麼結束：`extract.pages_failed` 多一個參數 `exit`，`--json` 的 `params` 與訊息都看得到，Windows 的原生崩潰同時列十六進位，訊號結束也說得清楚。`docling (windows-2025)` 的間歇失敗目前只有 `engine_crashed`，`engines/docling/main.py` 接住了每頁的例外，所以那是行程層級的崩潰，而我們沒有結束碼可以查。維護者選定先補結束碼再開 016，依據是 ADR-0101。

## Negative Scope

- 不保留 stderr，不動 `keepStderr`（ADR-0085 第 5 項）。
- 不改引擎，`engines/` 不動。
- 不新增原因代碼，`reasonFor` 維持 ADR-0090 第 6 項。
- 不改 `engine.install_failed` 的細節。
- 這個回合不修間歇失敗本身，只讓下一次失敗看得到結束狀態。

## Not Empowered

- ADR-0101 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。放進 PR 說明不算問。
- 核心不放給人看的文字，`exit` 的值只有數字與英文代碼。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，CI 全綠就回報 PR 連結與 attempt 1 的結果。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過
- [x] 改到 `src/core/extract.ts` 的提交，推送前在本機真的跑過 `tests/engine`
- [ ] `specs`、`test`、`engine` 在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑。`engine` 失敗就回報 findings，不重跑
- [ ] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] `exit` 不含書本文字，stderr 依然不保留

## The Defect, Measured

`7f12a18` 的 `docling (windows-2025)` 在 attempt 1 失敗，run 41331187356。findings 是 `extract.pages_failed`，兩頁都是 `engine_crashed`，第二個測試隨後成功。`d756b5d` 與 `7f12a18` 是同一棵樹，所以不是 015 的改動造成的。36 次裡原因不明的 Windows 失敗有 3 次。

`StreamOutcome` 的 `exited` 有 `code`，但 `extract.ts` 只用它分辨 `no_output` 與 `engine_crashed`，然後就丟掉了，所以回報裡沒有結束碼。`child.on('close')` 的第二個參數 `signal` 也沒有接，訊號結束時 `code` 是 null，看不出是什麼訊號。
