---
id: ADR-0127
status: accepted
date: 2026-11-09
depends-on: [ADR-0054, ADR-0055, ADR-0059, ADR-0081, ADR-0082, ADR-0107, ADR-0111, ADR-0113, ADR-0115, ADR-0118, ADR-0119, ADR-0120, ADR-0122, ADR-0125]
amends: [ADR-0055, ADR-0113]
---

# ADR-0127：tome run

## 脈絡

ADR-0055 定了 `tome run` 一路跑到下一個人工關卡，各階段指令也能單獨執行；審定高影響譯名與確認估價兩個關卡不能跳過；試翻後要不要停由使用者設定。ADR-0113 第 22 項把它排成回合 032，第 23 項留下「`tome run` 停在關卡時的結束碼與 `--trial`」。ADR-0119 第 2 項與 ADR-0120 第 11 項把「還有待審的卡時停下」留給 032。

**現有程式**：各階段都是獨立指令，各自拿書的鎖，鎖住之後的本體是 `*Locked` 函式（翻譯是在鎖裡呼叫 `withRun`）；書的鎖不能在同一個流程裡再拿一次。重跑時做完的會跳過：解析沿用 document 層、Pass 0 回 `scan.nothing`、翻譯只送沒翻好的單位。Pass 0 不加 `--confirm` 只估價（ADR-0118 第 13 項），翻譯要先 `tome estimate --confirm`。待審的卡只提醒、不擋。批次翻譯在程式裡每 60 秒查一次，等到結束。`--budget`、`--chapters`、`--chapter-level` 由 `tome estimate` 寫進 `book.yaml`。試翻（`tome trial`）排在 M4。

開工前的 13 項問題寫在共用筆記 `brief-032-questions.md`，維護者在 2026-11-09 選定：第 2 項停下來確認 Pass 0，第 3 項結束碼 0 加警告，第 6 項分兩種，其餘照建議。實作時的細節寫在 `brief-032-details.md`，維護者在同一天選定：第 1 項（更正問題第 6 項的一個例子）選「停在翻譯」，其餘照建議（見第 6 項）。

## 決定

1. **`tome run <書>`** 從已經 `tome add` 過的書開始，依序：解析（`tome extract`）→ Pass 0 的估價 → **關卡一：審定**（還有 `proposed` 或 `failed` 的卡就停，請跑 `tome glossary review`）→ **關卡二：確認估價**（沒有確認、或確認的估價跟目前的不同就停，請跑 `tome estimate --confirm`）→ 翻譯（含驗證與重送）→ 輸出 vault（`tome assemble`）。不做 `tome add`、試翻、`tome sync`、`tome status` 的下一步（問題第 1 項）。
2. **Pass 0 停下來確認**（維護者選的，問題第 2 項）：Pass 0 有要送的（`scan.not_confirmed`），顯示估價就停，請使用者跑 `tome scan-terms <書> --confirm`；沒有要送的（`scan.nothing`）直接往下。`tome run` 不送 Pass 0。**修改 ADR-0055 第 3 項**：兩個關卡之外，Pass 0 的花費也要停下來確認，這一次只是確認花費，不是人工審定（G-3、ADR-0118）。
3. **停下時結束碼 0**（維護者選的，問題第 3 項）：加一個 `warn` 的 `run.stopped`，說下一步要跑哪個指令（`tome scan-terms <書> --confirm`、`tome glossary review <書>`、`tome estimate <書> --confirm`，用即時模式時加 `--realtime`）；`--json` 的 `data` 寫 `stopped_at`（`scan`、`review`、`estimate`）與 `next`。整條跑完是 `run.done`（`info`）。定案 ADR-0113 第 23 項的結束碼。
4. **032 不做試翻**（問題第 4 項）：不收 `--trial`（回「不認得的選項」）；`tome trial`、`--trial` 與「試翻後要不要停」（ADR-0055 第 4 項）照路線圖在 M4。定案 ADR-0113 第 23 項的 `--trial`。

   2026-11-12 由 ADR-0135 第 4 項修改：`tome run` 收 `--trial`，過了審定就顯示試翻的估價並停下，請使用者跑 `tome trial --confirm`。這一項的斷言移到 ADR-0135。
5. **批次翻譯等到結束**，跟 `tome translate` 一樣；中斷後再跑 `tome run` 會接回還在跑的批次（問題第 5 項）。
6. **某一步有問題時分兩種**（維護者選的，問題第 6 項）：
   * **沒做完就停在那裡**：解析、Pass 0、確認估價、輸出有 `fail` 的發現（例如 `extract.no_engine`、`estimate.over_budget`、`assemble.edited`），或翻譯停在半路（`translate.done` 以外的 `fail`：個資閘門擋下、超過預算、供應商失敗、沒有金鑰）。結束碼照那一步的發現，不加 `run.stopped`，`next` 是 `null`。
   * **做完了、有單位沒翻成**：翻譯跑完，只是有單位未通過驗證、遭拒答，或之前就被個資閘門擋下（`translate.done` 是 `fail`），照樣輸出 vault，交付報告列出這些單位，結束碼照翻譯那一步（1）。
   * 更正（細節第 1 項）：問題第 6 項的例子把「個資閘門擋下」列在第二種；實際上請求命中個資清單時翻譯就停了（`translate.ts` 的 `sendWork` 回 `blockedStop`，`drain` 遇到停止就結束），後面的單位沒送。**維護者在 2026-11-09 選「停在翻譯」**：個資閘門第一次擋下屬於第一種，`tome run` 停在翻譯、不輸出 vault；`tome translate` 的行為不變；之前就被擋下的 `BLOCKED` 單位跟未通過驗證、遭拒答的一樣照樣輸出。
7. **旗標**（問題第 7 項）：`tome run <書> [--budget <美元>] [--chapters <範圍>] [--chapter-level <層>] [--realtime]`。不收 `--confirm`、`--dry-run`：兩個關卡與 Pass 0 都用各自的指令過。`--budget`、`--chapters`、`--chapter-level` 在解析之後就驗證、寫進 `book.yaml`，停在前面的關卡也記得，之後的 `tome run` 沿用（細節第 8 項，白皮書 §6.1）。`--realtime` 給 Pass 0 與翻譯；模式是確認估價的一部分，跟確認時不同就停在關卡二。
8. **不自動跑 `tome sync`**（問題第 8 項）：vault 被改過時停在輸出（`assemble.edited`），訊息照現在的請先跑 `tome sync`（ADR-0125 否決了輸出前自動回收）。
9. **輸出**（問題第 9 項、細節第 6 項）：每一步開始前在 stderr 印一行（ADR-0111）。`findings` 依序放各步的發現，最後是 `run.stopped` 或 `run.done`；`--json` 的 `data` 是 `{ book, stages: [{ stage, data }], stopped_at, next }`，只列跑過的步驟，各步的 `data` 照它自己的指令。只印數量與指令（ADR-0059）。
10. **鎖與續跑**（問題第 10 項、細節第 7 項）：程式在 `src/core/pipeline.ts`。整條拿一次書的鎖，依序呼叫匯出的 `extractLocked`、`scanLocked`、`estimateLocked`、`assembleLocked`，翻譯拆出 `translateLocked`、`translateInBatchesLocked`；原本的指令改成「拿鎖再呼叫它們」，行為不變。中斷後再跑就從頭檢查，做完的步驟會跳過。
11. **金鑰到翻譯那一步才取**（細節第 3 項）：前面的步驟都不連網；沒有金鑰是 `key.missing`，停在翻譯。
12. 測試只用假的引擎與假的供應商，不對真的 API 發請求；不量真書，M3 收尾（034）用 `tome run` 跑公有領域的文本與規則書一章（問題第 11 項、ADR-0113 第 20 項）。

## 驗證

<!-- @assert-count target="src/core/pipeline.ts" symbol="finding('run.stopped', 'warn'" expected="1" reason="第 3 項：停在要人點頭的地方是警告，結束碼 0" -->
<!-- @assert-count target="src/core/pipeline.ts" symbol="scanLocked({ home, slug, mode, confirm: false })" expected="1" reason="第 2 項：tome run 不送 Pass 0，只估價" -->
<!-- @assert-count target="src/core/pipeline.ts" symbol="code !== 'translate.done'" expected="1" reason="第 6 項：翻譯跑完、只是有單位沒翻成時照樣輸出" -->
<!-- @assert-count target="src/core/pipeline.ts" symbol="force: false" expected="1" reason="第 8 項：不覆蓋改過的 vault" -->
<!-- @assert-count target="src/core/pipeline.ts" symbol="from './sync.ts'" expected="0" reason="第 8 項：不自動跑 tome sync" -->
<!-- @assert-count target="src/core/pipeline.ts" symbol="withBookLock(options.home, options.slug, () => runLocked(options))" expected="1" reason="第 10 項：整條拿一次書的鎖" -->
## 後果

一本加入過的書，反覆跑 `tome run` 並照它說的指令點頭，就能一路到 vault；每次停下都說明為什麼、下一步是什麼，結束碼 0，腳本分得出「等人」與「出問題」（後者是 1 或 2）。比白皮書寫的兩個關卡多停一次（Pass 0 的花費），換來第一次花錢前一定看過估價。批次翻譯期間 `tome run` 會一直等，最久 24 小時，要馬上拿到結果的用 `--realtime`。

## 替代方案

否決了下列做法：

* **Pass 0 在預算內就直接送**：第一次跑就花錢，使用者沒看過估價。**`tome run --confirm` 只確認 Pass 0**：同一個旗標在兩個指令裡管的東西不同（問題第 2 項）。
* **停在關卡時結束碼 1**：會跟真的出問題混在一起（問題第 3 項）。
* **先收一個不做事的 `--trial`**：會讓人以為有試翻（問題第 4 項）。
* **任何一步有 `fail` 就停**：翻譯跑完只是有單位沒翻成時拿不到 vault（問題第 6 項）。
* **輸出前自動跑 `tome sync`**：回收人工修改要人決定（ADR-0125）。
* **讓書的鎖可以重入**：要改 ADR-0054 的鎖，兩個同時跑的指令也要分得開；匯出各步鎖住之後的本體比較單純。

## Open Questions

- [ ] `tome status` 要不要指出下一步（ADR-0055 的後果），跟 `tome run` 用同一段判斷。
- [ ] 試翻（M4）加進來時，`--trial` 的停法與「試翻後要不要停」的設定。
