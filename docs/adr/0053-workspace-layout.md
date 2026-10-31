---
id: ADR-0053
status: accepted
date: 2026-11-01
depends-on: [ADR-0001]
---

# ADR-0053：工作區的位置與版面

## 脈絡

G-5 要求公開 repo 在結構上裝不進書籍內容，TC-2 要求 PDF 不離開本機。Windows 的文件資料夾常被 OneDrive 同步，放那裡等於把書傳上雲端。

## 決定

1. 預設位置是機器本地目錄，Windows 是 `%LOCALAPPDATA%\tome`，可用 `TOME_HOME` 改。
2. `tome init` MUST 拒絕 git repo 內的路徑，偵測到同步資料夾時要警告。
3. 每本書一個 `book.db`，系列另一個 `series.db`。
4. 來源 PDF 不複製，只記路徑與雜湊。
5. Obsidian vault 另外指定。

## 後果

工作區較難直接找到，要靠 `tome status` 顯示路徑。跨書查詢要開兩個資料庫。

## 替代方案

**文件資料夾**：常被同步上雲端；**整個工作區一個資料庫**：刪除單書較難乾淨；**複製 PDF**：多一份商業書的副本；都否決。
