---
id: ADR-0135
status: accepted
date: 2026-11-12
depends-on: [ADR-0035, ADR-0036, ADR-0055, ADR-0059, ADR-0066, ADR-0068, ADR-0081, ADR-0103, ADR-0118, ADR-0123, ADR-0127, ADR-0129, ADR-0130, ADR-0133, ADR-0134]
amends: [ADR-0035, ADR-0036, ADR-0055, ADR-0103, ADR-0127, ADR-0134]
---

# ADR-0135：試翻、估價校準與提示快取

## 脈絡

ADR-0130 第 21 項把回合 045 排成 `tome trial`、`--trial`、試翻後停的設定、估價校準與 Q-6 的算法，並一起量快取的命中率（第 8 項）；第 9 項說估價的校準分兩步，第一步是 ADR-0134，第二步是試翻。之前定的：

* `tome trial` 先翻一小段，用實際的 `usage` 校準，人工改動回饋成風格範例（ADR-0035 第 4 項）。
* 試翻量到的命中率高於損益兩平點，才開 1 小時快取與預熱（ADR-0036 第 4 項）。M2、M3 都沒開快取（ADR-0099 第 5 項、ADR-0129 第 7 項）。
* 試翻後要不要停由使用者設定（ADR-0055 第 4 項）；`tome run` 不收 `--trial`，留給 M4（ADR-0127 第 4 項）。
* Q-6 是「試翻校準後的估價誤差在 ±20% 內」，用費用帳本量，是初值（ADR-0066）。

開工前的問題寫在共用筆記 `brief-045-questions.md`，11 項由維護者在 2026-11-12 全部照建議選定。

**模擬**（第 9 項，維護者同意）：在工作區的唯讀暫存複本上，用 M3 當時的程式重建第一次送出的請求，跟帳本逐個對上（規則書 190 個、公有領域 13 個），只印數字，量完刪掉。挑出試翻、算兩個倍數（第 6 項）、預測其他請求的花費，Q-6 用 043 之後的重送比例（規則書 24.6%、公有領域 27.9%，ADR-0134）算。用了兩種估價器：

* **ADR-0134 的估價器是樣本內**：它的比例就是用這兩本書擬合的，所以下表的 −0.1%、−0.9% 這類數字不能當成新書的預期。
* **044 之前的估價器是樣本外的替代**：手上沒有第三本書的帳本，就用一個在規則書上差 23.5% 的估價器，模擬「估價器不合這本書」的情況。它不是真的新書，只是替代。

| 規則書（批次，190 個請求） | 不試翻 | 平均間隔挑 19 個 | 平均間隔 5 到 30 個 | 取開頭 5 到 30 個 |
| :--- | ---: | ---: | ---: | ---: |
| ADR-0134 的估價器（樣本內） | −0.1% | −0.9% | −3.2% 到 ＋1.4% | ＋5.7% 到 ＋7.4% |
| 044 之前的估價器（樣本外的替代） | ＋23.5% | −4.6% | −8.1% 到 ＋6.7% | ＋9.9% 到 ＋18.0% |

* 平均間隔的起點換 10 種位置：ADR-0134 的估價器挑 19 個時 −2.2% 到 ＋2.1%；044 之前的估價器挑 5 到 30 個，最差 −11.7%。
* 取開頭的前 N 個一律偏高：規則書開頭的請求輸出比全書平均少。
* 試翻 19 個請求花 $0.16。開工前的問題用規則書每個請求的平均（$0.006）估成 $0.11，偏低：平均間隔挑到的請求比平均大。
* 公有領域（即時，13 個請求）：平均間隔挑 5 個，ADR-0134 的估價器（樣本內）＋2.4%，044 之前的估價器（樣本外的替代）＋3.0%，10 種起點都在 ＋0.5% 到 ＋4.5%；取開頭的 5 個是 ＋8.2% 與 ＋8.9%。試翻 5 個請求花 $0.16，是整本第一次送出的三成多。

**提示快取的事實**（Anthropic 的文件，2026-11 查的；批次的部分由 Manager 對照 prompt caching 頁關於批次的說明）：

* Sonnet 5.5、Opus 5.5、Haiku 5.5、Fable 5.1 最少 512 個 token 才會快取。TOME 的靜態前綴約 1,850 個 token（ADR-0134）。
* 寫入：5 分鐘是輸入價的 1.25 倍，1 小時是 2 倍；讀取：Sonnet 5.5、Opus 5.5 是 0.05 倍。批次的五折也套在快取的讀寫上。快取依模型分開。
* TTL 從請求開始時算。一個請求最多 4 個斷點。
* 文件建議批次用 1 小時的快取，因為批次常要 5 分鐘到 1 小時才做完；也建議先送一個帶前綴的請求、等它完成再送整批，等於預熱。同一批裡的命中是盡力而為。
* 損益兩平的命中率 ＝（寫入價 − 輸入價）÷（寫入價 − 讀取價）：Sonnet 5.5 批次、1 小時約 51%，5 分鐘約 21%；Opus 5.5 約相同。

## 決定

數字都是**提案**（ADR-0068）：模擬只有兩本書、一個模型（Sonnet 5.5），而且是樣本內；快取的命中率還沒量過。

**試翻**

1. `tome trial <書> [--confirm] [--budget <美元>] [--realtime]` 比照 `tome scan-terms`（ADR-0118 第 8 項）：不加 `--confirm` 只在本機估價、不連網、不取金鑰；加了而且估價跟上次顯示的相同才送。試翻的估價照挑到的請求逐一組出來算，不用每個請求的平均推。試翻計入預算，送出前用估價上限檢查，批次是每批、即時是每個請求。
2. **大小與選法**：在 `--chapters` 範圍內規劃好的請求裡，平均間隔挑整個請求，取每一段的中間；約 10%（四捨五入），最少 5 個、最多 30 個，不超過規劃好的數量。規則照建議不改：樣本外的替代（044 之前的估價器）挑 5 到 30 個、各種起點，Q-6 最差 −11.7%，在 ±20% 以內；取開頭的一律偏高。樣本內的數字更小，但不能當成新書的預期。
3. **譯文留下**：試翻的單位照一般翻譯驗證、重送，通過就是 `DONE`，主翻譯跳過它們。挑中的單位記在 `book.db` 的 `trial_unit`，校準後清掉；中斷了再跑 `tome trial --confirm` 接著做。挑中的都做完、只是還沒校準時（例如批次由 `tome batch collect` 收回），下一次 `tome trial` 不送，直接校準。
   * 挑中的單位送出去還沒收回或還沒驗證完（`IN_FLIGHT`、`RECEIVED`，例如試翻的批次在等待時被中斷）時，不算做完，不校準、也不清掉挑中的單位：加 `--confirm` 先收回、做完再校準，那次的確認已經涵蓋它；不加只說怎麼收回（`trial.in_flight`）；`tome run --trial` 停在試翻。否則收回的帳會記成翻譯、算進 Q-6，下次還要再試翻一次。
4. **`tome run --trial`**：修改 ADR-0127 第 4 項。過了審定的關卡之後，這本書在目前的模型與模式還沒校準，就顯示試翻的估價並停下（`run.stopped`，結束碼 0），請使用者跑 `tome trial <書> --confirm`（即時模式加 `--realtime`），比照 Pass 0；已經校準過就說 `trial.calibrated`、接著往下。`--trial` 不存進 `book.yaml`。
5. **不另設「試翻後要不要停」**：修改 ADR-0055 第 4 項。試翻後面一定是確認估價的關卡，校準會讓估價改變，本來就要停下確認。

**校準**

6. 修改 ADR-0103 第 8 項：每本書、每個模型、每個模式兩個倍數。用帳本裡試翻的請求：第一次送出、用主翻譯模型的請求，照送出時的組法重建，跟 ADR-0134 估價器的估計（不含校準）比。輸入的倍數 ＝ 實際的提示 token（`input_tokens` 加快取的讀寫）÷ 估計的前綴與其餘；輸出的倍數 ＝ 實際的輸出 ÷ 估計。估價時兩個倍數乘在 token 上，前綴也乘輸入的倍數。
7. 重送的餘裕照舊用供應商設定檔的 0.25（ADR-0134 第 4 項）。試翻的重送比例（重送的花費 ÷ 第一次送出的花費）記下來、只顯示：試翻只有幾個到幾十個請求，太不穩。
8. **存放**：`book.db` 的 `calibration` 表（遷移第 15 版），一個模型、一個模式一筆：兩個倍數、用了幾個請求、重送比例、快取的 TTL 與命中率、時間。換模型或模式時不套用。有校準時，它進估價的內容指紋，沒有時不加，比照 ADR-0115、ADR-0120 的前例，舊的確認不會因為這個回合失效。`tome estimate` 有校準時說 `estimate.calibrated`；沒有時說 `estimate.uncalibrated`，提示可以先試翻。
9. 估價器的輸入拆成前綴與其餘兩部分，快取只碰得到前綴；ADR-0134 第 1 項的算式不變，它的斷言改成指向兩行（見「驗證」）。

**快取**

10. 修改 ADR-0036 第 4 項：**斷點只有一個**，在靜態前綴的結尾：開快取時 `system` 是一塊帶 `cache_control` 的文字，`user` 每個請求都不同，放在斷點之後。
11. **試翻一律開快取**，才量得到命中率：批次用 1 小時，即時用 5 分鐘。命中率 ＝ 快取讀取的 token ÷（讀取 ＋ 寫入）。試翻的估價當成整個前綴都寫入，是上限。
12. **主翻譯**：試翻量到的命中率高於損益兩平點（依模型、模式與 TTL 的價格算），這本書的主翻譯才開快取，TTL 跟試翻相同；估價照命中率算前綴的價錢，`tome estimate` 說 `estimate.cache_on` 或 `estimate.cache_off`。沒有試翻就不開，請求跟這個回合之前一樣。
13. **這個回合不預熱**：批次裡不能送 `max_tokens: 0` 的請求；文件建議的「先送一個、等它完成再送整批」也先不做，先量。後果見 Open Questions。
14. 帳本照實際的 TTL 計算寫入的價錢：回應的 `usage.cache_creation.ephemeral_1h_input_tokens` 是 1 小時的寫入，其餘照 5 分鐘。

**Q-6**

15. **Q-6 ＝ 實際的翻譯花費 ÷ 校準後估價的中間值 − 1**。實際花費照 `tome report` 現有的配對：從確認到同一個階段下一次確認之前，含重送與回退，不含 Pass 0 與試翻。`estimate` 表加中間值與「有沒有校準」兩欄；試翻的確認另記一列，階段是 `trial`。帳本加 `trial` 一欄，試翻的請求是 1。`tome report` 對最近一次有校準、已有花費的翻譯估價印 `report.q6`，`--json` 每一列有 `q6`；其他的是 null。白皮書 §10 的量測方法跟著改。

**其他**

16. 修改 ADR-0035 第 4 項：人工改動回饋成風格範例排到 0.1.0 之後。它要先有收集改動的流程，還要改提示，改提示會讓每本書重新確認估價，也會改變要校準的東西。
17. 批次併發、串流、依區塊角色選模型、長度的門檻、重送併成一個請求都不在這個回合（ADR-0130 第 2、16 項，ADR-0133 第 4 項）。批次的處理時間已經在 `batch` 表（送出與結束的時間），重送有沒有命中快取在帳本，實測時一併報數字。
18. 改過的檔案不在變異測試的六個模組裡，改過的行在回合分支上用 `mutation-lines` 跑（ADR-0132）。本機不跑變異測試。

**合併後的實測**（問題第 7 項）

19. 維護者另開一個工作區（同一份 PDF 在同一個工作區只能加一次），用批次模式的 `tome run --trial` 重跑公有領域短篇，量批次的命中率、校準與 Q-6，數字寫進之後的 ADR，只寫數字。約 $0.3，上限 $0.6。正式的 Q-6 在 050 收尾時量（ADR-0130 第 20 項）。

## 驗證

<!-- @assert-count target="src/core/trial.ts" symbol="export const TRIAL_SHARE = 0.1;" expected="1" reason="第 2 項：約 10%" -->
<!-- @assert-count target="src/core/trial.ts" symbol="export const TRIAL_MIN = 5;" expected="1" reason="第 2 項：最少 5 個" -->
<!-- @assert-count target="src/core/trial.ts" symbol="export const TRIAL_MAX = 30;" expected="1" reason="第 2 項：最多 30 個" -->
<!-- @assert-count target="src/core/trial.ts" symbol="export const TRIAL_TTL: Readonly<Record<RequestMode, CacheTtl>> = { batch: '1h', realtime: '5m' };" expected="1" reason="第 11 項：批次 1 小時、即時 5 分鐘" -->
<!-- @assert-count target="src/core/trial.ts" symbol="state IN ('IN_FLIGHT', 'RECEIVED') AND unit_id IN (SELECT unit_id FROM trial_unit)" expected="1" reason="第 3 項：送出去還沒收回的試翻不算做完" -->
<!-- @assert-count target="src/core/pipeline.ts" symbol="code === 'trial.in_flight'" expected="1" reason="第 3 項：試翻還沒收回時 tome run 停在試翻" -->
<!-- @assert-count target="src/cli/run.ts" symbol="trial: { type: 'boolean' }" expected="1" reason="第 4 項：tome run 收 --trial，修改 ADR-0127 第 4 項" -->
<!-- @assert-count target="src/core/pipeline.ts" symbol="trialLocked({ home, slug, mode, confirm: false })" expected="1" reason="第 4 項：tome run 不送試翻，只估價後停下" -->
<!-- @assert-count target="src/core/book.ts" symbol="trial" expected="0" comments="include" reason="第 4 項：--trial 不存進 book.yaml" -->
<!-- @assert-count target="src/core/request.ts" symbol="cache_control: { type: 'ephemeral', ttl: cache.ttl }" expected="1" reason="第 10 項：斷點只有一個" -->
<!-- @assert-count target="src/core/request.ts" symbol="...(calibration === null ? [] : [calibration])," expected="1" reason="第 8 項：有校準時才進指紋" -->
<!-- @assert-count target="src/core/estimate.ts" symbol="prefix: prefixChars / prefix_chars_per_token," expected="1" reason="第 9 項：ADR-0134 第 1 項的前綴" -->
<!-- @assert-count target="src/core/estimate.ts" symbol="rest: userChars / chars_per_token + unit_input_tokens * units," expected="1" reason="第 9 項：ADR-0134 第 1 項的 user 與單位的標籤" -->
<!-- @assert-count target="src/core/ledger.ts" symbol="writes['1h'] * prices.cacheWrite['1h']" expected="1" reason="第 14 項：1 小時的寫入照自己的價錢" -->
<!-- @assert-count target="src/core/store.ts" symbol="ALTER TABLE ledger ADD COLUMN trial INTEGER NOT NULL DEFAULT 0;" expected="1" reason="第 15 項：帳本分得出試翻" -->
<!-- @assert-count target="src/core/report.ts" symbol="AND trial = 0" expected="1" reason="第 15 項：Q-6 不含試翻" -->

## 後果

試翻要花一點錢：規則書大小的書約 $0.16（19 個請求，批次）。小書碰到最少 5 個的下限，佔整本的比例大：公有領域短篇 13 個請求挑 5 個，試翻約 $0.16，是整本第一次送出的三成多。試翻的譯文留下，所以這筆錢不是白花，主翻譯少送同樣的單位；但校準只剩少數請求可以驗證，小書的 Q-6 數字也比較不穩。

校準過的書，估價會變，已確認的估價失效，要重新確認。校準過就不再試翻；同一本書換模型或模式時可以再試翻。

主翻譯開了快取時，請求帶 `cache_control`，前綴的價錢照命中率算；命中率比試翻量到的低時，實際花費會比估價高。沒有試翻的書，請求跟這個回合之前一樣。

`book.db` 升到第 15 版，既有的工作區開啟時會自動升級：舊的帳本列 `trial` 是 0；舊的估價沒有中間值，不算 Q-6。`tome estimate` 的估價結果不再說「尚未以實際用量校準」，改由 `estimate.calibrated` 或 `estimate.uncalibrated` 另外一行說。

## 替代方案

否決了下列做法：

* **取範圍開頭的前 N 個請求**：模擬裡一律偏高 6% 到 18%。
* **固定數量，或加 `--trial-size`**：小書幾乎整本都是試翻、大書不夠；多一個要解釋的旗標。
* **只量不留**：已翻完的書也能試翻，但每次試翻的錢都白花。
* **依書重新擬合 `chars_per_token`、`output_ratio`**：參數多，試翻的請求數少時不穩。
* **校準存在 `book.yaml`，或整個工作區共用一份**：量測值手改會讓指紋失去意義；書本文字每個字元的 token 依書不同（ADR-0134）。
* **`book.yaml` 加「試翻後不停」**：等於自動確認估價，跟 ADR-0055 第 3 項衝突。**`--trial` 存進 `book.yaml`**：已經校準時是白跑。
* **即時模式不試翻也開 5 分鐘快取**：沒量過，要修改 ADR-0036 第 4 項。**批次也用 5 分鐘**：同一批的請求相隔超過 5 分鐘時就對不上。
* **Q-6 用估價區間判定**：區間是中間值的 −20% 到 ＋30%，比 Q-6 的 ±20% 寬。**只算第一次送出**：量不到使用者真正付的錢。
* **風格範例這個回合就做**：要改提示，每本書重新確認估價，也會改變要校準的東西。

## Open Questions

- [ ] 實測（第 19 項）：批次的命中率、校準的兩個倍數與 Q-6 的第一筆數字，加上批次的處理時間與重送有沒有命中快取。
- [ ] 只量不預熱：同一批的請求可能同時開始，前面的還沒寫進快取，後面的就讀不到，量到的命中率可能偏低，主翻譯因此不開快取。實測之後再決定要不要照文件先送一個帶前綴的請求、等它完成再送整批（第 13 項）。
- [ ] 主翻譯的批次比試翻的批次大得多（ADR-0107 一次一批），命中率可能不同。
- [ ] 模擬是樣本內：ADR-0134 的比例就是用這兩本書擬合的，新書的誤差要等 050 收尾。
- [ ] 重送的餘裕固定 0.25，試翻量到的重送比例只顯示；兩本書差 3.3 個百分點，Q-6 就差約 2.6%。要不要用試翻的重送比例，等更多書。
- [ ] 校準過就不再試翻。改了提示、規則包或供應商設定之後要不要重新試翻、怎麼清掉舊的校準，還沒有指令。
