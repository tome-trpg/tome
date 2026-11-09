---
id: ADR-0126
status: accepted
date: 2026-11-09
depends-on: [ADR-0012, ADR-0059, ADR-0081, ADR-0102, ADR-0113, ADR-0115, ADR-0119, ADR-0120, ADR-0123, ADR-0125]
amends: [ADR-0113, ADR-0125]
---

# ADR-0126：人工譯文的檢查

## 脈絡

ADR-0125 第 1 項把回合 031 拆出 040「人工譯文的檢查」：人工譯文的零 token 驗證（ADR-0113 第 23 項留到開工前問）與交付報告的「內含舊譯名的人工譯文」（ADR-0081 第 6 項：鎖定譯名改動時，人工譯文不替換，內含舊譯名的段落列入交付報告，由人決定）。

**現有程式**：零 token 驗證只看模型的回應，輸入是帶標籤的片段，比的原文是遮蔽後看得到的文字。人工譯文是還原後的 Markdown，遮蔽的內容已經放回去，粗體斜體是 `*`。`tome verify` 跳過人工譯文（ADR-0125 第 10 項），`applyHuman` 套用時清掉那個單位的問題，所以人工譯文沒有任何問題記錄。交付報告的「鎖定的譯名沒有用上」已經會列出沒用目前譯名的人工譯文，但不分人工或模型，也不說舊譯名。S-16 只在改卡的當下知道舊譯名；之後留下的只有實體卡的 `previous_target`（ADR-0119 第 10 項），只記最近一次。

開工前的 13 項問題寫在共用筆記 `brief-040-questions.md`，維護者在 2026-11-09 選定：第 2 項跑、只報告，第 4 項同一張表、報告另開一節，第 7 項用 `previous_target`，其餘照建議。實作時的細節 8 項寫在 `brief-040-details.md`，維護者在同一天全部照建議選定（包括程式放 `verify.ts`）；下面各項註明出自問題或細節第幾項。

## 決定

**零 token 檢查**

1. **定案 ADR-0113 第 23 項：人工譯文跑零 token 檢查，只報告**（維護者選的，問題第 2 項）。檢查不改狀態、不重送、不改結束碼、不擋 `tome assemble`。人工譯文的優先序最高（ADR-0012），刻意的寫法不該被擋下，但掉了數字、混入簡體字、還留著舊譯名是使用者會想知道的。
2. 跟模型譯文**同一套比文字的規則**：數字（掉了、多出）、鎖定譯名、混入別的字體、長度、中國大陸用語、代名詞、機翻腔；模型譯文的「遮蔽標記一樣」在這裡改成「每個遮蔽內容的原文還找得到（同樣的次數）」。標籤、單位、模型的註記不查（問題第 3 項）。比之前先整理人工譯文：每個遮蔽內容拿掉一次（換成一個不會接成詞的字元；長的先拿，一樣長的照原本的順序，`1d6` 才不會切進 `11d6`，PR 審查時找到），使用者寫的粗體、斜體記號 `*` 拿掉；比的原文跟模型譯文一樣是遮蔽後看得到的文字（細節第 2 項）。
3. 問題記在同一張 `issue` 表、用同樣的代碼，**全部記成 `report` 等級**，不加遷移（維護者選的，問題第 4 項）。
4. **什麼時候查**（問題第 5 項、細節第 3 項）：`tome sync` 查這次存的人工譯文，`tome verify` 查全部人工譯文（鎖定譯名、語言資料可能改了，重查不花錢），兩者都用結果換掉那些單位原本的問題。`applyHuman` 不查、也**不碰問題**：`syncUnits` 重寫單位用 `INSERT OR REPLACE`，`human` 會變回 0、問題卻還在（`issue` 沒有外鍵），套回時分不出文字有沒有變。修改 ADR-0125 第 8 項的「問題清掉」與第 10 項的「`tome verify` 不重驗人工譯文」：不用模型的回應重驗，但跑這裡的檢查。
5. `tome sync` 時規則包讀不全：人工譯文照樣存、照樣套回，這次存的單位不查、原本的問題清掉，規則包的發現照 `tome verify` 的做法報出來（細節第 4 項）。
6. **訊息**（問題第 6 項、細節第 5 項）：`human.flagged`（`warn`，`tome sync` 與 `tome verify`）說查了幾個、幾個有問題；`human.checked`（`info`，只有 `tome verify`）說查了幾個、沒有問題。`tome verify` 只有人工譯文時不再是 `verify.nothing`。`--json` 加 `human_checked`、`human_flagged`。只印數量（ADR-0059）。
7. **程式放在 `verify.ts`**（細節第 1 項，改了問題第 10 項的建議）：`checkSegments` 拆出比文字的一半，模型的片段與人工譯文共用；人工譯文的檢查與「查一批、寫進 `issue`」也在 `verify.ts`。放 `human.ts` 會跟 `verify.ts` 互相 import（ADR-0115 第 9 項把章節的函式從 `request.ts` 搬到 `chapters.ts`，就是為了不循環匯入）。`verify.ts` 是變異測試模組，合併後在 main 上跑 mutation。`state.ts`、`memory.ts`、`mask.ts` 不動。

**交付報告**

8. 新增「**人工譯文的檢查**」一節，放在「只報告的檢查」之後，每個問題一行，平常會重送的五個代碼（數字缺漏、沒用鎖定譯名、混入簡體字、譯文過短、遮蔽的原文不見）另外有寫法，最後附「只報告、不會重送；要修改請在 vault 裡改，再執行 tome sync」。「只報告的檢查」與「不可譯標記」只列模型譯文（問題第 4 項、細節第 6 項）。
9. 新增「**內含舊譯名的人工譯文**」一節，放在「全書一致性」之後，每張卡一行：「{原文}」的譯名從「{舊譯名}」改為「{新譯名}」，幾處人工譯文仍用舊譯名與位置，附修法「在 vault 裡改，再執行 tome sync」（問題第 8 項）。這些單位不在「鎖定的譯名沒有用上」重複列出，也不在「人工譯文的檢查」為同一張卡目前的譯名列「沒有用鎖定的譯名」（PR 審查時找到：還用舊譯名就一定沒有新譯名，`tome verify` 之後會記成 `term_missing`；同一處列兩次只會讓人以為有兩個問題），`human_checks` 跟著少算。代名詞、性別、語域改了的人工譯文不列。
10. **舊譯名用 `previous_target` 算**（維護者選的，問題第 7 項）：產生報告時，命中一張鎖定卡、`DONE` 的人工譯文，含那張卡的 `previous_target`（不是空的、跟目前的譯名不同），而且有一處不在目前任何一張鎖定卡的較長譯名裡，就列出來。規則跟 S-16 的 `replaceTarget` 一樣，只是比純文字：「鹽沼」改成「鹽沼地」時，「鹽沼地」不算含舊譯名（細節第 7 項）。
11. 兩節**只在有內容時出現**，沒有人工譯文的書報告不變。`tome report` 與 `--json` 多 `human_checks`（人工譯文的問題幾個）與 `human_old_names`（內含舊譯名的人工譯文幾處）（細節第 6 項）。
12. 不自動替換人工譯文裡的舊譯名，不加丟掉人工譯文的指令（問題第 1、9 項）。

**測試**

13. 只用合成的文字（問題第 11 項）：逐項確認人工譯文的檢查（遮蔽內容裡的數字不算多出、拿掉的地方不會接成鎖定譯名、`*` 不影響、找不到的遮蔽內容）；性質測試：任何人工譯文的檢查都只有 `report` 等級；`tome sync`、`tome verify` 不改狀態與譯文、不改結束碼；交付報告的兩節與數字。性質測試的次數照寫在測試檔的跑，較大的次數只在 CI 跑。不量真書（book1 沒有人工譯文）。

## 驗證

<!-- @assert-count target="src/core/verify.ts" symbol="return problems.map((problem) => ({ ...problem, level: 'report' }));" expected="1" reason="第 1、3 項：人工譯文的問題全部只報告" -->
<!-- @assert-count target="src/core/verify.ts" symbol="...textProblems(unit, visible(original), visible(segments), context)," expected="1" reason="第 2 項：模型的片段與人工譯文用同一套比文字的規則" -->
<!-- @assert-count target="src/core/verify.ts" symbol="const human = checkHumans(store, context);" expected="1" reason="第 4 項：tome verify 查全部人工譯文" -->
<!-- @assert-count target="src/core/sync.ts" symbol="const human = checkHumans(store, context, new Set(saved));" expected="1" reason="第 4 項：tome sync 查這次存的人工譯文" -->
<!-- @assert-count target="src/core/human.ts" symbol="DELETE FROM issue" expected="0" comments="include" reason="第 4 項：套回人工譯文時不碰問題" -->
<!-- @assert-count target="src/core/report.ts" symbol="human: reported(HUMAN_CHECKS, 1, listedOld)," expected="1" reason="第 8、9 項：人工譯文的檢查另開一節，舊譯名一節列了的不再列一次" -->
<!-- @assert-count target="src/core/report.ts" symbol="SELECT id, previous_target FROM entity" expected="1" reason="第 10 項：舊譯名用實體卡的 previous_target 算" -->

## 後果

人工譯文的手誤（掉了數字、混入簡體字、改名前的譯名）會出現在交付報告裡，跟模型譯文的問題分開列，修法都是在 vault 裡改、再跑 `tome sync`。檢查不擋任何事，`tome verify` 的結束碼仍然只看模型譯文。

**已知的限制**：舊譯名只認得最近一次改名，同一張卡改過兩次，更早的譯名認不出來（人工譯文沒有目前的譯名時，鎖定譯名的檢查與「鎖定的譯名沒有用上」仍會列出它，只是不說舊譯名）；較長譯名只看實體卡、不看規則包的詞條（`collectReport` 只拿得到卡，呼叫的寫法由 ADR-0123 的斷言固定），規則包詞條的譯名含舊譯名時可能多列；`book.db` 重建後套回的人工譯文可能還帶著模型譯文的舊問題，下次 `tome verify` 換掉；`*` 一律拿掉，書裡本來的星號也一樣（檢查都不看 `*`）。

## 替代方案

否決了下列做法：

* **不跑零 token 檢查**：人工譯文的手誤沒人知道。**平常會重送的問題擋下 `tome assemble`**：會擋下人刻意的寫法（問題第 2 項）。
* **跟模型譯文混在原本的各節**：「只報告的檢查」會多出平常不在那裡的代碼，修法也不同。**另開一張表**：要加遷移（問題第 4 項）。
* **記下每張卡的改名歷史**：最完整，要加表與遷移。**S-16 當下記下命中的人工譯文**：之後才用舊譯名寫的認不出來（問題第 7 項）。
* **程式放 `human.ts`**：會跟 `verify.ts` 互相 import（第 7 項）。
* **`applyHuman` 套回時查**：估價與翻譯要多載入約 6 MB 的片語表。

## Open Questions

- [ ] 想把人工譯文改回模型譯文、讓 S-16 接手時要怎麼做（目前只能在 vault 裡改）。
- [ ] 實體卡的代名詞、性別、語域改了，命中的人工譯文要不要也列出來（目前沒有記下舊值）。
