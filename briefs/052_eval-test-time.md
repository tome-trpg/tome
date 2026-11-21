---
status: active
date: 2026-11-21
type: defect
wave: 53
affectedFiles:
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - tests/**
  - tools/eval.ts
  - tools/eval-*.ts
protectedFiles:
  - .github/**
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CLAUDE.md
  - engines/**
  - languages/**
  - package-lock.json
  - package.json
  - prompts/**
  - providers/**
  - schemas/**
  - src/core/egress/**
  - src/core/process.ts
  - src/core/store.ts
  - systems/**
  - vitest.config.ts
---

# 052 — 評測測試的時間

## Intent

這個回合結束時，`tests/tools/eval.test.ts` 的兩個端到端測試在 Windows runner 上離 vitest 的 30 秒上限有餘裕，PR 95（vitest 5.1.0）不再因為它們逾時卡住。做法先把測試改輕：查清楚時間花在哪裡，減少重複走完整流程的地方（段落更少、組數更少、完整的 6 組只在一個測試裡走），每一項原本驗證的行為都還有測試驗證。真的需要長時間的測試，才給有理由的單一上限，不改全域的 `testTimeout`。逾時之後清暫存資料夾報 `EPERM`，一起查清楚是資料庫或伺服器沒關，還是逾時的連帶結果。決定寫成 ADR-0140，記下修改後兩個測試在 Windows 上的秒數。名稱（`052_eval-test-time`、標題「評測測試的時間」）是提案，等維護者確認。

## Negative Scope

* 不改全域的 `testTimeout`（`vitest.config.ts`），也不靠重跑 CI 換綠燈。
* 不動 vitest、Anthropic SDK、docling 的版本（Dependabot #95、#96、#89、#97）。
* 不改評測工具給維護者用的行為與輸出；為了測試要改 `tools/` 時，只加測試用的參數，預設不變。
* 不在維護者的筆電上跑長時間吃滿所有核心的工作；不用 Python。

## Not Empowered

* `vitest.config.ts`、`package.json`、`package-lock.json`、workflow；要改時先停下來問。
* `src/core/store.ts`、`src/core/process.ts`、`src/core/egress/**`。
* 拿掉某個行為的驗證；改輕的同時要說明每一項驗證搬到哪裡。

## Invariants

- [ ] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [ ] 原本兩個測試驗證的每一項行為，修改後都還有測試驗證，ADR 列出對照
- [ ] 全域的 `testTimeout` 沒有改；若有單一上限，ADR 寫出理由與量到的秒數
- [ ] `specs`、`test` 在 CI 第一次跑就通過，Windows 與 Ubuntu 都過，沒有靠重跑
- [ ] ADR-0140 記下兩個測試修改前後在 Windows runner 上的秒數
- [ ] 逾時後 `EPERM` 的原因查清楚，或記成 Open Question
- [ ] 改到 `src/` 的 `.ts` 時跑 `mutation-lines`，存活的變異補上測試或說明

## The Defect, Measured

Manager 在 2026-11-21 讀 CI 的紀錄：

| 測試 | PR 94 | main `47cd1ac` | PR 95（vitest 5.1.0，job 136849709628） |
| :--- | ---: | ---: | ---: |
| runs the six variants in batches through the product, one passage per request | 13.7 秒 | 17.3 秒 | 32.6 秒，逾時 |
| walks select, estimate, run, score and report, and carries over a score from the blind round | 18.5 秒 | 26.6 秒 | 32.3 秒，逾時 |

* 都是 Windows runner；Ubuntu 都過。逾時的診斷寫 machine CPU 40%、event loop delay 最多 5.5 秒。
* 逾時後清暫存資料夾報 `EPERM ... syscall: 'rm'`，兩個 `tome-test-*` 資料夾刪不掉。

執行 session 在維護者的筆電（Windows 11，16 核）上只跑這個測試檔，2026-11-21：

| 測試 | 秒數 |
| :--- | ---: |
| runs the six variants… | 11.1 |
| walks select, estimate, run, score and report… | 8.5 |
| estimates each variant the way it will be sent… | 5.0 |
| copies the books out of the workspace… | 3.4 |

* 兩個慢的測試都把 6 組完整跑一次（`runAll`），走完整流程的那個用 26 段（合成的兩本書全部挑），六組的那個用 12 段；Haiku 的假譯文故意過短，每段重送到上限才淘汰。
* 用 `--testTimeout=3000` 讓「runs the six variants」逾時，清暫存資料夾就報 `EPERM`：逾時的測試還在跑、還開著 `book.db`，`onTestFinished` 的 `rmSync` 刪不掉。正常跑完的路徑，`tools/` 的每個 `openBookStore` 都在 `finally` 裡關。
