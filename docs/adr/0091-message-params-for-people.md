---
id: ADR-0091
status: accepted
date: 2026-11-01
depends-on: [ADR-0027, ADR-0059, ADR-0089]
amends: [ADR-0089]
---

# ADR-0091：訊息參數給人看

## 脈絡

ADR-0089 改寫 CLI 訊息時只改文字，代碼與佔位符不變。校對對照程式後留下一批只改文字修不掉的問題：編號從 0 起算、內部值直接顯示、兩種規則共用一則訊息。這些會動到 `--json` 的 `params`，維護者在 2026-11-01 同意修正。

## 決定

1. 訊息裡給人看的編號從 1 起算：`extract.pages_failed` 的 PDF 頁次、`pack.unknown_class` 的筆數。manifest、頁面檔名與 `tome-ir/1` 的頁碼維持從 0 起算。
2. 規則包 ID 不合法用錯誤代碼 `pack.bad_id`，YAML 語法錯誤用發現代碼 `pack.invalid_yaml`。
3. `cli.missing_argument` 的參數名稱與 `--help` 相同，名稱放訊息檔。
4. `probe.structure` 的 `tagged` 顯示有或無，機器要讀的值在 `data.probe.tagged`。`prices.pending` 不帶參數，不顯示內部路線圖代號。

## 驗證

<!-- @assert-count target="src/core/extract.ts" symbol="page + 1" expected="1" reason="第 1 項：頁次從 1 起算" -->
<!-- @assert-count target="src/core/pack-lint.ts" symbol="index: String(index + 1)" expected="1" reason="第 1 項：筆數從 1 起算" -->
<!-- @assert-count target="src/core/pack.ts" symbol="'pack.bad_id'" expected="1" reason="第 2 項：規則包 ID 有自己的訊息" -->
<!-- @assert-absence target="src/core/doctor.ts" symbol="milestone" reason="第 4 項：不顯示內部路線圖代號" -->
<!-- @assert-absence target="src/cli/run.ts" symbol="'cli.missing_argument', { argument: '" reason="第 3 項：參數名稱放訊息檔" -->

## 後果

`--json` 的 `params` 裡這幾個值是給人看的，會隨訊息檔改變。機器要讀的值放 `data`，代碼維持穩定。TOME 還沒有發布，沒有相容性問題。

## 替代方案

**`params` 維持英文，顯示時才翻譯**：要多一層對照，而且 `data` 已經有機器要的值；**只在文字裡註明從 0 起算**：使用者還是要自己換算；都否決。
