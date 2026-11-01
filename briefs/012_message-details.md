---
status: active
date: 2026-11-01
type: defect
wave: 10
affectedFiles:
  - CHANGELOG.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - src/cli/**
  - src/core/doctor.ts
  - src/core/errors.ts
  - src/core/extract.ts
  - src/core/findings.ts
  - src/core/pack-lint.ts
  - src/core/pack-test.ts
  - src/core/pack.ts
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
---

# 012 — 訊息要說得清楚

## Intent

這個回合結束時，brief 011 校對留下、要改程式才修得掉的訊息問題都解決了：使用者看到的編號從 1 起算，規則包 ID 不合法與 YAML 語法錯誤各有明確的訊息，缺少參數時的名稱與 `--help` 一致，訊息不再顯示 `M2`、`yes` 這類內部值。這些都會動到 `--json` 的 `params`，維護者已同意，ADR-0091 記下決定。

## Negative Scope

- 不開 brief 006。
- 不改 manifest、頁面檔名與 `tome-ir/1` 的頁碼，內部維持從 0 起算。
- 不改 `data` 的內容，機器要讀的值都在那裡。
- 不動 `extract.no_run_record` 重跑時不補紀錄的行為，那不在這批。

## Not Empowered

- 公開文件寫「維護者」，不寫人名。
- 檔案用一般的寫入工具改，不用 Bash 或腳本繞過寫入掛勾。
- 核心不放給人看的文字，文字只在 `src/cli/messages/zh-TW.json`。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] `specs` 與 `test` 兩條工作流程在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [x] 每一項都有測試，新的斷言先在舊程式上失敗過

## The Defect, Measured

brief 011 的校對對照程式找到這些項目：

| 項目 | 舊的行為 |
| :--- | :--- |
| `extract.pages_failed` | PDF 第 2 頁顯示成 `1:`，因為直接印內部索引 |
| `pack.unknown_class` | 第一筆顯示成「第 0 筆」 |
| `store.bad_id` | `tome system new` 也用這則，但規則包 ID 的規則比較嚴，照訊息改還是失敗 |
| `pack.bad_file` | YAML 語法錯誤時只顯示 `roles.yaml 有誤：yaml。` |
| `cli.missing_argument` | 顯示 `<book>`，`--help` 寫的是中文 |
| `prices.pending` | 顯示內部路線圖代號 `M2` |
| `probe.structure` | 顯示 `tagged yes` |
