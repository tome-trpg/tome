---
id: ADR-0007
status: accepted
date: 2026-10-31
---

# ADR-0007：自訂 tome-ir，解析引擎是獨立行程外掛

## 脈絡

Markdown 會丟失座標與區塊角色。`DoclingDocument` 沒有邊欄標籤，`TextItem` 也沒列字型與字級（[佐證 §2.6](../research/2026-10-31-landscape.md#26-docling-文件模型與-pdf-自帶結構)）。引擎之間有授權問題，相依也互斥。

## 決定

1. IR 用自訂的 `tome-ir`，分 `source`、`overrides`、`document` 三層。
2. `block_id` 與 `content_hash` 分開，翻譯記憶看內容。
3. 解析引擎是獨立行程的外掛，Docling 是預設引擎。
4. 先用 PDF 自帶結構，再用模型。
5. 每頁做字元守恆檢查。

## 後果

要維護一份 schema 與轉接器，換來換引擎、重新解析時，已付費的譯文與人工修正都留得住。第一版沒有網路沙箱，引擎的離線保證靠協定與審查。

## 替代方案

**直接用 `DoclingDocument`**：全專案跟著 Docling 改版；**不用 ML**：雙欄、邊欄、表格的規則全要自己寫；都否決。
