---
status: archived
date: 2026-11-01
type: defect
wave: 11
affectedFiles:
  - briefs/**
  - tests/engine/docling.test.ts
protectedFiles:
  - .github/**
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CLAUDE.md
  - docs/**
  - engines/**
  - languages/**
  - package-lock.json
  - package.json
  - schemas/**
  - src/**
integrity: sha256-2701840882448963f958ab9442ce641f14c843e6e696fb48fd68c2bc04d5c995
---

<!-- spec-brief:banner -->
> **Archived 2026-11-01.**
> blocks 測試改成先印 findings 再斷言結束碼，Windows 間歇失敗時紀錄才看得出原因。間歇失敗本身還沒修。
> Merged in pull request [#30](https://github.com/tome-trpg/tome/pull/30).
> Recorded at commit `12a88b1`: 2 files changed, +64 −2.
> The body below describes the tree before execution and is not maintained.
<!-- /spec-brief:banner -->

# 013 — 引擎測試失敗時要看得到原因

## Intent

這個回合結束時，`tests/engine/docling.test.ts` 的 `blocks` 測試跟 `layout` 測試一樣，先印出 `tome extract` 的 findings，再斷言結束碼。`docling (windows-2025)` 偶爾失敗時，紀錄才看得出是哪一則訊息造成的，之後才能查原因。

## Negative Scope

- 不修間歇失敗本身，原因還不知道。
- 不用重跑 CI 換綠燈。
- 不改 `engine.yml` 的路徑過濾。
- 不改 `src` 與 `engines`。

## Not Empowered

- 公開文件寫「維護者」，不寫人名。
- 檔案用一般的寫入工具改，不用 Bash 或腳本繞過寫入掛勾。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 在本機真的跑過 `tests/engine`，`blocks` 測試印出了 findings
- [x] 印出來的只有合成 PDF 的訊息，沒有書本文字
- [x] `specs` 與 `test` 兩條工作流程在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑

## The Defect, Measured

到 2026-11-01 的 26 次 `engine` 裡，`docling (windows-2025)` 有 2 次失敗的原因不明，都是 `tome extract` 回傳 1，Ubuntu 沒有這樣失敗過。

| 執行 | commit | 失敗的測試 |
| :--- | :--- | :--- |
| 17 | `931797a` | `assembles the forged layouts in reading order` |
| 24 | `b3e7398` | `writes source pages that pass tome-ir/1` |

`b3e7398` 跟 PR #12 上通過的 `b2b4ac2` 是同一棵樹，所以不是內容造成的。回傳 1 代表至少有一則 `fail` 等級的訊息，但 `blocks` 測試還沒印出 findings 就斷言失敗，紀錄看不出是哪一則。`a27f16e` 只補了 `layout` 測試。
