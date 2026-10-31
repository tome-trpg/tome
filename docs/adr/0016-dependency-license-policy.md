---
id: ADR-0016
status: accepted
date: 2026-10-31
---

# ADR-0016：相依授權政策

## 脈絡

PyMuPDF 等 AGPL 函式庫一旦進主程式，散布的組合就受 AGPL 約束；Marker、YomiToku 等引擎的權重另有限制（[佐證 §2.5](../research/2026-10-31-landscape.md#25-授權陷阱)）。

## 決定

1. 主程式同行程的相依 MUST 限 MIT、Apache-2.0、BSD、MPL-2.0。
2. AGPL、GPL、非商業、OpenRAIL 類引擎不隨附，由使用者自裝，以獨立行程執行。
3. 程式授權與權重授權分開審查。

## 驗證

<!-- @assert-import-absence target="src" exclude="*.json" module="mupdf mupdf-js pymupdf marker-pdf mineru yomitoku surya-ocr docling" reason="AGPL、GPL、非商業與引擎套件都不進主程式行程，主程式也不依賴任何引擎" -->
<!-- @assert-count target=".github/workflows/test.yml" symbol="npm run licenses" min="1" comments="include" reason="CI 用 lockfile 檢查全部相依的授權，名單外的讓 CI 失敗" -->

## 後果

引擎選擇較窄，授權風險留給自行安裝的人。

## 替代方案

**完全不支援非寬鬆授權引擎**：Marker 這類引擎接不上；**允許選用 AGPL 相依**：組合整體受 AGPL 約束；都否決。

## Open Questions

- [x] `src/` 建立時加上 `@assert-import-absence`，擋下不符政策的相依進主程式。2026-11-01 完成：斷言擋下已知的套件，`tools/check-licenses.ts` 在 CI 擋下其他白名單以外的授權，二進位檔的例外見 ADR-0083。
