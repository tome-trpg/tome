---
id: ADR-0096
status: accepted
date: 2026-11-01
depends-on: [ADR-0064]
amends: [ADR-0064]
---

# ADR-0096：改到引擎測試也要跑引擎工作流程

## 脈絡

ADR-0064 只在改到 `engines/` 或手動觸發時才跑 Docling。`tests/engine/` 的測試只有這條工作流程跑得到，`npm test` 會跳過，所以只改測試的 PR 沒有 CI 驗證過。PR #30 改了這個測試，要手動觸發才驗得到。

下列決定由維護者在 2026-11-01 從問題介面選定。

## 決定

1. 修改 ADR-0064 第 2 項：改到 `tests/engine/` 也要安裝 Docling 跑合成 PDF。
2. `.github/workflows/engine.yml` 的 `push` 與 `pull_request` 都加上這個路徑。

## 驗證

<!-- @assert-count target=".github/workflows/engine.yml" symbol="- 'tests/engine/**'" expected="2" reason="第 2 項：push 與 pull_request 都要涵蓋引擎測試" -->

## 後果

改到引擎測試的 PR 要多等 Docling 安裝與解析的時間。這條工作流程仍然有路徑過濾，不設必要檢查。

## 替代方案

**每次手動觸發**：容易忘記，也沒有紀錄擋得住；否決。

## Open Questions

* 改到 `src/core/engine.ts`、`src/core/extract.ts`、`schemas/tome-engine-1.schema.json` 時要不要也跑。brief 008 就是改到這類檔案，推上去才發現引擎測試失敗。
