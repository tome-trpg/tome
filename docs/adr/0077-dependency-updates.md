---
id: ADR-0077
status: accepted
date: 2026-11-01
depends-on: [ADR-0016]
---

# ADR-0077：相依更新有冷卻期

## 脈絡

上架頭幾天就被撤回或遭入侵的版本，不該自動進來。LiteLLM 2026-03 就是這類事件。

## 決定

1. Dependabot 更新相依與 Action，走 PR。
2. 冷卻期：patch 7 天、minor 14 天、major 30 天，安全更新不等。
3. Action 全部釘在 commit，簽出不保留 token，安裝用 `--ignore-scripts`。

## 後果

新版本晚一點才用得到。

## 替代方案

**手動更新**：容易忘記，也容易落後太多；否決。
