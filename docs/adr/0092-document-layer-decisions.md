---
id: ADR-0092
status: accepted
date: 2026-11-01
depends-on: [ADR-0007, ADR-0023, ADR-0049, ADR-0059, ADR-0084, ADR-0085, ADR-0091]
amends: [ADR-0085]
---

# ADR-0092：document 層與字元守恆的選型

## 脈絡

M1 最後一個回合要把 `source` 層組裝成 `document` 層。白皮書定了原則，留下幾個沒定的項目。開工前用真的 Docling 跑了合成版面，看到幾件事：

* 跨欄邊欄的頁，Docling 讀成左上、右上、邊欄、左下、右下，正確是整欄讀完再換欄。
* Docling 把跨欄的段落接成一個項目，兩個框共用一段文字。它的 `prov` 有 `charspan`，拆得開。
* 邊欄沒有標籤，標題與內文是 `heading`、`paragraph`。
* 首字放大變成 `T he`。跨頁表格是分開的兩塊，表頭重複。
* Docling 的 `orig` 跟 `text` 相同，斷字已經去掉，`raw` 不是真正的原文。
* 頁尾的購買者資訊與頁碼，這次都標成 `furniture`。

下列決定由維護者在 2026-11-01 從問題介面選定。

## 決定

**閱讀順序**

1. 閱讀順序與邊欄用幾何規則。轉接器依 `charspan` 把跨框的項目拆成一框一塊，`source` 層的格式不變。`src/core/pdf.ts` 多回傳向量方框，文字落在方框內算邊欄。主流依欄重排，再依語言設定檔接段。修改 ADR-0085 第 9 項：`source` 層的區塊是版面上的一塊，段落由組裝接起來。

**字元守恆**

2. 比對每頁的字元計數，不管順序，忽略空白與連字號，兩邊都套語言設定檔的正規化。缺字超過該頁字元數的 1%，而且超過 5 字，該頁失敗。門檻是提案，等 H-8 量過才定案。
3. `document` 加必填的 `pages`，每頁一筆，狀態是 `ok`、`skipped` 或 `failed`，帶原因代碼與缺字數，不帶書本文字。失敗頁的區塊不進 `blocks`，跨過它的段落不接，結束碼 1。

**`tome-overrides/1`**

4. 檔案是書資料夾裡的 `overrides.yaml`，`operations` 依序套用。`op` 是 `role`、`move`、`merge`、`split`、`skip`、`redact`。`split` 用 `before` 寫文字定位，`redact` 用 `text` 寫要遮的文字，換成 `[REDACTED]`。對不到的操作回報，不丟棄。

**章節與頁碼**

5. 書籤優先。沒有書籤就用 `title`、`heading` 區塊建一層章節。`page_map` 只來自頁碼標籤，沒有就是空的。

**範圍**

6. 行內 `runs` 排到 M3。`index`、`credits` 不自動判定，先靠 `overrides` 或規則包。編輯 `overrides.yaml` 的指令不做。
7. H-5、H-7、H-8 用維護者提供的商業書實測，結果只寫數字，不寫書名與內容。

**細節**

8. `document` 存成 `ir/document.json`，階段名稱是 `document`，指紋含 `source` 的鍵、`overrides`、語言設定檔、規則包與組裝版本。
9. 格式檔是 `schemas/tome-overrides-1.schema.json`。
10. 頁首頁尾：引擎標的 `furniture` 之外，數字拿掉後相同、貼上下 8% 頁邊、出現 3 頁以上也算。
11. 接段略過 `furniture`、邊欄與圖，照語言設定檔的 `join`。
12. 跨頁表格：相鄰兩張欄數相同就併，重複的表頭拿掉。
13. 首字放大：第一個文字段是單一字母，字高達其他文字的 2 倍就接回。
14. 同一個方框裡的區塊共用 `group`。
15. 規則包只判定 `furniture` 與表格以外的區塊，判到就蓋過核心角色。正則逾時回 1，列出是哪個模式。
16. 看不見的字從字元守恆的缺字扣掉。
17. `extract.source_only` 拿掉，改回報組裝結果。

**實作時定的細節**

18. 下列各項是實作時定的，維護者開 PR 後接受：
    * 方框裡要有內文才算邊欄，標題的底色帶不算。方框內的標題維持 `heading`，內文改 `sidebar`。
    * `blocks` 的順序是同一頁的主流、邊欄、頁首頁尾。
    * `merge` 留第一塊的 ID，`redact` 不改 ID，`split` 的第二塊用新 ID，手寫 `overrides.yaml` 不用算雜湊。
    * `overrides` 對不到是警告，結束碼 0。格式錯誤回 2。
    * 通過的頁也記 `missing`、`total`。
    * 引擎多出來的字不算失敗，只抓不見的字。
    * 沒有原生頁的書也寫 `document`，每頁都是 `skipped`。
    * `group` 的格式是 `p0012-box1`。
    * 小於 36×18 點的形狀不當方框。

第 2、10、13、18 項的數字是提案。

## 量測

2026-11-01，Windows 參考機器，Docling 2.140.0，合成 PDF。**已驗證**的範圍只到這裡，商業書**還沒量**。

| 項目 | 結果 |
| :--- | :--- |
| 版面案例 `layout` | 3 頁全過：跨欄邊欄的順序、跨邊欄與跨頁接段、斷字、跨頁表格、首字放大、購買者頁尾、連字都對 |
| 字元守恆 | 9 個案例 50 頁、104,365 個字元，缺字 0，沒有誤擋，含隱藏文字的頁也一樣 |
| 丟字 | 引擎少給一半文字的頁會失敗，區塊不進 `blocks`，結束碼 1 |
| 跨平台 | `engine.yml` 在 Windows 與 Ubuntu 跑 `layout`，缺字都是 0，三頁的字元數相同。Ubuntu 是拿掉網路跑的 |

字元守恆在開發時抓到一個真的錯誤：Docling 接段時拿掉行尾連字號，`charspan` 卻是拿掉之前算的，轉接器拆出來的文字差了兩個字元，第 0 頁缺 1 字。門檻放過了它，缺字數看得到才查出來，所以 `pages` 在通過的頁也記 `missing`。

**還沒驗證**：疊印的重複文字與可選內容圖層，合成 PDF 沒有這些案例。真實書籍的版面，H-5、H-7、H-8 都等維護者提供的書。

## 驗證

<!-- @assert-present file="schemas/tome-overrides-1.schema.json,src/core/assemble.ts,src/core/conservation.ts,src/core/overrides.ts" -->
<!-- @assert-absence target="src/cli/messages/zh-TW.json" symbol="extract.source_only" comments="include" reason="第 17 項：組裝已經接上" -->
<!-- @assert-count target="engines/docling/main.py" symbol="charspan" min="1" reason="第 1 項：跨框的項目依 charspan 拆開" -->
<!-- @assert-count target="schemas/tome-ir-1.schema.json" symbol="pageStatus" min="2" reason="第 3 項：document 記下每頁的狀態" -->
<!-- @assert-absence target="src/core/assemble.ts" symbol="generic" reason="ADR-0023：組裝不認得遊戲概念" -->

## 後果

規則要自己維護。底色用圖片畫的邊欄、四條線畫的方框都抓不到。全寬的表格與圖會把欄位切開，文字繞著它們排的版面，順序可能不對。`overrides.yaml` 含書本文字，它本來就只在工作區。

## 替代方案

**只信 Docling 的順序，錯的靠 overrides**：工作量小，但跨欄邊欄每本書都要人工修，接成一塊的段落也拆不開；**一字都不容忍**：疊印與可選內容圖層會誤擋；**門檻 5%**：漏掉一小段看不出來；**偏移量定位**：人數不出來，這個回合又沒有編輯指令；**有一頁失敗就不產生 `document`**：三百頁的書會被一頁卡住；**從版面推斷章節層級與頁碼**：規則多，沒有語料能驗證；都否決。

## Open Questions

* 方框的判定門檻：蓋住頁面 60% 以上的方框當版面裝飾，區塊有 80% 面積在方框內才算邊欄。提案，等 H-5 量過。
* 全寬區塊的判定：寬度超過文字區的 60% 算全寬。提案，等 H-5 量過。
