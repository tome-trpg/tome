---
status: active
date: 2026-11-08
type: feature
wave: 30
affectedFiles:
  - CHANGELOG.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - src/**
  - tests/**
protectedFiles:
  - .github/**
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CLAUDE.md
  - docs/research/**
  - engines/**
  - languages/**
  - package-lock.json
  - package.json
  - prompts/**
  - providers/**
  - schemas/**
  - stryker.config.mjs
  - systems/**
---

# 030 — vault 輸出

## Intent

這個回合結束時，`tome assemble <book>` 把一本書寫成 Obsidian 的 vault：`00-書目與來源.md`、一章一檔（frontmatter、依角色的 callout、頁面邊界、頁碼參照的連結、區塊回溯）、`entities/` 與 `review/`；沒設 `vault_path` 時寫到工作區的 `vault/`；圖只寫「原書 p.N 的圖」的 callout，不抽圖；上次輸出記在 `book.db` 的 `render` 表，vault 被人改過就拒絕輸出（031 之前可以 `--force`）；寫檔前查標題與表格的結構跟 IR 對得上。原本的回合 030 拆成 030「vault 輸出」與新的 038「報告與檢查」。

細節由維護者在 2026-11-08 選定（共用筆記 `brief-030-questions.md`：第 1 項拆回合，第 4 項沒設路徑寫到工作區的 `vault/`，第 5 項不抽圖，030 的其他項照建議；038 的第 12–17 項等 038 開工前再問），寫成 ADR-0122。

## Negative Scope

- 不做交付報告、`tome report`、一致性報告、代名詞與機翻腔的檢查、批次中改代名詞的修正、額外模式（038）；不做 `tome sync`（031）。
- 不抽圖、不建 `assets/`；不做 VTT 等其他格式；不改提示、schema 與語言設定檔。
- vault 與 `review/` 有書本文字：測試只用合成的 document，量測寫到暫存資料夾、只印數字、跑完刪掉；訊息、`--json` 與紀錄不印個別檔案的路徑。
- 不寫入維護者的工作區，不對真的 API 發請求。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。實作時冒出的新細節寫進共用筆記 `brief-030-details.md`。
- 寫給維護者的理由要先對照程式與 ADR 原文。
- 核心不放給人看的文字：vault 的固定文字放訊息檔。
- 成熟度照實寫：Obsidian 的顯示只能人看，測試只查產生的文字。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [x] 本機單一變異的小工具對改過的函式跑過一輪，存活的補上測試或說明是等價變異
- [ ] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑
- [ ] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] 訊息、`--json` 與紀錄都不含書本文字與個別檔案的路徑

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0122（`amends: [ADR-0113, ADR-0022]`：拆回合、新增 038；頁碼參照的連結顯示譯文裡原本的字）
- [x] `tome assemble`：`00-書目與來源.md`、章節檔、`entities/`、`review/`，沒翻成的單位走 `[!untranslated]`，`BLOCKED` 不放原文
- [x] 章節檔的 frontmatter、callout、頁面邊界、頁碼參照的連結、區塊回溯，檔名與連結清理過
- [x] 沒設 `vault_path` 寫到工作區的 `vault/`；vault 在 git repo 裡就拒絕
- [x] 圖寫成「原書 p.N 的圖」的 callout，不抽圖
- [x] `render` 表（遷移第 12 版）與未回收修改的偵測，`--force`
- [x] 輸出的標題與表格結構跟 IR 對不上就不寫檔
- [x] `book1` 複本的量測寫進 ADR-0122，只有數字
- [x] 白皮書與 CHANGELOG 更新

## Measured

2026-11-08（UTC），Windows 參考機器。

**`book1` 複本**（ADR-0115 的書 8）：複製 `document.json` 與 `book.db` 到暫存資料夾排出 vault，不寫檔、不讀 PDF，只印數字，跑完刪掉複本。2,579 個單位、2,551 個翻好，vault 裡 28 個沒翻成；352 個檔（章節檔 175 個、對照檔 175 個、書目與來源、區塊對應表），沒有鎖定的實體卡；標題 183/183、表格 53/53；翻好的單位裡沒有頁碼參照，連結量不到；排版 23 毫秒。

**本機單一變異的小工具**（不是 Stryker）：用 `@babel/parser` 對改過的行產生變異，一次套一個到複本，只跑對應的測試檔，不吃滿 CPU。

| 檔案 | 變異 | 殺掉 | 逾時 | 存活 | 等價 | 走不到 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| `src/core/vault.ts`（排版：`renderVault` 與小工具） | 426 | 411 | 1 | 0 | 14 | 0 |
| `src/core/vault.ts`（寫檔：`assembleBook`） | 72 | 61 | 0 | 0 | 2 | 9 |
| `src/core/pdf.ts`（`info()` 與 `metadataInfo`） | 18 | 18 | 0 | 0 | 0 | 0 |

逾時的 1 個是表格的列數 `+=` 換成 `-=`，迴圈停不下來，算抓到。第一輪存活：排版 102 個、寫檔 17 個、PDF 8 個。多數補了測試（頁碼標籤與 PDF 頁次、有樣式或空的標題、`BLOCKED` 的章名與標題、沒有標題就開始的章、callout 的空行、各種區塊的區塊回溯、表格的列數、沒有內容的區塊、目錄與索引有單位時、書目與來源和實體卡的全文、`review/` 的對應表、訊息的等級、`--json` 的 `data`、使用者已經刪掉的舊檔、PDF 中繼資料的空白與作者）。排版的 `sha256` 兩個用 `tests/cli/assemble.test.ts` 殺掉。改了 4 處程式：章名與檔名分開記、連結的標題跟輸出的標題同樣合併空白（原本兩個空白的標題會連不到）、`--force` 改成必填、`overwritten` 直接用改過的檔數；並修掉一個錯誤：**格子裡寫著 `---` 的列會被當成另一個表格**，結構檢查因此誤判、整本不輸出。

等價的 16 個：

* 排版：章節樹裡沒有 `block_id` 的節點也寫進深度表（用 `undefined` 當鍵，查不到）；只對翻好的單位呼叫的 `translation ?? ''` 三處（翻好就一定有譯文）；規則包角色一定有命名空間（IR schema 的 pattern），`:` 不會在第 0 個字；每個章都在章名表裡，`stemOf` 與 frontmatter 的備用值兩處走不到；沒有標題時也寫進標題表（存的是 `undefined`）；頁碼沒有數字時提早回傳（不回傳也找不到 `NaN` 頁）；表格計數的 5 個（表格列一定以 `|` 開頭也結尾，分隔線前面一定是表頭，`?? ''` 的備用字串換什麼都不會是 `|` 或分隔線）。
* 寫檔：`openPdf` 不是 `ok` 時不提早回傳也會在 `try` 裡丟錯、回傳空的；讀檔的編碼拿掉時拿到同樣位元組的 Buffer，雜湊一樣。

走不到的 9 個：寫檔前結構對不上的分支。IR 是合法的（schema 要求表格至少一列一欄）時，排版產生的標題與表格數一定跟預期相同，這個分支只在程式錯誤時才走到，CLI 測試觸發不了；計數本身在 `tests/core/vault.test.ts` 測了（含故意寫不出來的表格）。

本機結果：`npm test` 72 個測試檔通過、1 個跳過，1,830 個測試通過、5 個跳過；`npm run spec` 346 個斷言都成立，也都看過失敗；`npm run typecheck` 通過；`npm run licenses` 299 個套件沒有違規。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| 排版（`tests/core/vault.test.ts`） | 舊程式沒有 `vault.ts`；上面的單一變異都殺掉或列為等價 |
| CLI（`tests/cli/assemble.test.ts`） | 舊程式沒有 `tome assemble`；上面的單一變異都殺掉或列為等價 |
| 遷移第 12 版（`tests/core/store.test.ts`） | 舊程式的版本是 11 |
| PDF 中繼資料（`tests/core/pdf.test.ts`） | 舊程式沒有 `info()` 與 `metadataInfo` |
| 格子裡的 `---`（`counts a table once even when its cells hold dashes`） | 第一版的計數把每一列 `\| --- \|` 都算成分隔線，這個測試會得到 2 個表格 |
