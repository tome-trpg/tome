---
status: active
date: 2026-11-11
type: chore
wave: 45
affectedFiles:
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - package-lock.json
  - package.json
  - stryker.config.mjs
  - tests/**
  - vitest.config.ts
protectedFiles:
  - .github/**
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CHANGELOG.md
  - CLAUDE.md
  - docs/research/**
  - engines/**
  - languages/**
  - prompts/**
  - providers/**
  - schemas/**
  - src/**
  - systems/**
---

# 041 — 對外出口的變異測試與 Windows 卡住的調查

## Intent

這個回合結束時，對外出口（`src/core/egress/`）明顯存活與沒被涵蓋的變異都有測試殺掉，分數從 `main` 最近一次的 84.77（run 42583693624）升到 95 以上；逾時設定的兩種做法在 CI 上各量兩次，數字交給維護者決定留哪一個；Windows 上 `test` 卡住的原因查到哪裡、為什麼不改測試的行為，連同下一次能分辨原因的診斷，一起寫成 ADR-0131。只補測試，不改程式（ADR-0130 第 11 項）。

細節由維護者在 2026-11-12 照建議選定（共用筆記 `brief-041-questions.md` 的 7 項）：

* `anthropic.ts` 殺 26 個，`client.ts`、`gate.ts` 殺 6 個；走不到或等價的 6 個不硬殺，理由寫進 ADR。
* `openTelemetry: false` 的變異用 tracer provider 的測試殺，開發相依加 `@opentelemetry/api`，釘 1.10.0。
* 假供應商補三個地方：處理函式丟錯時回 400、`calls` 記查詢字串、查詢批次時可以讓本文斷線。
* 逾時設定：A（現在的設定）與 B（`timeoutFactor` 3、`timeoutMS` 10000）在 CI 各跑兩次，`ignoreStatic` 用同一批報告算。
* Windows：不改測試的行為，加只在逾時時才印的診斷。

## Negative Scope

- 不改 `src/**`。存活的變異如果揭露了程式的錯，停下回報，不自己改程式。
- 不硬殺等價或走不到的變異。
- 不碰對外出口以外模組的存活變異（驗證、遮蔽還原等）。
- 不改 `mutation.yml` 與門檻。有 job 超過 60 分鐘被取消就停下來問。
- 不在本機跑 Stryker。本機只用暫存複本一次套一個變異、跑相關的測試檔，小工具放 scratchpad，不進 repo。
- Windows：不加重試、不拉長測試的時限、不減少 worker，也不吞掉暫存資料夾的 `EPERM`。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。
- 逾時設定留 A 或 B 由維護者看過數字後決定；B 不留就加一個還原的 commit。
- 寫給維護者的理由要先對照程式與報告原文。
- 成熟度照實寫：分數以 CI 上 `mutation.yml` 的結果為準。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠、mutation 量過就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 每個新的測試都在本機確認過殺得掉它要殺的變異

  `1530941` 的測試下 39 個存活、81 與 82 號逾時，跟 run 42583693624 相同；這個回合的測試下殺掉 35 個，存活的 6 個就是 ADR-0131 第 3 項的清單，每個殺掉的都是為它補的那個測試失敗。
- [ ] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑
- [ ] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] `src/**` 與 `.github/**` 沒有改動
- [x] 新的開發相依只有 `@opentelemetry/api` 1.10.0，`npm run licenses` 通過

  lockfile 只多根項目的一行，跟 `npm install --package-lock-only` 產生的相同；299 個套件、0 違規。

## Acceptance Criteria

- [ ] 對外出口沒偵測到的 39 個變異的分類、補測試前後的分數寫成 ADR-0131，白皮書的 ADR 索引加一列
- [ ] 逾時設定 A、B 各兩次的 CI 數字，與 `ignoreStatic` 用同一批報告算的分數，寫進 ADR-0131
- [ ] 維護者對逾時設定的決定寫進 ADR-0131；改設定時 `amends: [ADR-0110]`
- [x] Windows 卡住的分析與診斷的用法寫進 ADR-0131
- [ ] 對外出口在 CI 的分數在 95 以上
