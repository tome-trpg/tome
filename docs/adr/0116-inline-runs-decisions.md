---
id: ADR-0116
status: accepted
date: 2026-11-08
depends-on: [ADR-0023, ADR-0059, ADR-0068, ADR-0084, ADR-0085, ADR-0092, ADR-0097, ADR-0099, ADR-0100, ADR-0102, ADR-0113, ADR-0114, ADR-0115]
amends: [ADR-0099, ADR-0114, ADR-0115]
---

# ADR-0116：行內樣式：`runs` 與 `<pc>`

## 脈絡

ADR-0115 第 1 項把行內 `runs` 與 `<pc>` 拆成回合 035：粗體、斜體與連結進 IR 的 `runs`，翻譯時以 `<pc>` 保留，回填與驗證；ADR-0099 第 9 項的斷言（`mask.ts` 沒有 `<pc`）由這個回合處理。開工前查到的事實寫在共用筆記 `brief-035-questions.md`，實作時的細節寫在 `brief-035-details.md`。

**現有程式**：IR schema 已經有 `runs`（`bold`、`italic`、`small_caps`、`ruby`、`link`）。`prompts/translate.md` 已經寫了 `<pc>` 的規則，`tags.ts` 解析得到，`verify.ts` 已經把 `<pc>` 算進「標記要一樣」，少了會重送。`mask.ts` 還原時把 `<pc>` 丟掉。Docling 的 PDF 流程不填 `formatting`，文字格有 `font_name`。

**量測**：2026-11-08，執行 session 用 pdf.js（不跑 Docling）讀維護者 `C:\Repos\tome-books` 的 8 個 PDF，1 個加密的照 PC-3 跳過，其餘 7 本只印比例與數量，不印字型名稱、字詞與書名，書用 ADR-0115 的編號。pdf.js 預設不匯出字型名稱，要開 `fontExtraProperties` 才有；合成 PDF 上看得到的 `bold`、`italic` 旗標，真書的字型物件裡沒有，所以只能依字型名稱判斷。開了之後 7 本書共 670 個字型都有名稱。依名稱判斷的字元比例（量測時比對整個名稱，規則比第 2 項鬆）：

| 書 | 頁數 | 粗體字元 | 斜體字元 | 粗斜體 | 連到網址 | 連到頁 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | 226 | 8.3% | 8.3% | 1.2% | 3 | 1,942 |
| 3 | 182 | 9.4% | 5.2% | 0.8% | 3 | 1,289 |
| 4 | 274 | 6.3% | 2.6% | 1.3% | 12 | 2,169 |
| 5 | 449 | 4.2% | 12.9% | 0.1% | 0 | 188 |
| 6 | 7 | 4.6% | 3.0% | 1.2% | 3 | 0 |
| 7 | 62 | 10.2% | 8.3% | 1.7% | 1 | 34 |
| 8 | 110 | 12.7% | 10.7% | 3.4% | 3 | 0 |

名稱的判斷規則沒有逐一對過，因為量測不印名稱。名稱裡沒有樣式字樣的字型、用描邊畫的粗體會漏掉。小型大寫與 `ruby` 沒有量。

問題清單的 13 項由維護者在 2026-11-08 照建議選定。實作時的細節 11 項在維護者已定的方向內，由 Manager 在同一天照建議同意；其中第 1 項改了問題清單第 7 項的欄位（見第 14 項），第 11 項是寫測試時才發現的（見第 4 項）。

## 決定

**樣式從哪裡來**

1. `runs` 由 TOME 在組裝時產生，**不改 Docling 轉接器**，也不改 `tome-engine/1`。換成別的引擎也適用（ADR-0085），改動不碰 `engines/`。引擎給的 `runs` 不用：它對的是引擎的文字，組裝清理過的文字對不上。
2. 粗體、斜體依 **pdf.js 的字型名稱**判斷。`openPdf` 加選項 `fontStyles`，開了才傳 `fontExtraProperties`；只有 `tome extract` 組裝讀版面時開，`tome probe` 不開，探測用不到字型，記憶體用量也沒量過。`TextRun` 只多 `bold`、`italic` 兩個旗標，字型名稱不往外傳。
   * 名稱先拿掉子集前綴（`ABCDEF+`），只看最後一個 `-` 或 `,` 之後的樣式段，沒有樣式段才看整個名稱，字族名稱裡的 `Black` 才不會被當成粗體。
   * 粗體：`bold`、`black`、`heavy`、`demi`（不分大小寫，`semibold` 包含在 `bold` 裡）。斜體：`italic`、`oblique`（不分大小寫），或樣式段裡大寫的 `It` 後面不接小寫字母（`MinionPro-It`、`-BoldIt`、`-ItCapt`）。
3. 連結用 `pdf.ts` 已經讀出的連結方框。pdf.js 只給一整段文字的方框，段內每個字的位置用寬度平均分，字的中心落在方框裡就掛上連結，目標是頁（`page`，從 0 起算）或網址（`uri`）。
4. **對齊**：每個區塊取中心落在區塊方框裡的 pdf.js 文字段，依內容串流的順序，只比字母與數字（照來源語言設定檔正規化、拆掉附加符號、不分大小寫，跟字元守恆一樣，ADR-0092）。
   * 對不上時往前看 **24** 個字，找連續 **3** 個字相同的位置接回去，找不到就兩邊各跳一個字。從頭往後掃一次，耗時跟字數成正比。
   * 區塊裡對上的字母數字少於 **95%** 時不給 `runs`，寧可沒有樣式也不要錯的樣式。
   * 沒對上的字：前後對上的字樣式相同就跟著用，不同就沒有樣式。同樣式、中間只隔空白或標點的字併成一段。
   * 樣式只放在**完整的詞**上：一段的頭或尾落在詞的中間時，縮到它完整蓋住的詞，一個詞都沒蓋滿就不給。首字放大的字母常用別的字型，只蓋到詞的一個字母，送成 `<pc>` 模型也放不回譯文。詞的邊界用平台的 `Intl.Segmenter`，依來源語言設定檔的 `lang` 切，核心不放語言規則。
5. 做粗體、斜體與連結，**不做小型大寫與 `ruby`**：小型大寫沒有可靠的判斷，`ruby` 是日文用的（白皮書 §5.2）。**表格儲存格不做**：IR 的儲存格沒有座標，對不到 pdf.js 的文字，短格子的標籤也會增加 token（ADR-0114）。
6. 跨欄、跨頁接段時，後一塊的 `runs` 跟著位移，相鄰同樣式的接成一段。`overrides` 的 `merge` 依接起來的位置位移；`split` 分給前後兩塊，跨過切點的切開；`redact` 被遮掉的範圍拿掉樣式，後面的位移；`role`、`move`、`skip` 不影響。
7. `ASSEMBLY_VERSION` 從 2 改成 3。已解析的書下次 `tome extract` 會重新組裝，引擎不重跑。

**翻譯**

8. 有樣式的文字用 **`<pc id="n">…</pc>`** 包起來送出，**只帶編號**，不帶樣式：模型不需要知道是什麼樣式，也少幾個 token。編號在單位內從 1 起算，**跟 `<ph>` 分開**。沒有樣式的單位遮蔽後的文字跟以前一樣，翻譯記憶的鍵與已確認的估價都不變。連結的目標不送給模型。
9. `<pc>` **攤平不巢狀**：每個 `<pc>` 是一段樣式組合相同的文字，粗斜體是一個 `<pc>`。單位裡每個字母數字都有的樣式提出來當**整單位的樣式**，不送 `<pc>`，譯文整段套用；剩下的 `<pc>` 只帶差異。整段粗體的標題送出去沒有標籤。
10. 整個 `<ph>` 都在樣式範圍裡時，`<ph>` 包在 `<pc>` 裡；只蓋到一部分時，`<pc>` 縮到不含那個 `<ph>`，縮完沒有字就不送。縮小不會讓兩個 `<pc>` 重疊，代價是那一小段遮蔽的文字還原後沒有樣式。
11. 驗證照舊要求每個 `<pc>` 恰好出現一次，少了重送；`prompts/` 不改。譯後排版判斷相鄰的字時看 `<pc>` 裡面的字，有沒有 `<pc>` 排出來一樣（`zh-TW` 拿掉漢字與英數之間的空白）。
12. 修改 ADR-0114 第 2 項：`max_tokens` 每個 `<pc>` 多給 **10** 個 token（`<pc id="1">` 加 `</pc>` 約 9 個），加在取 2 倍之前。估價照 ADR-0114 不變；估價的輸入用實際送出的內容，已經算到 `<pc>`。數字是提案。
13. 還原在譯後排版之後，沿片段樹記下每個 `<pc>` 在譯文裡的起訖，兩端的空白不算。翻譯記憶只存遮蔽後的片段，命中時用目前單位的樣式。

**儲存**

14. `book.db` 遷移第 8 版，`unit` 加兩欄，舊的列是 NULL、沒有樣式：
    * **`formats`**：原文的樣式（JSON），整單位的樣式 `whole`，加上每個 `<pc>` 的 `id`、在原文的起訖與樣式。
    * **`translation_pc`**：每個 `<pc>` 在譯文裡的位置（`id`、`start`、`end`，JSON）。**樣式讀的時候從 `formats` 套上**，整單位的樣式不存位置。
    * 這裡改了問題清單第 7 項：原本建議的欄位是 `translation_runs`，存套好樣式的譯文 `runs`。改存位置的理由：整段同一樣式的單位不送 `<pc>`，遮蔽後的文字跟 035 之前一樣，重新解析後會保留舊譯文；存套好樣式的 `runs` 的話，這些單位要重跑 `tome verify` 才有樣式，存位置則讀的時候直接從 `formats` 套上，**不用重翻也有樣式**。樣式的判斷規則以後改了，譯文的樣式也跟著 `formats` 走，不會跟原文對不上。
    * `unit.translation` 照舊是純文字，`placeholders` 照舊只有 `<ph>`。
    * 遮蔽後的文字沒變時，`syncUnits` 保留狀態與譯文，只更新 `formats`：整段同一樣式的單位重新解析後不用重翻也有樣式。遮蔽後的文字含 `<pc>`，樣式的範圍變了會回到起點。
    * 不需要 LLM 的單位譯文就是原文，`translation_pc` 直接用 `formats` 在原文的位置。
15. 已翻好的書**重新執行 `tome extract`** 之後，帶 `<pc>` 的單位遮蔽後的文字變了，會再翻一次，估價會先顯示，要確認才送。不重新解析就沒有影響。接受：0.1.0 還沒發佈，M3 收尾本來就要重跑規則書。

**預覽與其他**

16. `tome preview` 的原文與譯文都用 Markdown 標出粗體 `**`、斜體 `*`、粗斜體 `***`，連結只顯示文字。樣式兩端的空白移到記號外面，書裡本來的 `*` 不跳脫：預覽要跟書對得起來。vault 的連結在 030。
17. `tome extract` 不加樣式的訊息：對不上的區塊只是沒有樣式，使用者能做的事不多，`tome preview` 看得到。
18. ADR-0099 第 9 項的斷言照 brief 022 的前例**原地改成**檢查 `mask.ts` 產生 `<pc>`。ADR-0115 檢查 `ASSEMBLY_VERSION = 2` 的斷言原地改成版本不小於 2。這一項結束 ADR-0115 的 Open Question「行內 `runs` 與 `<pc>`」。

## 驗證

<!-- @assert-count target="src/core/pdf.ts" symbol="fontExtraProperties: withStyles," expected="1" reason="第 2 項：開了 fontStyles 才傳 fontExtraProperties" -->
<!-- @assert-count target="src/core/extract.ts" symbol="openPdf(path, { fontStyles: true })" expected="1" reason="第 2 項：只有組裝讀版面時讀字型" -->
<!-- @assert-absence target="src/core/book.ts" symbol="fontStyles" reason="第 2 項：tome probe 不讀字型" -->
<!-- @assert-count target="src/core/runs.ts" symbol="export const RUNS_MIN_SHARE = 0.95;" expected="1" reason="第 4 項：對上的字母數字不到 95% 不給樣式" -->
<!-- @assert-count target="src/core/runs.ts" symbol="const RESYNC_WINDOW = 24;" expected="1" reason="第 4 項：往前看 24 個字" -->
<!-- @assert-count target="src/core/runs.ts" symbol="const RESYNC_ANCHOR = 3;" expected="1" reason="第 4 項：連續 3 個字相同才接回去" -->
<!-- @assert-count target="src/core/runs.ts" symbol="new Intl.Segmenter(lang, { granularity: 'word' })" expected="1" reason="第 4 項：詞的邊界依語言設定檔切" -->
<!-- @assert-count target="src/core/assemble.ts" symbol="into.runs = joinRuns(text, into.runs, next.runs, next.text.length);" expected="1" reason="第 6 項：接段時後一塊的樣式跟著位移" -->
<!-- @assert-count target="src/core/assemble.ts" symbol="export const ASSEMBLY_VERSION = 3;" expected="1" reason="第 7 項：產生 runs 之後要重新組裝" -->
<!-- @assert-count target="src/core/tags.ts" symbol="export function pairedTag(id: number): string {" expected="1" reason="第 8 項：pc 只帶編號" -->
<!-- @assert-count target="src/core/mask.ts" symbol="return { ...(isPlain(whole) ? {} : { whole }), paired };" expected="1" reason="第 9 項：整單位的樣式不送 pc" -->
<!-- @assert-count target="src/core/format.ts" symbol="if (item?.type === 'pc') return neighbor(" expected="1" reason="第 11 項：譯後排版看得到 pc 裡的字" -->
<!-- @assert-count target="prompts/translate.md" symbol="<pc> wraps formatted text." expected="1" comments="include" reason="第 11 項：提示不改，pc 的規則本來就在" -->
<!-- @assert-count target="src/core/request.ts" symbol="export const PAIRED_OUTPUT_TOKENS = 10;" expected="1" reason="第 12 項：每個 pc 多給 10 token" -->
<!-- @assert-count target="src/core/store.ts" symbol="ALTER TABLE unit ADD COLUMN formats TEXT;" expected="1" reason="第 14 項：原文的樣式" -->
<!-- @assert-count target="src/core/store.ts" symbol="ALTER TABLE unit ADD COLUMN translation_pc TEXT;" expected="1" reason="第 14 項：pc 在譯文裡的位置" -->
<!-- @assert-count target="src/core/units.ts" symbol="return unit.needs_llm ? null : pairedJson(unit.formats?.paired ?? []);" expected="1" reason="第 14 項：不送 LLM 的單位用原文的位置" -->
<!-- @assert-count target="src/core/preview.ts" symbol="if (bold && italic) return '***';" expected="1" reason="第 16 項：預覽用 Markdown 標樣式" -->

實作後的驗證（2026-11-08）：在暫存資料夾複製 `book1`（書 8）的 `source` 層，pdf.js 開 `fontStyles` 讀版面，在程序內對齊與重新組裝，只印數量與比例，每次約 5 秒，跑完刪掉複本，沒有寫入維護者的工作區。用第 2 項的規則量到粗體 12.7%、斜體 10.7% 的字元，跟上表一樣。量了兩次：第一次在加上「樣式只放在完整的詞上」（第 4 項）之前，第二次在之後。

* 1,608 個有文字的段落類 `source` 區塊（表格不算），兩次一樣：對上 99% 以上的 1,578 個、95–99% 的 8 個、50–95% 的 4 個、低於 50% 的 18 個，**低於 95% 而沒有樣式的占 1.4%**。依角色：段落 816 個裡 19 個低於 95%，標題 186 個裡 3 個，清單項目、說明與頁首頁尾都沒有。

| 數量 | 第一次 | 第二次（完整的詞） |
| :--- | ---: | ---: |
| 有 `runs` 的 `source` 區塊 | 958 | 956 |
| 重新組裝後 1,723 個區塊裡有 `runs` 的 | 949 | **947** |
| 其中只有一段、從頭蓋到尾的 | 529 | 529 |
| `runs` 共幾段 | 1,024 | 1,019 |
| 粗體／斜體／連到網址（這本書沒有連到頁的連結） | 758／490／3 | 754／489／3 |
| 一個區塊最多幾段 | 6 | 6 |

* 少掉的 2 個區塊、5 段是只蓋到詞的一部分的樣式。
* 第二次另外算了送出的樣子。會翻譯的段落類區塊 1,199 個（不含表格、頁首頁尾、目錄、索引、版權頁與圖，沒有規則包的遮蔽）：724 個有樣式，其中 **306 個整段同一樣式、不送 `<pc>`**，**418 個帶 `<pc>`**，共 488 個，一個單位最多 6 個。

真書的 `<pc>` 模型放得對不對、重送會不會變多，**沒有驗證**：這個回合沒有用真的 API 翻。

## 後果

翻好的段落保留粗體、斜體與連結，`tome preview` 看得到，vault（030）與 Pass 0 的候選詞（027）用得到。規則書約三分之一的段落要多送 `<pc>`，輸入多一點 token，模型漏了 `<pc>` 會重送；整段同一樣式的標題不受影響。

字型名稱的規則與 95% 的門檻只用維護者的書量過，名稱裡沒有樣式字樣的字型、描邊畫的粗體會漏掉，漏的只是沒有樣式。pdf.js 的文字段落在兩個區塊之間、或內容串流的順序跟閱讀順序差很多時，那個區塊沒有樣式。

已翻好的書重新解析後，帶 `<pc>` 的段落會再翻一次（第 15 項）。`tome extract` 的版面讀取多傳字型資料，記憶體與時間沒有量過。

## 替代方案

否決了下列做法：

* **Docling 轉接器用文字格的 `font_name` 算 `runs`**：對齊比較準，但只有 Docling 有，每次推送都要跑 `engine` 工作流程。
* **依 pdf.js 的 `bold`、`italic` 旗標**：真書的字型沒有這兩個旗標。**比對整個字型名稱**：字族名稱裡的 `Black` 會被當成粗體。
* **`<pc>` 帶樣式（`<pc id="1" fmt="b">`）**：每個 `<pc>` 多幾個 token，模型也可能抄錯。**`<pc>` 跟 `<ph>` 一起編號**：沒有樣式的單位的 `<ph>` 編號也會變，翻譯記憶的鍵全部失效。**巢狀的 `<pc>`**：還原與驗證都複雜，標籤也更多。
* **`<pc>` 蓋到一部分 `<ph>` 時擴大到整個 `<ph>`**：兩個 `<pc>` 可能重疊。
* **`translation_runs` 存套好樣式的 `runs`**：整段同一樣式的單位保留舊譯文時沒有樣式，要重跑 `tome verify` 才補得上；樣式規則改了也跟譯文對不上。**樣式混進 `placeholders`**：`tome status` 等讀它的地方都要分辨 `<ph>` 與 `<pc>`。
* **只差在 `<pc>` 時保留舊譯文**：重跑 `tome verify` 時舊回應少了 `<pc>` 會被判成要重送，要另外放寬驗證。**`book.yaml` 加開關，預設不做樣式**：多一個設定，樣式要到使用者發現才有。
* **`fontExtraProperties` 一律開**：`tome probe` 也多傳字型資料，卻用不到。
* **表格儲存格也做**：儲存格沒有座標；短格子的標籤造成過截斷（ADR-0114）。
* **詞中間的樣式也送 `<pc>`**：首字放大會變成 `<pc>T</pc>he`，模型放不回譯文只會重送。
* **`tome extract` 印有樣式與沒對上的區塊數**：使用者能做的事不多，預覽看得到。
* **預覽跳脫書裡的 `*`**：預覽跟書對不起來。

## Open Questions

- [ ] 真書的 `<pc>` 模型放得對不對、重送會不會變多，等 M3 收尾用真的 API 重跑規則書時看 `placeholder_mismatch` 的數量（第 8–11 項）。
- [ ] 每個 `<pc>` 10 個 token 的額度是提案，跟 ADR-0114 Open Question 的 `UNIT_OUTPUT_TOKENS` 一起，下一次真實翻譯後用帳本的 `stop_reason` 與 `max_tokens` 再看（第 12 項）。
- [ ] 字型名稱的規則在其他六本書漏掉多少，維護者在本機用 `tome preview` 對照後再看（第 2 項）。
- [ ] `fontExtraProperties` 對整本書的記憶體與時間影響，第一次整本重新解析時量（第 2 項）。
