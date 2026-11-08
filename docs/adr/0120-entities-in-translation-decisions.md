---
id: ADR-0120
status: accepted
date: 2026-11-08
depends-on: [ADR-0026, ADR-0036, ADR-0059, ADR-0063, ADR-0068, ADR-0081, ADR-0102, ADR-0103, ADR-0113, ADR-0118, ADR-0119]
amends: [ADR-0103]
---

# ADR-0120：實體卡進翻譯與 S-16

## 脈絡

ADR-0118 第 1 項把「實體卡與全書提要進翻譯請求、活躍實體、`keep_source` 實體卡的遮蔽、翻譯記憶與譯名驗證加上實體卡、`prompts/translate.md` 的改動」拆成回合 037，排在審定（028）之後；ADR-0119 第 1 項把 S-16 也移到 037，028 只記下 `previous_target`。白皮書 §5.6：鎖定後才進主翻譯；靜態前綴放全書提要；動態部分放命中的實體卡與「最近 5 個區塊出現過的實體卡」（活躍實體）；優先序是使用者 > 本書審定 > 系列 > 規則包 > LLM 提議（ADR-0026 第 4 項）；改譯名時替換譯文與翻譯記憶、再驗證，代名詞或語域改動要重翻並先列估價（ADR-0026 第 7 項、ADR-0081 第 6 項）。

**現有程式**：`loadBookPack` 只回傳規則包 `glossary.yaml` 的詞條，同一份給 `<glossary>`、譯名驗證與翻譯記憶的鍵；`keep_source` 的詞條在 `units.ts` 遮蔽。ADR-0103 第 2 項的請求是 `system`（指令、風格指南、規則包的文風與範例）與 `user`（`<context>`、`<glossary>`、`<roles>`、`<s>`），寫著「全書提要與活躍實體要等 M3」。單位的狀態 `DONE` 只能經 `STALE` 重驗，回到 `PENDING` 只有 `syncUnits` 重寫這條路。人工譯文還不存在（回合 031）。

開工前的 17 項問題寫在共用筆記 `brief-037-questions.md`，維護者在 2026-11-08 選定：第 4 項 `prompts/translate.md` 照草稿接上，第 1 項 S-16 不拆，第 15 項本機單一變異的小工具可以跑，其餘照建議。實作時的細節 18 項寫在 `brief-037-details.md`，維護者在同一天全部照建議選定；其中第 1 項「比對指令前後的卡」的代價寫在後果。

## 決定

**哪些卡、優先序**

1. 只有 `locked` 的實體卡進翻譯，不論 `decided_by` 是 `human`、`auto` 還是 `import`；還沒鎖定的提議不進。同一個原文，實體卡優先於規則包的詞條。「使用者」與「本書審定」在同一本書是同一列，「系列」還沒有，所以實際是：本書的實體卡 > 規則包。
2. 合併是 `verify.ts` 的純函式 `bookTerms`，回傳跟以前一樣的詞條清單，`<glossary>`、譯名驗證、翻譯記憶三處照用；卡的 `gender`、`pronoun`、`register` 帶在詞條的 `attributes` 上，至少有一項才有，沒有屬性的卡在請求與翻譯記憶的鍵裡跟規則包詞條一樣。卡的詞條 `text` 是原文，`source` 是空的對照表（卡只有一種原文）。`bookVerifyContext` 要給 `book.db`，`tome verify`、`translate`、`batch collect` 的詞條都含鎖定的卡。

**請求**

3. **`prompts/translate.md`** 照維護者逐字審過的草稿，逐位元組相同（測試釘住雜湊）：`<glossary>` 說明多了的屬性；新增 `<recent>` 與系統提示最後的 `<book>`；規則加代名詞、語域兩條，`<new-term>` 那條改成「不在 `<glossary>` 或 `<recent>`」。之後要改字就是新的提示審查。
4. **修改 ADR-0103 第 2 項**：`system` 的最後多一段 `<book>`（`<era>`、`<tone>`、`<factions>`，先跳脫），沒有提要就不放，同一本書照樣位元組一致；`user` 的順序是 `<context>`、`<glossary>`、`<recent>`、`<roles>`、`<feedback>`、`<s>`。全書提要照原樣用，不經人審。
5. `<glossary>` 的一行是 `<term source target gender pronoun register/>`，屬性順序固定、沒有的不寫；規則包的詞條跟以前逐字相同。`class` 不送，`keep_source` 的卡已經遮蔽。
6. **活躍實體**：請求第一個單位之前、同一章的 **5** 個區塊裡命中、有性別或代名詞的鎖定卡，扣掉這批已經命中的，最多 **10** 張，離請求最近的優先，放在 `<recent>`。區塊是有翻譯單位的區塊（`furniture`、`figure` 這類不產生單位的不算），表格的儲存格同一個區塊算一個；往前看時，沒送出的單位（上文、原樣保留的）也算。10 是提案。
7. `keep_source` 的卡跟規則包的 `keep_source` 詞條一樣，在 `units.ts` 遮蔽成 `<ph kind="keep_source"/>`。遮蔽後的文字變了，已翻的單位會被 `syncUnits` 重寫、重翻，估價會列出來。

**翻譯記憶、驗證、估價**

8. 翻譯記憶的鍵：命中詞條的摘要加上卡的性別、代名詞、語域，**只在有屬性時才加**；只有規則包詞條的單位，鍵跟以前逐字相同，已存的翻譯記憶照樣命中。活躍實體不進鍵。
9. 譯名驗證不另外加判定：`term_missing` 與「鎖定譯名的字不算混入」直接涵蓋實體卡。代名詞與實體卡不符的檢查留在回合 030。審定前就翻過的單位，`tome verify` 會用新的詞條重驗，沒有鎖定譯名的要重送。
10. 估價的指紋加上鎖定卡（原文、譯名、性別、代名詞、語域、`keep_source`、比對條件）的雜湊，有鎖定的卡才加；提要在靜態前綴裡，提示的雜湊已經算到。`prompts/translate.md` 改了，合併後每本書都要重新確認一次估價。
11. 還有 `proposed` 或 `failed` 的卡時，`tome estimate`、`translate`、`--dry-run` 印 `glossary.pending`（warn，結束碼 0），只印筆數，不擋翻譯；擋下是 032 `tome run` 的關卡。

**S-16**

12. `tome glossary review` 與 `import` 改了已鎖定的卡時，同一個指令當下做 S-16：審定在套用之後、收 `<new-term>` 與自動鎖定之前做，匯入在交易結束後做；有單位要替換時才載入片語表。哪張卡改了，是**比對指令開始前後的鎖定卡**（維護者選的）：`previous_target` 分不出是不是這次改的，也不記性別、代名詞、語域；它照 ADR-0119 繼續記。
13. **譯名改了**：原文命中這張卡、狀態是 `DONE`、`FAILED_QA`、`RECEIVED` 或 `STALE` 的單位（後兩種的回應也是用舊的卡翻的），拿最後一份回應，把舊譯名換成新譯名（`memory.ts` 的 `replaceTarget`：先跳脫再找、標籤裡不換、只掃一次；落在較長譯名裡的不換，較長譯名是這本書目前全部詞條的譯名，含這張卡的新譯名，所以「鹽沼」改成「鹽沼地」時原本的「鹽沼地」不會變成「鹽沼地地」），換了就存成新的一列 `response`（同一個 `attempt`、原本那份回應的模型），再驗證並照結果更新狀態。通過的用指令開始前的卡算出舊的鍵、找到翻譯記憶的那一筆，複製它的中繼資料（模型、提示雜湊、規則包雜湊、SDK 版本、書），換好片段用新的鍵存；找不到就不存，舊的不刪。找不到舊譯名就不換，照樣重新驗證，會是 `term_missing`，進重送。
14. **性別、代名詞或語域改了**（譯名一起改也一樣，反正要重翻）：命中這張卡的已翻單位回到 `PENDING`，跟 `syncUnits` 重寫一樣：譯文清空、`attempts` 歸零、刪掉這個單位的 `issue`，重翻時有完整的 3 次。鍵也跟著變，不會從翻譯記憶拿回舊的；估價會列出，確認後才送。只有活躍範圍有這張卡的單位不動，這是已知的不精確。不改 `state.ts`。
15. `IN_FLIGHT` 的單位不動，只算數量，收回時用新的詞條驗證。`class` 改了不動；`keep_source`、比對條件改了走現有的路；已鎖定的卡被拒絕，已翻的譯文不動。規則包詞條的譯名改了不做 S-16。人工譯文在回合 031，交付報告在 030。
16. 訊息 `glossary.renamed`（info）只印數量：替換、重送、重翻、批次中各幾個，並提醒先跑 `tome estimate`（ADR-0059）；`--json` 的 `data` 多一個 `renamed`。沒有鎖定卡改動時不印。

**程式與測試**

17. 合併的判斷放 `verify.ts`、替換的判斷放 `memory.ts`，都在變異測試的名單裡；讀卡與提要在 `entities.ts`，S-16 的流程在新的 `rename.ts`，活躍實體在 `request.ts`。`mask.ts` 沒有改。變異測試的名單不變（ADR-0063 第 1 項）。
18. 推 PR 前用本機的單一變異小工具（不是 Stryker）對改過的函式跑一輪，存活的補上測試或說明是等價變異；TypeScript 7 沒有 JS 的編譯器 API，變異用 `node_modules` 裡已有的 `@babel/parser` 產生。正式的分數等合併後在 `main` 觸發 `mutation.yml`。

## 驗證

<!-- @assert-count target="prompts/translate.md" symbol="When a proper noun is not in <glossary> or <recent>, wrap your translation of it" expected="1" comments="include" reason="第 3 項：審過的提示" -->
<!-- @assert-count target="src/core/verify.ts" symbol="if (card.status !== 'locked' || card.target === null) return [];" expected="1" reason="第 1 項：只用鎖定的卡" -->
<!-- @assert-count target="src/core/verify.ts" symbol="return [...own, ...packTerms.filter(({ text }) => !taken.has(text))];" expected="1" reason="第 1 項：實體卡優先於規則包" -->
<!-- @assert-count target="src/core/prompt.ts" symbol="bookBlock(summary)," expected="1" reason="第 4 項：提要放靜態前綴的最後" -->
<!-- @assert-count target="src/core/request.ts" symbol="recentBlock(request, recent)," expected="1" reason="第 4 項：recent 在 glossary 之後" -->
<!-- @assert-count target="src/core/request.ts" symbol="const ATTRIBUTES = ['gender', 'pronoun', 'register'] as const;" expected="1" reason="第 5 項：屬性的順序" -->
<!-- @assert-count target="src/core/request.ts" symbol="export const ACTIVE_BLOCKS = 5;" expected="1" reason="第 6 項：往前看 5 個區塊" -->
<!-- @assert-count target="src/core/request.ts" symbol="export const ACTIVE_LIMIT = 10;" expected="1" reason="第 6 項：最多 10 張，是提案" -->
<!-- @assert-count target="src/core/memory.ts" symbol="attributes === undefined" expected="1" reason="第 8 項：只在有屬性時才加，規則包詞條的鍵不變" -->
<!-- @assert-count target="src/core/request.ts" symbol="...(locked === null ? [] : [locked])," expected="1" reason="第 10 項：指紋含鎖定的卡" -->
<!-- @assert-count target="src/core/request.ts" symbol="finding('glossary.pending', 'warn'" expected="1" reason="第 11 項：待審只提醒" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="await applyRenames({ home, book, store, pack, before });" expected="2" reason="第 12 項：審定與匯入當下做 S-16" -->
<!-- @assert-count target="src/core/memory.ts" symbol="if (insideTag(fragment, at) || shielded.some(([start, stop]) => start <= at && end <= stop)) continue;" expected="1" reason="第 13 項：標籤裡與較長譯名裡的不換" -->
<!-- @assert-count target="src/core/rename.ts" symbol="UPDATE unit SET state = 'PENDING', attempts = 0, translation = NULL, translation_pc = NULL WHERE unit_id = ?" expected="1" reason="第 14 項：代名詞改了回到待翻" -->
<!-- @assert-count target="src/core/state.ts" symbol="DONE: { stale: 'STALE' }," expected="1" reason="第 14 項：不改狀態機" -->

實作後的量測（2026-11-08）：複製 `book1`（ADR-0115 的書 8）的 `document.json` 到暫存資料夾，用 ADR-0118 的規則挖出 744 個候選詞，**全部當成鎖定的實體卡**（上限的情況），譯名用固定的 4 個字代替，組出全書的請求，只印數字，跑完刪掉複本；只讀維護者工作區的 `book.yaml` 與規則包，沒有寫入。

* 2,579 個單位、194 個請求；沒有實體卡時每個請求的 `user` 平均 1,731 字元，靜態前綴 4,325 字元（含 800 字元的假提要）。
* 卡沒有屬性時：每個請求的 `<glossary>` 平均 14.3 行（最多 84 行）、617.5 字元（最多 3,884），占請求（靜態前綴加 `user`）平均 8.5%（最多 34.7%）。
* 每張卡都有性別與代名詞時：`<glossary>` 平均 1,018 字元（最多 6,236）；`<recent>` 只出現在 15 個請求，平均 0.4 張（最多 10 張）、31.6 字元；加起來占請求平均 13.4%（最多 46.4%）。
* `<recent>` 少的原因**沒有量**：推測是一個請求涵蓋很多區塊，前 5 個區塊的人物多半已經在這批單位裡命中。

這本書沒有真的鎖定卡，候選詞也含很多不會鎖定的標題詞，實際的數字會比上面小。

## 後果

規則包與實體卡的譯名、代名詞、全書提要一起進翻譯，「It moves.」這類句子有機會選對它、牠、祂。請求變長，估價會算進去；改了已鎖定的譯名不必重翻，改代名詞要重翻命中的單位。合併後每本書都要重新確認一次估價，因為提示改了。

**比對指令前後的卡（第 12 項）的代價**：S-16 做到一半中斷時（例如審定改卡的交易已經寫入、替換還沒做完），下次跑不會補做，因為前後的卡已經一樣。沒處理到的單位會留著舊譯名，直到跑 `tome verify`：它用新的鎖定譯名重驗，`term_missing` 進重送。譯文不會在驗證時被當成對的，只是要多花一次重送的錢。

實體卡的品質決定譯文的品質：自動鎖定的提議沒有人看過就進翻譯（ADR-0119 第 9 項）。模型會不會照 `<recent>` 選代名詞**沒有驗證**：這個回合只跟假供應商跑，沒有對真的 API 發請求。

## 替代方案

否決了下列做法：

* **S-16 再拆成 038**：037 合併到 038 之前，改已鎖定的譯名只能重翻。
* **提要放進審定檔讓人改**：審定檔要多一段，流程多一種東西。
* **活躍實體不分有沒有代名詞都送**、**不設上限**：請求變長，多數幫不上忙。
* **活躍實體進翻譯記憶的鍵**：同樣的段落在不同人物附近就不能重用。
* **狀態機加 `DONE → QUEUED`**：改到第四個變異測試模組。
* **延後到下次翻譯或驗證才做 S-16**：要多記一份「上次套用到譯文的卡」。**批次沒收回時不准改已鎖定的譯名**：多一個限制。
* **只看 `previous_target` 判斷改了什麼**：分不出是不是這次改的，也不記代名詞。
* **全部放新模組**：新的判斷沒有變異測試的保護。

## Open Questions

- [ ] 活躍實體 10 張的上限與「只送有性別或代名詞的卡」，等真的 API 翻過有人物的章節再看（第 6 項）。
- [ ] 模型照不照 `<recent>` 與 `<glossary>` 的代名詞，030 的代名詞檢查做好之後量（第 3、6 項）。
- [ ] 只有活躍範圍有這張卡的單位，代名詞改了不重翻，要不要補（第 14 項）。
