---
id: ADR-0118
status: accepted
date: 2026-11-08
depends-on: [ADR-0023, ADR-0039, ADR-0049, ADR-0054, ADR-0059, ADR-0068, ADR-0080, ADR-0081, ADR-0099, ADR-0102, ADR-0103, ADR-0104, ADR-0107, ADR-0113, ADR-0114, ADR-0115, ADR-0116]
amends: [ADR-0113]
---

# ADR-0118：Pass 0：候選詞、實體卡的提議與全書提要

## 脈絡

ADR-0113 第 13–15、22 項把回合 027「實體卡與 Pass 0」排在 026 之後：`entity` 表、`tome scan-terms`（批次與即時，預設批次）、`scanner_model`、全書提要、活躍實體進請求。白皮書 §5.6 的 Pass 0 是：本機挖候選詞（索引、標題、粗體、大寫片語、規則包），只把候選詞與幾段上下文送給便宜模型，模型提議譯名、類別、性別、代名詞、語域，類別由規則包宣告；依出現次數與類別分級審定，**鎖定後才進主翻譯**。同時從目錄與序章產出全書提要，放翻譯的靜態前綴。開工前查到的事實寫在共用筆記 `brief-027-questions.md`，實作時的細節寫在 `brief-027-details.md`。

**現有程式**：規則包的 `entities.yaml` 宣告類別與預設代名詞，`glossary.yaml` 的詞條翻譯時已經進 `<glossary>`；`prompts/translate.md` 沒有實體卡與提要的位置；批次的程式綁著翻譯單位；個資閘門在對外出口掃整個請求；`zh-TW.yaml` 已經有 `pronouns`。

**量測（原型）**：開工前用原型在 `book1`（ADR-0115 的書 8）的 `document.json` 複本上挖候選詞，只印數量，跑完刪掉：約 715 個；每個帶兩句、每句最多 300 字元時，要送全書文字的 173%。所以每句的上限與重複的句子要處理（第 5 項）。

問題清單的 15 項由維護者在 2026-11-08 選定：第 1 項拆回合、第 2 項兩份提示照草稿接上、第 3 項上下文「兩句、每句 200 字元」，其餘照建議。實作時的細節 12 項也由維護者在同一天照建議選定；其中第 1 項是**更正**問題清單第 8 項寫錯的事實（批次模式會等到批次結束，見第 13 項），第 6 項沒拿到提議的詞是警告、結束碼 0（見第 16 項）。

## 決定

**範圍**

1. 修改 ADR-0113 第 22 項：027 只做 Pass 0，產出的是**還沒審過的提議**。實體卡與全書提要進翻譯請求、活躍實體、`keep_source` 實體卡的遮蔽、翻譯記憶與譯名驗證加上實體卡、`prompts/translate.md` 的改動，拆到新的回合 **037「實體卡進翻譯」**。順序是 027 → 028（審定）→ 037 → 029 → 030…：白皮書說鎖定後才進主翻譯，鎖定的介面在 028，037 進翻譯的就是審過的卡。037 也是會改到 `mask.ts`、`verify.ts`、`memory.ts` 三個變異測試模組的那一半。
2. `series.db` 只照 ADR-0080 第 4 項留結構，不做跨書共用（ADR-0113 第 15 項）。日文的候選詞挖法到時再評估。

**候選詞**

3. 來源：`index` 區塊每行頁碼清單前面的詞（沿用 026 判斷索引的掃法）；6 個詞以內的 `heading`、`title`；6 個詞以內的粗體 `runs`（ADR-0116）；**大寫片語**：連續的大寫開頭詞，中間可以夾 `connectors`，只隔空白，開頭的 `stopwords` 拿掉，句首只有一個詞的不算，而且要出現 **2** 次以上。
   * 規則包 `glossary.yaml` 已有譯名的詞不當候選詞，翻譯本來就用它。
   * 去掉頭尾的標點；全字、區分大小寫算會翻譯的文字裡的出現次數；記第一次出現的區塊；依第一次出現的順序排。
   * 索引常把詞倒過來寫（`Armor, light`），正文找不到，出現次數是 0、沒有上下文，照樣送，由模型判斷要不要略過。
   * 大寫片語用固定的正規表示式切詞再逐一判斷，語言設定檔的詞不編成正規表示式（ADR-0049 的精神）。
4. `tome-lang/1` 的來源語言加選用的 **`pass0`**：`connectors`（`en` 是 `of`、`the`、`de` 等，不含 `and`，否則兩個名字會被接成一個）、`stopwords`（句首常見的大寫詞與 `Chapter`、`Table` 這類標題詞）、`pronouns`（挑上下文用）、`sentence_end`（`.`、`!`、`?`、`…`，後面接空白才算句尾；`join.sentence_end` 是接段用的，含引號與 `)`，不能拿來切句）。沒有 `pass0` 的語言不挖大寫片語。清單都是提案，沒有用語料量過。目標語言不加欄位，驗證代名詞沿用 `zh-TW.yaml` 已有的 `pronouns`。
5. **上下文**：每個候選詞最多 **兩句**：第一次出現的句子，加上第一個「出現的那句或下一句帶代名詞」的句子；每句最多 **200** 字元，太長時從詞前面 80 字元開始取，切在詞的邊界。同一個請求裡一句已經跟在前面的詞後面送過，後面的詞就不再送這句；提示裡的 `<q id>` 是一句對一個詞，改成一句多個詞要改提示、重新審，所以不改。

**請求與回覆**

6. 兩份提示 **`prompts/scan-terms.md`**、**`prompts/summary.md`** 照維護者審過的草稿接上，英文，測試釘住雜湊；之後要改字就是新的提示審查。提議譯名的系統提示是指令加上目標語言的風格指南，同一本書不變；提要用英文寫，系統提示只有指令。
7. 送出的格式：`<classes>`（規則包的類別，一行一個，有預設代名詞的寫在後面），接著每個候選詞一個 `<term id count>`，後面跟它的 `<q id>`。書本文字都先跳脫。回覆是 `<card id class gender pronoun register keep>譯名</card>` 或 `<skip id/>`，提要是 `<brief>` 裡的 `<era>`、`<tone>`、`<factions>`。跟翻譯一樣用文字標籤（S-4），解析耗時跟長度成正比。
8. **全書提要**：英文、名字留原文、150 個詞以內，存 `book.db`；037 才放進翻譯的靜態前綴。輸入是 `toc` 區塊（最多 2,000 字元）加上開頭的會翻譯文字，合計最多 6,000 字元。跟候選詞放同一批送出；只有輸入變了（重新解析後目錄或開頭不同）才重寫。
9. **驗證**：每個 `id` 恰好一個 `<card>` 或 `<skip>`；少了、標籤壞了、譯名是空的、混入簡體字（`script_check`）就下次再送，最多 **3** 次，用完是 `failed`，留給人填。`class` 不在規則包的類別、`pronoun` 不在目標語言的代名詞、`gender` 不是 female、male、none，就拿掉並列報告，不重送（ADR-0102 的原則）。被拒時先對半拆，拆到底才換 `fallback_model`；被截斷時對半拆，沒得拆就放棄，跟翻譯一樣（ADR-0104 第 12、15 項）。
10. **請求的大小**：一個請求最多 **40** 個候選詞、詞與上下文合計 6,000 字元（沿用 `REQUEST_UNITS`、`REQUEST_CHARS`）。`max_tokens` 每個候選詞給 **32** token、提要給 **400** token，含關不掉的思考，取 2 倍，下限 1,024。估價的輸出也這樣算，不用字元比例：Pass 0 的輸出跟輸入的長度無關。數字是提案。
11. 列報告的問題照翻譯寫進 `issue`，`unit_id` 用 `term:<id>`：`card_attribute`（`detail` 寫拿掉哪一個）、`card_missing`、`empty`、`script_mixed`、`refused`、`truncated`。

**儲存**

12. `book.db` 遷移第 9 版：
    * **`entity`**：`source`（原文，唯一）、`target`、`class`、`gender`、`pronoun`、`register`、`keep_source`、`match`（JSON，NULL 是預設的區分大小寫、全字）、`status`、`origin`、`sources`（JSON）、`occurrences`、`first_block`、`attempts`、時間。027 的 `status` 是 `candidate`、`sent`（在批次裡還沒收回）、`proposed`、`skipped`、`failed`，`origin` 是 `pass0`；028 再加 `locked`、`rejected`、`import`、`new_term`。
    * **`summary`**：一列，`era`、`tone`、`factions`、輸入的雜湊、模型、時間。
    * 請求、回應、帳本、外送紀錄與批次**沿用現有的表**，鍵用 `term:<id>`、`summary`。`batch` 加一欄 **`stage`**（`translate` 或 `scan`，舊的列是 `translate`）：翻譯收批次的程式只看自己的，否則 Pass 0 的批次會被當成翻譯的收掉，結果就不見了。
    * 重新解析後再跑：已有的列不刪；文件裡找不到的候選詞出現次數改成 0；新的加進來，只送 `candidate`。

**指令**

13. **`tome scan-terms <book> [--realtime] [--budget <美元>] [--confirm]`**，預設批次。
    * 不加 `--confirm` 只估價（不連網、不取金鑰），記下這次的內容指紋（`stage` 表的 `scan-estimate`）。加 `--confirm` 時，指紋要跟**上一次顯示的**相同才送；不同或沒估過，就顯示這次的估價、回 `scan.changed`（結束碼 1），看過後再跑一次 `--confirm`。比照 `tome estimate --confirm` 與 `tome translate`（ADR-0104），只是在同一個指令。
    * 指紋含全部候選詞與上下文、提要的輸入、`scanner_model`、`fallback_model`、兩份提示、規則包、來源與目標語言、模式與預算，跟翻譯一樣算全部，送到一半中斷時續跑不用重新確認。
    * 預算跟翻譯共用 `book.yaml` 的 `budget_usd`，`--budget` 跟 `tome estimate` 一樣可以改；送出前檢查已花加進行中加這次的上限。Pass 0 一律跑全書，不吃 `--chapters`。
    * **更正**：批次模式跟 `tome translate` 一樣，送出後在同一個指令裡每 60 秒查一次，等批次結束、收回、套用才結束（ADR-0107 第 12 項）；問題清單第 8 項寫的「送出後就結束」是錯的。中斷時留下的批次，再跑一次或 `tome batch collect` 收回。`--realtime` 遇到還沒收回的 Pass 0 批次就停（`batch.pending`）。
    * 收回比照翻譯的批次（ADR-0107 第 8、11、13 項）：送出時跟意圖紀錄同一個交易把詞標成 `sent`；收回時只套用還是 `sent` 的詞，中斷在收回到一半時，套用過的不再套用，同一份回覆也不會多算一次嘗試；每個詞帶著送出時在請求裡的位置，`<card id>` 照那個位置對，中間有詞不在了，後面的詞才不會拿到別人的卡。重新解析後文件裡沒有的詞不套用。沒有送到、拿不回結果、單筆錯誤、取消或過期的詞放回 `candidate`，下一批重送。Manager 審 PR 67 時找到第一版用過濾後的位置對卡的錯，這一段是修正。
    * 個資閘門、外送紀錄與帳本走跟翻譯一樣的路（ADR-0039、ADR-0104）：即時模式每個請求在對外出口檢查，批次模式送出前逐一掃描整批，命中就不送。
14. `tome.yaml` 的 **`scanner_model`** 必填，用到時才檢查，沒設回 `scanner_model.missing`（結束碼 2），不在模型表上回 2。拒答時改送 `fallback_model`，思考參數照 `translator_model` 的規則。
15. `tome batch status|collect|cancel` 也管 Pass 0 的批次。沒有 Pass 0 的批次時，`tome batch collect` 跟以前一模一樣；有的話先收它，也有翻譯的批次就接著收翻譯的，`--json` 的 `data` 照舊是翻譯的，多一個 `scan`。
16. 訊息、`--json` 與紀錄**只有數量**：候選詞幾個、送出幾個、提議幾個、略過幾個、沒拿到提議幾個、提要幾份、花費。候選詞、譯名與提要都是書本內容（ADR-0059）。結束時有候選詞用完 3 次仍沒有提議，或還沒處理完，`scan.done` 是 warn，結束碼 0：Pass 0 沒有提議不影響之後的步驟，028 審定時由人填。看提議的介面在 028。

## 驗證

<!-- @assert-count target="src/core/store.ts" symbol="CREATE TABLE entity (" expected="1" reason="第 12 項：實體卡的提議" -->
<!-- @assert-count target="src/core/store.ts" symbol="CREATE TABLE summary (" expected="1" reason="第 12 項：全書提要" -->
<!-- @assert-count target="src/core/store.ts" symbol="ALTER TABLE batch ADD COLUMN stage TEXT NOT NULL DEFAULT 'translate';" expected="1" reason="第 12 項：翻譯與 Pass 0 的批次分開" -->
<!-- @assert-count target="src/core/batch.ts" symbol="AND stage = 'translate' ORDER BY id LIMIT 1" expected="1" reason="第 12 項：翻譯只收自己的批次" -->
<!-- @assert-count target="src/core/scan.ts" symbol="AND stage = 'scan' ORDER BY id LIMIT 1" expected="1" reason="第 12 項：Pass 0 只收自己的批次" -->
<!-- @assert-count target="src/core/candidates.ts" symbol="export const CANDIDATE_MAX_WORDS = 6;" expected="1" reason="第 3 項：6 個詞以內" -->
<!-- @assert-count target="src/core/candidates.ts" symbol="export const CAPS_MIN_OCCURRENCES = 2;" expected="1" reason="第 3 項：大寫片語要出現兩次以上" -->
<!-- @assert-count target="src/core/candidates.ts" symbol="export const CONTEXT_SENTENCES = 2;" expected="1" reason="第 5 項：最多兩句" -->
<!-- @assert-count target="src/core/candidates.ts" symbol="export const CONTEXT_CHARS = 200;" expected="1" reason="第 5 項：每句最多 200 字元" -->
<!-- @assert-count target="languages/source/en.yaml" symbol="connectors: [of, the, de, du, la, le, von, van]" expected="1" comments="include" reason="第 4 項：連接詞不含 and" -->
<!-- @assert-count target="src/core/prompt.ts" symbol="promptFile('scan-terms.md')" expected="1" reason="第 6 項：提議譯名的提示" -->
<!-- @assert-count target="src/core/prompt.ts" symbol="return promptFile('summary.md').trim();" expected="1" reason="第 6 項：提要的系統提示只有指令" -->
<!-- @assert-count target="src/core/cards.ts" symbol="const GENDERS: ReadonlySet<string> = new Set(['female', 'male', 'none']);" expected="1" reason="第 9 項：性別只收三種" -->
<!-- @assert-count target="src/core/scan.ts" symbol="export const CARD_OUTPUT_TOKENS = 32;" expected="1" reason="第 10 項：每個候選詞 32 token" -->
<!-- @assert-count target="src/core/scan.ts" symbol="export const TOC_CHARS = 2000;" expected="1" reason="第 8 項：目錄最多 2,000 字元" -->
<!-- @assert-count target="src/core/scan.ts" symbol="if (shown !== plan.fingerprint) {" expected="1" reason="第 13 項：要跟上次顯示的估價相同才送" -->
<!-- @assert-count target="src/core/scan.ts" symbol="ids: kept.map(({ position }) => String(position + 1))," expected="1" reason="第 13 項：批次收回時照送出時的位置對 card id" -->
<!-- @assert-count target="src/core/scan.ts" symbol="const inFlight = placed.filter(({ id }) => statusOf(store, id) === 'sent');" expected="1" reason="第 13 項：只套用還在批次裡的詞" -->
<!-- @assert-count target="src/core/scan.ts" symbol="throw new TomeError('scanner_model.missing');" expected="1" reason="第 14 項：scanner_model 必填" -->
<!-- @assert-count target="src/core/scan.ts" symbol="const level = counts.failed > 0 || counts.left > 0 ? 'warn' : 'info';" expected="1" reason="第 16 項：沒拿到提議不讓結束碼變 1" -->

實作後的量測（2026-11-08）：複製 `book1` 的 `document.json` 到暫存資料夾，用實作的規則挖詞，照第 10 項的切法與第 5 項的去重算實際送出的書本文字，只印數字，跑完刪掉複本；只讀維護者工作區的 `book.yaml` 與規則包，沒有寫入。

* 會翻譯的文字 253,306 字元。候選詞 **744** 個：標題 156、大寫片語 632、索引 0（這本書沒有書末索引）、粗體 0（這份 `document.json` 是 035 之前解析的，沒有 `runs`；重新解析後會多出粗體的候選詞）。
* 350 個帶兩句，沒有一個沒有上下文；切成 21 個請求。
* 實際送出的詞與句子 **78,475 字元，占全書文字的 31.0%**；不去掉重複的句子是 104,026 字元（41.1%）。加上提要的輸入（最多 6,000 字元），Pass 0 一共最多送 84,475 字元（33.3%）。
* 開工前原型的 173% 是用每句 300 字元的上限、而且以上限計算；實際的句子多半比上限短。

候選詞的挖法、停用詞與請求的數字只在這本書與合成的測試資料上量過，模型的提議品質與召回率**沒有驗證**：這個回合只跟假供應商跑，沒有對真的 API 發請求。

## 後果

`tome scan-terms` 會把書的候選詞與句子送給 `scanner_model`，規則書約三分之一的文字會送出去一次；翻譯時全書本來就會送出，個資閘門與外送紀錄一樣管。提議存在 `book.db`，還沒有人看得到，要等 028 的審定介面；翻譯也還不會用它們，要等 037。

規則書的標題與大寫詞很多，候選詞上千時，一次 Pass 0 約 20 個請求。用便宜的 `scanner_model` 時花費主要是輸入。停用詞清單漏掉的句首大寫詞會變成候選詞，模型可以 `<skip>`，多花一點錢。

`batch` 多一欄 `stage`，翻譯與 Pass 0 的批次各收各的；預算的「進行中」兩種都算。

## 替代方案

否決了下列做法：

* **一個回合做完**：PR 很大，審定還沒做，要先定沒審過的卡能不能進翻譯。**037 排在 028 之前**：只能讓規則包詞條進翻譯，Pass 0 的提議還是用不上。
* **只送一句上下文**：送出量約減半，但性別與代名詞大多判斷不了。**每句 300 字元**：原型量到全書文字的 173%。
* **一句多個詞的 `<q id="1 2">`**：要改審過的提示。
* **提要用目標語言寫**：名字的譯法會跟審定的譯名打架。**提要也接風格指南**：風格指南是寫中文的規則。
* **Pass 0 自己一套請求、回應與批次的表**：重複的程式多，預算要合併兩邊。
* **估價放 `tome estimate --scan`**：`tome estimate` 的選項與輸出都是翻譯的。**第一次就加 `--confirm` 直接送**：使用者沒看過估價。
* **批次模式送出後就結束**：跟 `tome translate` 不一致（ADR-0113 第 13 項）。
* **沒拿到提議時結束碼回 1**：不影響之後的步驟，審定時由人填。
* **目標語言加 `pass0.pronouns`**：`pronouns` 已經有了。**連接詞含 `and`**：`Ada and Bram` 會變成一個名字。
* **027 先產生本機的對照檔**：028 的審定檔案會取代它。

## Open Questions

- [ ] H-11：候選詞加少量上下文的召回率，要有已知詞表的公開素材才量得出來（第 3、5 項）。
- [ ] 停用詞清單與連接詞，在更多書上看誤判與漏判（第 4 項）。
- [ ] 每個候選詞 32 token、提要 400 token 的額度，下一次真實的 Pass 0 後用帳本的 `output_tokens` 與 `stop_reason` 再看（第 10 項）。
- [ ] 模型提議的品質（類別、代名詞、`keep_source` 判得對不對），等 M3 收尾用真的 API 跑規則書時看（第 9 項）。
