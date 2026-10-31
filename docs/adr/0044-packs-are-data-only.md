---
id: ADR-0044
status: accepted
date: 2026-11-01
depends-on: [ADR-0023]
---

# ADR-0044：規則包只能是資料

## 脈絡

G-2 要求遊戲規則是資料。規則包作者不該需要會寫程式，安裝別人的包也不該等於執行別人的程式，主程式手上有金鑰與書籍內容。

## 決定

1. 規則包只有 YAML 與 Markdown，不執行任何程式。
2. 檔案沿用 prompt 的 `persona_and_tone.md`、`glossary.yaml`、`syntax_patterns.yaml`、`few_shots.md`，另加 `pack.yaml`、`roles.yaml`、`entities.yaml`。
3. 規則包不能指定連線端點，也不能碰金鑰。
4. `persona_and_tone.md` 會進入提示，規則包是不受信任的資料。

## 後果

做不到的功能要進引擎核心或解析引擎。

## 替代方案

**允許 JavaScript 外掛**：彈性最高，但安裝別人的包等於執行別人的程式；否決。
