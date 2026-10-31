---
id: ADR-0005
status: accepted
date: 2026-10-31
---

# ADR-0005：主要輸出是 Obsidian 相容的 Markdown

## 脈絡

翻好的書是帶團時用的，要能快速搜尋與跳轉，也要讓一般 Markdown 工具讀得動。

## 決定

1. 主要輸出是 Obsidian 相容的 Markdown，保留區塊 ID。
2. 雙語對照檔一律另外輸出，給校對用。
3. VTT 等其他格式之後由 IR 轉出。

## 後果

要處理 Obsidian 的語法限制，細節在白皮書 §5.5。

## 替代方案

**單檔 Markdown**：跳轉弱；**離線靜態網站**：不好再編輯；都否決。
