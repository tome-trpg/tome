---
id: ADR-0115
status: accepted
date: 2026-11-08
depends-on: [ADR-0011, ADR-0018, ADR-0023, ADR-0029, ADR-0059, ADR-0068, ADR-0085, ADR-0092, ADR-0097, ADR-0099, ADR-0100, ADR-0103, ADR-0112, ADR-0113]
amends: [ADR-0092, ADR-0099, ADR-0103, ADR-0113]
---

# ADR-0115：文件結構：索引、版權頁、書籤層級、`full_image` 與放行

## 脈絡

ADR-0113 第 22 項把回合 026「文件結構」排在 025 之後：行內 `runs` 與 `<pc>`（第 4 項）、`index` 與 `credits` 自動判定（第 5 項）、巢狀書籤依層級選章節（第 7 項）、`scan` 改名（第 8 項）與放行操作的格式（ADR-0099 第 11 項）。開工前查到的事實寫在共用筆記 `brief-026-questions.md`，實作時的細節寫在 `brief-026-details.md`。

**`scan`**：最大一張圖占頁面 60% 以上、文字層幾乎看不見或少於 40 個字的頁（`src/core/probe.ts`）。它同時包含真的掃描頁與整頁的插圖，ADR-0092 量到的 141 頁都是滿版圖片。這個名稱也在 `tome-engine/1` 的頁面類型裡。

**行內 `runs`**：IR schema 已經有欄位，Docling 轉接器不輸出。用合成 PDF 試 pdf.js：`bold` 旗標讀得到，`Times-Italic` 的 `italic` 卻是 false，真書的字型沒有量過。

**量測**：2026-11-08，執行 session 用 pdf.js（不跑 Docling）讀維護者 `C:\Repos\tome-books` 的 8 個 PDF，1 個加密的照 PC-3 跳過，其餘 7 本只印頁次、位置與數量，約 10 秒，書用編號代替，不寫書名（ADR-0092 第 7 項）。「像索引的頁」是至少 10 行、一半以上的行結尾是頁碼清單的頁，位置是頁次除以頁數：

| 書 | 頁數 | 書籤 | 開頭 | 中段 | 書末 |
| :--- | ---: | :--- | :--- | :--- | :--- |
| 2 | 226 | 3 層 | 0.02 | — | 0.96–1.00，中間有一頁低於一半 |
| 3 | 182 | 2 層 | 0.02 | — | 0.97–0.98 |
| 4 | 274 | 3 層 | — | — | 0.97–0.98 |
| 5 | 449 | 2 層 | 0.02 | 0.53 | 0.88–0.89、0.94–0.95 |
| 6 | 7 | 無 | — | — | — |
| 7 | 62 | 無 | 0.05 | — | — |
| 8 | 110 | 無 | 0.03 | 0.41、0.45 | — |

* 開頭的都是目錄，書末索引最早在 0.94。書 3、4、5 的最後一個頂層書籤正好從書末那段開始。書 5 在 0.88 的那段在倒數第二個頂層書籤裡，內容沒有看，分不出是不是索引。
* 帶 `©`、`(c)` 加年份或 `ISBN` 的頁：書 2、3 的第 3 頁，書 4 的第 3、5 頁，書 5 的第 4、5 頁。書 6、7、8 沒有這些記號，只有英文的 `copyright`、`all rights reserved`，都在第 2 頁。書末都沒有。
* 第 8 本是維護者的規則書 `book1`。它已解析的 `document.json` 沒有書末索引，第 3 頁的目錄 Docling 已標成 `document_index`，轉接器對到 `toc`，38 行裡 32 行結尾是頁碼，跟索引的行長得一樣。

**更正**：規則書 `book1` 沒有書籤：`probe.json` 的 `outline` 是 0 筆，pdf.js 讀到的頂層書籤也是 0。它的 174 個章節是沒有書籤時用 `heading`、`title` 建的（ADR-0092 第 5 項）。ADR-0112 Open Question 3 與 ADR-0113 第 7 項說的「平的書籤清單、一個章節只是一個小標題」是 Manager 的推論寫錯了，正確是「沒有書籤、用標題建出一層章節，每個小標題都成了一章」。

下列決定由維護者在 2026-11-08 選定：問題清單的 11 項全部照建議；細節第一輪 7 項中 `index` 的位置門檻從建議的 85% 改成 90%，其餘照建議；第二輪 9 項照實作的做法定案。

## 決定

**範圍**

1. 修改 ADR-0113 第 22 項：行內 `runs` 與 `<pc>` 拆到新的回合 **035**，排在 026 之後、027 之前（粗體與索引都是 Pass 0 的候選詞來源）。027 到 034 的編號不變。035 開工前要先量真書的字型資訊，`runs` 會改到變異測試的三個模組。ADR-0099 第 9 項的斷言（`mask.ts` 沒有 `<pc`）由 035 處理。
2. 修改 ADR-0113 第 7 項與 ADR-0112 Open Question 3：「平的書籤清單怎麼分章」改成「**沒有書籤的書怎麼分章**」，照舊等引擎評估（OpenDataLoader 這類有標題層級的引擎），不在 026 處理。

**`full_image`**

3. 修改 ADR-0099 第 12 項：頁面類型 `scan` 改名 **`full_image`**，判定不變。`probe.done` 寫「滿版圖片 {full_image} 頁」。
4. `tome-probe/1` 與 `tome-engine/1` 的列舉原地改，不升 schema 版本：0.1.0 還沒發佈，schema 一直在 `/1` 原地改。`PROBE_VERSION` 從 4 改成 5；版本不同時舊的 `probe.json` 不會被讀，直接重新探測，所以舊檔的 `scan` 不會造成格式錯誤。宣告 `pages: [scan]` 的第三方引擎會被格式檢查擋下，內建的 Docling 是 `[native]`。

**`index` 與 `credits`**

5. 修改 ADR-0092 第 6 項的「`index`、`credits` 不自動判定」：組裝時在核心判定（ADR-0023 第 1 項，兩者都是描述文件結構的核心角色），規則包不用宣告。判定在每頁排好閱讀順序之後、跨頁接段之前：`assemble.ts` 的接段只接兩個 `paragraph`，索引的條目常以小寫開頭，先判成 `index` 才不會被接成一長段。`overrides` 照舊在組裝之後套用，`role` 可以改回，也可以手動標。`ASSEMBLY_VERSION` 從 1 改成 2，已解析的書下次 `tome extract` 會重新組裝，引擎不重跑。
6. **`index`**：頁次在全書的 **90%** 之後（頁次加 1 除以頁數），那一頁至少 **10 行**，**一半以上**的行結尾是頁碼清單；夾在兩頁索引之間的一頁也算。那些頁上的 `paragraph`、`list_item`、`toc`、`table` 改成 `index`，標題、圖、說明、邊欄與頁首頁尾不動。
   * 位置：判錯成 `index` 的內容不會翻譯、使用者也不會發現；漏判只是多花錢翻索引。所以寧可少判，比照 `credits`。量到的書末索引最早在 0.94，書 5 在 0.88 的那段不會碰到。不用書籤：書 6、7、8 沒有書籤，位置已經分得開。
   * 行：表格每一格一行；其他區塊用引擎的原文 `raw` 依換行分行，因為組裝會把區塊內的行接成一行；讀不出來的字當空白。頁首頁尾與圖不算。
   * 「結尾是頁碼清單」：前面要有字母，清單前要有空白、逗號或句點，頁碼是 1 到 4 位數，可以是範圍（`12–14`），用逗號分隔。判斷用從行尾往前掃一次的函式，不用正規表示式，長行不會回溯。
7. **`credits`**：開頭 **6 頁**與最後 **2 頁**裡，帶版權記號的 `paragraph`、`list_item`、`sidebar` 改成 `credits`，只改有記號的區塊，不整頁改。
   * 記號：`©`、`(c)` 加四位數年份、`ISBN` 不分語言，寫在核心。`™`、`®` 不算，規則書的內文裡就有商標。
   * 語言相關的字詞放來源語言設定檔，`tome-lang/1` 加選用欄位 **`credits_phrases`**，不分大小寫比對；`en` 是 `copyright`、`all rights reserved`。書 6、7、8 只有這種字詞。
   * 範圍是 6 頁，因為有兩本的版權頁在第 5 頁。ADR-0011 的版權頁保留原文，誤判的內文就不會翻譯，所以只看強記號與字詞。
8. 重新組裝時，`tome extract` 判出 `index` 或 `credits` 就各印一行：`extract.index_found`、`extract.credits_found`（info），寫頁數與 PDF 頁次，提醒判錯時可以用 `overrides.yaml` 的 `role` 改回。頁次清單最多 20 頁。手動標的也算在內；沿用 `document` 層時不印。

**書籤的層級**

9. 修改 ADR-0103 第 18 項：`--chapters` 的編號依 **`book.yaml` 的 `chapter_level`**（整數，預設 1），`tome estimate --chapter-level <層>` 寫進去，之後沿用。第 N 層的章節是**深度 N 以內的所有書籤，依閱讀順序攤平**，每個區塊照舊依章節的起始區塊歸章。只取第 N 層的話，沒有子書籤的上層書籤與父書籤到第一個子書籤之間的內容會沒有自己的章。
   * `--chapters`、請求不跨章、批次的分批、`tome preview` 的分檔、`tome status` 與翻譯的範圍都依這個層級。
   * 內容指紋在設了 `chapter_level` 時加入它，換層級要重新確認估價；沒設時指紋不變，已確認的估價不會因為升級而失效。
   * 已存了範圍、層級又改了時，同一個指令要一起給 `--chapters`，否則回 `chapter_level.needs_chapters`（結束碼 2），避免舊的編號指到別的章。
   * 層級超過書籤的層數、不是正整數時回 `chapter_level.invalid`（結束碼 2）。沒有書籤的書只有一層。
   * 書籤標題是書本文字，CLI 不列章名（ADR-0059）。書籤有兩層以上時，`tome extract` 與 `tome estimate` 印 `chapters.levels`（info）：共幾層、每層幾個、目前依第幾層、共幾章，只有數字。
   * 章節的函式從 `request.ts` 搬到 `src/core/chapters.ts`，`tome extract` 用得到，也不會循環匯入。

**放行**

10. 依 ADR-0099 第 11 項，`tome-overrides/1` 加放行操作 **`{ op: accept, page: 13 }`**。
    * `page` 是 PDF 頁次，從 1 起算，跟 `extract.characters_missing` 印的一樣。
    * 效果：那一頁的狀態是 `ok`，`reason` 是 `accepted`，`missing`、`total` 照留；區塊進 `blocks`，會翻譯。`tome-ir/1` 不用改，`reason` 本來就是自由的代碼。
    * 組裝判斷頁面狀態時套用，不是組裝之後：失敗頁的區塊在組裝時就丟掉了。只放行**未通過字元守恆**的頁；引擎沒有輸出的頁沒有區塊可收。
    * 放行一頁不需要放行的頁時回 `overrides.no_page`（warn，結束碼 0），跟其他對不到的操作一樣（ADR-0092 第 18 項）。放行生效時印 `extract.accepted`（info），寫頁數與頁次。
    * 預設仍是失敗。交付報告列出放行的頁在 030。

## 驗證

<!-- @assert-count target="src/core/probe.ts" symbol="export const PROBE_VERSION = 5;" expected="1" reason="第 4 項：改名之後重新探測" -->
<!-- @assert-count target="src/core/probe.ts" symbol="export type PageKind = 'native' | 'full_image' | 'broken_text' | 'image_only';" expected="1" reason="第 3 項：scan 改名 full_image" -->
<!-- @assert-absence target="src/core/probe.ts" symbol="'scan'" reason="第 3 項：不再有 scan 這個頁面類型" -->
<!-- @assert-count target="schemas/tome-engine-1.schema.json" symbol="full_image" expected="1" comments="include" reason="第 4 項：引擎協定的頁面類型也改名" -->
<!-- @assert-count target="src/core/assemble.ts" regex="true" symbol="export const ASSEMBLY_VERSION = ([2-9]|\d{2,});" expected="1" reason="第 5 項：判定改了要重新組裝，035 再加 1（ADR-0116）" -->
<!-- @assert-count target="src/core/assemble.ts" symbol="const INDEX_FROM_SHARE = 0.9;" expected="1" reason="第 6 項：只判全書 90% 之後的頁" -->
<!-- @assert-count target="src/core/assemble.ts" symbol="const INDEX_MIN_LINES = 10;" expected="1" reason="第 6 項：至少 10 行" -->
<!-- @assert-count target="src/core/assemble.ts" symbol="const INDEX_LINE_SHARE = 0.5;" expected="1" reason="第 6 項：一半以上的行結尾是頁碼" -->
<!-- @assert-count target="src/core/assemble.ts" symbol="const CREDITS_FIRST_PAGES = 6;" expected="1" reason="第 7 項：開頭 6 頁" -->
<!-- @assert-count target="src/core/assemble.ts" symbol="const CREDITS_LAST_PAGES = 2;" expected="1" reason="第 7 項：最後 2 頁" -->
<!-- @assert-count target="src/core/assemble.ts" symbol="markIndex(work, pages.length);" expected="1" reason="第 5 項：在接段之前判定" -->
<!-- @assert-count target="languages/source/en.yaml" symbol="credits_phrases: [copyright, all rights reserved]" expected="1" comments="include" reason="第 7 項：語言相關的字詞放語言設定檔" -->
<!-- @assert-count target="src/core/chapters.ts" symbol="...(level > 1 ? chapterSections(section.children, level - 1) : [])," expected="1" reason="第 9 項：深度 N 以內的書籤依閱讀順序攤平" -->
<!-- @assert-count target="src/core/request.ts" symbol="...(book.config.chapter_level === undefined ? [] : [book.config.chapter_level])," expected="1" reason="第 9 項：設了層級才進內容指紋" -->
<!-- @assert-count target="src/core/assemble.ts" symbol="if (accepted.has(page)) return { page, status: 'ok', reason: ACCEPTED, missing, total };" expected="1" reason="第 10 項：放行的頁狀態是 ok、原因是 accepted" -->
<!-- @assert-count target="schemas/tome-overrides-1.schema.json" symbol="#/$defs/accept" expected="1" comments="include" reason="第 10 項：overrides 的放行操作" -->

實作後的驗證（2026-11-08）：在暫存資料夾複製 `book1` 的 `source` 層，在程序內重新組裝，只印數量，跑完刪掉複本，沒有寫入維護者的工作區。110 頁都是 `ok`，區塊數前後都是 1,723；`index` 0 個（這本書沒有書末索引）；`credits` 1 個區塊，在第 2 頁，原本是 `sidebar`；第 60 頁內文裡的商標沒有被判成 `credits`。Docling 會把書末索引切成目錄、段落還是表格，已解析的書都沒有索引，**沒有驗證**：門檻是用 pdf.js 的行量的。

## 後果

書末索引與版權頁的記號區塊不再送翻譯，`tome extract` 會說哪幾頁是，判錯時用 `overrides` 改回。規則只用七本書的 pdf.js 行量過，Docling 怎麼切書末索引沒有驗證，有書末索引的書第一次解析時要看那一行的數量。90% 的門檻會漏掉在書末 10% 之前開始的長索引，漏的部分照常翻譯。

巢狀書籤可以依層級選章，Cthulhu 選第 2 層就是書名那一章加三章。選更深的層級時章變多，請求不跨章，所以請求也會變多。父書籤與第一個子書籤落在同一個區塊時（組裝依標題在那一頁找區塊，找不到取第一個區塊），父書籤那一章是空的，`--chapters` 選到它不會有單位。沒有書籤的書照舊每個標題一章。

`full_image` 的判定沒變，已探測的書會重新探測一次。放行的頁會翻譯，缺的字照樣缺，要在交付報告（030）列出來。

## 替代方案

否決了下列做法：

* **026 不拆，一個回合做完**：PR 很大，`runs` 的可行性還沒量。**`runs` 先做**：同上。
* **`scan` 改成 `image_page`、`raster` 或 `image_cover`**：`full_image` 只描述看得到的事實。**升成 `tome-probe/2`、`tome-engine/2`**：0.1.0 還沒發佈，一直原地改。
* **`index` 的門檻 85%**：會碰到書 5 在 0.88 那段不確定是不是索引的內容，判錯時翻譯會少掉、使用者不會發現。**用最後一個頂層書籤判定**：有三本沒有書籤，也要把書籤傳進組裝。**只看內容不看位置**：目錄會被判成索引。
* **判定放在規則包的 `detect`**：`index`、`credits` 是核心角色，不是遊戲知識。**接段之後才判**：索引的條目會先被接成一長段。
* **版權頁整頁改成 `credits`**：同一頁有別的內容時會誤判。**只看前 4 頁**：兩本的版權頁在第 5 頁。**`™`、`®` 也算**：內文裡的商標會被誤判。**英文字詞寫在核心**：核心不放語言相關的字詞。
* **用正規表示式判斷頁碼清單**：長行會回溯，PR 40 的 CodeQL 因為 `js/polynomial-redos` 失敗過。
* **只取第 N 層的書籤**：上層沒有子書籤的書籤與父書籤下的開頭內容會沒有自己的章。**頂層只有一個書籤時自動往下一層**：另一條規則，使用者看不出發生了什麼。**`--chapters 2:1-3` 把層級寫進範圍**：每次都要寫層級。**層級一律進內容指紋**：升級後所有已確認的估價都要重新確認。**換層級時自動清掉範圍**：使用者不會注意到範圍沒了。
* **放行只定格式、不生效**：使用者寫了也沒有用。**放行的頁用新的狀態 `accepted`**：要改 `tome-ir/1`，`reason` 已經夠用。**頁面用從 0 起算的索引**：跟訊息印的頁次不同。
* **索引、版權頁的那兩行沿用時也印**：每次都印同樣的內容。

## Open Questions

- [ ] 沒有書籤的書怎麼分章（第 2 項），等引擎評估的結果（ADR-0113 第 21 項）。
- [ ] Docling 怎麼切書末索引，有書末索引的書第一次解析之後再看 `extract.index_found` 的數量（第 6 項）。
- [ ] 書 5 在 0.88 的那段是不是索引，維護者在本機看過之後，決定 90% 要不要再調（第 6 項）。
- [x] 行內 `runs` 與 `<pc>`，回合 035（第 1 項）。2026-11-11 核對：ADR-0116 定案（ADR-0129 第 9 項）。
