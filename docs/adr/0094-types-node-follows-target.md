---
id: ADR-0094
status: accepted
date: 2026-11-01
depends-on: [ADR-0052, ADR-0077]
amends: [ADR-0077]
---

# ADR-0094：@types/node 的 major 跟著目標 Node 版本

## 脈絡

TOME 的最低版本是 Node 24（ADR-0052）。Dependabot 依 ADR-0077 在 PR #13 提出把 `@types/node` 從 24 升到 26。型別的 major 對應 Node 的 major，升上去之後，型別檢查會放行 Node 24 沒有的 API。

下列決定由維護者在 2026-11-01 從問題介面選定。

## 決定

1. 修改 ADR-0077 第 1 項：`@types/node` 的 major 不走 Dependabot，跟著 TOME 的最低 Node 版本（ADR-0052）。minor 與 patch 照常更新。
2. `.github/dependabot.yml` 用 `ignore` 擋下這個套件的 major 更新。

## 驗證

<!-- @assert-count target=".github/dependabot.yml" symbol="dependency-name: '@types/node'" expected="1" reason="第 2 項：@types/node 的 major 不走 Dependabot" -->
<!-- @assert-count target=".github/dependabot.yml" symbol="- version-update:semver-major" expected="1" reason="第 1 項：只擋 major，minor 與 patch 照常更新" -->

## 後果

提高最低 Node 版本時，`@types/node` 要手動一起升，Dependabot 不會提醒。

## 替代方案

**每次手動關掉 PR**：每個新的 major 都會再提一次；**在 PR 留言叫 Dependabot 忽略**：規則不在 repo 裡，也看不到是誰決定的；都否決。
