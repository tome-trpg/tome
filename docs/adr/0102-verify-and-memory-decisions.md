---
id: ADR-0102
status: accepted
date: 2026-11-02
depends-on: [ADR-0026, ADR-0050, ADR-0054, ADR-0056, ADR-0059, ADR-0060, ADR-0081, ADR-0086, ADR-0099, ADR-0100]
---

# ADR-0102：驗證與翻譯記憶的細節

## 脈絡

brief 016 開工前比對 ADR-0060、ADR-0099 與白皮書 §5.6、§6.2，留下這些沒定的細節：混入簡體字怎麼判定，數字怎麼比，排版規則怎麼避開 `1,000`，翻譯記憶與資料表放什麼，`tome verify` 做到哪裡。誤判的代價很具體：正確的譯文重送三次後變成 `FAILED_QA`，費用也白花。

下列決定都由維護者在 2026-11-02 從問題介面選定。

## 決定

**簡體字**

1. 混入簡體字的判定沿用 `tests/tools/traditional-chinese.test.ts` 的做法：標準 Big5 以外的漢字，加上 Big5 也收錄的簡體字形，再排除繁體也這樣寫的詞。不靠 OpenCC 的片語表，也不開例外清單。
2. 字表與例外詞移成語言資料，放 `tome-lang/1` 的 `script_check`，欄位是 `encoding`、`lead_ranges`、`trail_ranges`、`shared_forms`、`allowed_words`、`misused_words`。測試工具與核心共用同一份，判定函式在 `src/core/language.ts`。`languages/target/zh-TW.yaml` 因此刻意收錄簡體字，列進測試的例外清單（ADR-0086 第 5 項）。
3. 判定前先拿掉這個單位命中的詞條 `target`。鎖定譯名裡的字不算混入，否則重送也修不好。
4. 要有測試：合成的繁體長文，判定結果是零。

**用語檢查**

5. OpenCC 只用在不重送的用語檢查。`tome-lang/1` 加 `opencc: { from, to }`，`zh-TW` 是 `tw` 到 `twp`。只有 `src/core/opencc.ts` 碰 `opencc-js`，用到時才動態載入。
6. 譯文裡出現片語表的詞就記成 `issue`，只有那個詞與建議用語進 `detail`。再比對 `term_checks` 的 `avoid`。誤報放 `term_exceptions`，先留空。

**重送的檢查**

7. 數字比遮蔽後的文字，先做 NFKC。逗號後面剛好三位數才算千分位，拿掉後比較，`1,000` 與 `1000` 相同，`1,2,3` 是三個數字。
8. 原文的數字都要在譯文出現，次數也要夠，少了重送。譯文多出來的只報告：`three` 譯成 `3` 不是錯。
9. 原文用 `findTerm` 命中的詞條，譯文至少要出現一次 `target`，不比次數。`keep_source` 的詞條已遮蔽，不查。`match.roles` 照樣生效。
10. 長度比字母數（`\p{L}`），不算佔位符。原文少於 20 個字母不查。過短用 `min_length_ratio`，過長用新增的 `max_length_ratio`，值 1.5，只報告。20 與 1.5 都是提案，等試翻量過。
11. `<s>` 之外的文字略過，不算協定錯誤。單位對不上時一對一檢查會抓到。

**排到 M3**

12. 機翻腔訊號、代名詞與實體卡不符、輸出的標題與表格結構都排到 M3。

**譯後排版**

13. 只處理解析出的文字片段，佔位符不動。`punctuation.replace` 在兩側都是半形英文字母或數字時不換。
14. `“”` 換成 `「」`，`‘’` 換成 `『』`。成對的 `"` 依序換成 `「」`，單數個就不動。`'` 不動，它可能是撇號。
15. `space_around_latin: false` 移除中文與拉丁字母、數字之間的空白，佔位符當成拉丁文字。
16. 網址整段不動，到空白或非 ASCII 字元為止，結尾的標點不算網址。緊接在數字後面的 `"` 是英寸記號，不算引號，配對也不計入（ADR-0029 規定單位不換算）。

**翻譯記憶**

17. 放 `series.db` 的 `memory` 表，系列 ID 用書的 slug。
18. 鍵是遮蔽後文字、命中詞條摘要、目標語言、風格版本的 SHA-256。遮蔽後的可見文字 40 字元以下的短段落，再加前一段的遮蔽後文字雜湊。
19. 命中詞條摘要是命中詞條的原文與譯名，排序後取雜湊。風格版本是角色 `style` 文字的雜湊，沒有 `style` 時是空字串的雜湊。
20. 存遮蔽後的譯文片段，不同的骰子值也能重用。另存模型、提示雜湊、規則包雜湊、SDK 版本、來源書。
21. 只有驗證通過的譯文才進。命中後重跑零 token 驗證，不過就當沒命中。

**資料表**

22. `book.db` 的遷移第 3 版加 `unit`、`response`、`issue`。`ledger` 在 017，`egress` 在 018，`batch`、`batch_unit` 在 019。
23. `unit` 的欄位是 `unit_id`、`block_id`、`role`、`group_id`、`section`、`seq`、`source`、`masked`、`placeholders`、`state`、`attempts`、`translation`。`translation` 存排版並還原後的譯文。
24. `response` 的欄位是 `id`、`unit_id`、`attempt`、`text`、`model`、`created_at`，`text` 是回應裡這個 `<s>...</s>` 的原文，`ParsedUnit` 多一個 `raw`。
25. `issue` 的欄位是 `id`、`unit_id`、`code`、`level`、`detail`、`created_at`。`detail` 可以含書本文字，只留在工作區，不進訊息與 `--json`。
26. `issue.code` 的重送類是 `tag_error`、`unit_missing`、`placeholder_mismatch`、`number_missing`、`term_missing`、`script_mixed`、`too_short`。只報告類是 `number_extra`、`too_long`、`term_suspect`、`new_term`、`untranslatable`。`untranslatable` 對應 `<flag>`。
27. `syncUnits` 寫入單位：同一個 `unit_id` 且遮蔽後文字相同就保留狀態，文字變了回到 `PENDING`，`document` 裡沒有的單位刪除，回應保留。

**狀態機與 `tome verify`**

28. `nextState(state, event)` 是純函式，狀態用白皮書 §6.2 的名稱，非法轉換丟程式錯誤，重試上限是常數 3。
29. §6.2 多兩條轉換：`FAILED_QA --> STALE`（重跑驗證）、`STALE --> FAILED_QA`（重跑失敗且已到上限）。重跑一律先進 `STALE`。
30. `tome verify <book>` 對每個單位最新的回應重跑驗證，範圍是 `RECEIVED`、`DONE`、`FAILED_QA`，不花 token，不動 `attempts`。通過的成為 `DONE`，失敗的回 `QUEUED`，已到上限的是 `FAILED_QA`。
31. 全部通過回 0，有失敗回 1，訊息只有數字，取書鎖。沒有回應時回報 `verify.nothing`，回 0。
32. 規則包讀不全就不驗證，回報規則包的發現。詞條少掉時譯名驗證會默默不做，所有譯文都會通過，所以不能繼續。

**命名**

33. 模組是 `src/core/verify.ts`、`src/core/format.ts`、`src/core/opencc.ts`、`src/core/memory.ts`、`src/core/state.ts`。

## 驗證

<!-- @assert-import-absence target="src" exclude="src/core/opencc.ts *.json" module="opencc-js" reason="第 5 項：只有這個模組碰 opencc-js" -->
<!-- @assert-present file="src/core/verify.ts,src/core/format.ts,src/core/opencc.ts,src/core/memory.ts,src/core/state.ts" -->
<!-- @assert-absence target="tests/tools/traditional-chinese.test.ts" symbol="SIMPLIFIED_IN_BIG5" reason="第 2 項：字表只有一份，放語言資料" -->
<!-- @assert-count target="languages/target/zh-TW.yaml" symbol="script_check:" expected="1" reason="第 2 項：字表是語言資料" -->

## 後果

標準 Big5 之外的字一律算混入，少數繁體罕用字會重送，鎖定譯名之外沒有放行的路。OpenCC 的字典約 6 MB，只在用語檢查時才載入。翻譯記憶的鍵不含模型，換模型不會重翻。排版的引號只處理成對的情況，模型寫錯的引號會留著。

## 替代方案

**用 OpenCC 判定簡體字**：片語表沒收的詞會誤判，正確的譯文會被重送三次；**字表留兩份**：改一邊會漏另一邊；**數字嚴格相等**：`three` 譯成 `3` 會白花重送；**不分字母數比長度**：`Yes` 譯成「是」會被當成摘要；**機翻腔訊號放進 M2**：要有維護者定的清單，也要交付報告才有地方看；**翻譯記憶存還原後的文字**：換個骰子值就重用不了；**`tome verify` 動 `attempts`**：重跑不花錢，不該吃掉重試額度；**規則包壞掉時只略過譯名驗證**：所有譯文都會通過，看起來一切正常；都否決。

## Open Questions

- 「於」的簡體字形也是繁體的姓氏，字表算它混入，譯文裡的姓氏會被重送，三次後變成 `FAILED_QA`。例外詞比對的是字串，姓氏接的名字沒有窮盡的辦法，先不處理。人物的譯名鎖定之後不受影響（第 3 項），M3 有實體卡時再看。
- `allowed_words` 是字串比對，「天后」也會蓋掉「三天」後面寫錯的簡體字形。誤判的代價比漏掉高，先接受，等真實譯文的統計再看。
