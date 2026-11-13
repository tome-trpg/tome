---
id: ADR-0136
status: accepted
date: 2026-11-13
depends-on: [ADR-0023, ADR-0042, ADR-0044, ADR-0045, ADR-0048, ADR-0061, ADR-0066, ADR-0068, ADR-0084, ADR-0092, ADR-0100, ADR-0121, ADR-0130, ADR-0133]
amends: [ADR-0061]
---

# ADR-0136：d100-orc 規則包

## 脈絡

第一版的完成條件是公開的 ORC 文件一章，加本機商業書一章，全流程跑完、Q-1 到 Q-8 達標（ADR-0066 第 3 項）。ADR-0130 第 13、21 項把回合 046 排成 `d100-orc`：規則包、公開素材的下載與雜湊、H-15 的量測；用哪一份 ORC 文件，開工前調查授權與雜湊後給維護者選，範圍先做到完成條件那一章用得到的角色、數值塊與詞條。之前定的：

* 內建規則包 `d100-orc` 依 Basic Roleplaying: Universal Game Engine 的 ORC 內容，目錄用 ORC 授權；`NOTICE` 要有 ORC 聲明、署名、Reserved Material 聲明（白皮書 §5.8、ADR-0048）。ID 用中性名稱，來源只在 `NOTICE` 寫明（ADR-0042）。
* 公開規則包的譯名自己定，不抄任何官方中文版（PC-1）。
* 公開素材下載後驗證雜湊，不進 repo；每個素材在來源清單登記授權與雜湊（ADR-0061）。
* 數值塊欄位化已實作，只用合成的測試規則包驗證過；真書的涵蓋率（H-15）等 `d100-orc`（ADR-0121）。

開工前的問題寫在共用筆記 `brief-046-questions.md`，10 項由維護者在 2026-11-13 選定；譯名表、比對範圍與範例另外審過。

## 決定

**文件與下載**

1. **用 Chaosium 官方的 Basic Roleplaying ORC Content Document，PDF 版。** 它是 Chaosium 唯一的 ORC 內容文件，也有 RTF 版，但 `tome add` 只收 PDF。2026-11-13 下載到維護者的 `C:\Repos\tome-books\public\`，保留給 050 的全流程用：3,843,799 位元組，SHA-256 `d38af1fc2c27326b0ee8e42af0579684220ccf30809b195275d9daf29cedbb28`。網頁沒有公布雜湊、版本或大小，雜湊是下載後算的。文件 303 頁、有書籤；它是公開素材，可以讀內容，規則包從它衍生；文件本身、整段原文、譯文與截圖都不進 repo。
2. **授權全文用註冊的定稿。** Chaosium 網頁上的 `ORC_License_FINAL.pdf`（202,167 位元組）內文標題是「ORC LICENSE [INTERIM]」，聲明的範例寫「TX00[number TBD]」，是註冊前的暫定版；條文第 V.c 節說以 Azora Law 向美國著作權局註冊的英文版為準。維護者同意改下載 Paizo 的 `ORC_LicenseFINAL.pdf`（248,604 位元組，SHA-256 `3fffe0fe69781b7115bccbfa0f51489e0a073c211772f5ebcd84d34f88f19b29`），內文標題是「ORC LICENSE FINAL」、號碼是 TX 9-307-067；兩版的條文只差這個號碼。另外下載的 Chaosium 暫定版與 AxE（251,968 位元組）只拿來讀，不是測試素材，不登記。
3. **完成條件那一章是第 11 章 Creatures**（第 262 到 303 頁，42 頁），維護者在各章的數字出來後選定。下面的數字只用 PDF 的文字層算，**不是 `tome extract` 與 `tome estimate` 的結果**（成熟度：估算）：
   * 一行裡六個屬性（STR、CON、SIZ、INT、POW、DEX）齊全的行：Creatures 54 行、在 33 頁，其他章合計 4 行。
   * 估價：段落照行距粗分、照 `REQUEST_CHARS` 與 `REQUEST_UNITS` 裝進請求，照 ADR-0134 的算式、0.25 的重送餘裕，Sonnet 5.5 批次、只算主翻譯：138,981 個字元、約 280 段、約 26 個請求，$0.39 到 $0.63。不含 Pass 0、試翻與欄位化省下的請求。精確的數字等第 13 項的 workflow 在 runner 上解析後再補。

**規則包**

4. **範圍只做 Creatures 用得到的。** `systems/d100-orc/`，`extends: generic`、`license: ORC`。`stat_block` 宣告 `detect` 與 `fields`：偵測屬性的標頭列、`Move:`、`Damage Modifier:`、`Attacks:`、`Skills:` 開頭的欄位與「名稱 數字%, 傷害」的攻擊行；`Powers:`、`Weaknesses:`、`Spells:` 是敘述，不判。表格不判角色（ADR-0092），自然動物表照常送 LLM。不做法術、超能力、世界設定與那一章用不到的詞。
5. **詞條 299 個**：維護者審過的 300 個，拿掉第 7 項的三個，加第 7 項的兩個長詞。譯名是 TOME 的貢獻者自己擬的，沒有參考任何官方中文版。
   * 屬性與衍生數值的縮寫保留原文：STR、CON、SIZ、INT、POW、DEX、CHA、HP、MOV、SAN、`dm`、`DM`（`keep_source`）。全名照譯，例如 Strength 力量、Hit Points 生命值、Damage Modifier 傷害加值。
   * 生物與條目名收。
6. **進提示的文字**：`stat_block.style` 照抄 `generic` 的那一句（同名的角色由子包整個取代，不會繼承）；人設沿用 `generic`，不寫 `persona_and_tone.md`；`few_shots.md` 六組，前三組照抄 `generic`，後三組是自己編的數值塊與規則用語，雜湊釘在 `tests/core/prompt.test.ts`。`dm` 保留原文，送出前就遮蔽成 `keep_source` 的佔位標籤，範例照模型看到的寫。
7. **比對範圍**。詞條一律強制：原文出現、譯文沒用到譯名就重送（`term_missing`），比對預設是大小寫相符、整個詞。用 Creatures 的文字層量過散文（扣掉數值塊、自然動物表與技能清單）：技能與攻擊名命中 38 次，其中 28 次不是指技能或武器（Tail 12 次是命中部位、Sense 10 次是異能名、Shield 2、Spot 1、Science 1、Language 1、Drowning 1）；全書句首的技能名幾乎都是指技能本身。所以：
   * `Sense`、`Tail`、`Shield`、`Hammer`、`Drowning` 只在數值塊比對；小寫的傷害類型、`fire`、`special`、`thrown` 這類也只在數值塊。
   * 加長詞擋住：`Spot Rules` 譯「情境規則」、`Science Fiction` 譯「科幻」，長詞蓋過短詞（ADR-0133）。
   * 拿掉 `Giant`、`Sorcerer`、`Psychic`：它們也是形容詞或法術名的一部分（Sorcerer 7 次裡 6 次是法術名、Giant 7 次裡 4 次是形容詞）。
   * 其他照預設。
   * 只在數值塊比對的角色寫成 `d100-orc:stat_block`：單位的角色帶規則包的 ID，寫成 `stat_block` 一處都比對不到，`tests/core/d100-orc-pack.test.ts` 擋著。
8. **resistance roll 譯「抗衡檢定」，Resistance Table 譯「抗衡表」**；opposed roll 譯「對抗檢定」、opposed skill roll 譯「技能對抗檢定」。整份文件 resistance roll 出現 222 次、Resistance Table 43 次、opposed roll 6 次，另有約 46 處其他的 opposed，兩種都有，所以分開。Creatures 只有 resistance roll，這個回合只收它；Resistance Table 與兩種 opposed 留給之後的章。
9. **授權與聲明**：`LICENSE` 放第 2 項的定稿全文，文字照 PDF 的文字層，只修正抽字留下的空白與合併的欄位，字詞逐字對過。`NOTICE` 照 Chaosium 網頁的寫法放 ORC 聲明與署名，我們的署名寫「TOME 的貢獻者（TOME contributors）」；這個包沒有自己保留的部分，全部照 ORC 授權提供；寫明不是 Chaosium 的官方產品、沒有背書。不放「Powered by BRP」標誌或任何圖檔；商標與世界設定的專有名詞不收進詞條。

**登記、驗證與量測**

10. **修改 ADR-0061 第 2、4 項的做法**：`tests/fixtures/SOURCES.yaml` 加 `external` 一段，登記 repo 外的公開素材，每筆寫 ID、網址、檔名、授權、位元組數、SHA-256、取得日期；`tests/tools/fixtures.test.ts` 查欄位，也查這些檔不在 repo 裡。現在登記第 1 項的內容文件（ORC）與第 2 項的授權定稿（Azora Law 在 AxE 裡把條文獻給公有領域）。
11. **驗證雜湊的工具不連網**：`node tools/verify-public.ts <資料夾> [ID …]` 照登記的檔名找、比位元組數與 SHA-256，只印 ID 與結果；下載用瀏覽器或指令手動做。
12. CI 的 `test` 跟 `generic` 一樣跑 `system lint systems/d100-orc --public` 與 `system test systems/d100-orc`。
13. **H-15 在 GitHub runner 上量整份文件**：`.github/workflows/h15.yml` 只能手動觸發，下載文件、用第 11 項的工具驗證、用 Docling 解析、套 `d100-orc`，跑 `tome estimate` 與 `tools/h15.ts`，只上傳數字：數值塊的單位有幾個在本機翻好、幾個原樣保留、幾個要送 LLM，整份與 Creatures 各一組，加上兩者的估價。
14. **本機語料**：2026-11-13 用維護者工作區兩本書的 document 層唯讀暫存複本量，只印數字，量完刪掉；照組裝時的做法用 `d100-orc` 的偵測判角色，再照翻譯時的做法遮蔽、欄位化（成熟度：已量測，但不是 `tome extract` 重新組裝的結果）。規則書（1,723 個區塊、54 個表格）判到 3 個數值塊，欄位化 0 個；公有領域短篇 0 個。兩本都不是 BRP，數字只當參考。

## 驗證

<!-- @assert-count target="systems/d100-orc/pack.yaml" symbol="license: ORC" expected="1" reason="第 4 項：目錄用 ORC 授權" -->
<!-- @assert-count target="systems/d100-orc/pack.yaml" symbol="extends: generic" expected="1" reason="第 4 項：繼承 generic" -->
<!-- @assert-count target="systems/d100-orc/LICENSE" symbol="ORC LICENSE FINAL" expected="1" reason="第 2、9 項：註冊的定稿" -->
<!-- @assert-count target="systems/d100-orc/LICENSE" symbol="number TBD" expected="0" reason="第 2 項：不是暫定版" -->
<!-- @assert-count target="systems/d100-orc/NOTICE" symbol="held in the Library of Congress at TX 9-307-067" expected="1" reason="第 9 項：照 Chaosium 的寫法" -->
<!-- @assert-count target="systems/d100-orc/NOTICE" symbol="TOME contributors" expected="3" reason="第 9 項：我們的署名與沒有自己保留的部分" -->
<!-- @assert-count target="systems/d100-orc/roles.yaml" symbol="style: 保留所有數字與欄位順序，只翻譯標籤。" expected="1" reason="第 6 項：照抄 generic" -->
<!-- @assert-count target="systems/d100-orc/glossary.yaml" symbol="target: 抗衡檢定" expected="1" reason="第 8 項：resistance roll" -->
<!-- @assert-count target="systems/d100-orc/glossary.yaml" symbol="opposed" expected="0" reason="第 8 項：opposed roll 留給之後的章" -->
<!-- @assert-count target="systems/d100-orc/glossary.yaml" symbol="roles: [stat_block]" expected="0" reason="第 7 項：角色要帶規則包的 ID" -->
<!-- @assert-count target=".github/workflows/test.yml" symbol="system lint systems/d100-orc --public" expected="1" comments="include" reason="第 12 項" -->
<!-- @assert-count target="tests/fixtures/SOURCES.yaml" symbol="sha256: d38af1fc2c27326b0ee8e42af0579684220ccf30809b195275d9daf29cedbb28" expected="1" comments="include" reason="第 1、10 項：內容文件的雜湊" -->
<!-- @assert-count target="tools/verify-public.ts" symbol="fetch(" expected="0" comments="include" reason="第 11 項：不連網" -->
<!-- @assert-count target="tools/h15.ts" symbol="fetch(" expected="0" comments="include" reason="第 13 項：量測不連網" -->

## 後果

`d100-orc` 隨程式發佈，跟 `generic` 一起出現在 `tome system list`。用它的書，Creatures 那種數值塊整塊在本機翻好，不送 LLM；護甲後面有說明、技能有沒收的專長、攻擊有特殊效果的行照常送。詞條強制譯名，所以散文裡技能名的譯法跟數值塊一致；誤判多的五個詞只在數值塊比對，換來的是散文裡提到它們時譯法不保證一致。

規則包的內容照 ORC 授權發佈，`NOTICE` 寫漏或寫錯會讓授權自動終止（第 V.a 節），所以 `tome system lint --public` 由 CI 把關。之後別章的詞要加進來時，照這次的做法先量散文裡的誤判。

`SOURCES.yaml` 多了 repo 外的素材，CI 只查欄位，不下載；要驗證的人自己下載、跑第 11 項的工具。

## 替代方案

**用 RTF 版**：TOME 不能直接處理；否決。**下載到暫存資料夾、用完刪掉**：050 的全流程也要用這份檔，跟第 10 項的登記矛盾；否決。**`LICENSE` 用 Chaosium 網頁上的暫定版**：號碼是空的，條文說以註冊版為準；否決。**`LICENSE` 只放聲明與位置**：合乎授權，但使用者要上網才看得到條款；否決。**縮寫譯成中文**：數值塊的標頭會變成中文，但跟英文版對照不便；維護者選保留。**D、E 段全部只在數值塊比對**：誤判歸零，散文裡的技能名就不保證一致；否決。**resistance roll 譯「對抗檢定」**：會跟 opposed roll 撞名；否決。**附「Powered by BRP」標誌**：它是圖檔，使用條件沒有明文；否決。**工具自己下載再驗證**：要在對外出口模組外連網，牽動 ADR-0039；否決。**在維護者的筆電上解析整份文件**：可能長時間吃滿所有核心；否決。

## Open Questions

* 散文裡的詞形變化（複數、所有格）不會命中，例如 `resistance roll` 不會比對到 `resistance rolls`。要不要加變化形，等 050 跑過 Creatures 看重送的原因再定。
