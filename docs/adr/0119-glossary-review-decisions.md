---
id: ADR-0119
status: accepted
date: 2026-11-08
depends-on: [ADR-0023, ADR-0026, ADR-0054, ADR-0059, ADR-0068, ADR-0082, ADR-0102, ADR-0113, ADR-0118]
amends: [ADR-0113, ADR-0118]
---

# ADR-0119：實體卡的審定、匯入與 `<new-term>` 佇列

## 脈絡

ADR-0113 第 22 項把回合 028 排成「審定與詞庫：`tome glossary review`、`import`、`<new-term>` 進佇列、S-16」，第 16 項定了「審定的介面是工作區裡的檔案，格式在那個回合開工前定」。ADR-0118 讓 Pass 0 產出**還沒審過的提議**，把狀態 `locked`、`rejected` 與來源 `import`、`new_term` 留給 028，沒拿到提議的詞（`failed`）留給人填。白皮書 §5.6 要依出現次數與類別分級審定：高影響的由人審，低頻的自動通過但保留紀錄；鎖定後才進主翻譯；優先序是使用者 > 本書審定 > 系列 > 規則包 > LLM 提議（ADR-0026 第 4 項）。

**現有程式**：`entity` 表在 `book.db` 第 9 版；翻譯還不用實體卡，只用規則包的 `glossary.yaml`；`<new-term>` 只在 `verify.ts` 寫成 `issue` 表的一列（`code` 是 `new_term`，`detail` 是原文與模型的譯名）；`tome-pack/1` 的 `entities.yaml` 有 `review_weight`，程式沒有讀，`generic` 也沒設；上下文的句子沒有存，只在 Pass 0 送出時算；沒有 CSV 的相依。

**量測（開工前）**：`book1`（ADR-0115 的書 8）的 `document.json` 複本，用 ADR-0118 的規則挖詞，只印數字，跑完刪掉：744 個候選詞，出現 3 次以上 385 個、5 次以上 207 個、10 次以上 97 個、20 次以上 40 個，只出現 1 次 142 個。這本書用 `generic`，沒有真的 Pass 0 提議，類別與代名詞的分布量不到。

開工前的 16 項問題寫在共用筆記 `brief-028-questions.md`，維護者在 2026-11-08 選定：第 1 項 S-16 移到 037，第 2 項審定介面用 YAML 檔，第 5 項門檻 5，其餘照建議。實作時的細節 17 項寫在 `brief-028-details.md`，維護者在同一天全部照建議選定；其中第 8 項「有性別或代名詞」照字面算，是提案（見第 9 項）。Manager 審 PR 68 時找到沒填 `decision` 的修改會被蓋掉，維護者選了保留（第 7 項）。

## 決定

**範圍**

1. 修改 ADR-0113 第 9、22 項與 ADR-0118 第 1 項：**S-16 移到回合 037**「實體卡進翻譯」。S-16 替換的是「已經用了舊譯名的譯文與翻譯記憶」，028 時翻譯還不用實體卡，沒有東西可換。028 只在審定改了已鎖定的譯名時記下 `previous_target`（第 10 項），037 從這裡接。
2. 028 不擋 `tome translate`：翻譯還不用實體卡。037 讓翻譯只用 `locked` 的卡；「還有要人審的詞時停下」是 032 的 `tome run` 關卡（白皮書 §8.2）。

**審定檔**

3. 審定在工作區的 **`books/<slug>/glossary-review.yaml`** 做，跟 `book.yaml`、`overrides.yaml` 一樣是人手改的檔；不放 `review/`（那是 `tome preview` 產生的）；不叫 `glossary.yaml`，免得跟規則包的檔名混淆。
4. 檔案分三段，取代問題清單第 2 項範例裡的單一 `entries`（第 4 項要已鎖定的另一段、第 11 項要略過的放最後一段）：**`review`**（`proposed` 與 `failed`，照影響由大到小，同分照 id）、**`locked`**、**`skipped`**（照出現次數）。`candidate`、`sent` 與 `rejected` 不列。每列有 `id`、`source`、`target`、`class`、`gender`、`pronoun`、`register`、`keep_source`、`match`（`case_sensitive`、`whole_word`、`roles`，一律攤開寫）、`count`、`origin`、`decision`；`review` 與 `skipped` 多一個 `seen_in`，`locked` 多一個 `decided_by`。欄名用英文。
5. 檔頭的說明與段落標題放 `src/cli/messages/zh-TW.json`，由 CLI 帶進核心（ADR-0082 第 9 項，核心不放給人看的文字）。
6. **`seen_in`** 是最多兩句上下文，用 ADR-0118 第 5 項的規則在跑指令時重算，不存進 `book.db`，改了也不套用。`<new-term>` 與匯入的詞用同樣的方法在全書找句子。

**套用**

7. **`tome glossary review <book>`** 一個指令做兩件事：檔案在就先讀回來，**只套用 `decision` 填了 `lock` 或 `reject` 的列**（不分大小寫）；然後收 `<new-term>`、自動鎖定、重寫檔案。
   * `lock` 依該列的欄位鎖定，`decided_by` 是 `human`；`reject` 不驗證其他欄位。已拒絕的要救回，用 `tome glossary import` 或在檔案裡寫它的 `id`。
   * 有問題的列不套用，其他照樣套用；訊息是 fail（結束碼 1），只印 `編號:欄位`，最多列 20 個。**有問題的列照人填的樣子寫回原來的段落**，只要改點名的欄位；`id` 不對、或卡不在任何一段（例如已拒絕）的放在 `review` 最前面。人這次改過但沒套用成功的卡不自動鎖定。
   * **沒填 `decision` 的修改也照人填的樣子留著**：可修改的欄位（`target`、`class`、`gender`、`pronoun`、`register`、`keep_source`、`match`）跟 `book.db` 不同的列，寫回原來的段落，不套用，這次也不自動鎖定；內容沒變的照舊從 `book.db` 重寫。比對前先正規化：空白、null 與預設的比對條件跟 `book.db` 的 NULL 視為相同，YAML 讀回來的 `false` 或寫出來的 `case_sensitive: true` 才不會被當成有改。`id` 對不到卡、沒填 `decision` 的列也留著，人刪掉才會不見。人改到一半、為了套用別的列跑一次指令，改的東西不會不見。這是 Manager 審 PR 68 時找到的（第一版會用 `book.db` 的內容蓋掉），維護者選了「照改的樣子保留」。
   * 檔案讀不懂（YAML 壞了、段落不是清單、列不是物件）時什麼都不套用、不覆寫檔案，人改到一半的內容才不會不見。
   * 先寫暫存檔再改名。要先解析過（`document.json`）。拿書的鎖（ADR-0054）。
8. **驗證人填的內容**：`target` 不能是空的、不能混入簡體字（ADR-0102 的 `script_check`）；`class` 要在規則包的類別裡；`pronoun` 要在目標語言的代名詞清單裡；`gender` 只收 female、male、none；`keep_source`、`case_sensitive`、`whole_word` 是布林；`roles` 是核心角色或 `規則包:角色`。預設的比對條件存 NULL，跟 ADR-0118 第 12 項一樣。
9. **分級審定**：下列任一項就要人審，其餘的提議在每次跑 `tome glossary review` 時**自動鎖定**，第一次跑就鎖，`decided_by` 是 `auto`，之後在檔案裡照樣可以改：
   * 出現次數乘上類別的 `review_weight`（繼承鏈由子到父，子包的優先，沒設是 1）達 **5**；
   * 有性別或代名詞的提議，**照字面算**：`gender: none` 與跟類別預設代名詞一樣的代名詞（例如 `item` 的「它」）也算；
   * `keep_source`；
   * 沒拿到提議（`failed`）或來自 `<new-term>`。

   自動鎖定要有譯名。門檻 5 與「有性別或代名詞」的範圍都是**提案**：`prompts/scan-terms.md` 會把類別的預設代名詞列給模型看，模型可能每個 `item`、`creature` 都加上代名詞，自動鎖定的比例就會變低；照字面只會多審，不會少審。等真的跑過 Pass 0、看到分布，兩者一起調。
10. **上一個譯名**：已鎖定的卡改了譯名才記 `previous_target`，再改就換成新的上一個；沒改譯名時保留原本記的。給 037 的 S-16 用。
11. **`<new-term>` 進佇列**：跑 `tome glossary review` 時把 `issue` 表裡 `new_term` 的列收進 `entity`，`origin` 是 `new_term`、`status` 是 `proposed`、`target` 是模型在譯文裡用的譯名（沒有就留空），出現次數照全書重算。同一個原文只收一次；`entity` 已有同一個原文的（任何狀態）不收，被拒絕的詞翻譯再回報也不會回來。

**匯入**

12. **`tome glossary import <book> <csv>`**：使用者自己的譯名**直接鎖定**，`origin` 與 `decided_by` 都是 `import`；新的詞先建卡，再走跟審定同一段鎖定的程式。同一個原文已有的就覆蓋，`origin` 改成 `import`（使用者的優先序最高）；內容跟已鎖定的一樣算「未變更」。原文比對區分大小寫，前後空白不算；同一份 CSV 有重複的原文，後面的覆蓋前面的。規則包有同一個詞時照存，037 依優先序用本書的。不用先解析，沒解析過時出現次數記 0。
    * 欄位：`source,target,class,gender,pronoun,register,keep_source,case_sensitive,whole_word`，沒有 `roles`；第一列是欄名（不分大小寫），只有 `source`、`target` 必填；有不認得的欄名或缺必填欄，整份不匯入。是非欄位收 `true`、`yes`、`1` 與 `false`、`no`、`0`（不分大小寫），留白用預設（`keep_source` 否、`case_sensitive` 與 `whole_word` 是）。
    * UTF-8，開頭的 BOM 可以有（Excel 存的檔）；引號照 RFC 4180，**手寫解析**（ADR-0113 第 19 項），耗時跟長度成正比；引號沒收尾時整份不匯入。
    * 驗證跟第 8 項一樣，有問題的列不匯入，其他照樣匯入，訊息只印 `列號:欄位`。列號跟試算表一樣：空行也算一列，引號裡的換行不另算；一排逗號的空白列跳過。

**儲存與訊息**

13. `book.db` 遷移第 10 版：`entity` 加 **`decided_by`**（`human`、`auto`、`import`）、**`decided_at`**、**`previous_target`**。`status` 多了 `locked`、`rejected`，`origin` 多了 `import`、`new_term`（ADR-0118 第 12 項留給 028 的）。
14. 訊息、`--json` 與紀錄**只有數量、編號、列號與欄位名**；審定檔裡有書本文字（`source`、`target`、`seen_in`），只留在工作區（ADR-0059）。檔頭說明提醒不要分享。
15. **`tome status`** 多一行實體卡的數量：待人審（`proposed` 加 `failed`，其中幾筆沒提議）、已鎖定（人審、自動、匯入）、已拒絕。沒有任何實體卡時不印。
16. 程式放 `src/core/glossary.ts`（審定與匯入）、`src/core/csv.ts`（CSV 解析）與 `src/core/entities.ts`（實體卡的計數，`tome status` 與審定共用，`status.ts` 不必依賴審定的程式）。

## 驗證

<!-- @assert-count target="src/core/store.ts" symbol="ALTER TABLE entity ADD COLUMN decided_by TEXT;" expected="1" reason="第 13 項：誰決定的" -->
<!-- @assert-count target="src/core/store.ts" symbol="ALTER TABLE entity ADD COLUMN previous_target TEXT;" expected="1" reason="第 10、13 項：上一個譯名，給 037 的 S-16" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="export const REVIEW_FILE = 'glossary-review.yaml';" expected="1" reason="第 3 項：審定檔的位置" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="export const REVIEW_THRESHOLD = 5;" expected="1" reason="第 9 項：門檻 5，是提案" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="row.occurrences * weightOf(row.class) >= REVIEW_THRESHOLD" expected="1" reason="第 9 項：出現次數乘權重" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="row.origin === 'new_term' ||" expected="1" reason="第 9 項：new-term 一律人審" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="if (needsHuman(row, weightOf) || row.target === null || touched.has(row.id)) continue;" expected="1" reason="第 7、9 項：要人審的、沒譯名的、人改壞的不自動鎖定" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="else if (editable(entry) !== stored(row)) kept.set(row.id, entry);" expected="1" reason="第 7 項：沒填 decision 的列不套用，改過的照人填的樣子留著" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="findings: [finding('glossary.file_invalid', 'fail', { path })]" expected="1" reason="第 7 項：讀不懂就什麼都不改" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="const previous = row.status === 'locked' && row.target !== null && row.target !== card.target ? row.target : null;" expected="1" reason="第 10 項：已鎖定的改了譯名才記" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="const GENDERS: ReadonlySet<string> = new Set(['female', 'male', 'none']);" expected="1" reason="第 8 項：性別只收三種" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="SELECT DISTINCT detail FROM issue WHERE code = 'new_term'" expected="1" reason="第 11 項：new-term 從 issue 表收" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="lock(store, existing, card, 'import', 'import');" expected="1" reason="第 12 項：匯入直接鎖定並覆蓋" -->
<!-- @assert-count target="src/core/csv.ts" symbol="export function parseCsv(input: string): CsvResult {" expected="1" reason="第 12 項：手寫的 CSV 解析" -->
<!-- @assert-count target="src/core/status.ts" symbol="finding('status.entities', 'info'" expected="1" reason="第 15 項：tome status 的實體卡數量" -->

測試只用合成的詞（`tests/cli/glossary.test.ts`、`tests/core/csv.test.ts`），確認訊息與 `--json` 不含原文、譯名與上下文。

## 後果

維護者第一次跑 `tome glossary review` 時，低影響的提議已經自動鎖定，檔案裡要審的是高影響、有性別或代名詞、要保留原文、沒提議或翻譯回報的新詞。照 `book1` 的出現次數，5 次以上的約占候選詞的四分之一（207／744）；加上有代名詞的提議，實際要人審的比例要等真的 Pass 0 才知道，可能更高（第 9 項照字面算代名詞）。

審定檔在工作區、有書本文字，跟 `book.db` 一樣只在本機；維護者可以分好幾次審，改壞的列與還沒決定的修改都不會不見。代價是：用 `tome glossary import` 改了檔案裡已有的詞之後，檔案裡那一列的舊內容跟 `book.db` 不同，會被當成人改的留著；刪掉那一列（或整個檔案）再跑一次，就會照 `book.db` 重寫。鎖定的卡還不會進翻譯，要等 037；S-16 也在 037。

`entity` 多三欄，舊的列是 NULL。`tome glossary import` 讓使用者自己的譯名不必經過 Pass 0。

## 替代方案

否決了下列做法：

* **028 做 S-16**：沒有用過實體卡的譯文可換；只對規則包詞條做，要另外記住上次用的規則包譯名，範圍變大。
* **審定用 CSV**：Excel 會改編碼與引號，上下文的句子放進格子不好讀。**Markdown 表格**：vault 在 030 才有，表格難編輯。**終端機逐筆問答**：幾百筆要一次答完、中途不能存，也不能腳本化測試。
* **分成兩個指令或 `--apply` 旗標**：多一個要記的東西。
* **門檻 3 或 10**、**不自動鎖定**、**自動鎖定只限只出現一次的詞**：門檻是提案，等真的 Pass 0 再調；全部人審做不到。
* **性別 `none` 與類別預設代名詞不算**：可能讓更多詞自動鎖定；維護者選了先照字面，只會多審，等 Pass 0 的分布再調。
* **有問題的列用 `book.db` 的內容重寫**：人填的東西會不見。**有問題就整份不套用**：一處打錯就卡住其他幾百筆。**沒填 `decision` 的列一律用 `book.db` 重寫**（第一版的做法）：人改到一半跑一次指令，改的東西沒有提示就不見。
* **`rejected` 也列成一段**：檔案變長；救回可以用匯入或寫 `id`。
* **Pass 0 送出時把句子存進 `entity`**：多存一份書本文字，舊的候選詞沒有。
* **用套件解析 CSV**：要過授權與冷卻期，RFC 4180 手寫不長。

## Open Questions

- [ ] 分級審定的門檻 5 與「有性別或代名詞」的範圍（`gender: none` 與類別預設代名詞算不算），等真的 Pass 0 提議出來，看分布與要人審的比例再一起調（第 9 項）。
- [ ] 審定檔在上千筆時好不好用，等 M3 收尾用真的規則書審過再看（第 4 項）。
