---
id: ADR-0014
status: accepted
date: 2026-10-31
---

# ADR-0014：採用 spec 工具

## 脈絡

spec 工具的正文可用任何語言，只要求狀態字為英文，也支援非 Node 專案；繁中 repo `seekers-journal` 已經四個都用（[佐證 §3.7](../research/2026-10-31-landscape.md#37-spec-工具)）。spec-graph 不把單字母前綴當編號，所以決策要寫成 ADR 才檢查得到。

## 決定

1. 四個工具都採用，分兩階段。
2. 第一階段：現在安裝 spec-graph、spec-guard，ADR 提前建立並回填。
3. 第二階段：spec-brief、spec-harness 在第一個實作回合前安裝。
4. `package.json` 釘死確切版本，`.npmrc` 設 `yes=false`，執行時一律給 `npx` 完整套件名。

## 驗證

<!-- @assert-present file="package.json,package-lock.json,.npmrc,.spec-graph.json,.spec-guard.json,.spec-brief.json,.spec-harness.json,.github/workflows/specs.yml" -->
<!-- @assert-count target=".npmrc" symbol="yes=false" min="1" comments="include" reason="npx 不得在未安裝時自行下載" -->
<!-- @assert-absence target=".github" regex="true" symbol="npx\s+(--no-install\s+)?spec-(guard|graph|brief|harness)" comments="include" reason="裸名不是本專案的套件" -->

## 後果

多一份 Node 工具鏈，但主程式本來就是 TypeScript。第二階段前沒有 brief 與寫入護欄。

## 替代方案

**等第 8 輪再裝**：決策越多，回填越多；**現在四個全裝**：白皮書階段沒有 brief，工具沒東西可管；都否決。

## Open Questions

- [x] 第一個實作回合前安裝 spec-brief、spec-harness，並跑 `spec-harness init`。2026-11-01 完成，版本釘死在 `package.json`，brief 放 `briefs/`。
