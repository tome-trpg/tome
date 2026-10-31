---
id: ADR-0071
status: accepted
date: 2026-11-01
depends-on: [ADR-0052]
---

# ADR-0071：安裝方式與引擎發送

## 脈絡

使用者要有 Node 才能跑主程式，要有 uv 才能裝 Docling。Node 的單一執行檔還在開發中。

## 決定

1. 用 `npm install -g tome-trpg` 安裝。
2. `tome doctor` 檢查 uv 並指引安裝。
3. Docling 轉接器的原始碼與 `uv.lock` 隨 npm 包發送。
4. 第一版不提供單一執行檔。

## 後果

對不熟指令列的 GM 門檻較高。

## 替代方案

**同時提供單一執行檔**：功能還不穩定，未簽章也會跳警告；**轉接器另外發到 PyPI**：多一個名字與發佈流程；都否決。
