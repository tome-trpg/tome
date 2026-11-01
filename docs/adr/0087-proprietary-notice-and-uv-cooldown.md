---
id: ADR-0086
status: accepted
date: 2026-11-01
depends-on: [ADR-0043, ADR-0077, ADR-0085]
amends: [ADR-0077, ADR-0085]
---

# ADR-0086：引擎的專有元件提示與 uv 的冷卻期

## 脈絡

ADR-0085 審 CUDA 版時看到，預設的 CPU 版也帶 Intel 的元件，第 10 項沒有涵蓋，留成 Open Question。維護者選定也要提示。

Intel 的元件是 torch 的 wheel 帶的，不是每個引擎都有，核心又不寫引擎的名字（ADR-0085 第 9 項），所以要由引擎自己宣告，`tome-engine/1` 得多一個欄位。

ADR-0085 列為還沒驗證的 Dependabot 行為，在 PR #11 合併後第一次跑出了結果，見量測一節。

下列決定由維護者在 2026-11-01 從問題介面選定。

## 決定

1. `tome-engine/1` 的 `license` 加選用的 `proprietary`：環境裡專有元件的名稱，至少一項。裝完引擎時列出來。核心只回代碼 `engine.proprietary`，文字在 `zh-TW.json`。沒有宣告就不提示。
2. Docling 宣告 `Intel oneMKL`，CPU 版與 CUDA 版都提示，訊息不分平台。Intel OpenMP 只在 Windows，不列。
3. 修改 ADR-0077 第 2 項：uv 的 patch 冷卻期也是 14 天，跟 `exclude-newer = "14 days"` 一致。minor 14 天、major 30 天不變，npm 與 Action 不變。

第 3 項是預防，不是修正：下面量到的失敗沒有一個是它造成的。直接相依的 patch 上架 7 到 13 天時，Dependabot 提得出來，`exclude-newer` 卻解析不出來，所以把兩邊對齊。

LGPL 的函式庫不提示，ADR-0085 的 Open Questions 維持待決。CUDA 版的提示維持原樣。

## 量測

**Linux 的 wheel 也帶 oneMKL。** ADR-0085 寫 Linux 看不出來。2026-11-01 用 HTTP range 讀 torch 2.14.1 的 `+cpu` 與 `+cu130` Linux x86_64 wheel：兩份 `libtorch_cpu.so` 都有 oneMKL 的版本字串與 `mkl_blas` 符號，wheel 裡沒有 `libiomp5`，也沒有獨立的 MKL 函式庫。這是看字串與檔名，沒有實際執行。

**Dependabot 第一次跑**，2026-11-01。ADR-0085 要等這次才看得到的行為有了答案：它重鎖得動這份鎖定檔，`exclude-newer-span` 也留著，但安全更新過不了 `exclude-newer`，跟 ADR-0085 第 1 項預期的一樣，要手動開例外。

| 工作 | 版本 | 上架 | 結果 | 原因 |
| :--- | :--- | :--- | :--- | :--- |
| 一般更新 | `docling-core` 2.102.0 | 14 天 | 開了 PR | 通過 |
| 一般更新 | `huggingface-hub` 2.1.1 | 30 天 | 失敗 | `docling-slim` 限制 `<2`，屬於正常 |
| 安全更新 | `setuptools` 84.1.0 | 12 天 | 失敗 | `exclude-newer` 擋下 |
| 安全更新 | `certifi` 2026.10.18 | 13 天 | 失敗 | `exclude-newer` 擋下 |
| 安全更新 | `pillow` 13.0.0 | 15 天 | 失敗 | `docling-core` 2.101.1 限制 `<13` |

安全更新不看冷卻期，所以第 3 項幫不上這三個，要另外處理。

**還沒驗證**：`conflicts` 與 `exclude-newer` 之下，Dependabot 遇到 7 到 13 天的 patch 會怎樣，這次的直接相依沒有碰到，第 3 項的理由來自設定本身。

## 驗證

<!-- @assert-count target="engines/docling/engine.yaml" symbol="proprietary: [Intel oneMKL]" expected="1" reason="第 2 項：Docling 宣告 Intel oneMKL" -->
<!-- @assert-count target="src/cli/messages/zh-TW.json" symbol="engine.proprietary" expected="1" reason="第 1 項：文字留在訊息檔" -->
<!-- @assert-absence target="src" glob="*.ts" symbol="Intel" comments="include" reason="第 1 項：核心不認得廠商，提示只來自宣告" -->
<!-- @assert-count target=".github/dependabot.yml" symbol="semver-patch-days: 14" expected="1" reason="第 3 項：uv 的 patch 跟 exclude-newer 一致" -->

## 後果

`tome-engine/1` 多一個欄位，舊的 `engine.yaml` 不受影響。名單要隨鎖定檔人工維護，沒有自動檢查，宣告可能過時。CPU 版安裝多一句提示。uv 的 patch 比 npm 慢一週。

## 替代方案

**訊息檔寫死一句，每次裝 uv 引擎都印**：不用改協定，但不用 torch 的引擎也會印，只能用「可能含」帶過；**核心認得 Intel**：違反 ADR-0085 第 9 項；**uv 維持 7 天**：跟 ADR-0077 一致，但那種版本出現時 Dependabot 會失敗一次；都否決。
