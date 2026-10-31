---
id: ADR-0052
status: accepted
date: 2026-11-01
amends: [ADR-0015]
---

# ADR-0052：狀態庫用 node:sqlite，最低 Node 24

## 脈絡

`better-sqlite3` 是原生模組，文件沒點名 Windows 預編譯檔。`node:sqlite` 是內建模組，文件標示 Release candidate。在 Node 24.22.1 實測，WAL、外鍵、STRICT 表、JSON、FTS5、`user_version`、`VACUUM INTO`、交易回滾與第二條連線都正常（[佐證 §2.9](../research/2026-10-31-landscape.md#29-nodesqlite-實測)）。

## 決定

1. 狀態庫用 `node:sqlite`，開 WAL，以 `user_version` 做單向遷移。
2. 外面包一層資料存取層，需要時能換。
3. 最低版本從 Node 22 提高到 Node 24 LTS，取代 ADR-0015 的版本要求。

## 驗證

<!-- @assert-count target="package.json" symbol="\"node\": \">=24\"" min="1" comments="include" reason="最低版本與 ADR-0052 一致" -->

## 後果

內建模組還不是穩定版，升級 Node 時要重測。

## 替代方案

**`better-sqlite3`**：成熟，但是原生模組，安裝失敗時要編譯器；否決。
