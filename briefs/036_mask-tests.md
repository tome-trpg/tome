---
status: active
date: 2026-11-08
type: chore
wave: 26
affectedFiles:
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - tests/**
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
  - package-lock.json
  - package.json
  - prompts/**
  - providers/**
  - schemas/**
  - src/**
  - stryker.config.mjs
  - systems/**
---

# 036 — 遮蔽還原的變異測試

## Intent

這個回合結束時，`src/core/mask.ts` 在 035 加的 `<pc>` 處理有測試把明顯存活與沒被涵蓋的變異殺掉，遮蔽還原的變異分數從 035 合併後的 87.31（`main` 的 run 42444515055）回到 95 以上。只改測試，不改程式。41 個沒偵測到的變異逐一分類：補測試殺掉的 29 個（035 加的 27 個，加上 035 之前就存活的 2 個），等價或走不到的 12 個不硬殺，理由與前後分數寫成 ADR-0117。

細節由 Manager 在 2026-11-08 照建議同意（共用筆記 `brief-036-questions.md` 的 5 項）。

## Negative Scope

- 不改 `src/**`。存活的變異如果揭露了程式的錯，停下回報，不自己改程式。
- 不硬殺等價或走不到的變異。
- 不改 `mutation.yml`、`stryker.config.mjs` 與門檻。
- 不在本機跑 Stryker。本機只用暫存複本一次套一個變異、跑相關的測試檔，小工具放 scratchpad，不進 repo。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。
- 寫給維護者的理由要先對照程式與報告原文。
- 成熟度照實寫：分數以 CI 上 `mutation.yml` 的結果為準。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠、mutation 量過就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 每個新的測試都在本機確認過殺得掉它要殺的變異
- [x] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑

  `182e930` 與 `2f68521` 的 `specs`、`test` 在 Windows 與 Ubuntu 都是第一次跑就通過。
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示

  `CodeQL` 是 success、0 個 annotation。三個 `Analyze` 工作各有 1 個 notice，是 `ubuntu-latest` 要換成 Ubuntu 26 的執行環境通知，不是程式掃描的警示。
- [x] `src/**` 沒有改動

## Acceptance Criteria

- [x] 41 個沒偵測到的變異的分類、前後分數寫成 ADR-0117，白皮書的 ADR 索引加一列

  開工前估的是殺 29、等價 12，對照後是殺 28、等價 13：96 號是 `residual` 裡 `run.marks ?? []` 的 `[]`，不是 `whole.marks` 的，殺得掉；90 號因為 `styleOf` 會拿掉 undefined 的連結而等價；205 號因為排序是穩定的、切點本來就依序放進去而等價。
- [x] 在分支上用 `workflow_dispatch` 跑 `mutation.yml`，遮蔽還原的分數在 95 以上，其他模組的分數也記下

  `182e930` 的 run 42447828630 第一次就全綠：遮蔽還原 95.67，其他 5 個模組跟 `main` 的 run 42444515055 相同，寫在 ADR-0117 第 5 項。

## Measured

2026-11-08（UTC），Windows 參考機器。

**存活清單**：run 42444515055 的 `mutation-mask` artifact（JSON 報告），用 `git credential fill` 取 token 下載，沒有印出 token。報告裡的 `mask.ts` 跟 `6ecb0a3` 的一字不差。

**本機確認**：scratchpad 的 Node 小工具把 `src`、`tests` 與設定複製到暫存資料夾，`node_modules` 用目錄連結，一次套一個變異，只跑 `tests/core/mask.test.ts`，跑完刪掉複本。新測試加上去之前，抽查的 3 個都存活；加上去之後 41 個裡殺掉 28 個、存活 13 個、沒有逾時，存活的就是 ADR-0117 的等價清單。41 個約 55 秒。

本機結果：`npm test` 62 個測試檔通過、1 個跳過，1,611 個測試通過、5 個跳過；`npm run spec` 273 個斷言都成立，也都看過失敗；`npm run licenses` 沒有違規。

**CI 的 mutation**：`182e930` 用 `workflow_dispatch` 觸發 `mutation.yml`（run 42447828630），6 個 job 第一次都通過。下載各 job 的 JSON 報告算分數：遮蔽還原 95.67（323 個變異，殺掉 292、逾時 17、存活 12、沒涵蓋 2），比預估的 95.98 少一個，是 169 號由逾時變成存活，它是等價的。
