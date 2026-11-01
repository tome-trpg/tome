---
id: ADR-0090
status: accepted
date: 2026-11-01
depends-on: [ADR-0085, ADR-0088]
amends: [ADR-0085, ADR-0088]
---

# ADR-0090：引擎協定的實作細節定案

## 脈絡

brief 005 與 009 實作時定了幾個細節，當時沒有先問，留成提案。維護者在 2026-11-01 從問題介面全部接受。

## 決定

1. 引擎的 manifest 多 `pdf_sha256`、`data_dir`、`config_hash` 三個欄位。
2. 安裝紀錄是引擎資料夾裡的 `install.json`。
3. 頁面輸出的檔名是 `p0123.json` 的形式。
4. 設定雜湊的輸入是轉接器與鎖定檔的內容、裝置、來源語言。
5. 引擎的事件只是進度，算數的是檔案。
6. 引擎失敗的原因代碼是 `conversion_failed`、`out_of_memory`、`invalid_output`、`no_output`、`engine_crashed`、`engine_not_found`、`timeout`。
7. `tome extract` 每 10 頁在 stderr 報一次進度。
8. CI 的 uv 釘在 0.13.5。
9. Docling 標籤對核心角色的對照表寫在轉接器裡，沒列到的當段落。
10. ADR-0088 第 2 項的例外用相對期間 `7 days`，取 ADR-0077 的 patch 冷卻期。這結束了 ADR-0088 的第一個 Open Question。

## 驗證

<!-- @assert-count target="engines/docling/pyproject.toml" regex="true" symbol="certifi = .7 days." expected="1" reason="第 10 項：例外用相對期間" -->
<!-- @assert-count target=".github/workflows/engine.yml" symbol="version: '0.13.5'" expected="1" reason="第 8 項：CI 的 uv 釘版本" -->
<!-- @assert-count target="src/core/extract.ts" symbol="'invalid_output'" expected="1" reason="第 6 項：原因代碼" -->

## 後果

這些細節之後要改，就走新的 ADR。

## 替代方案

**維持提案**：實作已經合併，之後的回合會建立在這些細節上，留成提案只是延後決定；否決。
