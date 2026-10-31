---
id: ADR-0006
status: accepted
date: 2026-10-31
---

# ADR-0006：套件與指令命名

## 脈絡

npm 上的 `tome` 已被占用，`tome-trpg` 在 2026-10-31 未被占用。指令 `tome` 是專案一開始就指定的，但 JFrog 與 `@tomehq/cli` 也用這個指令（[佐證 §3.4](../research/2026-10-31-landscape.md#34-命名)）。

## 決定

1. npm 套件名 `tome-trpg`。
2. 指令 `tome`，另設別名 `tome-trpg`，撞名時用別名。

## 後果

名稱要首次發佈才算保留。

## 替代方案

**只用 `tome-trpg` 指令**：較長；**`@dancraft3746/tome`**：較難搜尋；都否決。
