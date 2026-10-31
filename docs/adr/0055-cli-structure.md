---
id: ADR-0055
status: accepted
date: 2026-11-01
depends-on: [ADR-0028]
---

# ADR-0055：指令結構與人工關卡

## 脈絡

prompt 列了 `system`、`provider`、`extract`、`scan-terms`、`translate`、`batch`、`verify`、`assemble`，前幾輪又帶來 `engine`、`glossary`、`trial`、`sync` 等指令。

## 決定

1. prompt 列的指令全部保留。
2. `tome run` 一路跑到下一個人工關卡，各階段指令也能單獨執行。
3. 審定高影響譯名與確認估價兩個關卡不能跳過。
4. 試翻後要不要停由使用者設定。

## 後果

指令較多，要靠 `tome status` 指出下一步。

## 替代方案

**只有分階段指令**：每次要記得下一步；**只有估價確認**：譯名全部自動通過；**每個階段都停**：一鍵指令失去意義；都否決。
