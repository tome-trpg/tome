---
id: ADR-0122
status: accepted
date: 2026-11-08
depends-on: [ADR-0005, ADR-0011, ADR-0012, ADR-0022, ADR-0053, ADR-0054, ADR-0059, ADR-0068, ADR-0081, ADR-0102, ADR-0113, ADR-0115, ADR-0116, ADR-0120]
amends: [ADR-0113, ADR-0022]
---

# ADR-0122：vault 輸出

## 脈絡

ADR-0113 第 22 項把回合 030 排成「vault 與報告：`tome assemble`、`render` 表、交付報告與 `tome report`、一致性報告、M3 的三項驗證、額外模式（第 11、17、18 項）」，第 23 項列出開工前要問的細節。白皮書 §5.5 定了 vault 的樣子（原則已定案，ADR-0005）：一本書一個資料夾，書目與來源、交付報告、一章一檔、`entities/`、`assets/`、`review/`；章節資訊放 frontmatter；邊欄與規則包的區塊用 callout；沒翻成的段落用 `[!untranslated]` 加原文（ADR-0081 第 7 項）；頁碼參照輸出成連結（ADR-0022）；頁面邊界 `<!-- page: N -->`；區塊回溯只放在連結目標上，完整對應表放 `review/`；檔名與連結要清理。ADR-0113 第 17 項：vault 的固定文字放訊息檔；第 18 項：檔名「編號加章名」，訊息只印 vault 的根目錄與數量，vault MUST 在任何 git repo 之外（ADR-0053 第 2 項）。

**現有程式**：沒有 `tome assemble`、`render` 表；`tome preview` 在 `books/<slug>/review/` 寫對照；`vault_path` 選填；IR 的 `figure` 只有頁碼與方框，沒有圖片資料，repo 沒有能把 PDF 畫成圖的套件；`book.yaml` 沒有書名與作者。

開工前的 19 項問題寫在共用筆記 `brief-030-questions.md`，維護者在 2026-11-08 選定：第 1 項拆回合，第 4 項沒設路徑寫到工作區的 `vault/`，第 5 項不抽圖，030 的其他項照建議；038 的第 12–17 項等 038 開工前再問。實作時的細節 20 項寫在 `brief-030-details.md`，維護者在同一天全部照建議選定：第 1 項頁碼連結「用譯文原本的字」（修改 ADR-0022，見第 9 項），第 10 項 frontmatter 的欄名用中文。

## 決定

**範圍**

1. **修改 ADR-0113 第 22 項**：回合 030 拆成 **030「vault 輸出」**與新的 **038「報告與檢查」**。038 做交付報告與 `tome report`、一致性報告、代名詞與實體卡不符、機翻腔訊號、批次中改代名詞的修正（ADR-0120 後果，維護者選在這裡修）、額外模式；細節在 038 開工前再問。順序 030 → 038 → 031 → 032 → 033 → 034。輸出結構的檢查是輸出端的自我檢查，留在 030。

**vault 的位置與檔案**

2. vault 的根目錄是 `tome.yaml` 的 `vault_path`；**沒設時寫到工作區的 `vault/`**，訊息印出根目錄並提醒可以用 `tome init --vault` 設。寫之前查路徑：在 git repo 裡就拒絕（`vault.in_git_repo`），在同步資料夾裡就警告。一本書一個資料夾，用書的名稱（`slug`）。
3. 書的資料夾裡：`00-書目與來源.md`、一章一檔、`entities/`、`review/`。章節照 `chapter_level`，跟 `--chapters` 與 `tome preview` 同一個分法（ADR-0115）；第一章之前的部分寫進 `00-卷首.md`。檔名是兩位數編號加章名（這章第一個標題的譯文，沒翻成用原文，沒有標題只用編號），清理掉檔名與 Obsidian 連結不能用的 ASCII 字元，最多 60 字。輸出整本書，不看 `--chapters`。
4. **不抽圖**：圖的位置寫一行 `> [!figure] 原書 p.N 的圖`（N 是原書印的頁碼），不建 `assets/`；抽圖另開回合，交付報告（038）列出沒抽的圖。
5. `00-書目與來源.md`：PDF 中繼資料的書名與作者（沒有就用書的名稱、作者寫「不明」）、來源 PDF 的 SHA-256、不得散布的聲明、版權頁的原文（ADR-0011、PC-5）。`entities/`：每張鎖定、有譯名的卡一個檔（檔名是清理過的譯名，撞名時加卡的 id；內容是原文、譯名、類別、性別、代名詞、語域，有值才寫），章節裡不自動加連結。`review/`：每章一個對照檔，格式跟 `tome preview` 相同，另有 `00-區塊對應表.md`（每個區塊一列，連到它的章節檔）；`tome preview` 照舊寫在 `books/<slug>/review/`。

**章節檔**

6. 開頭是扁平的 frontmatter，**欄名用中文**：書、章、標題、原書頁碼（放訊息檔，值寫成 JSON 字串，原書頁碼是這章第一頁到最後一頁的標籤）。每個檔案開頭與每次換頁標 `<!-- page: N -->`（原書印的頁碼，沒有就用 PDF 的頁次）。
7. 依角色：標題用 Markdown 標題，層級照章節樹的深度（不在樹裡的用二級，`title` 用一級，最多六級）；段落；清單 `- `；表格用 Markdown 表格，第一列當表頭，格子裡換行換成 `<br>`、`|` 跳脫，跨列跨欄不處理，缺的格子留空；邊欄 `> [!sidebar]`；規則包角色 `> [!<角色名>]`（去掉命名空間、底線換連字號）。`toc`、`index`、`furniture` 不輸出，`credits` 只放進書目與來源。粗體、斜體用 Markdown（ADR-0116）。書本文字開頭的 `#`、`>`、`|` 前面加反斜線。
8. 沒翻成的單位：`> [!untranslated] 狀態` 加原文；**`BLOCKED` 不放原文**（個資）；沒翻成的標題仍是標題（原文，下一行加 callout）；表格裡沒翻成的格子放原文、`BLOCKED` 的格子只寫狀態。
9. **頁碼參照的連結，修改 ADR-0022 第 1、2 項**：ADR-0022 寫「顯示 `（參見原書 p.42）`」、「解析不到時留純文字 `（參見原書 p.42）`」；改成**連結只包住遮蔽的頁碼那幾個字，顯示譯文裡原本的字**，例如「見 `[[02-沼澤#沼澤|p.3]]`。」，解析不到的照譯文留著、不加字（維護者選的）。遮蔽的只有「p.42」，「參見」這類字已經在譯文裡，換成「（參見原書 p.42）」會變成「參見（參見原書 p.42）」。白皮書 §5.5 的表格跟著改。連結的目標：照原書的頁碼（`page_map`，找不到就當 PDF 的頁次）找到那一頁第一個會輸出的區塊，連到同一章裡在它之前最近的標題（同一個檔寫 `[[#標題|…]]`）；標題有 ASCII 的 `#`、`|`、`^`、`:`、`%`、`[`、`]`（全形的「：」不影響）、有樣式或跨行時改連區塊，並在那個區塊加 `^區塊 ID`：段落、標題、清單寫在行尾，callout、表格、圖寫在下一行。

**上次輸出與檢查**

10. `book.db` 遷移第 12 版：`render`（每個區塊輸出的 Markdown 與章節檔，給 031 的 `tome sync`）與 `render_file`（每個檔的 SHA-256）。
11. **vault 被人改過就拒絕**：檔案還在、雜湊跟上次不同就整本不輸出（`assemble.edited`，結束碼 1），只印改過的檔案數；031 之前可以加 `--force` 覆蓋，`--json` 的 `data` 多 `overwritten`（覆蓋了幾個改過的檔）。被刪掉的檔照樣重寫，不算改過；這次沒產生的舊檔（例如換了分章層級、卡被拒絕）刪掉；使用者自己放的檔不在表裡，不會動到。先寫檔、再一次更新兩張表；寫到一半中斷，下次會把已經改寫的檔當成被人改過而擋下，要 `--force`。
12. **輸出結構的檢查**（ADR-0102 第 12 項的三項之一）：從產生的章節檔數標題與表格（callout 裡的不算；表格從前一行不是表格列的 `|` 開始、下一行是分隔線，格子裡寫著 `---` 的列不算新的表格），跟 IR 對（`BLOCKED` 的標題不算）；對不上就不寫檔（`assemble.structure_mismatch`，結束碼 1），說明這是程式錯誤。
13. 訊息、`--json` 與紀錄只印 vault 的根目錄與數量（檔案數、單位數、沒翻成的單位數；`--json` 照其他指令另有書的名稱，就是指令的參數），不印書的資料夾路徑、檔名與書本文字（ADR-0059、ADR-0113 第 18 項）。Obsidian 裡怎麼顯示**只能人看**，測試只查產生的文字。

## 驗證

<!-- @assert-count target="src/core/vault.ts" symbol="const root = configured ?? join(home, 'vault');" expected="1" reason="第 2 項：沒設路徑寫到工作區的 vault/" -->
<!-- @assert-count target="src/core/vault.ts" symbol="const placement = pathFindings('vault', root, process.env, process.platform);" expected="1" reason="第 2 項：vault 不得在 git repo 裡" -->
<!-- @assert-count target="src/core/vault.ts" symbol="if (block.role === 'figure') return" expected="1" reason="第 4 項：圖只寫 callout，不抽圖" -->
<!-- @assert-count target="src/core/vault.ts" symbol="assets/" expected="0" comments="include" reason="第 4 項：不建 assets/" -->
<!-- @assert-count target="src/core/vault.ts" symbol="return unit.state === 'BLOCKED' ? quote(head) : `${quote(head)}\n${quote(escapeLines(unit.source))}`;" expected="1" reason="第 8 項：BLOCKED 不放原文" -->
<!-- @assert-count target="src/core/vault.ts" symbol="const link = `[[${target}|${reference}]]`;" expected="1" reason="第 9 項：連結顯示譯文裡原本的字" -->
<!-- @assert-count target="src/core/store.ts" symbol="CREATE TABLE render (" expected="1" reason="第 10 項：上次輸出的區塊" -->
<!-- @assert-count target="src/core/store.ts" symbol="CREATE TABLE render_file (" expected="1" reason="第 10 項：上次輸出的檔案雜湊" -->
<!-- @assert-count target="src/core/vault.ts" symbol="if (edited.length > 0 && !force) {" expected="1" reason="第 11 項：被人改過就拒絕" -->
<!-- @assert-count target="src/core/vault.ts" symbol="if (expected.headings !== actual.headings || expected.tables !== actual.tables) {" expected="1" reason="第 12 項：結構對不上就不寫檔" -->

**量測**（2026-11-08）：複製 `book1`（ADR-0115 的書 8）的 `document.json` 與 `book.db` 到暫存資料夾，排出 vault（不寫檔、不讀 PDF），只印數字，跑完刪掉複本；只讀維護者工作區的 `book.yaml`，沒有寫入。2,579 個單位、2,551 個翻好，vault 裡 28 個沒翻成；352 個檔（章節檔 175 個、對照檔 175 個、書目與來源、區塊對應表），沒有鎖定的實體卡；標題預期 183 個、產生 183 個，表格預期 53 個、產生 53 個；翻好的單位裡沒有頁碼參照，所以連結的部分這本書量不到；排版 23 毫秒。

## 後果

翻好的書可以在 Obsidian 裡讀：章節、邊欄、數值塊的 callout、沒翻成的段落都看得出來，頁碼參照能點。vault 在本機，有書本文字，不得散布的聲明寫在書目與來源裡。

031 之前，vault 裡的修改沒辦法收回，只能 `--force` 覆蓋；`tome assemble` 會先擋下來，不會默默蓋掉。圖要等另一個回合才抽，現在只有一行原書頁碼。

## 替代方案

否決了下列做法：

* **不拆回合**：PR 會比 037 大兩倍。**拆成三個**：檢查與修正分開，多一次開工前的問題。
* **沒設路徑就停下來**：032 的 `tome run` 一路跑時會卡住。
* **抽原樣存的 JPEG**、**加能畫 PDF 的套件**、**讓解析引擎輸出圖**：範圍大，或要過相依的審查與冷卻期，或只有 Docling 有。
* **連結顯示「（參見原書 p.42）」**：譯文裡的「參見」會重複。
* **`tome preview` 改寫到 vault 或拿掉**：沒設 vault 也要能看譯文。
* **章節裡自動連到 `entities/`**：要改動譯文。
* **031 之前不檢查、直接覆蓋**：vault 裡的修改會沒預警地不見。

## Open Questions

- [ ] 頁碼參照的連結在真書上解析得到多少，要等有頁碼參照、翻好的書再量（第 9 項）。
- [ ] Obsidian 裡的顯示（callout、連結、frontmatter），要人在 Obsidian 裡看過（第 6–9 項）。
- [ ] 抽圖的回合怎麼做（第 4 項）。
