---
id: ADR-0121
status: accepted
date: 2026-11-08
depends-on: [ADR-0023, ADR-0051, ADR-0059, ADR-0061, ADR-0063, ADR-0068, ADR-0092, ADR-0100, ADR-0102, ADR-0111, ADR-0113, ADR-0115, ADR-0120]
amends: [ADR-0100, ADR-0051]
---

# ADR-0121：數值塊欄位化與合成測試規則包

## 脈絡

ADR-0051 第 1 項定了「`roles.yaml` 可以宣告數值塊欄位，標籤用術語翻，數字保留，整塊對得上就不送 LLM」，涵蓋率待驗證（H-15）。ADR-0113 的回合表把「數值塊欄位化與合成測試包」排在 030 之前，第 12 項說 M3 只用合成的測試規則包驗證，H-15 的真實量測等 M4 的 `d100-orc`。白皮書 §6.2：不需要 LLM 的單位包括遮蔽後不含字母的單位，以及整塊對上的數值塊。

**現有程式**：`tome-pack/1` 的 `roles.yaml` 早就有 `fields`，是名稱的清單，型別也有，但**沒有程式讀它**；名稱不說標籤長什麼樣。規則包的角色只判到段落區塊，頁首頁尾與表格不判定（ADR-0092），所以數值塊是一個段落、一個翻譯單位。不送 LLM 的單位只有佔位符以外沒有字母的（ADR-0100），譯文就是原文，訊息寫「不需翻譯、原樣保留」（ADR-0111）。`tests/fixtures/packs/sample-pack` 有一個 `stat_block` 角色。0.1.0 還沒發佈，schema 原地改（ADR-0115 的前例）。

開工前的 14 項問題寫在共用筆記 `brief-029-questions.md`，維護者在 2026-11-08 選定：第 2 項 `fields` 的格式選 (A) 標籤清單，第 7、12 項命名 `stat-fixture` 與 `fields.ts`，其餘照建議。實作時的細節 16 項寫在 `brief-029-details.md`，維護者在同一天全部照建議選定；第 1 項欄位之間的分隔選了「全形空白與全形標點」。

## 決定

**格式**

1. **修改 ADR-0051 第 1 項的寫法**：`roles.yaml` 的 `fields` 是標籤的清單，每一項是「語言 → 標籤」，跟 `glossary.yaml` 的 `source` 同一種寫法；標籤的譯名只放在詞條，跟正文同一個譯名，書可以用實體卡或匯入蓋掉（ADR-0120 的優先序）。`tome-pack/1` 原地改，`sample-pack` 一起改（標籤改成 `{ en: HP }`、`{ en: AC }`，詞條補上這兩個標籤的譯名）。標籤照書的來源語言，沒有寫法時用主要語言（`en-GB` 用 `en`），寫了 `en-GB` 就用它。

**判定與產生**

2. **修改 ADR-0100**：不需要 LLM 的單位多一種。段落區塊判到有 `fields` 的角色時，遮蔽後看得到的文字扣掉**有譯名的欄位標籤**與**鎖定的實體卡**之後，一個字母（`\p{L}`）都不剩，就是整塊對得上的數值塊。數字、佔位符與標點不是字母，自然通過；至少要換到一個詞。規則包裡不是欄位的詞條不算。比對條件照詞條（預設區分大小寫、全字），長的先比、不重疊。只有一部分對得上的照常送 LLM，不在本機翻一部分。
3. **譯文**：把標籤與名字換成譯名、組成 `<s>` 片段，走跟模型回覆**同一條**驗證、排版與還原（`verifyFragment`），不通過就照常送 LLM；不載入片語表，不進翻譯記憶。產生片段時先整理詞與詞之間的文字（維護者選了「全形空白與全形標點」）：兩個詞之間只隔著空白的換成一個全形空白（排版只拿掉半形空白與 tab，ADR-0102 第 15 項，只照排版會黏成「韌性12機智9」）；標點前後的空白拿掉，排版會換成全形標點；逗號、句點兩邊都是數字時不動，免得「2, 4」讀成一個數字；標籤與數字之間照排版的規則。粗體標籤前面的空白也算詞與詞之間。合成的例子（`stat-fixture`）：
   * `Grit 12 Wits 9 Reach 1D6+1` →「韌性12　機智9　觸及1D6+1」
   * `Grit 12, Wits 9, Reach 3, Ward 2/4, Stride 10%` →「韌性12，機智9，觸及3，護甲2/4，步幅10%」
   * 名字是鎖定的實體卡：`Tide Warden Grit 12, Wits 9, Reach 1D6+1` →「潮汐守衛　韌性12，機智9，觸及1D6+1」
4. **每次組請求重算**（`tome estimate`、`translate`、`--dry-run`）：欄位化的譯文照最新的譯名改寫；原本送模型翻好的單位變成能欄位化，就改用本機的譯文，回應紀錄留著；原本欄位化、現在對不上的回到待翻。還在批次裡的單位這次不欄位化，收回之後的下一次才換（直接改成完成，收回時狀態機會丟錯）。

**儲存與訊息**

5. `book.db` 遷移第 11 版：`unit` 加 `fielded`（0 或 1）。`tome status` 只讀 `book.db`，靠它數欄位化的單位。
6. 欄位化的單位**不算「原樣保留」**：估價、試算、翻譯完成與 `tome status` 另印 `units.fielded`（有才印，只有數字），原本的訊息不改；`--json` 的 `data` 多 `fielded`。「完成」照舊含欄位化的單位。

**規則包工具與合成包**

7. `tome system test` 的測試案例加選用的 `fielded`：預期本機欄位化的譯文，`null` 表示該送 LLM。案例照規則包的第一個來源語言，譯文照 zh-TW，只用規則包自己的詞條。遮蔽跟翻譯時同一個函式（`units.ts` 的 `maskSources`）。
8. `tome system lint` 在欄位標籤（任何一種來源語言的寫法）在繼承鏈的詞條裡沒有譯名時印 `pack.field_untranslated`（warn，只印角色名與第幾個欄位，不印標籤）：書可以用實體卡或匯入補，所以不是 fail。
9. 合成測試規則包 **`tests/fixtures/packs/stat-fixture`**：虛構的遊戲系統，屬性名、名字與譯名全部自己編，不用任何商業書或特定遊戲的屬性名稱（連 ORC 授權的也不用）；`extends: generic`，Apache-2.0，每個檔案登記在 `tests/fixtures/SOURCES.yaml`（ADR-0061），不隨程式發佈。`Knack` 故意沒有譯名，示範送 LLM 與 lint 的提醒；`Lantern` 是詞條但不是欄位，數值塊裡有它就送 LLM。偵測是 Grit 與 Wits 都後接數字；8 個測試案例，7 個檔案。
10. 程式放 `src/core/fields.ts`，純函式；不加進變異測試的名單（ADR-0063 第 1 項），推 PR 前用本機的單一變異小工具跑一輪。`verify.ts`、`mask.ts`、`memory.ts` 沒有改。

**不做**

11. `d100-orc` 與真書的 H-15 量測（M4）、表格的欄位化（ADR-0092 表格不判角色）、部分欄位化、欄位結構的檢查（標籤後面要接數字之類）、改 `generic` 與任何提示。

## 驗證

<!-- @assert-count target="schemas/tome-pack-1.schema.json" symbol="Stat block field labels, each written per source language like a glossary source." expected="1" comments="include" reason="第 1 項：fields 是標籤清單" -->
<!-- @assert-count target="src/core/fields.ts" symbol="if (LETTER.test(gap)) return null;" expected="1" reason="第 2 項：詞以外剩下字母就送 LLM" -->
<!-- @assert-count target="src/core/fields.ts" symbol="const { translation, paired } = verifyFragment(unit, fragment, context);" expected="1" reason="第 3 項：走跟模型回覆同一條驗證" -->
<!-- @assert-count target="src/core/fields.ts" symbol="const IDEOGRAPHIC_SPACE = '　';" expected="1" reason="第 3 項：欄位之間用全形空白" -->
<!-- @assert-count target="src/core/request.ts" symbol="const fielded = fieldUnits(built, { pack, sourceLang, terms, names: bookTerms([], cards), language });" expected="1" reason="第 2、4 項：每次組請求重算，名字只收鎖定的卡" -->
<!-- @assert-count target="src/core/units.ts" symbol="if (unit.fielded !== undefined && before.state !== 'IN_FLIGHT') fieldUnit(store, { ...unit, fielded: unit.fielded });" expected="1" reason="第 4 項：批次中的單位這次不欄位化" -->
<!-- @assert-count target="src/core/store.ts" symbol="ALTER TABLE unit ADD COLUMN fielded INTEGER NOT NULL DEFAULT 0;" expected="1" reason="第 5 項：遷移第 11 版" -->
<!-- @assert-count target="src/core/status.ts" symbol="return count === 0 ? [] : [finding('units.fielded', 'info', { count: String(count) })];" expected="1" reason="第 6 項：欄位化另外算數，有才印" -->
<!-- @assert-count target="src/core/pack-lint.ts" symbol="finding('pack.field_untranslated', 'warn'" expected="1" reason="第 8 項：缺譯名只提醒" -->
<!-- @assert-count target="systems/generic/roles.yaml" symbol="fields" expected="0" comments="include" reason="第 11 項：不改 generic" -->

**合成包上的數字**（2026-11-08，不是 H-15 的證據）：`stat-fixture` 的 8 個測試案例裡，判到數值塊的 7 個，整塊對上、在本機翻好的 4 個（57%）；另外 3 個是故意設計成要送 LLM 的（一句話、沒有譯名的欄位、不是欄位的詞條）。這些案例是為了測程式寫的，比例沒有意義，只說明規則照設計運作。真書上的涵蓋率**沒有量測**，等 M4 的 `d100-orc`（ADR-0113 第 12 項）。

## 後果

有欄位與詞條的規則包，整塊對上的數值塊不花 token、數字也不會被改錯；沒有欄位的規則包（包括 `generic`）跟以前一樣。規則包作者要把標籤寫進 `fields`、譯名寫進 `glossary.yaml`，缺譯名時 lint 會提醒。

欄位之間的全形空白、標點的處理是這個回合定的樣子，跟模型翻的數值塊（經過同一條排版，標籤與數字會黏在一起）不一定一致。

## 替代方案

否決了下列做法：

* **`fields` 照舊是名稱，詞條多一個 `field` 欄位**：改的是 `glossary.yaml` 的 schema，欄位散在兩個檔。**不改 schema，有 `fields` 就啟用**：`fields` 的名字沒有用處，lint 也查不到缺譯名。
* **欄位化時規則包的任何詞條都算**：數值塊裡的說明文字只要碰巧都是詞條就不送，風險大。
* **只照排版、不整理詞與詞之間**：「韌性12機智9」黏在一起。**欄位之間用「、」或「，」**：改了原本的標點。
* **只在單位第一次建立時算**：譯名改了，本機的譯文會留著舊的。
* **欄位化的單位算在「原樣保留」裡**：它們是翻好的，不是原文。
* **擴充 `sample-pack`**：它已經給 lint、test、extract 的測試用，案例混在一起不好讀。
* **鍛造有數值塊的合成 PDF**：判角色在 `extract.test.ts` 已經測過，CLI 測試用合成的 `document.json` 就夠。
* **放進 `mask.ts`**：它是遮蔽與還原的模組，範圍會變大。

## Open Questions

- [ ] H-15：真書的數值塊有多少整塊對得上，等 M4 的 `d100-orc` 量（第 2 項）。
- [ ] 欄位之間的全形空白與標點的處理，等真的規則包與真書的數值塊再看（第 3 項）。
- [ ] 表格形式的數值塊要不要欄位化（第 11 項）。
