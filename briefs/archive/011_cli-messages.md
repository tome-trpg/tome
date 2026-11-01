---
status: archived
date: 2026-11-01
type: feature
wave: 9
affectedFiles:
  - CHANGELOG.md
  - CONTRIBUTING.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - src/cli/messages/zh-TW.json
  - tests/cli/**
  - tests/core/**
  - tests/tools/**
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
integrity: sha256-1ba82e5cab9b98608a20b05a6e8b1eebade16375a1a1a3ca5e2b0a4ea7b40ce9
---

<!-- spec-brief:banner -->
> **Archived 2026-11-01.**
> Merged in pull request [#22](https://github.com/tome-trpg/tome/pull/22).
> Recorded at commit `9b6f671`: 13 files changed, +276 −106.
> The body below describes the tree before execution and is not maintained.
<!-- /spec-brief:banner -->

# 011 — CLI 訊息的文字規範

## Intent

這個回合結束時，CLI 的訊息、說明與範本都跟使用者文件一樣，是專業、文件化且淺顯易懂的寫法：不用口語，不對讀者稱「你」，用台灣慣用的技術用語。ADR-0086 把 CLI 訊息留成待決事項，維護者選了要改，所以 ADR-0089 結案，檢查也擴大到訊息檔。維護者同時接受了 M1 實作時定的細節，ADR-0090 把它們從提案改成定案。

## Negative Scope

- 不改訊息的代碼與佔位符，只改文字。
- 不改 `src/` 的程式，文字只在 `src/cli/messages/zh-TW.json`。
- 不改白皮書與既有 ADR 的內文，白皮書只加 ADR 索引的列。
- 不開 brief 006。

## Not Empowered

- 公開文件寫「維護者」，不寫人名。
- 檔案用一般的寫入工具改，不用 Bash 或腳本繞過寫入掛勾。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] `specs` 與 `test` 兩條工作流程在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [x] 每則訊息的佔位符跟改寫前相同，只有 `engine.third_party` 多用一次 `{name}`，好寫出移除指令

## Acceptance Criteria

- [x] 訊息檔沒有「你」，也沒有 `正則` 這類中國大陸用語，測試會擋
- [x] 文字由沒看過改寫過程的人校對過
- [x] ADR-0089、ADR-0090 記下決定，並列進白皮書的 ADR 索引

## Measured

校對對照了程式，發現一批改寫前就存在、訊息與實際行為不符的項目。只靠文字能修的都在這個回合修了，例如 `roles.yaml` 的鍵不能有冒號、`tome engine add` 失敗時不會重建環境、`tome provider auth set` 缺少必填參數。

下列項目要改程式，或會動到 `--json` 的 `params`，不在這個回合：

- `extract.pages_failed` 與 `pack.unknown_class` 顯示的編號從 0 起算。目前先在文字裡註明。
- `store.bad_id` 同時用於一般名稱與規則包 ID，兩者的規則不同。目前先把兩種規則都寫出來。
- YAML 語法錯誤時，`pack.bad_file` 的 `issue` 只有 `yaml`。
- `cli.missing_argument` 的參數名稱是英文，與 `--help` 的中文不同。
- `prices.pending` 的 `{milestone}` 是內部代號，`probe.structure` 的 `{tagged}` 是 `yes`、`no`。
