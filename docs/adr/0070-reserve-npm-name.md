---
id: ADR-0070
status: accepted
date: 2026-11-01
depends-on: [ADR-0006]
---

# ADR-0070：用佔位版本保留 npm 名稱

## 脈絡

npm 名稱要首次發佈才算保留，Trusted Publisher 也是在套件設定頁設定。

## 決定

1. 現在發佈不含程式的 `tome-trpg@0.0.0`。
2. 佔位包放在 `tools/npm-placeholder/`，由維護者用自己的帳號發一次。
3. Trusted Publisher 等第一版才設，因為設定後 2 天內要完成首次發佈。

## 後果

多一個 0.0.0 版本留在 npm。

## 替代方案

**等第一版再發**：名稱可能被拿走，第一次也要手動發佈；否決。
