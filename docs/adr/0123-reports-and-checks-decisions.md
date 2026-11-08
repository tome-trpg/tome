---
id: ADR-0123
status: accepted
date: 2026-11-09
depends-on: [ADR-0009, ADR-0022, ADR-0026, ADR-0059, ADR-0060, ADR-0081, ADR-0102, ADR-0103, ADR-0107, ADR-0112, ADR-0113, ADR-0119, ADR-0120, ADR-0122]
amends: [ADR-0122]
---

# ADR-0123：交付報告與報告類的檢查

## 脈絡

ADR-0122 第 1 項把回合 038「報告與檢查」排成：交付報告與 `tome report`、一致性報告、代名詞與實體卡不符、機翻腔訊號、批次中改代名詞的修正、單書額外模式。交付報告的項目在白皮書 §5.6（原則已定案，ADR-0081），費用帳本「對照估價誤差，寫進交付報告」在 §8.1；機翻腔與代名詞是 ADR-0102 第 12 項排到 M3 的只報告檢查；批次中改代名詞的問題寫在 ADR-0120 的後果。

**現有程式**：確認估價時只記指紋（`stage` 表），金額沒存，只有批次存了 `batch.high_usd`。主翻譯回報的 `<new-term>` 存成 `issue` 表的 `new_term`。S-16（`rename.ts` 的 `changesOf`）只處理指令前後都已鎖定的卡，新鎖定的卡不替換。批次收回時，驗證與翻譯記憶的鍵都用這次執行開始時的卡，送出後改了或新鎖定了卡，用舊資訊翻的譯文會通過、存進新的鍵。目標語言設定檔有代名詞集合，沒有機翻腔的資料。

開工前的 18 項問題寫在共用筆記 `brief-038-questions.md`，維護者在 2026-11-09 選定：第 1 項拆出 039，第 5 項開始存估價，第 9 項代名詞例外詞與第 12 項機翻腔詞表照草稿接上，第 13 項送出時記鍵、收回時比對，第 14 項不清翻譯記憶（037 之後沒有在批次中改過或新鎖定過卡），其餘照建議。實作時的細節 18 項寫在 `brief-038-details.md`，維護者在同一天全部照建議選定：第 1 項機翻腔寫成一個物件（見第 11 項），第 18 項 book1 上命中次數最多的列也全部留著（見第 12 項）。

## 決定

**範圍**

1. **修改 ADR-0122 第 1 項**：038 不做單書額外模式，另開 **039「單書額外模式」**（`book.yaml` 的 `patterns`）；順序 038 → 039 → 031 → 032 → 033 → 034。039 的細節等它開工前再問。

**交付報告與 `tome report`**

2. `tome assemble` 每次輸出都在書的資料夾寫 `00-交付報告.md`，跟其他檔一樣記進 `render_file`（有人在報告上寫筆記，下次也照 ADR-0122 第 11 項擋下，報告開頭寫明不要在上面寫筆記）。報告可以含書本文字，只在 vault 裡；固定文字放訊息檔，重送原因與頁面原因的代碼換成中文，不認得的照原樣。
3. 各節照白皮書 §5.6：覆蓋率與花費（跟 `tome status` 同一套分類、翻譯與 Pass 0 分開的花費、預算、待審的卡、估價與實際花費）；未翻譯的單位（`FAILED_QA` 附這個單位最後一次的重送原因，**`BLOCKED` 只寫狀態與位置**）；未翻譯的頁面（原書頁碼與原因）；未翻譯的圖片（`figure` 區塊與整頁是圖的頁）；不可譯標記；只報告的檢查（疑似大陸用語、機翻腔、長度過長、多出數字、代名詞不符）；全書一致性。`tome sync` 的項目等 031。未翻譯的單位一個單位一行（表格的格子可能同一個區塊多行）；不可譯標記與只報告的檢查只列翻好的單位，沒翻成的已經列在前面；整頁是圖的頁在「未翻譯的頁面」與「未翻譯的圖片」兩節都列。
4. 每筆連到章節檔裡的區塊（`[[章節檔#^區塊 ID|章節檔 p.原書頁碼]]`），並在那個區塊加 `^區塊 ID`；報告指到的區塊就是連結目標，ADR-0122 第 9 項的規則不用改。不在章節檔裡的區塊只寫 ID。除了估價是表格，其他各節用清單，一筆一行（表格的格子要跳脫 `|`，連結也要寫成 `\|`，清單比較穩），書本文字的換行換成空白。
5. **開始存估價**：`book.db` 遷移第 13 版加 `estimate` 表（階段 `translate`、`scan`、模式、模型、**請求數**、低、高、時間），只有數字；Pass 0 沒有單位，兩邊都有的是請求數。翻譯在 `tome estimate --confirm` 時記，**同一份估價再確認不另記**（指紋沒變），報告才不會多出沒有花費的列；Pass 0 沒有分開的確認步驟，在 `scan-terms --confirm` 通過預算檢查、要送出前記。每一筆對到之後、同一個階段下一次確認之前的實際花費（帳本用 `unit_id` 分翻譯與 Pass 0），寫出落在估價區間的百分比（四捨五入），區間寬度是 0 時寫「-」。
6. `tome report <書>` 只印各項的數字（覆蓋率、花費、最近一次的估價誤差、各節的筆數），`--json` 也只有數字，不印書本文字與檔名（ADR-0059）。不寫檔、不拿書的鎖、不需要先 `tome assemble`，結束碼 0。

**一致性**

7. 產生報告時算兩種，不存表：**同一個原文、多種譯名**（還沒有鎖定卡的原文，各單位的 `new_term` 回報了兩種以上的譯名，原文與譯名去掉前後空白）；**鎖定的譯名沒用上**（命中鎖定卡、翻好的單位，還原後的譯文裡沒有它的譯名；`keep_source` 的卡不算）。放在交付報告的一節，不獨立成檔；`tome report` 只印筆數。
8. 038 只報告，不自動修正。有一致性問題時，報告最後寫明：鎖定或確認譯名後跑 `tome verify`，沒用上的單位會重送（要花錢，先估價）。新鎖定的卡沿用 `new_term` 的其他譯名做替換，之後另議。

**代名詞與實體卡不符**（只報告，`pronoun_mismatch`）

9. 單位命中**恰好一張**有代名詞的鎖定卡，譯文先拿掉命中的所有譯名（含規則包詞條）與目標語言的 `pronoun_exceptions`，出現代名詞集合裡別的字、又沒有那張卡的代名詞才報，別的代名詞全部列出。多張卡、沒有卡、卡只有性別沒有代名詞時不判，活躍實體不看（驗證拿不到 `<recent>`）。例外詞是語言資料：其他、其它、他人、他們、她們、牠們、它們、祂們、吉他、他鄉、他國、他處、他方、他日、他者、利他、排他、無他、他殺、他用，**維護者在 2026-11-09 逐字審過**。複數列進例外，卡的代名詞是單數。
10. 一定會有的誤報：譯文裡的代名詞指的是沒有卡的人（例如卡是「她」，句子是「瑪拉把鑰匙交給他」）。只報告，不重送。

**機翻腔訊號**（只報告，`translationese`）

11. 目標語言設定檔加 **一個物件** `translationese`：`pair_gap`、`sentence_end`、`phrases`、`exceptions`（問題清單第 11 項原本寫成 `translationese` 與 `translationese_exceptions` 兩個欄位；成對寫法的字數與句末的字是語言資料，核心不能寫死，所以放在一起，維護者選的）。`pronoun_exceptions` 是獨立的欄位。兩個都是選填，其他語言可以不寫。`phrases` 每一列是字串（`text`）或前後成對（`pair`），都帶建議用語；成對的要在同一句裡（中間沒有 `sentence_end` 的字）、前半之後 `pair_gap` 個字以內出現後半。每一列在一個單位裡最多報一次，`detail` 是命中的字（成對的是從前半到後半那一段）與建議。比對寫在核心、不依語言分支。
12. zh-TW 的詞表 36 列（字串 28、成對 8，`pair_gap` 15，`sentence_end` 是「。」「！」「？」），**維護者在 2026-11-09 逐字審過**，照問題清單第 12 項的草稿；「進行檢定」「使得」「通過」等刻意不收。book1 上命中次數最多的列（第 33 列 8 次，只占 0.3% 的單位）也**全部留著**，只報告（維護者選的）。誤報率沒有量過。
13. 兩項檢查跟用語檢查一樣跑在排版前的譯文上，結果寫進 `issue` 表；模型寫半形的 `?`、`!` 時成對的寫法會跨過它。之前翻好的單位要跑 `tome verify` 才會有。

**批次中改卡的修正**

14. **送出時記鍵、收回時比對**：批次送出時，把每個單位的翻譯記憶鍵記進 `batch_unit.memory_key`（遷移第 13 版）；收回時用目前的詞條重算，不一樣就不驗證、不存翻譯記憶，回到待翻（用 `rename.ts` 的 `resetUnit`：譯文與問題清掉、`attempts` 歸零），回應照樣留著（付過錢）。收回後印 `batch.cards_changed`（幾個單位、提醒先估價），批次模式的 `--json` 多 `cards_changed`。鍵含命中的卡的譯名、性別、代名詞、語域與風格，所以送出後**改了卡或新鎖定了卡**都會抓到；遷移前送出的列是 NULL，不比。收回時另印幾個單位要重翻，`glossary.renamed` 的批次那句跟著改。狀態用 SQL 直接改回 `PENDING`，`state.ts` 不動。
15. 已經存在翻譯記憶裡的不清：卡的屬性在 037 才進鍵，維護者確認 037 之後沒有在批次中改過或新鎖定過卡。

## 驗證

<!-- @assert-count target="src/core/report.ts" symbol="export const REPORTED_CHECKS = ['term_suspect', 'translationese', 'too_long', 'number_extra', 'pronoun_mismatch'] as const;" expected="1" reason="第 3 項：只報告的檢查都列進交付報告" -->
<!-- @assert-count target="src/core/vault.ts" symbol="report: collectReport(store, document, cards, book.config.budget_usd ?? null)," expected="1" reason="第 2 項：tome assemble 每次寫交付報告" -->
<!-- @assert-count target="src/core/store.ts" symbol="CREATE TABLE estimate (" expected="1" reason="第 5 項：確認過的估價" -->
<!-- @assert-count target="src/core/request.ts" symbol="recordEstimate(store, { stage: 'translate'" expected="1" reason="第 5 項：翻譯確認估價時記下" -->
<!-- @assert-count target="src/core/scan.ts" symbol="recordEstimate(store, { stage: 'scan'" expected="1" reason="第 5 項：Pass 0 送出前記下" -->
<!-- @assert-count target="src/core/verify.ts" symbol="if (card === undefined || carded.length > 1) return [];" expected="1" reason="第 9 項：只有恰好一張有代名詞的卡才判" -->
<!-- @assert-count target="src/core/verify.ts" symbol="...pronounProblems(translation, hits, context.language)," expected="1" reason="第 9 項：代名詞不符在驗證裡" -->
<!-- @assert-count target="src/core/verify.ts" symbol="...translationeseProblems(translation, context.language)," expected="1" reason="第 11 項：機翻腔在驗證裡" -->
<!-- @assert-count target="languages/target/zh-TW.yaml" symbol="pronoun_exceptions:" expected="1" reason="第 9 項：代名詞例外詞是語言資料" -->
<!-- @assert-count target="languages/target/zh-TW.yaml" symbol="pair_gap: 15" expected="1" reason="第 12 項：成對的寫法相隔 15 個字以內" -->
<!-- @assert-count target="src/core/store.ts" symbol="ALTER TABLE batch_unit ADD COLUMN memory_key TEXT;" expected="1" reason="第 14 項：送出時記鍵" -->
<!-- @assert-count target="src/core/batch.ts" symbol="key !== null && key !== memoryKeyOf(run, unit)" expected="1" reason="第 14 項：收回時比對鍵" -->
<!-- @assert-count target="src/core/translate.ts" symbol="if (work.changed?.has(unit.unit_id) === true) {" expected="1" reason="第 14 項：鍵不同的單位回到待翻、不存記憶" -->

**量測**（2026-11-09）：複製 `book1`（ADR-0115 的書 8）的 `document.json` 與 `book.db` 到暫存資料夾，產生交付報告的資料（不寫檔、不讀 PDF），只印數字，跑完刪掉複本；只讀維護者工作區的 `book.yaml`，沒有寫入。未翻譯的單位 9 個、未翻譯的頁面 0、圖片 136、不可譯標記 2、疑似大陸用語 134、多出數字 51、長度過長 0、一致性的多種譯名 6 個；這本書沒有鎖定的卡，代名詞不符與鎖定譯名沒用上量不到；估價是 038 之前確認的，沒有紀錄。產生報告 17 毫秒。機翻腔：這本書在 038 之前驗證，`issue` 表沒有；用同樣的比法在 2,551 個翻好的單位上數，命中的單位數是第 33 列「以……的方式」8、第 35 列「最……之一」7、第 30 列「由……所」6、第 36 列「對……進行」4，第 19、21、25、29 列各 2，第 7、24、26 列各 1，其他 25 列 0，合計 37。沒看命中的句子，誤報率不知道。

## 後果

交付報告集中列出這本書還要人處理的地方，每筆點得到章節裡的位置；`tome report` 在終端機只給數字，可以安心貼出去。M3 收尾要的估價誤差從這個回合起有紀錄，之前確認的估價沒有。

代名詞與機翻腔都是訊號，不是錯誤：代名詞會報到指沒有卡的人的句子，機翻腔的詞表只量過命中次數。批次收回時卡改過的單位會重翻，多花一次錢，換來不把舊代名詞的譯文存進翻譯記憶；只改了譯名的卡原本收回時會因為 `term_missing` 重送，結果一樣是重翻。

## 替代方案

否決了下列做法：

* **額外模式留在 038**：跟報告、驗證沒有交集，038 會跟 030 一樣大。
* **038 不存估價**（M3 收尾照 M2 手抄）、**只用批次的 `high_usd`**：即時模式沒有紀錄。
* **`tome report` 也印內容**：終端機的輸出可能被貼到別處。
* **一致性對全書的大寫片語做對齊**：沒有逐詞對齊，做不準。
* **038 擴充 S-16 處理新鎖定的卡**：模型回報的譯名可能只是片段，誤換的風險要另外想。
* **代名詞看命中的卡都沒有的代名詞就報**：誤報更多。
* **機翻腔只收字串**：「當……的時候」這類最常見的寫法收不了；**用正規表示式**：要放進 worker，語言資料也難審。
* **批次修正 (A) S-16 標記**：抓不到新鎖定的卡；**(C) 有批次時不准改卡**：多一個限制；**(D) 只修翻譯記憶**：`DONE` 的單位要靠代名詞檢查報出來。

## Open Questions

- [ ] 機翻腔詞表的誤報率，要等有人看過命中的句子（第 12 項；36 列目前全部留著）。
- [ ] 代名詞不符在有鎖定卡的真書上報多少、誤報多少（第 9、10 項）。
- [ ] 新鎖定的卡要不要用 `new_term` 的其他譯名做 S-16 替換（第 8 項）。
- [ ] 交付報告在 Obsidian 裡的顯示要人看過（第 4 項）。
