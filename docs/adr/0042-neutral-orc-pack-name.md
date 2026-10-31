---
id: ADR-0042
status: accepted
date: 2026-11-01
amends: [ADR-0001]
---

# ADR-0042：ORC 規則包改用中性名稱 d100-orc

## 脈絡

Chaosium 的 ORC 文件寫明 Basic Roleplaying 是它的商標，ORC 明文不授權商標（[佐證 §3.8](../research/2026-10-31-landscape.md#38-開放授權規則包的義務)）。ADR-0001 的 `brp-orc` 沒有查到明文允許。

## 決定

1. 規則包 ID 改成 `d100-orc`，取代 ADR-0001 的 `brp-orc`。
2. 來源只在 `NOTICE` 裡依 ORC 的署名要求寫明。

## 後果

名稱看不出是哪套系統，要靠說明文件。現在還沒有程式碼，改名沒有成本。

## 替代方案

**維持 `brp-orc`**：一眼看得出系統，但沒有明文允許用在套件名稱；否決。
