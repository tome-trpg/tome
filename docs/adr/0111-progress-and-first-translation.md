---
id: ADR-0111
status: accepted
date: 2026-11-07
depends-on: [ADR-0060, ADR-0068, ADR-0085, ADR-0086, ADR-0089, ADR-0090, ADR-0100, ADR-0102, ADR-0104, ADR-0107, ADR-0109]
amends: [ADR-0090, ADR-0102]
---

# ADR-0111：長時間指令的進度與第一次真實翻譯的回饋

## 脈絡

維護者在 2026-11-07 第一次自己跑 `tome extract`，20 頁的公有領域 PDF，Docling CPU 版。指令開始後畫面完全沒有輸出，看不出是在跑還是卡住。原因有兩個：

* `tome-engine/1` 只有 `page` 與 `done` 兩種事件，引擎啟動、載入模型時 TOME 收不到事件。
* `tome extract` 每 10 頁才印一次進度（ADR-0090 第 7 項）。

維護者選了全面檢查：其他可能跑很久的指令也查一次，找出沒有輸出的空檔。查過的結果：

| 指令 | 沒有輸出的空檔 | 最長多久 |
| :--- | :--- | :--- |
| `tome extract` | 引擎啟動到第 10 頁做完 | Docling CPU 版：30 頁雙欄文字含啟動 61 秒；12 頁、每頁 3 個表格含啟動 170 秒，每頁約 14 秒，前 10 頁可能超過 2 分鐘（ADR-0085） |
| `tome extract` | 每 10 頁之間、組裝 document 層 | 每頁 1.3–2.0 秒時 13–20 秒（ADR-0092）；組裝沒有量過 |
| `tome add`、`tome probe` | 整個探測 | 合成書 400 頁約 2.2 秒、1,200 頁約 14 秒（Q-9 的量測） |
| `tome translate --realtime` | 第一個請求回來之前 | 沒有量過 |
| 所有連到供應商的呼叫 | 重試的退避 | 1＋2＋4＋8＋16＝31 秒，`retry-after` 更長時照它 |

批次的輪詢每分鐘已經印一行，`tome engine add` 每個階段前也有一行。`tome estimate`、`tome verify`、`tome preview`、`tome status` 只讀本機資料，`tome verify` 載入 OpenCC 詞表在本機量過是 78 毫秒，都不用補。

同一天維護者用 Sonnet 5.5、批次模式，第一次以真的 API 翻譯了一本公有領域的短篇小說：127 個單位，完成 126 個，花費 $0.1924，落在估價 $0.16 至 $0.26 之間。這次翻譯冒出三個問題：

* **長度下限太嚴**：`zh-TW` 的 `min_length_ratio` 是 0.3，當時還是提案（ADR-0102 第 10 項）。1 句自然的譯文因為 `too_short` 重試 3 次後成了 `FAILED_QA`，另有 2 句重試後才過，共多付 5 個單位的請求。
* **單位數的說法不一致**：估價說 117 個翻譯單位，翻譯完成說共 127 個。差的 10 個是場景分隔 `* * *`，不需翻譯，建立時就原樣完成（ADR-0100），不送出也不計費。
* **翻譯完沒有說譯文在哪**：完成的訊息沒有提到 `tome preview`。

這些事實與每一項的建議寫在共用筆記 `brief-024-questions.md`。下列決定由維護者在 2026-11-07 選定，11 項之中第 5 項改成 0.2，其餘照建議。實作時又多了 7 項細節，寫在 `brief-024-details.md`，也照實作的做法定案：`tome status` 的重算方式與 `kept` 欄位（第 8 項）、「仍在執行」每秒檢查與沒跑的步驟不印、裝置寫小寫（第 2、3 項）、完成訊息帶書名（第 9 項）、`tome provider test` 也印重試（第 5 項）。

## 決定

**長度下限**

1. 修改 ADR-0102 第 10 項的提案值：`zh-TW` 的 `min_length_ratio` 從 0.3 改成 **0.2**，`too_short` 照舊重送。依據是第一次真實翻譯的數字，照 `verify.ts` 的算法，只比字母數（`\p{L}`）：
   * 原文 40 個字母以上、已完成的 109 句：比例最低 0.301、平均 0.371；低於 0.33 有 25 句，低於 0.35 有 47 句。
   * 0.301 是截斷過的最低值：低於 0.3 的都被送回重譯，所以看不到。至少有 3 句自然的譯文低於 0.3，其中成了 `FAILED_QA` 的那句，原文 149 個字母，自然的譯文約 40 字，比例約 0.27。改成 0.25 只留下約 0.02 的空間，規則書的比例可能更低。
   * 0.2 仍抓得到少了一半的摘要：平均 0.371 的一半約 0.19。

   成熟度：第一筆數據，只有一本書、一個模型（Sonnet 5.5）、小說的敘事文字。規則書的表格、數值塊與短標籤沒有數據。

**進度**

2. 修改 ADR-0090 第 7 項：`tome extract` 的進度改成依時間印，不再固定每 10 頁。
   * 啟動引擎前印一行，帶引擎名稱、裝置與這次要解析的頁數，並說第一次載入模型可能需要一段時間。裝置照 `tome engine list` 寫小寫的 `cpu`、`gpu`。
   * 第一頁一定印，之後距離上一行滿 5 秒才印，最後一頁一定印。照 ADR-0092 的速度大約每 3 頁一行。
   * 引擎沒有事件滿 30 秒時印一行「仍在執行」與已等待的秒數，之後距離上一行滿 30 秒再印。每秒檢查一次，所以第一行在第 30 到 31 秒之間出現。引擎啟動、載入模型的空檔靠這一行。
   * 組裝 document 層之前印一行。
   * 沒有真的跑的步驟不印：document 層沿用時不印組裝那一行，引擎的頁全部沿用時不印啟動那一行。
   * 時間由呼叫端注入，測試用假的時鐘，正式程式不加測試用的掛勾。
3. `tome add`、`tome probe`、`tome extract` 要重新探測時，先印一行要探測幾頁。沿用 `probe.json` 時不印。
4. `tome translate` 要送出請求之前印一行模式與請求數，即時與批次都一樣，沒有要送的就不印。只有數字，不寫要花多久，因為沒有量過。
5. 連到供應商的呼叫每次重試之前印一行：狀態碼（沒有收到回應時是 `-`）、幾秒後重試、第幾次、最多幾次。秒數有 `retry-after` 時照它。即時請求、批次的建立、查詢、下載、取消、刪除、列出，以及 `tome provider test`，都用同一個回呼。
6. 進度一律走 stderr，`--json` 的 stdout 不受影響，也不含書本文字。不在終端機上用同一行更新：要判斷是不是 TTY，記錄檔與 `--json` 也會混進控制字元。
7. 引擎協定 `tome-engine/1` 不改，第 2 項的啟動那一行與「仍在執行」已經蓋住引擎啟動的空檔。

**單位的說法與下一步**

8. 估價、試算、翻譯完成與 `tome status` 都叫「翻譯單位」，並寫出不需翻譯、原樣保留的數量：
   * `tome estimate` 與 `tome translate --dry-run` 寫「本次要送出」的數量，另寫不需翻譯的數量。
   * `tome translate` 完成與 `tome status` 寫總數與其中不需翻譯的數量，完成數含原樣保留的。
   * `tome estimate`、`tome translate --dry-run`、`tome translate`、`tome batch collect`、`tome status` 的 `--json` 在 `data` 多一個 `kept`，跟訊息裡的數字相同。這是新增的欄位，`tome-cli/1` 的外層不變（ADR-0082 第 11 項），沒有其他 schema 或文件列出這些指令的 `data` 欄位。
   * `tome translate` 從計畫的單位算。`tome status` 只讀 `book.db`，單位表沒有這一欄，要重算，不遷移資料庫。
   * 問題清單原本建議從存下的 `masked` 重算：拿掉佔位符標籤、還原跳脫之後，看有沒有字母。實作時改用單位表的 `source` 與 `placeholders`，維護者同意了：
     * `mask.ts` 新增 `needsLlm(text, placeholders)`：原文的字母數大於佔位符原文的字母數合計，就要送 LLM。佔位符是原文裡不重疊的片段，相減就是佔位符以外的字母數。
     * 建立單位的 `maskText` 也改用這個函式，`tome status` 跟遮蔽時用同一個判斷。
     * 用 `masked` 要解析佔位符標籤、還原跳脫，等於另外寫一次遮蔽的反向。
     * `tests/core/mask.test.ts` 用 fast-check 確認 `needsLlm` 跟原本「拿掉佔位符之後有沒有字母」的判斷相同，另有逐例的測試。
     * 只有一種情況兩者不同：範圍的邊界切在 UTF-16 代理對的中間。這時字母在原文裡算得到，切開之後的兩半都不算字母。
9. `tome translate` 完成的訊息最後加一句，請使用者執行 `tome preview <名稱>` 在本機產生原文與譯文的對照檔。`tome batch collect` 完成時用同一個訊息。路徑由 `tome preview` 自己印，這裡不寫，避免各系統的分隔符號不同。
10. 金額小於 1 美分時照舊印 6 位小數，例如 `$0.007869`。`provider.ts` 的 `usd()` 刻意讓小數位數跟著金額走，註解寫明便宜的模型一本書可能不到一美元。

## 驗證

<!-- @assert-present file="src/cli/progress.ts,tests/cli/progress.test.ts" -->
<!-- @assert-count target="languages/target/zh-TW.yaml" symbol="min_length_ratio: 0.2" expected="1" comments="include" reason="第 1 項：長度下限 0.2" -->
<!-- @assert-count target="src/core/verify.ts" symbol="return [{ code: 'too_short', level: 'resend' }];" expected="1" reason="第 1 項：過短照舊重送" -->
<!-- @assert-count target="src/cli/progress.ts" symbol="export const PAGE_EVERY_MS = 5_000;" expected="1" reason="第 2 項：頁的進度滿 5 秒才再印" -->
<!-- @assert-count target="src/cli/progress.ts" symbol="export const ENGINE_QUIET_MS = 30_000;" expected="1" reason="第 2 項：30 秒沒有事件就說仍在執行" -->
<!-- @assert-absence target="src/cli/run.ts" symbol="PROGRESS_EVERY" comments="include" reason="第 2 項：不再固定每 10 頁" -->
<!-- @assert-count target="src/core/extract.ts" symbol="options.onEngineStart?.({ name: spec.name, device, pages: pending.length });" expected="1" reason="第 2 項：啟動引擎前印一行" -->
<!-- @assert-count target="src/core/book.ts" symbol="onProbe?.(opened.pdf.pageCount);" expected="1" reason="第 3 項：重新探測時先說頁數" -->
<!-- @assert-count target="src/core/translate.ts" symbol="if (requests > 0) options.onStart?.(run.plan.mode, requests);" expected="1" reason="第 4 項：有要送的才印" -->
<!-- @assert-count target="src/core/llm.ts" symbol="onRetry?.(result.status, wait, index + 1, BACKOFF_SECONDS.length);" expected="1" reason="第 5 項：重試前通知" -->
<!-- @assert-count target="src/core/status.ts" symbol="needsLlm(" expected="1" reason="第 8 項：tome status 從原文與佔位符重算" -->
<!-- @assert-count target="src/core/mask.ts" symbol="needs_llm: needsLlm(text, placeholders)" expected="1" reason="第 8 項：建立單位時用同一個判斷" -->
<!-- @assert-count target="src/cli/messages/zh-TW.json" symbol="請執行 tome preview {book}，在本機產生原文與譯文的對照檔。" expected="1" comments="include" reason="第 9 項：完成時提示 tome preview" -->

## 後果

跑得久的指令都有輸出：`tome extract` 從啟動引擎到開始組裝，最長約 31 秒會有一行；組裝本身沒有量過，只在開始前印一行。重試時說要等多久。進度只在 stderr，用 `--json` 的程式不受影響。

長度下限放寬之後，比例在 0.2 到 0.3 之間的譯文不再送回。少掉的內容不到一半的摘要可能因此通過，要靠人看預覽。這個值只有一本小說的數據，翻規則書之後要再看一次。

`tome status` 每次都讀全部單位的原文重算，書很大時會多花一點時間，沒有量過。

## 替代方案

否決了下列做法：

* **`min_length_ratio` 改成 0.25**：離那句 0.27 只剩約 0.02，規則書的比例可能更低。
* **`too_short` 改成只報告**：不會白花錢，但摘要也不會自動補翻。
* **分兩段，太短的重送、稍短的只報告**：規則比較複雜，也沒有數據支持中間那條線。
* **每頁一行**：449 頁的書就是 449 行。
* **在終端機上同一行更新**：要判斷 TTY，`--json` 與記錄檔會混進控制字元。
* **在 `tome-engine/1` 加選用的 `ready` 事件**：要改 schema 與 Docling 引擎，Docling 只能在 CI 上驗證。
* **估價也報全部單位的總數**：估價時沒有這個數字。
* **`book.db` 加一欄 `needs_llm`**：要遷移資料庫。
* **從存下的 `masked` 重算不需翻譯的數量**：要解析佔位符標籤、還原跳脫，等於另外寫一次遮蔽的反向。
* **金額小於 1 美分時印「不到 $0.01」**：看不出實際的金額。

## Open Questions

- [ ] `term_suspect` 的誤報：`zh-TW` 的用語檢查載入 OpenCC 從 `tw` 到 `twp` 多出來的詞表，同時有資訊用語與人名譯名的對照，所以「文件→檔案」「循環→迴圈」與人名裡的「格拉斯→葛拉斯」都會比對到。只報告、不擋翻譯，但第一次真實翻譯一章就有幾十則。在 `term_exceptions` 補上這次的誤報，會把真正該改的用語一起蓋掉；依角色或書的類型決定要不要套用詞表比較完整，要另開回合設計。
- [ ] `min_length_ratio` 0.2 要在翻過規則書之後再看一次，特別是表格、數值塊與短標籤（第 1 項）。
- [ ] 不放進這個回合的：引擎協定的 `ready` 事件（第 7 項）；PDF 書籤只取單層，第一次真實翻譯的三章被當成一章（ADR-0092）；開頭引文的署名被排到第一章標題之後的閱讀順序；H-17 在真的 API 上還沒驗證。
