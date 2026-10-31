---
id: ADR-0015
status: accepted
date: 2026-10-31
---

# ADR-0015：主程式用 TypeScript

## 脈絡

獨立行程的引擎讓主程式的語言不再被預設引擎綁住。主程式主要在處理字串和等網路，效能不是重點。起草時曾把 Python 寫成限制，那只是機器上裝了什麼。完整比較見[佐證 §2.8](../research/2026-10-31-landscape.md#28-主程式語言選型)。

## 決定

1. 主程式用 TypeScript，執行環境是 Node 22 以上。
2. Docling 轉接器維持 Python，環境由 uv 管理，兩邊只靠 `tome-ir` 的 JSON Schema 溝通。
3. `tome probe` 用 pdf.js。

## 後果

使用者要有 Node 與 uv。pdf.js 能否判定壞文字層待驗證（H-10），SQLite 用 `node:sqlite` 或 better-sqlite3 在第 6 輪定。

## 替代方案

**Python**：函式庫最齊，但維護者不想長期維護；**Rust**：開發最慢，單一執行檔的好處被 uv 抵銷；**C#**：文字處理生態較弱；都否決。
