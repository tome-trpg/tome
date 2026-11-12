---
id: ADR-0132
status: accepted
date: 2026-11-12
depends-on: [ADR-0033, ADR-0059, ADR-0068, ADR-0082, ADR-0107, ADR-0111, ADR-0118, ADR-0123, ADR-0127, ADR-0129, ADR-0130]
amends: [ADR-0123, ADR-0127]
---

# ADR-0132：四個顯示問題的修正與停在 M2 的文字

## 脈絡

M3 收尾時，維護者跑 `tome run` 看到四個顯示問題，記在 ADR-0129 第 10 項：

* (a) 即時模式的估價訊息仍印「批次資料最多在供應商端保留 29 天」。
* (b) `tome run` 把分章層級與預算那兩行各印兩次。
* (e) 翻譯的批次編號接著 Pass 0 算，規則書的翻譯從「第 4 批」開始。
* (f) `tome report` 在花費超過上限時印「落在估價區間的 199%」。

ADR-0130 第 10、21 項把它們跟白皮書、README 停在 M2 的文字排進回合 042，第 22 項列了開工前要問的：保留期說法、批次編號、白皮書與 README 改到什麼程度。

查到的事實（共用筆記 `brief-042-questions.md`）：

* (a) `estimate.done` 與 `scan.estimate` 不分模式，都接保留期那一句；天數來自 `providers/anthropic.yaml` 的 `retention_days`，那是 Batch 的天數。即時模式的保留期，供應商設定檔、schema 與白皮書都沒有登記。DC-3 的表也只有 Batch。
* (b) `tome run` 把每一步的發現接在一起印：解析與翻譯的估價都印分章層級，Pass 0 與翻譯的估價都印預算。`--chapter-level` 在解析之後才寫進 `book.yaml`，所以同一次換了層級時，解析那一步印的是舊的層級。兩次估價也都印價目表過期的警告。
* (e) 進度印的是 `batch` 表的列號，Pass 0 與翻譯共用這張表。續跑時接著等上一次的批次，印的也是列號。每次執行只會送一個階段。
* (f) 位置 ＝（花費 − 下限）÷（上限 − 下限）。用 M3 的數字套：規則書翻譯印 199%（實際超出上限 38%），規則書 Pass 0 印 -7%（實際低於下限 4%），公有領域 Pass 0 實際略低於下限，卻四捨五入成看似在區間內的 0%。

維護者在 2026-11-12 把 7 項全部照建議選定。

## 決定

**保留期（(a)）**

1. 保留期從 `estimate.done` 與 `scan.estimate` 拆成自己的發現，依模式各一個代碼，翻譯與 Pass 0 共用：
   * 批次模式是 `estimate.retention`，照舊印「批次資料最多在供應商端保留 {retention} 天」。
   * 即時模式是 `estimate.retention_realtime`，不帶參數，說即時模式不經過批次、TOME 沒有登記即時模式的保留期、以供應商的政策為準。
   * 沒有要送的（`estimate.nothing`、`scan.nothing`）不印。

   即時模式的天數沒有查證過的來源，寫數字就是沒量測的主張（ADR-0068）。要不要在供應商設定檔登記即時模式的天數，跟 049 重新查證價目表時一起看。`estimate.done` 與 `scan.estimate` 的 `params` 因此不再有 `retention`；`--json` 的 `data.retention_days` 不變，外層不變（ADR-0082 第 11 項）。

**`tome run` 的重複（(b)）**

2. 修改 ADR-0127 第 9 項：`tome run` 的 `findings` 照樣依序放各步的發現，但代碼、等級、參數都相同的只留最後一次；`chapters.levels` 不論參數只留最後一次。所以預算與分章層級出現在翻譯的估價旁邊，是這次寫進 `book.yaml` 之後的值。單獨的指令不變，`data.stages` 裡各步的 `data` 也不變。

**批次編號（(e)）**

3. 批次的進度改成這次執行送出的第幾批，從 1 算起，供應商確認收到才加一，並附上預計的批數：
   * 翻譯：每送一批，照當時的佇列（含重送）用 `planBatches` 重算，預計的批數 ＝ 這次已送出的批數 ＋ 剩下的批數。重送讓批數變多時，數字跟著變大。
   * Pass 0：每一輪把剩下的全部放進同一批，所以預計的批數就是到這一批為止，有重送時下一輪再加一。
   * 續跑時接著等上一次送出的批次，不給編號，印「上次送出的一批」。
   * 計數跟 `run.batches` 分開，`--json` 的 `data.batches` 照舊。
   * 進度文字：「已送出第 {batch} 批（預計共 {planned} 批），含 {requests} 個請求。」「第 {batch} 批處理中，已等待 {minutes} 分鐘。」「上次送出的一批處理中，已等待 {minutes} 分鐘。」

**花費與估價（(f)）**

4. 修改 ADR-0123 第 5 項：`tome report` 與交付報告不再寫「落在估價區間的百分比」，改成分情況說：

   | 情況 | 寫法 | `tome report` 的代碼 |
   | :--- | :--- | :--- |
   | 花費高於上限 | 超出上限 38%（＝ 花費 ÷ 上限 − 1） | `report.estimate_over` |
   | 在區間內（含上下限） | 在估價區間內（65% 處） | `report.estimate` |
   | 低於下限 | 低於下限 4%（＝ 1 − 花費 ÷ 下限） | `report.estimate_under` |
   | 超出或低於不到 1% | 超出上限不到 1%、低於下限不到 1% | `report.estimate_over_small`、`report.estimate_under_small` |
   | 還沒有花費 | 尚無花費 | `report.estimate_none` |
   | 區間寬度是 0、花費剛好等於它 | `-` | `report.estimate` |

   * 百分比四捨五入到整數；「不到 1%」看的是沒有四捨五入的值。
   * 先比上限與下限，再看位置：區間寬度是 0 時，花費高於或低於它照樣說超出或低於，只有剛好等於時才是 `-`。
   * 交付報告估價表的欄名「落在估價區間」改成「與估價相比」，值用上表的寫法。
   * `--json` 的 `data.estimates[].position` 不變，照樣是原本的數字。

**文件**

5. 白皮書停在 M2 的 6 處照事實改寫：Pass 0 提示與實體卡已實作（ADR-0118 到 ADR-0120）；即時模式由維護者用真的 API 翻過一篇公有領域短篇（ADR-0129 第 4 項）；`book.db` 第 14 版、`series.db` 第 3 版的表；估價的真實數據改成 M2、M3 兩次的摘要，仍然只有 Sonnet 5.5、仍是未校準（ADR-0112、ADR-0129）。第 1 到 4 項寫進對應的「已實作」段落。這幾段是「已實作」的現況描述，前面每個回合都跟著自己的 PR 更新。
6. `README.md` 與 `README.en.md` 一起改狀態那一段與「開發進度」表，結構不動：已能輸出 Obsidian 的 vault，補上 M3 的指令，翻譯的批次與即時模式都用真的 API 跑過、只用過一個模型。安裝與發佈的段落留給 049（ADR-0130 第 18 項）。
7. 改的都是給人看的文字與進度，記進 CHANGELOG「尚未發布」的「變更」一節。翻譯、估價、預算與分批的行為都不變；不加遷移，不改提示、語言設定檔、規則包、schema 與變異測試的設定。訊息只帶數字（ADR-0059）。

## 驗證

<!-- @assert-count target="src/cli/messages/zh-TW.json" symbol="estimate.retention_realtime" expected="1" comments="include" reason="第 1 項：即時模式的保留期是自己的發現" -->
<!-- @assert-count target="src/cli/messages/zh-TW.json" symbol="批次資料最多在供應商端保留 {retention} 天" expected="2" comments="include" reason="第 1 項：只剩 estimate.retention 與 provider.listed，估價的訊息不再接這一句" -->
<!-- @assert-count target="src/core/pipeline.ts" symbol="findings: once([...findings, ...last])," expected="1" reason="第 2 項：tome run 的發現只留最後一次" -->
<!-- @assert-absence target="src/core/batch.ts" symbol="onBatchSent?.(row.id" reason="第 3 項：進度不印 batch 表的列號" -->
<!-- @assert-absence target="src/core/scan.ts" symbol="onBatchSent?.(row.id" reason="第 3 項：Pass 0 的進度也不印列號" -->
<!-- @assert-count target="src/cli/messages/zh-TW.json" symbol="落在估價區間" expected="0" comments="include" reason="第 4 項：不再寫落在估價區間的百分比" -->
<!-- @assert-count target="src/cli/messages/zh-TW.json" symbol="與估價相比" expected="1" comments="include" reason="第 4 項：交付報告的欄名" -->

## 後果

即時模式的估價不再給一個不屬於它的天數，但也沒有給天數；DC-3 的「同時顯示資料保留期」在即時模式只做到提醒。`tome run` 的輸出少了重複的行，預算與分章層級出現在翻譯的估價旁邊。批次的進度看得出這次送了幾批、大概還有幾批，預計的批數在有重送時會變大。交付報告直接說超出或低於多少，M3 那種 199% 與看似在區間內的 0% 不會再出現。

`--json` 的使用者要注意三件事：`estimate.done` 與 `scan.estimate` 的 `params` 少了 `retention`；`tome report` 的估價依情況換代碼；`tome run` 的 `findings` 少了重複的項目。`data` 的欄位都不變。

## 替代方案

否決了下列做法：

* **即時模式完全不提保留期**：少了 DC-3 要的提醒。
* **查證 Anthropic 一般 API 的保留政策，在供應商設定檔與 schema 加即時模式的天數**：要動 schema 與供應商設定檔，跟 049 重新查證價目表一起做比較合適。
* **只處理 `chapters.levels` 與 `estimate.budget` 兩個代碼**：價目表過期的警告到時候還是會印兩次。
* **批次只從 1 算起，不印預計批數**：看不出還要等多久。
* **預計批數只在開始時算一次**：有重送時會出現「第 5 批（預計共 4 批）」。
* **只改超出上限，低於下限照舊印負的百分比**：-7% 一樣難讀，0% 還會被誤讀成在區間內。
* **README 只改錯的三句，或全部留給 049**：README 是外人第一個看到的地方，狀態與功能表會再錯幾個回合。

## Open Questions

- [ ] 即時模式的資料保留期要不要查證、登記在供應商設定檔，跟 049 重新查證價目表時一起看（第 1 項）。
