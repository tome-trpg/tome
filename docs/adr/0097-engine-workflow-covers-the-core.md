---
id: ADR-0097
status: accepted
date: 2026-11-01
depends-on: [ADR-0064, ADR-0096]
amends: [ADR-0064, ADR-0096]
---

# ADR-0097：改到引擎核心與 schema 也要跑引擎工作流程

## 脈絡

ADR-0096 留下一個 Open Question：改到 `src/core/engine.ts`、`src/core/extract.ts`、`schemas/tome-engine-1.schema.json` 時要不要也跑。brief 008 在 `license` 加了欄位，本機全綠，推上去之後 `engine` 才在兩個平台失敗。這類改動目前靠本機手動跑，一忘記就漏了。

下列決定由維護者在 2026-11-01 從問題介面選定。

## 決定

1. 修改 ADR-0064 第 2 項：改到這三個檔案也要安裝 Docling 跑合成 PDF。這結束了 ADR-0096 的 Open Question。
2. `.github/workflows/engine.yml` 的 `push` 與 `pull_request` 都加上這三個路徑。

## 驗證

<!-- @assert-count target=".github/workflows/engine.yml" symbol="- 'src/core/engine.ts'" expected="2" reason="第 2 項：push 與 pull_request 都要涵蓋引擎核心" -->
<!-- @assert-count target=".github/workflows/engine.yml" symbol="- 'src/core/extract.ts'" expected="2" reason="第 2 項：push 與 pull_request 都要涵蓋引擎核心" -->
<!-- @assert-count target=".github/workflows/engine.yml" symbol="- 'schemas/tome-engine-1.schema.json'" expected="2" reason="第 2 項：push 與 pull_request 都要涵蓋引擎的 schema" -->

## 後果

改到這些檔案的 PR 要多等 Docling 安裝與解析的時間。其他核心檔案不會自動觸發，例如 `src/core/assemble.ts`，那些靠錄好的輸出與手動觸發。

## 替代方案

**維持本機手動**：容易忘記，brief 008 就是這樣漏掉的；**`src/core/` 全部都跑**：多數改動用不到 Docling，每個 PR 都要多等；都否決。
