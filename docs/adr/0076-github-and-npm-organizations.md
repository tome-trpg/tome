---
id: ADR-0076
status: accepted
date: 2026-11-01
depends-on: [ADR-0006]
---

# ADR-0076：專案放在組織底下

## 脈絡

套件還沒發佈，現在搬的成本最低。發佈後 Trusted Publisher 綁定 repo 路徑，spec 工具從 `@descent-vtt` 搬到 `@spec-family` 時每個使用的專案都要改。npm 組織也能管理不帶 scope 的套件（[佐證 §3.10](../research/2026-10-31-landscape.md#310-組織與發佈)）。

## 決定

1. GitHub 組織 `tome-trpg`，repo 是 `tome-trpg/tome`。
2. npm 組織 `tome-trpg`，套件名維持 `tome-trpg`，由組織管理。
3. `@tome-trpg/` 留給之後的函式庫與規則包。

## 後果

GitHub 建議組織至少兩位 owner，目前只有一位。token 要重建。DMCA 政策沒有區分組織與個人，所以這不算隔離法律風險。

## 替代方案

**維持個人帳號**：之後要搬會貴很多；**改成 `@tome-trpg/cli`**：安裝指令較長，裸名也要留佔位；**不建 npm 組織**：之後沒有 scope 可用；都否決。
