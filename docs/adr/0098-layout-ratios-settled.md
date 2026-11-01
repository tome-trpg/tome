---
id: ADR-0098
status: accepted
date: 2026-11-01
depends-on: [ADR-0092]
amends: [ADR-0092]
---

# ADR-0098：閱讀順序通過，版面比例定案

## 脈絡

ADR-0092 把版面規則的比例留成提案，等 H-5 在真實書籍上驗過才定案。書本內文不能離開本機，所以另外產生本機檢視檔，由維護者對照 PDF 判斷。

下列決定由維護者在 2026-11-01 從問題介面選定。

## 決定

1. 真實書籍的閱讀順序通過，依據是維護者對照本機檢視檔與 PDF 的結果。H-5 的數值塊不在這次範圍，要等 M2 的規則包。
2. 下列比例定案，第 10、13、18 項的數字不再是提案：

   | 規則 | 數字 |
   | :--- | :--- |
   | 頁首頁尾貼著的頁邊 | 上下 8% |
   | 頁首頁尾至少出現 | 3 頁 |
   | 首字放大的字高 | 其他文字的 2 倍 |
   | 方框的最小尺寸 | 36×18 點 |
   | 當成版面裝飾的方框 | 蓋住頁面 60% 以上 |
   | 算邊欄的區塊 | 80% 面積在方框內 |
   | 全寬的區塊 | 寬度超過文字區 60% |

3. 這結束了 ADR-0092 的兩個 Open Questions。

## 量測

閱讀順序是人工判斷，不是量化數字，也沒有記下對照了哪些頁。檢視檔用 Docling 2.140.0 與 docling-core 2.101.1 產生，之後升到 docling-core 2.102.0 沒有重做。

## 驗證

<!-- @assert-count target="src/core/assemble.ts" symbol="MARGIN_SHARE = 0.08" expected="1" reason="第 2 項：頁邊比例定案" -->
<!-- @assert-count target="src/core/assemble.ts" symbol="REPEATED_PAGES = 3" expected="1" reason="第 2 項：重複頁數定案" -->
<!-- @assert-count target="src/core/assemble.ts" symbol="DROP_CAP_RATIO = 2" expected="1" reason="第 2 項：首字倍數定案" -->
<!-- @assert-count target="src/core/pdf.ts" symbol="BOX_MIN_WIDTH = 36" expected="1" reason="第 2 項：方框最小寬度定案" -->
<!-- @assert-count target="src/core/pdf.ts" symbol="BOX_MIN_HEIGHT = 18" expected="1" reason="第 2 項：方框最小高度定案" -->
<!-- @assert-count target="src/core/assemble.ts" symbol="BOX_MAX_PAGE_SHARE = 0.6" expected="1" reason="第 2 項：方框上限定案" -->
<!-- @assert-count target="src/core/assemble.ts" symbol="BOX_INSIDE_SHARE = 0.8" expected="1" reason="第 2 項：邊欄比例定案" -->
<!-- @assert-count target="src/core/assemble.ts" symbol="WIDE_SHARE = 0.6" expected="1" reason="第 2 項：全寬比例定案" -->

## 後果

比例要改就走新的 ADR。閱讀順序沒有量化的基準，換引擎或升 Docling 時要重新對照。本機檢視檔含書的全文，看完可以刪，要重新對照就重跑 `tome extract`。

## 替代方案

**把閱讀順序量化**：要有標準答案，書本內文又不能離開本機，成本高；**等更多書再定案**：M2 要建在 `document` 層上，比例一直是提案，後面的工作都靠未定案的數字；都否決。
