---
id: ADR-0093
status: accepted
date: 2026-11-01
depends-on: [ADR-0077, ADR-0085]
amends: [ADR-0085]
---

# ADR-0093：setup-uv 的版本跟著 Dependabot 更新

## 脈絡

ADR-0085 第 8 項指定 `astral-sh/setup-uv` 用 v10.3.0，驗證也綁住那個 commit。Dependabot 依 ADR-0077 在 PR #12 提出 10.3.2 時，`spec-guard` 在 Ubuntu 與 Windows 都失敗，原因是斷言找不到舊的 commit。

這個失敗沒有擋下任何風險。ADR-0077 要求 Action 釘在 commit，版本由 Dependabot 依冷卻期更新。斷言綁住特定 commit，每次升版都會失敗。

下列決定由維護者在 2026-11-01 從問題介面選定。

## 決定

1. 修改 ADR-0085 第 8 項：`astral-sh/setup-uv` 的版本跟著 Dependabot 更新（ADR-0077），不再由 ADR 指定。ADR-0085 寫的 v10.3.0 是當時的版本。
2. 這個 Action 仍然 MUST 釘在 commit（ADR-0077 第 3 項）。
3. ADR-0085 的斷言移到這份 ADR，改成只檢查有沒有釘 40 位的 commit。

## 驗證

<!-- @assert-count target=".github/workflows/engine.yml" regex="true" symbol="astral-sh/setup-uv@[0-9a-f]{40}" expected="1" reason="第 2 項：Action 釘在 commit，版本由 Dependabot 更新" -->

## 後果

升 `setup-uv` 不用再改 ADR。斷言只看得出有沒有釘 commit，看不出釘的是不是那個版本的 commit，這要靠審查 Dependabot 的 PR。

## 替代方案

**只改斷言，不寫 ADR**：比較快，但 ADR-0085 第 8 項的 v10.3.0 會過時，也等於改寫已定案的決定；**每次升版都手動改斷言**：沒有多擋下風險，只多一道手續；都否決。
