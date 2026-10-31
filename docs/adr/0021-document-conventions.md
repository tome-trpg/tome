---
id: ADR-0021
status: accepted
date: 2026-10-31
---

# ADR-0021：文件慣例

## 脈絡

文件要能被機器驗證，工具只讀英文的狀態字與關係。

## 決定

1. 白皮書用 arc42、C4、BCP 14、成熟度標籤，以輪次討論。
2. 每個架構決策一份 ADR，放 `docs/adr/`，檔名 `NNNN-kebab-title.md`，編號永不重用。
3. front matter 一律英文：`id`、`status`、`date`，關係寫 `depends-on`、`amends`、`supersedes`。
4. 正文繁體中文，固定段落是脈絡、決定、後果、替代方案，有可驗證規則時加「驗證」。
5. 待決事項放在英文標題 `## Open Questions` 之下。
6. 決策改變時新增一份 ADR，不改寫歷史。

## 驗證

<!-- @assert-present file="docs/adr,docs/WHITEPAPER.md" -->
<!-- @assert-structure target="docs/adr" pattern="[0-9][0-9][0-9][0-9]-*.md" reason="ADR 檔名是四位數流水號加 kebab 標題" -->

## 後果

寫 ADR 多一步，換來引用不會悄悄斷掉。

## 替代方案

**MADR**：英文段落標題較多，跟繁中正文混在一起；**簡化白皮書**：主張是否有佐證就看不出來；都否決。
