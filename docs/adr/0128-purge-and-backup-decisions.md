---
id: ADR-0128
status: accepted
date: 2026-11-09
depends-on: [ADR-0053, ADR-0054, ADR-0058, ADR-0059, ADR-0104, ADR-0107, ADR-0113, ADR-0118, ADR-0122, ADR-0125]
amends: [ADR-0058, ADR-0113]
---

# ADR-0128：tome purge 與 tome backup

## 脈絡

ADR-0058 定了 `tome purge <書>` 刪 IR、`book.db`、系列記憶裡這本書的項目，並清掉遠端殘留的批次；不動 PDF 與 vault，加 `--vault` 才刪 vault，執行前列出清單要確認；`tome backup` 匯出資料庫與實體卡，不含 PDF。ADR-0113 第 22 項把它排成回合 033，第 23 項留下「`tome purge` 的確認方式；`tome backup` 的範圍、格式與個資清單要不要進備份；外送紀錄的保留期（ADR-0104 的 Open Question）」。

**現有程式**：一本書在工作區的東西是 `books/<slug>/`（`book.yaml`、`book.db` 與 WAL 檔、`ir/` 的 source 層與 document 層、`overrides.yaml`、`review/`、`book.lock`）、`series/<slug>/series.db`（系列的 ID 目前就是書的 `slug`，`memory` 與 `human` 都有 `book` 欄），以及 vault 的 `<vault>/<slug>/`。實體卡在 `book.db` 的 `entity` 表。PDF 不在工作區，金鑰在作業系統的憑證庫。批次收回後才刪遠端，刪除失敗只警告，`deleted_at` 留空，下次收回時再試；`tome batch cancel` 只叫供應商取消，本機的紀錄還是「送出中」，要再跑 `tome batch collect` 才收回。`node:sqlite` 的 SQLite 是 3.53，`VACUUM INTO` 在 WAL 模式下也能寫出一致的複本。

開工前的 15 項問題寫在共用筆記 `brief-033-questions.md`，維護者在 2026-11-09 選定：第 3 項兩步確認、比照估價，第 4 項清乾淨才刪，第 5 項只刪 TOME 寫的檔，第 7 項資料庫加 document 層，其餘照建議。實作時的細節寫在 `brief-033-details.md`，維護者在同一天選定照建議（8 項）。

## 決定

1. **範圍**（問題第 1 項）：做 `tome purge <書>` 與 `tome backup <書>`。不做還原指令，也不刪整個工作區、引擎與金鑰。
2. **`tome purge` 刪的東西**（問題第 2、6 項）：整個 `books/<slug>/`（含 `book.db` 裡的帳本、外送紀錄、原始回應與實體卡）；`series/<slug>/series.db` 裡 `book` 是這本書的翻譯記憶與人工譯文，刪完沒有別的書的項目就刪整個系列資料夾；遠端殘留的批次（第 4 項）；加 `--vault` 時 vault 裡 TOME 寫的檔（第 5 項）。**不動** PDF、引擎、`tome.yaml`、金鑰、別的書與備份。同系列的別本書命中過的翻譯記憶跟著刪，那本書之後只是少一筆快取。
3. **兩步確認**（維護者選的，問題第 3 項、細節第 2 項）：`tome purge <書>` 只列出要刪的東西（書的資料夾、單位與翻好的單位數、實體卡、翻譯記憶與人工譯文的筆數、遠端殘留的批次數，加 `--vault` 時另一行 vault 的檔案數），把這份清單的指紋存在這本書 `book.db` 的 `stage` 表（`purge-list`），結束碼 0（`purge.list`、`purge.not_confirmed`）。`tome purge <書> --confirm` 只有清單跟上次列的相同才刪；不同或沒列過就重新列出、記下新的指紋、什麼都不刪，結束碼 1（`purge.changed`），看過之後再確認一次。指紋包含書的資料夾與系列資料夾的路徑、上面各項的數量、遠端殘留的批次 ID、有沒有加 `--vault`，加了的話還有要刪的 vault 檔案（路徑與現在的雜湊）、使用者自己的檔案數與改過還沒讀回的檔案數；所以加不加 `--vault`、中間 vault 被改過或又翻了一批，都要再看一次清單。
4. **批次清乾淨才刪**（維護者選的，問題第 4 項、細節第 1、5 項）：
   * 還有**送出中或只記了意圖**的批次（`batch.state` 是 `intent` 或 `submitted`，翻譯與 Pass 0 都算）時，列清單與確認都不刪，結束碼 1（`purge.batches_pending`），請使用者先跑 `tome batch collect`；要放棄的批次先 `tome batch cancel`、再 `tome batch collect`。
   * **遠端殘留**是已收回、遠端還沒刪掉的批次（`state` 是 `collected`、`remote_id` 不是空的、`deleted_at` 是空的；`abandoned` 的沒有建立在遠端）。`--confirm` 時先用批次模式原本的刪除（ADR-0107 第 15 項）刪遠端：刪掉或遠端已經沒有（404，照樣警告）都記下 `deleted_at`。有任何一筆刪不掉（沒有金鑰、連不上、供應商回錯），本機什麼都不刪，結束碼 1（`purge.remote_failed`），已經刪掉的記好 `deleted_at`，下次只刪剩下的。
   * 只有確認刪除、又有遠端殘留時才取金鑰、連網；其他時候不連網、不要金鑰。
5. **`--vault` 只刪 TOME 寫的檔**（維護者選的，問題第 5 項、細節第 4 項）：vault 的位置照 `tome assemble`（`tome.yaml` 的 `vault_path`，沒設就是工作區的 `vault/`），這本書的資料夾是 `<vault>/<slug>/`。只刪 `render_file` 記得、現在還在的檔，再由下往上刪因此變空的資料夾，`<vault>/<slug>/` 空了也刪；使用者自己放的檔與原本就空的資料夾留著，清單寫有幾個檔。改過、還沒 `tome sync` 讀回的檔（雜湊跟 `render_file` 不同，跟 `tome assemble` 擋下的判斷一樣）照樣刪，清單另外寫有幾個：讀回成人工譯文也會被 `tome purge` 刪掉，所以提醒的是「改過的內容會不見」。刪除不做 git repo 與同步資料夾的檢查，`tome assemble` 本來就不會寫到那些地方。**修改 ADR-0058 第 3 項**：`--vault` 刪的是 TOME 寫的檔，不是整個資料夾。
6. **刪的順序**（細節第 3 項）：先刪遠端殘留，全部成功才刪本機：vault 的檔（加 `--vault` 時）→ 系列記憶裡這本書的列 → `books/<slug>/`。資料庫都先關掉再刪，Windows 才刪得掉；書的鎖檔跟著書的資料夾一起刪掉。
7. **備份的範圍**（維護者選的，問題第 7、10 項）：`book.db`、`series/<slug>/series.db`、`book.yaml`、`overrides.yaml`、`ir/document.json` 與 `ir/probe.json`，還沒有的就不放（沒翻過的書沒有系列資料庫）。不含 `ir/source/`（引擎的原始輸出，可以重新解析得到）、PDF、`review/`（`tome preview` 重產）、vault（使用者手上就有）、`tome.yaml` 與金鑰。個資清單在 `tome.yaml`，不屬於一本書，不進備份；`book.yaml` 裡這本書的個資例外照原樣進備份。**修改 ADR-0058 第 4 項**：除了資料庫（實體卡在 `book.db` 裡），也備 document 層，重建它要重跑引擎。
8. **備份的格式**（問題第 8 項、細節第 6 項）：一個資料夾，照工作區的目錄排（`books/<slug>/…` 與 `series/<slug>/series.db`）；資料庫用 `VACUUM INTO` 寫出一致的複本，其他檔原樣複製；另加 `manifest.json`：`format: "tome-backup/1"`（只是格式的名字，不加 schema 檔）、`book`、`created_at`（UTC）、`tome_version`、兩個資料庫的遷移版本（`user_version`，沒有系列資料庫時是 `null`）、每個檔的相對路徑、大小與 SHA-256。不壓縮、不加相依。還原就是把其中的 `books/` 與 `series/` 放回工作區。
9. **備份放哪裡**（問題第 9 項）：預設 `<工作區>/backups/<slug>-<UTC 時間，例如 20261109T120000Z>/`，`--out <資料夾>` 指定別處。備份含書本文字與譯文（G-5），跟工作區、vault 一樣查路徑：在 git repo 裡拒絕（`backup.in_git_repo`，結束碼 1），在同步資料夾裡警告（`backup.sync_folder`）。目的地已經存在就不覆蓋，結束碼 2（`backup.exists`）；寫到一半失敗時刪掉這次建立的資料夾。`tome purge` 不刪備份。
10. **外送紀錄的保留期**（問題第 11 項）：跟 `book.db` 一起留到 `tome purge`，不另設期限，也進備份。它只有雜湊、大小與時間，不含內容，留著才查得到 TOME 對這本書送過什麼、送過幾次。結掉 ADR-0104 的 Open Question。
11. **訊息與結束碼**（問題第 12 項、細節第 7 項）：只印數量與工作區的路徑，不印書本文字（ADR-0059）。`tome purge` 刪完是 `purge.done`，加 `--vault` 時另一行 `purge.vault_done`（刪了幾個、留下幾個）。`tome backup` 完成是 `backup.done`（目的地與檔案數），每次都加一個 `warn` 的 `backup.private`：備份含書本文字與譯文，請放在安全的地方。兩個指令都拿書的鎖，書正在跑別的指令就停（`book.busy`，結束碼 2）。定案 ADR-0113 第 23 項的 `tome purge` 確認方式、`tome backup` 的範圍與格式、個資清單與外送紀錄的保留期。
12. 測試只在暫存的合成工作區跑，遠端刪除用假的供應商；不在維護者的工作區、書與 vault 上跑任何刪除（問題第 13 項）。

## 驗證

<!-- @assert-count target="src/core/purge.ts" symbol="recordStage(store, LIST_STAGE, fingerprint)" expected="1" reason="第 3 項：列清單時記下指紋，確認時比對" -->
<!-- @assert-count target="src/core/purge.ts" symbol="FROM batch WHERE ${OUTSTANDING}" expected="1" reason="第 4 項：送出中或只記了意圖的批次擋下刪除，翻譯與 Pass 0 都算" -->
<!-- @assert-count target="src/core/purge.ts" symbol="await retryDeletes(run)" expected="1" reason="第 4 項：遠端殘留用批次模式原本的刪除" -->
<!-- @assert-count target="src/core/purge.ts" symbol="if (removed.left > 0)" expected="1" reason="第 4 項：有一筆刪不掉就整個不刪" -->
<!-- @assert-count target="src/core/purge.ts" symbol="FROM render_file" expected="1" reason="第 5 項：vault 只刪 TOME 寫的檔" -->
<!-- @assert-count target="src/core/purge.ts" symbol="vault_path ?? join(home, 'vault')" expected="1" reason="第 5 項：vault 的位置照 tome assemble" -->
<!-- @assert-count target="src/core/purge.ts" symbol="config.pdf" expected="0" reason="第 2 項：不動 PDF" -->
<!-- @assert-count target="src/core/backup.ts" symbol="VACUUM INTO ?" expected="1" reason="第 8 項：資料庫是一致的複本" -->
<!-- @assert-count target="src/core/backup.ts" symbol="ir/source" expected="0" reason="第 7 項：不含 source 層" -->
<!-- @assert-count target="src/core/backup.ts" symbol="review" expected="0" reason="第 7 項：不含 review/" -->
<!-- @assert-count target="src/core/backup.ts" symbol="pdf" expected="0" reason="第 7 項：不含 PDF" -->
<!-- @assert-count target="src/core/backup.ts" symbol="readWorkspaceConfig" expected="0" reason="第 7 項：不讀 tome.yaml，個資清單不進備份" -->
<!-- @assert-count target="src/core/backup.ts" symbol="pathFindings('backup'" expected="1" reason="第 9 項：備份跟工作區一樣查路徑" -->
<!-- @assert-count target="src/core/backup.ts" symbol="throw new TomeError('backup.exists'" expected="1" reason="第 9 項：目的地已經存在就不覆蓋" -->

## 後果

刪一本書要跑兩次指令，第二次跟第一次之間清單變了就要再看一次，換來看過清單才刪，`--json` 與腳本也能用。還在跑的批次要先收回或取消再收回，遠端刪不掉時本機整個留著，本機的紀錄就不會在遠端還有資料時先不見。vault 裡使用者自己的筆記不會被刪；TOME 寫的檔就算改過也會刪，清單先說有幾個。

備份比 ADR-0058 寫的多了 document 層，還原後不必重新解析；但不含 source 層，還原後要重新解析時（例如換了引擎）照樣要跑引擎。沒有還原指令，還原是手動把資料夾放回工作區，版本不同的遷移與撞名都由使用者自己處理。備份含書本文字與譯文，放哪裡由使用者負責，TOME 只擋 git repo、提醒同步資料夾。

## 替代方案

否決了下列做法：

* **互動輸入書名才刪**：最不容易誤按，但不能用在腳本與 `--json`。**`--yes` 直接刪**：容易沒看清單就刪（問題第 3 項）。
* **`tome purge` 自己取消並等到批次結束再刪**：可能要等很久。**本機照刪，警告遠端還有幾筆**：遠端的批次 ID 跟著本機的紀錄一起不見，使用者沒辦法再清（問題第 4 項）。
* **`--vault` 刪整個 `<vault>/<slug>/`**：使用者自己的筆記會一起不見（問題第 5 項）。
* **連 `ir/source/` 一起備份**：還原後不用重新解析就能重新組裝，但檔案大很多。**只備兩個資料庫與 `book.yaml`**：還原後要重新解析，整本書可能要好幾小時（問題第 7 項）。
* **壓縮成單一檔案**：Node 沒有內建的封存格式，手寫 zip 或 tar 要多寫、多測；要單一檔案的話使用者自己壓縮（問題第 8 項）。

## Open Questions

- [ ] `tome restore`：版本不同的遷移、跟工作區裡既有的書撞名時怎麼處理（問題第 1 項）。
- [ ] 讀不出 `book.yaml` 的書目前 `tome purge` 也刪不掉（書的鎖要先讀 `book.yaml`），要不要給壞掉的書另一條刪除的路。
