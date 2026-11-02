---
id: ADR-0107
status: accepted
date: 2026-11-02
depends-on: [ADR-0033, ADR-0038, ADR-0039, ADR-0054, ADR-0056, ADR-0062, ADR-0068, ADR-0081, ADR-0099, ADR-0103, ADR-0104]
amends: [ADR-0081, ADR-0099, ADR-0104]
---

# ADR-0107：Batch 與續跑的細節

## 脈絡

brief 019 開工前比對 ADR-0033、ADR-0054、ADR-0099 第 2、6、22 項與 ADR-0104，留下這些沒定的細節：一批多大、一次幾批、重送怎麼排、當機後怎麼認回批次、每種結果怎麼處理、`tome status` 與 `tome batch` 輸出什麼、Batch 的介面長什麼樣子。

維護者在 2026-11-02 選了先做 019 不需要 SDK 的部分，Batches API 的轉接層跟即時模式的轉接層一起移到 brief 022（`@anthropic-ai/sdk` 0.137.0 在 2026-11-03 22:23 UTC 才過冷卻期，ADR-0077）。所以 019 的批次流程只跟假供應商跑過。

Batches API 的行為以 2026-11-02 讀的官方文件為準（platform.claude.com 的 batch-processing、API reference 的 create、retrieve、results、cancel、delete、list，與 refusals-and-fallback）：

* `custom_id` 要符合 `^[a-zA-Z0-9_-]{1,64}$`，同一批內不能重複。結果的順序不保證跟送出順序相同。
* 一批最多 100,000 個請求或 256 MB。`processing_status` 只有 `in_progress`、`canceling`、`ended`。
* 每個請求的結果是 `succeeded`、`errored`、`canceled`、`expired`，後三種不收費。拒答是 `succeeded` 加上 `stop_reason: "refusal"`。
* 建立後 24 小時沒處理完就過期，結果從建立起算 29 天內可以下載。結束之後才能刪除，進行中的要先取消。
* 建立時沒有批次層級的標籤，`list` 從最新的開始列。`fallbacks` 在 Batch 不支援。文件沒有建議輪詢間隔，範例程式每 60 秒查一次。

下列決定都由維護者在 2026-11-02 從問題介面選定。字元上限、輪詢間隔與時鐘差都是**提案**，沒有量過。H-17 仍是**假說**，要等真實請求確認。

## 決定

**回合**

1. 修改 ADR-0104 第 19、45 項：Batch 對使用者開放的時間從 019 改成 022。019 的批次流程只有測試注入的轉接層跑得到，不帶 `--realtime` 的 `tome translate`、`--retry-failed` 與 `tome batch` 在 022 之前回 `translate.not_ready`。`tome --help` 加上 `status`，翻譯用的旗標與 `tome batch` 在 022 接上轉接層時一起列。
2. 修改 ADR-0099 第 2 項：`tome batch status|collect|cancel` 也在 019 做。這是擴大範圍，維護者在 2026-11-02 同意，依據是 ADR-0054 第 2 項、白皮書 §6.4 與 §8.1。

**分批**

3. 照閱讀順序累加整章的原文字元數，只算原文，跟每個請求的 6,000 字元同一種算法。加入下一章會超過上限時，先送出這一批。單一章超過上限時，才在請求的邊界切成幾批。請求仍不跨章（ADR-0103 第 10 項）。上限是 100,000 字元，是提案。分批不改變每個請求的內容與價格，上限不進內容指紋。
4. 修改 ADR-0081 第 2 項的做法：M2 一次只有一批在跑。送出、等結束、收回、驗證、刪除，再送下一批，每批的品質問題在下一批送出前就看得到。預算公式的「進行中」因此通常是 0。併發等 M4 試翻量過處理時間再決定。
5. 下一批依序放對半拆與換 `fallback_model` 的請求，照原樣不重組，再放 `PENDING`、`QUEUED` 的單位照閱讀順序組的請求，一起受上限。重送的請求不受「相鄰章節」限制。中斷在兩批之間時，記憶體裡的拆分會遺失，續跑照原本的大小重組，跟即時模式相同（ADR-0104 第 28 項）。

**預算與個資閘門**

6. 每批送出前檢查預算：`next` 是整批的估價上限加總，`in_flight` 是還沒收回的批次的估價。超過就整批不送並停下，保留進度，不縮小批次去湊剩下的預算。
7. 個資閘門在寫意圖紀錄之前逐一掃描每個請求。命中的請求的單位標成 `BLOCKED`，其他單位留在 `QUEUED`，整批不送並停下，只回報命中次數（ADR-0081 第 4 項、ADR-0104 第 9 項）。`guardedFetch` 照樣掃描序列化後的整批內容，當最後一關，萬一在那裡才擋下，整批的單位都標成 `BLOCKED`。

**意圖紀錄與認回（H-17）**

8. 意圖紀錄、批次與單位的對應、單位改成 `IN_FLIGHT`，在同一個交易寫進 `book.db`，之後才呼叫建立。建立的請求有收到回應就照實記下：成功記遠端 ID，失敗代表沒有建立，單位放回佇列。沒有收到回應時不知道有沒有建立，留著意圖紀錄。
9. 續跑時遇到沒有遠端 ID 的意圖紀錄，從最新的批次往回列，到建立時間早於意圖時間減 10 分鐘為止。10 分鐘是本機與伺服器的時鐘差，是提案。候選是這本書還沒記錄過、請求總數跟意圖相同的批次，取最早的一個認回來，照常等它結束。收回結果時每個 `custom_id` 都要帶著這次意圖的隨機碼，對不上就不是這本書的批次：不採用它的結果，也不刪除它，再找下一個候選。沒有候選就當成沒有送出，意圖標成放棄，單位放回佇列。
10. `custom_id` 是 `tome-<16 個十六進位的隨機碼>-<請求序號>`。隨機碼每個意圖一個。不放書名、`slug` 或單位 ID，`slug` 預設取自 PDF 檔名，可能就是書名。

**資料表**

11. `book.db` 的遷移第 6 版加兩張表。`batch` 是 `id`、`nonce`（唯一）、`remote_id`（唯一，可以是空的）、`state`（`intent`、`submitted`、`collected`、`abandoned`）、`requests`、`high_usd`、`created_at`、`submitted_at`、`expires_at`、`ended_at`、`collected_at`、`deleted_at`。`batch_unit` 是 `batch_id`、`custom_id`、`position`、`unit_id`、`model`，`position` 是單位在請求裡的位置，`<s id>` 是它加 1，`model` 是這個請求用的模型。一個單位同時只會在一個沒收回的批次裡，收回時以「單位還在 `IN_FLIGHT`」判斷這個請求套用過沒有，中斷在收回到一半時再下載一次結果，跳過已經套用的請求。

**輪詢與 API 呼叫**

12. 每 60 秒查一次，是提案。TOME 不另外設逾時，批次最晚在建立後 24 小時結束。等待時每次在 stderr 印一行，不影響 `--json` 的 stdout。查詢、下載結果、取消、刪除、列出的重試跟即時模式相同：只重試 429、5xx 與網路錯誤，最多 5 次，退避 1、2、4、8、16 秒（ADR-0104 第 11 項）。重試用完就停下，批次留在紀錄裡，下次執行接著做。

**每個結果怎麼處理**

13. 依結果處理：

| 結果 | 處理 |
| :--- | :--- |
| `succeeded`，正常結束 | 跟即時模式相同：先存回應、記帳，再驗證，失敗的回佇列 |
| `succeeded`，`stop_reason` 是 `max_tokens` | 跟即時模式相同：對半拆，排進下一批，沒得拆是 `FAILED_QA`，照樣記帳 |
| `succeeded`，`stop_reason` 是 `refusal` | 跟即時模式相同：先對半拆，拆到一個單位再換 `fallback_model`，都不行是 `REFUSED`，照樣記帳 |
| `errored`：`rate_limit_error`、`timeout_error`、`api_error`、`overloaded_error` | 不收費，單位放回佇列，下一批重送 |
| `errored`：其他種類 | 不收費，單位放回佇列。這批套用完、刪除遠端之後停下，回報錯誤種類，重送也會一樣失敗 |
| `expired`、`canceled` | 不收費，單位放回佇列，下一批重送 |
| 結果裡沒有的 `custom_id` | 當成可以重送的錯誤 |
| 不認得的 `custom_id` | 忽略 |

14. 一批收回之後一個 `succeeded` 都沒有時就停下回報，不在同樣的錯誤上一直繞。`attempts` 照 ADR-0104 第 27、35 項，只算模型回了譯文的次數，`errored`、`expired`、`canceled` 不算。結果超過保留期限下載不到時，單位放回佇列，警告重送要再付一次錢。

**刪除遠端資料**

15. 整批的結果都套用進 `book.db` 之後才刪除（ADR-0033 第 2 項），成功記 `deleted_at`。刪除失敗只警告，下次執行 `tome translate` 或 `tome batch collect` 時再試。取消或過期的批次也一樣要刪。第 9 項認錯的批次不刪。

**即時與批次混用**

16. 批次模式開頭先處理沒收回的批次與沒有遠端 ID 的意圖。`tome translate --realtime` 遇到它們時停下，回報 `batch.pending`，請使用者先 `tome batch collect` 或 `tome batch cancel`，否則同一段要付兩次。開頭的收尾只把不屬於任何沒收回批次的 `IN_FLIGHT` 放回佇列。

**指令**

17. `tome batch` 三個指令都要拿書的鎖（ADR-0054 第 5 項），`tome translate` 正在等批次時，要先 Ctrl-C 才能取消：
    * `tome batch status <book>`：查這本書每個沒收回的批次在供應商那邊的狀態，不等待，不改本機狀態。
    * `tome batch collect <book>`：先處理沒有遠端 ID 的意圖，等沒收回的批次結束，收回、驗證、刪除，不送新的批次。不要求確認估價，因為不花新的錢，估價確認之後內容又改了的時候，也還能把已經付費的結果收回來。
    * `tome batch cancel <book>`：對沒收回的批次要求取消，不等待。之後收回時，已經處理完的請求照常套用，取消的放回佇列。
18. `tome status <book>` 只讀 `book.db` 與 `book.yaml`，不連網，不拿書的鎖，`tome translate` 在等批次時也能用。只有數字，不含書本文字：單位數、花費與預算、每個沒收回的批次、還沒刪除遠端資料的批次數。還沒有單位時請使用者先執行 `tome estimate`。不重算內容指紋，所以不顯示估價是否仍有效。`--json` 的 `data` 是 `book`、`units`（9 種狀態各幾個）、`spent_usd`、`budget_usd`、`batches`（每批的 `remote_id`、`state`、`requests`、`submitted_at`、`expires_at`、`deleted`）。

**介面**

19. 修改 ADR-0104 第 39 項與白皮書 §5.7 的提案：`LLMProvider` 加 `submitBatch`、`pollBatch`、`collectBatch`、`cancelBatch`、`deleteRemote`、`listBatches`，由 022 的轉接層實作。`RemoteBatch` 是 `id`、`status`、`requests`、`createdAt`、`expiresAt`、`endedAt`。`BatchItem` 是 `customId` 加上結果：`succeeded` 轉成既有的 `RequestResult`，另外有 `errored`（帶錯誤種類）、`expired`、`canceled`。解析結果的函式放核心，跟 `messageResult` 一樣，轉接層不用自己判斷拒答與截斷。意圖由核心寫，轉接層沒有 `intent` 參數。`capabilities` 先不加，M2 只有 Anthropic，第二家供應商進來時再加。

**外送紀錄**

20. 沒有本文的查詢、下載、取消、刪除、列出照樣寫外送紀錄，大小是 0，ADR-0104 第 2 項的行為不變。建立批次的紀錄，`model` 讀每個請求的 `params.model`，只有一種就記那個，有多種就用逗號連起來。

**模組與代碼**

21. 模組是 `src/core/batch.ts`（批次的送出、輪詢、收回、刪除、認回）與 `src/core/status.ts`（`tome status`），分批的函式放 `src/core/request.ts`，即時與批次共用的收回、驗證、記帳、拒答、截斷留在 `src/core/translate.ts`。新的發現是 `batch.budget_exceeded`、`batch.recovered`、`batch.not_sent`、`batch.errored`、`batch.archived`、`batch.delete_failed`、`batch.pending`、`batch.status`、`batch.canceling`、`batch.none`、`status.units`、`status.spent`、`status.no_budget`、`status.batch`、`status.not_deleted`、`status.no_units`。進度多 `batch_sent`、`batch_wait`。`tome batch collect` 的結果沿用 `translate.done`，`--json` 的 `data` 多一個 `batches`。`translate.not_confirmed` 的 `flags` 在批次模式是 `--confirm`。

**測試**

22. 當機注入（白皮書 §8.4、Q-7）：測試用 `vi.mock` 包住 `book.db` 的存取層，第 N 次寫入時丟出錯誤模擬當機，交易整個回滾，跟真的當機一樣。N 從 1 跑到整個流程的寫入次數，每次中斷後重跑到完成，檢查已經 `DONE` 的單位之後沒有再出現在任何請求裡，帳本沒有替已驗證的單位重複記帳。即時與批次兩種模式都跑，批次另外在「供應商已建立、還沒回應」這一步中斷，走第 9 項的認回。正式程式不加測試用的掛勾。

**不放進 019 的**

23. ADR-0106 的 Open Question、併發送出多批、把對半拆的狀態存進 `book.db`、依處理時間調整輪詢間隔。

## 驗證

<!-- @assert-present file="src/core/batch.ts,src/core/status.ts,tests/cli/batch.test.ts,tests/cli/crash.test.ts,tests/helpers/fake-provider.ts" -->
<!-- @assert-count target="src/cli/run.ts" symbol="path: ['batch', 'cancel']" expected="1" reason="第 2 項：tome batch 在 019" -->
<!-- @assert-count target="src/core/request.ts" symbol="BATCH_CHARS = 100_000" expected="1" reason="第 3 項：一批 100,000 字元，是提案" -->
<!-- @assert-count target="src/core/batch.ts" symbol="overBudget(run, high)" expected="1" reason="第 6 項：每批送出前檢查預算" -->
<!-- @assert-count target="src/core/batch.ts" symbol="markBlocked(run, work.request.units, hits, ['block'])" expected="1" reason="第 7 項：閘門逐一掃描每個請求" -->
<!-- @assert-count target="src/core/llm.ts" symbol="status !== null && retryable(status)" expected="1" reason="第 8 項：沒收到回應的建立不重送" -->
<!-- @assert-count target="src/core/batch.ts" symbol="CLOCK_SKEW_MS = 10 * 60 * 1000" expected="1" reason="第 9 項：時鐘差 10 分鐘，是提案" -->
<!-- @assert-count target="src/core/batch.ts" symbol="return `tome-${nonce}-${index + 1}`;" expected="1" reason="第 10 項：custom_id 只有隨機碼與序號" -->
<!-- @assert-count target="src/core/store.ts" symbol="CREATE TABLE batch_unit" expected="1" reason="第 11 項：遷移第 6 版" -->
<!-- @assert-count target="src/core/batch.ts" symbol="POLL_SECONDS = 60" expected="1" reason="第 12 項：每 60 秒查一次，是提案" -->
<!-- @assert-count target="src/core/llm.ts" symbol="['rate_limit_error', 'timeout_error', 'api_error', 'overloaded_error']" expected="1" reason="第 13 項：這幾種錯誤才重送" -->
<!-- @assert-count target="src/core/batch.ts" symbol="run.llm.deleteRemote(remoteId)" expected="1" reason="第 15 項：收回之後刪除遠端資料" -->
<!-- @assert-count target="src/core/translate.ts" symbol="refusePending: true" expected="1" reason="第 16 項：即時模式遇到沒收回的批次就停下" -->
<!-- @assert-count target="src/core/batch.ts" symbol="confirm: false" expected="1" reason="第 17 項：tome batch collect 不要求確認估價" -->
<!-- @assert-absence target="src/core/status.ts" symbol="withBookLock" reason="第 18 項：tome status 不拿書的鎖" -->
<!-- @assert-absence target="src/core/status.ts" symbol="connect(" reason="第 18 項：tome status 不連網" -->
<!-- @assert-absence target="src/core/llm.ts" symbol="capabilities" reason="第 19 項：capabilities 先不加" -->
<!-- @assert-count target="src/core/ledger.ts" symbol="SELECT 1 FROM ledger WHERE request_id = ?" expected="1" reason="收回到一半中斷時，同一筆費用只記一次" -->

## 後果

022 合併之前，使用者打 `tome translate` 不會真的送出批次。一次一批讓全書要等的輪數等於批數，大的書要等比較久。認回批次靠請求總數、時間與 `custom_id` 的隨機碼，伺服器端的列表若有延遲，可能重送一整批，要等真實請求才知道。中斷在兩批之間時，被拒的請求可能再被拒一次。

## 替代方案

**50,000 或 200,000 字元一批**：前者批次多、要等的輪數多，後者預算擋下的顆粒粗、品質晚看到；**預算允許時全部送出**：跟 ADR-0033 否決的「整本書一批」一樣，要到最後才知道品質；**縮小批次去湊剩下的預算**：跟即時模式的「超過就停」不一致；**沒有遠端 ID 就當成沒送出**：可能重複付一整批；**停下來要使用者處理**：使用者沒有資訊可以判斷；**只比對請求總數與時間**：同一個工作區的其他書剛好同時中斷時會認錯，認錯的批次還會被刪掉；**即時模式自動等批次收完**：可能要等到 24 小時；**`status` 併進 `tome status`**：`tome status` 不連網，看不到供應商那邊的狀態；**沒有本文的請求不寫外送紀錄**：看不出 TOME 連過供應商幾次；都否決。

## Open Questions

- [ ] 一批 100,000 字元、輪詢 60 秒、時鐘差 10 分鐘，都要等真實請求量過。
- [ ] H-17：伺服器端的列表會不會晚於建立的回應出現，要等 022 之後的真實請求確認。
