---
id: ADR-0073
status: accepted
date: 2026-11-01
---

# ADR-0073：版本策略

## 脈絡

早期格式常會變。工作區資料與第三方規則包會跨版本，需要各自的版本號。

## 決定

1. 從 0.x 起步，1.0 前每個 minor 可以有破壞性變更，寫進 `CHANGELOG.md`。
2. `tome-ir`、`tome-pack`、`tome-engine`、`--json` 各自有版本號。

## 後果

要維護多個版本號。

## 替代方案

**一開始就嚴格 semver**：主版號會一直跳；否決。
