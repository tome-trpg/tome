---
id: ADR-0125
status: accepted
date: 2026-11-09
depends-on: [ADR-0012, ADR-0026, ADR-0054, ADR-0059, ADR-0081, ADR-0102, ADR-0113, ADR-0119, ADR-0120, ADR-0122, ADR-0123]
amends: [ADR-0113, ADR-0122]
---

# ADR-0125：讀回 vault 與人工譯文

## 脈絡

ADR-0012 讓 vault 可以直接修改，`tome sync` 把改過的段落存成人工譯文，優先序最高，併段、拆段這類結構改動回收不了、列進交付報告。ADR-0113 第 22 項把回合 031 排成「`tome sync`：讀回 vault、人工譯文、H-12」，第 23 項留下「人工譯文要不要跑零 token 驗證」。ADR-0122 第 10、11 項記下上次輸出（`render`、`render_file`），vault 被人改過就擋下，031 之前用 `--force` 覆蓋。ADR-0081 第 6 項與第 11 項：人工譯文不做 S-16 替換、跟翻譯記憶一起存在 `series.db`。

**現有程式**：沒有 `tome sync`，也沒有人工譯文的表或欄位，`series.db` 只有翻譯記憶。`render` 每個區塊一列（區塊、章節檔、輸出的 Markdown），沒有順序欄，檔案全文沒存。會改寫單位譯文的地方有四個：`tome verify` 用最後一份回應重驗（`DONE` 也在內）、S-16 的替換與改代名詞時的重設、`syncUnits` 在遮蔽後的文字變了時重寫整列、欄位化的單位每次重寫譯文。狀態機沒有「人工」的事件。

開工前的 18 項問題寫在共用筆記 `brief-031-questions.md`，維護者在 2026-11-09 選定：第 1 項拆成 031 與 040，第 3 項不加標記、序列比對，第 5 項 `series.db` 為主、`book.db` 加標記，第 11 項留著 `--force`，第 14 項也量 book1 的複本，其餘照建議。實作時的細節 14 項寫在 `brief-031-details.md`，維護者在同一天全部照建議選定；下面各項註明出自細節第幾項。細節第 3 項（怎麼判斷差異是哪個區塊的）在實作時因為性質測試找到會寫到別的區塊的情況，改得比原本寫的更嚴（Dice 0.5 換成字元留存 75% 與幾項防護），補充寫在同一份筆記，結果見第 4 項。

## 決定

**範圍**

1. **修改 ADR-0113 第 22 項**：031 拆成 **031「讀回與人工譯文」**與 **040「人工譯文的檢查」**（人工譯文的零 token 驗證、交付報告的「內含舊譯名的人工譯文」），順序 031 → 040 → 032 → 033 → 034（維護者選的）。
2. `tome sync <書>` 只讀 `render` 裡有區塊的**章節檔**。`00-書目與來源.md`、`entities/`、`review/`、`00-交付報告.md` 被改了不回收（`file`）；章節檔的 frontmatter、頁碼註解或段與段之間的空行改了也不回收（`other`）。使用者自己放的檔不讀。

**對回區塊（H-12）**

3. **不加標記、序列比對**（維護者選的）：上次輸出的區塊照 `render` 的插入順序（rowid，不加順序欄）、目前的檔案照空行切成段，frontmatter 與 `<!-- page: N -->` 不參加；CRLF、BOM、結尾的換行與行尾空白不算改動（細節第 1 項）。手寫 Myers 差異演算法，不加相依；一個檔的差異超過 2,000 段整個檔記成 `other`（細節第 2 項）。
4. 兩段沒變的段之間是一塊差異，**不確定就記成回收不了**（細節第 3 項與它的補充）。細節第 3 項原本寫「同一個區塊照位置、不看像不像；跨區塊用 Dice 0.5 而且比配給別的區塊像」，性質測試找到五種會寫到別的區塊的合成修改（別處的段搬進刪掉的段的位置、改過的段搬走後原位置換成別的字、新文字是別的區塊拆出來的、併進了被刪掉的區塊、兩段併起來後在別處拆開），所以改成下面的規則，Dice 0.5 不再當門檻：
   * 只屬於同一個區塊、新舊段數一樣：照位置回收，但檔案裡有別的區塊跟它一樣像或更像這段新文字（字元雙字組的 Dice 係數，大於 0）就不收（完全一樣是 `moved`，否則 `ambiguous`）。區塊有好幾段（模型的譯文裡有空行）時，同一個區塊的幾塊差異（中間隔著沒變的段）**合成一筆**再判斷，一個區塊只回收一筆；除了整個區塊比，也一段一段比：別的區塊有一段跟換掉的舊段一樣像、或更像這段新文字，也不收。沒翻成的區塊上次輸出的是原文，不比像不像。
   * 跨好幾個區塊：舊的都是完整的區塊、段數一樣，段的界線沒有移動（保住每一條界線的字元對齊要比任何一條界線對不上的都長），每一對新舊都至少留著 75% 的字、比配給別的區塊像，也沒有更像的區塊，才一對一配。全部是沒翻成的區塊時只看位置與界線。
   * 只有舊的是 `deleted`、只有新的是 `added`（跟刪掉的一模一樣是 `moved`），段數不一樣是 `split` 或 `merged`。
   * 要回收的區塊另外檢查，做到沒有變化為止：沒對上的段有八成在它的舊文字裡（至少 4 個字元雙字組），或它的任何一段舊文字有八成在沒對上的段裡；別的區塊沒對上的舊段有八成在新文字裡；新文字整段（至少 8 個字）原封不動出現在別的區塊，或加進去的字裡有連續 8 個字原封不動出現在別的區塊（併過來的字前後常帶著接起來的標點）。有一項就是 `ambiguous`。新舊文字的字元增刪超過 2,000 個、算不出加了哪些字，也是 `ambiguous`。
   * 門檻 75%、八成、4 個雙字組、8 個字都是**提案**，只在合成的修改上量過；Dice 只用來比哪個區塊比較像。
   * 已知的限制：同一個位置刪掉一段又加一段別的，會當成改了那一段；一段拆開後把一部分搬走，留下的那部分（這段自己的字）可能被當成它的人工譯文；把併起來的段在別處拆開、或把拆出來的一段併進別段，等於把字搬過段的界線，跟兩段各改一些分不出來，性質測試沒有涵蓋這兩種組合。
   * PR 審查找到：同一個區塊的兩塊差異原本各記一筆，存人工譯文時後一筆蓋掉前一筆，檔案卻算整個回收了，下次 `tome assemble` 就蓋掉被丟掉的修改。改成上面的合成一筆；性質測試加上有好幾段的區塊後，又找到兩種被同一個區塊的其他段稀釋、寫到別的區塊的修改（一段搬走又改過、原位置換成新字；一個區塊的段搬進別的區塊刪掉的段的位置），所以比像不像與防護也改成一段一段比。只有一段的區塊，判斷跟原本一樣。
   * 結果：性質測試在測試裡跑 1,000、1,000、300 次，區塊有好幾段的兩個跑 1,000、300 次，最後的規則在本機另外各跑 2 萬次（有好幾段的兩個跑三輪），都通過；book1 複本**回收錯的都是 0**（見下面的量測）。
   * **維護者在 2026-11-09 接受這個改得更嚴的規則**，不改用標記。之後在真的使用者修改上量到寫錯地方時，替代方案是每個區塊前加看不見的標記，ADR-0122 的區塊回溯（白皮書 §5.5 的表，只在連結目標上加 `^區塊 ID`）要跟著改。
5. **整個檔都回收了**才更新 `render_file` 的雜湊：把對上的區塊換回上次輸出的 Markdown、其他照目前的檔案，算出來的 SHA-256 跟上次一樣，而且沒有記到回收不了的改動。整段回收的區塊把 `render` 的 Markdown 換成目前的寫法，下次從這裡比；有單位還在送出中的區塊不換（細節第 4 項）。

**從 Markdown 反推**

6. 照 `vault.ts` 的寫法反過來：拿掉標題的 `#`（層級要一樣）、清單的 `- `、callout 的 `> ` 與 `[!類型]`（類型要一樣）、開頭的反斜線、`^區塊 ID`；表格照列與欄對格子（列數、欄數一樣，收 Obsidian 重排過的分隔線，`<br>` 換回換行、`\|` 換回 `|`）。頁碼參照的連結換回顯示的字，使用者自己加的連結照留；粗體、斜體照使用者寫的 Markdown 存。段落變成標題、引言或表格，標題換層級、callout 換類型是 `type`；沒翻成的區塊還留著 `[!untranslated]` 那一行就是 `untranslated`，拿掉了才算人工譯文，段落與 callout 角色也收純文字；表格改了結構或填了沒有單位的格子是 `table`；圖沒有單位，改了是 `type`；內容跟上次一樣的不存（細節第 5 項）。

**人工譯文**

7. **`series.db` 為主、`book.db` 加標記**（維護者選的）：`series.db` 遷移第 3 版 `human`（書、單位、原文的雜湊、譯文、時間），同一個單位再回收就覆蓋；`book.db` 遷移第 14 版 `unit.human`。每次 `syncUnits` 之後與 `tome sync` 寫完之後套回；原文的雜湊對不上（原文變了）就不套，算「對不到的人工譯文」（細節第 6 項）。
8. 人工譯文的單位是 `DONE`、`human = 1`，用 SQL 直接設（跟 `resetUnit` 與 ADR-0123 第 14 項一樣，`state.ts` 不動）；問題清掉、`attempts` 不動。`IN_FLIGHT`、`RECEIVED` 的單位不收（`in_flight`），收回批次後再跑一次；`BLOCKED` 的可以收（人工譯文不送出）。
9. 輸出照存的樣子（`vault.ts`、`tome preview` 與 `review/` 都不經 `markdownText`），再照輸出的規則加反斜線、頁碼參照的連結與錨點（細節第 7 項）。
10. **擋下會蓋掉它的地方**：`tome verify` 不重驗人工譯文（`verify.ts` 的 `LATEST_RESPONSES`）；S-16 不替換、改代名詞與語域也不重設（`rename.ts`）；`syncUnits` 重寫的列與欄位化重寫的譯文由第 7 項套回。翻譯記憶命中與 `--retry-failed` 碰不到 `DONE`（細節第 8 項）。
11. 人工譯文**不存**進翻譯記憶：翻譯記憶的鍵是送給模型的內容，人工譯文常是針對那一處的修正。

**`tome assemble` 與 `--force`**

12. **留著 `--force`，只用來丟掉回收不了的改動**（維護者選的）。`tome assemble` 先查有沒有改過、還沒回收的檔，有就停下（`assemble.edited`，訊息改成先跑 `tome sync`）；整個檔都回收了的檔不再擋，修改 ADR-0122 第 11 項「031 之前可以加 `--force` 覆蓋」的說法。
13. 回收不了的改動記在 `book.db` 的 `sync_change`（遷移第 14 版：檔、類型、前後對上的區塊；**不存書本文字**），回收不了的檔讀回時的雜湊記在 `sync_file`（同一版），每次 `tome sync` 兩張都整張重記。`tome assemble --force` 時，交付報告加一節「這次覆蓋的、`tome sync` 無法回收的修改」，只列被覆蓋的檔（寫檔前先把其他檔的筆清掉，它們的檔已經改回去了），連到前後的區塊，附修法（合併、拆分、略過用 `overrides.yaml`）；寫檔後兩張都清掉。`tome report` 多印尚待處理的筆數（細節第 9 項）。
    * **未經 `tome sync` 讀回的修改**（維護者在 2026-11-09 選「列在報告裡」）：被覆蓋的檔沒有 `sync_file` 的雜湊（沒跑過 `tome sync`，或整個檔回收後又改過），或雜湊跟目前的檔不同（上次 `tome sync` 之後又改過），那個檔的舊筆描述的是之前的版本，不列，改成一筆「未經 tome sync 讀回的修改」，只列檔名，不放書本文字（舊筆不列也是維護者同意的）。`--force` 照樣覆蓋。

**指令與訊息**

14. `tome sync` 拿書的鎖，只讀 vault，寫 `book.db` 與 `series.db`；vault 的位置跟 `tome assemble` 同樣查。訊息、`--json` 與紀錄只印數量（改過的檔、回收的單位、回收不了的改動、送出中沒回收的單位、對不到的人工譯文），不印檔名與書本文字（ADR-0059、ADR-0122 第 13 項）；有回收不了的改動時警告，結束碼 0（細節第 10 項）。`tome status`、`tome report` 與交付報告的覆蓋率多「人工譯文」，仍算在翻好的裡面（細節第 11 項）。

**測試與量測**

15. 測試只用合成的文字。fast-check 的性質測試：合成的段落隨機套上改字、刪段、加段、搬動、對調、併段、拆段，**回收的文字只能來自那個區塊**（第 4 項的已知限制除外）；只有改字、刪段、加段、搬動、對調時，回收的一定是那個區塊最後的整段文字；彼此不相鄰的改字全部回收（細節第 13 項）。區塊也可以有好幾段：每個區塊最多回收一筆，回收的每一段都是這個區塊自己的；彼此不相鄰的改字全部回收，同一個區塊的合成一筆。book1 複本的量測見下面，只有數字（細節第 12 項）。
16. 變異測試模組只改 `verify.ts` 的 `LATEST_RESPONSES` 一個條件，`state.ts`、`memory.ts`、`mask.ts` 不動；推 PR 前用本機的單一變異小工具跑改過的函式（細節第 14 項）。

## 驗證

<!-- @assert-count target="src/core/store.ts" symbol="ALTER TABLE unit ADD COLUMN human INTEGER NOT NULL DEFAULT 0;" expected="1" reason="第 7 項：book.db 的人工譯文標記" -->
<!-- @assert-count target="src/core/store.ts" symbol="CREATE TABLE human (" expected="1" reason="第 7 項：人工譯文以 series.db 為主" -->
<!-- @assert-count target="src/core/store.ts" symbol="CREATE TABLE sync_change (" expected="1" reason="第 13 項：回收不了的改動" -->
<!-- @assert-count target="src/core/store.ts" symbol="CREATE TABLE sync_file (" expected="1" reason="第 13 項：回收不了的檔讀回時的雜湊" -->
<!-- @assert-count target="src/core/vault.ts" symbol="VALUES (?, 'unsynced', NULL, NULL, ?)" expected="1" reason="第 13 項：未經 tome sync 讀回的修改列在報告裡" -->
<!-- @assert-count target="src/core/request.ts" symbol="withSeries(home, book.slug, (series) => applyHuman(store, series, book.slug));" expected="1" reason="第 7 項：syncUnits 之後套回人工譯文" -->
<!-- @assert-count target="src/core/human.ts" symbol="if (BUSY_STATES.has(unit.state)) continue;" expected="1" reason="第 8 項：送出中的單位不套" -->
<!-- @assert-count target="src/core/verify.ts" symbol="WHERE u.state IN ('RECEIVED', 'DONE', 'FAILED_QA') AND u.human = 0" expected="1" reason="第 10 項：tome verify 不重驗人工譯文" -->
<!-- @assert-count target="src/core/rename.ts" symbol="return TRANSLATED.has(unit.state) && unit.human === 0;" expected="1" reason="第 10 項：S-16 不替換、不重設人工譯文" -->
<!-- @assert-count target="src/core/memory.ts" symbol="human" expected="0" comments="include" reason="第 11 項：人工譯文不進翻譯記憶" -->
<!-- @assert-count target="src/core/preview.ts" symbol="if (row.human === 1) return translation;" expected="1" reason="第 9 項：人工譯文照存的樣子輸出" -->
<!-- @assert-count target="src/core/sync.ts" symbol="export const MAX_EDITS = 2000;" expected="1" reason="第 3 項：差異太多整個檔記成回收不了" -->
<!-- @assert-count target="src/core/sync.ts" symbol="export const MIN_KEPT = 0.75;" expected="1" reason="第 4 項：跨區塊一對一配只收輕微的修改" -->
<!-- @assert-count target="src/core/sync.ts" symbol="if (local.length === 0 && sha256(alignment.candidate) !== file.sha256) local.push({ kind: 'other', before: null, after: null });" expected="1" reason="第 5 項：整個檔都回收了才更新雜湊" -->
<!-- @assert-count target="src/core/sync.ts" symbol="writeFileSync" expected="0" comments="include" reason="第 14 項：tome sync 不寫 vault" -->
<!-- @assert-count target="src/core/vault.ts" symbol="store.run('DELETE FROM sync_change');" expected="1" reason="第 13 項：寫檔後清掉回收不了的改動" -->

**量測**（2026-11-09，H-12）：複製 `book1`（ADR-0115 的書 8）的 `document.json` 與 `book.db` 到暫存資料夾，用 `renderVault` 輸出暫存的 vault（175 個章節檔、1,389 個區塊，其中 11 個的 Markdown 有空行，不讀 PDF），用固定的亂數種子挑彼此不相鄰的區塊套上合成的修改，跑 `tome sync` 的核心，只印數字，跑完刪掉。PR 審查後改了規則，同樣的種子重量一次，數字一樣。

* **只有改字**（種子 31）：段落、標題、清單、callout 改字 200 個、表格格子 30 個，回收對的 230、**回收錯的 0**、沒回收的 0，`tome sync` 的核心花 145 毫秒（改之前 137 毫秒）。
* **改字加上結構改動**（種子 31、32、33）：併段、拆段、搬動、刪段、加段、表格格子各 30 個，再加上位置還夠的改字 107、113、100 個。回收對的 136、135、118，**回收錯的都是 0**；沒回收的改字 1、8、12 個（跟結構改動在同一個檔、被第 4 項的檢查擋下，記成 `ambiguous`）；結構改動全部記成回收不了，沒有一個被回收。

改字的判斷是看回收的譯文有沒有那一處的記號、有沒有別處的記號；結構改動的記錄類型（`merged`、`split`、`moved`、`deleted`、`added`）大致照套上的數量出現，種子 32、33 各有 3 個搬動記成刪段加上加段（一樣是回收不了，原因沒有追）。這是合成的修改，不是使用者真的改法。

## 後果

帶團時在 vault 裡順手改的字，跑 `tome sync` 就會變成人工譯文，之後重新輸出、`tome verify`、改譯名或改代名詞都不會蓋掉；沒翻成的段落也能直接在 vault 裡補上譯文。併段、拆段、搬動與看不準的修改不會被猜，`tome assemble` 照樣擋下，確定要丟掉才加 `--force`，交付報告列出被丟掉的位置；沒跑 `tome sync`、或跑過之後又改的檔也列出來（只有檔名）。

判斷是啟發式的：門檻（75%、八成、4 個雙字組、8 個字）是提案，只在合成的修改上量過；跟結構改動混在同一個檔的改字，有一部分會因為看不準而不回收，要分開改、分開跑 `tome sync`。**已知的限制**：在同一個位置刪掉一段、又加一段別的，會當成改了那一段，那段的人工譯文就變成新加的文字；一段拆開後把一部分搬走，留下的部分會被當成它的人工譯文。這兩種都只會用到這個位置或這段自己的字。一段改了超過 2,000 個字元的增刪也不回收，要分幾次改、每次都跑 `tome sync`。人工譯文的零 token 驗證與「內含舊譯名的人工譯文」在 040。

## 替代方案

否決了下列做法：

* **每個區塊前加看不見的標記**：對應幾乎不會錯，但編輯模式下每段前都有一行註解，使用者複製或刪掉時要另外處理；在真的修改上量到寫錯地方時改用它，ADR-0122 的區塊回溯跟著改（第 4 項）。
* **只存在 `book.db`**：`syncUnits` 重寫時要另外保留，也跟白皮書寫的不同。
* **`tome assemble` 先自動跑 `tome sync`**：輸出的指令會改資料庫；**拿掉 `--force`**：回收不了的改動會在沒有明確同意下消失。
* **跨區塊照位置一對一配、不看像不像**：改過又對調的兩段會配錯；**完全不做跨區塊**：連續改兩段就都回收不了。
* **人工譯文存進翻譯記憶**：別處同樣的原文會用上針對這一處的修正。
* **加相依的差異套件**：手寫的 Myers 只要幾十行，不用等冷卻期。

## Open Questions

- [ ] 第 4 項的門檻在真的使用者修改上會擋下多少改字，要等有人在 vault 裡實際改過（目前只有合成的修改）。
- [ ] 回收不了的改動要不要另外提供恢復的方法（目前只能照報告用 `overrides.yaml` 重做）。
