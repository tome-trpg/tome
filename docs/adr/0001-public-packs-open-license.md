---
id: ADR-0001
status: accepted
date: 2026-10-31
---

# ADR-0001：公開 repo 只附開放授權的規則包

## 脈絡

公開 repo 要附哪些規則包，取決於出版社政策。Call of Cthulhu、Delta Green、Trail of Cthulhu、Achtung! Cthulhu 都沒有涵蓋軟體的開放授權，Delta Green 的指南還明列不允許 AI 內容與翻譯（[佐證 §3.1](../research/2026-10-31-landscape.md#31-出版社政策)）。

## 決定

1. 公開 repo 只附 `generic`、`brp-orc`、`gumshoe-srd`。
2. 上述四個品牌系統走本機規則包，由 `tome system init` 從使用者自己的書產生，MUST NOT 進 repo。
3. 公開 repo MUST NOT 含有任何商業書籍的原文段落，使用者的書與衍生資料由 `.gitignore` 排除。

## 驗證

<!-- @assert-count target=".gitignore" symbol="*.pdf" min="1" comments="include" reason="使用者的書不進 repo" -->

## 後果

使用品牌系統的人要自己產生規則包，開箱體驗較差，但 repo 不會因為規則包內容被下架。

## 替代方案

**內建 prompt 列的四套規則包**：與出版社政策衝突，公開散布的風險最高；否決。
