---
status: active
date: 2026-11-09
type: feature
wave: 40
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

# 031 — 讀回與人工譯文

## Intent

這個回合結束時，`tome sync <書>` 讀回 vault 的章節檔，跟上次輸出的區塊做序列比對（手寫，不加相依），一個區塊對一段新文字才回收成人工譯文，併段、拆段、搬動、新增、刪除與類型改變都不猜，記成回收不了。人工譯文以 `series.db` 為主、`book.db` 的單位加標記，狀態是 `DONE`，`tome verify`、S-16、改代名詞與 `syncUnits` 都不會蓋掉它，輸出時原樣放回。整個檔都回收了的檔不再擋 `tome assemble`；回收不了的改動照樣擋，`--force` 只用來丟掉它們，交付報告列出被覆蓋的有哪些。H-12 用合成的修改集驗證「不會寫到別的區塊」，也量 book1 的複本。

細節由維護者在 2026-11-09 選定（共用筆記 `brief-031-questions.md`：第 1 項拆成 031 與 040，第 3 項不加標記、序列比對，第 5 項 `series.db` 為主、`book.db` 加標記，第 11 項留著 `--force`，第 14 項也量 book1，其餘照建議），寫成 ADR-0125。

## Negative Scope

- 不做人工譯文的零 token 驗證與交付報告的「內含舊譯名的人工譯文」（040）、`tome run`（032）。
- 不回收 `entities/`、`review/`、書目與交付報告上的修改，不自動回收結構改動，人工譯文不跨書共用，不存進翻譯記憶，`tome sync` 不寫 vault。
- 不改提示、語言設定檔、schema；`state.ts`、`memory.ts`、`mask.ts` 預計不動。
- 讀回的內容是書本文字，只存在 `book.db` 與 `series.db`：測試只用合成的文字，量測寫到暫存資料夾、只印數字、跑完刪掉、不讀 PDF；訊息、`--json` 與紀錄只印數量。
- 不寫入維護者的工作區，不對真的 API 發請求。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。實作時冒出的新細節寫進共用筆記 `brief-031-details.md`。
- 寫給維護者的理由要先對照程式與 ADR 原文。
- 核心不放給人看的文字：訊息與報告的固定文字放訊息檔。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [x] 本機單一變異的小工具對改過的函式跑過一輪（含 `verify.ts`），存活的補上測試或說明是等價變異
- [ ] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑
- [ ] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] 訊息、`--json` 與紀錄都不含書本文字與個別檔案的路徑

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0125（`amends: [ADR-0113, ADR-0122]`，拆出 040）
- [x] `tome sync <書>`：序列比對，一個區塊對一段才回收，其他記成回收不了
- [x] 人工譯文存在 `series.db`（遷移第 3 版）與 `unit.human`（遷移第 14 版），每次 `syncUnits` 之後套回
- [x] `tome verify`、S-16、改代名詞、欄位化都不蓋掉人工譯文
- [x] 整個檔都回收了才不擋 `tome assemble`，`--force` 只丟掉回收不了的改動，交付報告列出被覆蓋的
- [x] H-12：合成修改集的性質測試（不會寫到別的區塊），book1 複本的數字寫進 ADR-0125
- [x] 白皮書與 CHANGELOG 更新

## Measured

2026-11-09（UTC+8），Windows 參考機器。

**H-12**（ADR-0125 第 4 項與量測）：

* 性質測試「回收的文字只能來自那個區塊」、「只改字時回收那個區塊最後的整段文字」、「彼此不相鄰的改字全部回收」在測試裡各跑 1,000、1,000、300 次；最後的規則在本機另外各跑 20 萬次（共 44 秒），都通過。改規則前找到的 9 個寫到別的區塊的反例留在測試的回歸表裡。
* book1 的複本（`document.json` 與 `book.db` 複製到暫存資料夾，175 個章節檔、1,389 個區塊，不讀 PDF，只印數字，跑完刪掉）：只改字 230 處，回收對的 230、**回收錯的 0**、沒回收的 0，`tome sync` 的核心 137 毫秒；改字加上結構改動（種子 31、32、33），回收對的 136、135、118，**回收錯的都是 0**，沒回收的改字 1、8、12 個，結構改動全部記成回收不了。

**本機單一變異的小工具**（不是 Stryker）：用 `@babel/parser` 對改過的行產生變異，一次套一個到複本，只跑對應的測試檔，第一次失敗就停的性質測試次數減少（150、150、100 次），不吃滿 CPU。`verify.ts` 與 `request.ts` 改的地方在 SQL 字串與一個函式呼叫裡，產生器沒有產生變異，改用手寫的變異。

| 檔案 | 測試檔 | 變異 | 殺掉 | 逾時 | 存活 | 等價 |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: |
| `src/core/sync.ts`（比對與反推） | `tests/core/sync.test.ts` | 828 | 770 | 10 | 0 | 48 |
| `src/core/sync.ts`（`syncFolder`、`syncBook`） | `tests/cli/sync.test.ts`、`tests/core/human.test.ts` | 118 | 117 | 0 | 0 | 1 |
| `src/core/human.ts` | 同上 | 31 | 31 | 0 | 0 | 0 |
| `src/core/preview.ts`（`translatedMarkdown`） | `tests/cli/preview.test.ts`、`tests/cli/sync.test.ts`、`tests/core/vault.test.ts` | 22 | 21 | 0 | 0 | 1 |
| `src/core/rename.ts`（S-16 略過人工譯文） | `tests/cli/entities.test.ts` | 14 | 14 | 0 | 0 | 0 |
| `src/core/report.ts`（覆蓋率與回收不了的一節） | `tests/core/report.test.ts`、`tests/cli/sync.test.ts` | 45 | 41 | 0 | 0 | 4 |
| `src/core/status.ts`（人工譯文的數量） | `tests/core/status.test.ts`、`tests/cli/sync.test.ts`、`tests/cli/batch.test.ts` | 13 | 13 | 0 | 0 | 0 |
| `src/core/vault.ts`（擋下與 `--force`） | `tests/cli/sync.test.ts`、`tests/cli/assemble.test.ts` | 28 | 27 | 0 | 0 | 1 |
| `src/core/verify.ts`（`AND u.human = 0`，手寫 2 個） | `tests/cli/sync.test.ts` | 2 | 2 | 0 | 0 | 0 |
| `src/core/request.ts`（`syncUnits` 之後套回，手寫 1 個） | `tests/cli/sync.test.ts` | 1 | 1 | 0 | 0 | 0 |

逾時的 10 個是迴圈不會結束的變異，算偵測到。第一輪存活 244 個、第二輪 100 個（含逾時），補了測試：多區塊配對每一個條件單獨不成立、差異的共同結尾、界線的記號、只蓋到一部分的區塊、做到沒有變化為止、八成與 4 個雙字組的邊界、加進去的字被自己的字隔開、整段帶空白、超過 2,000 個字元的增刪、沒有 frontmatter 的檔、接起兩行、表格的分隔線與只有標題列、人工譯文再改一次，殺掉其餘的。`flush` 裡一行一定會被覆蓋的重設（等價）刪掉了。

等價的 55 個：

* `sync.ts` 比對與反推的 48 個：
  * 24 個是一定存在的索引與一定比對到的正則群組的後備值（`?? ''`、`?? -1`、`chunk === undefined`）；第二行不存在時的後備值換成別的字也不是 `[!untranslated]`。
  * 4 個是 `<` 換成 `<=`：多讀到的位置是 `undefined`，不會等於字串。
  * 2 個是 Myers 的細節：先去掉頭尾相同的，`d = 0` 那一步一定沒有對角線；`'insert'` 換成空字串，`diffSequences` 照樣當成加入。
  * 3 個在 `borrowed`：累積的字串開頭換成 Stryker 的標記，只多出以它開頭的視窗；刪掉的字也切開加進去的字，但這裡的 Myers 在每一段差異裡都先刪後加（隨機 20 萬對確認過），刪掉的字不會夾在加進去的字中間。
  * 1 個是界線的記號換成空字串：仍然是一個不會跟任何字元相同的記號。
  * 1 個是比像不像時排除自己：自己的文字跟自己一樣，下一個條件也排除。
  * 1 個是段數不同時 `>` 換成 `>=`。
  * 3 個是跨區塊的欄方向比較：別的區塊一樣像或更像就不收的檢查已經涵蓋；兩個完全一樣的區塊在同一塊差異裡，列方向就不成立。
  * 1 個是上面說的 `flush` 的重設，已刪掉。
  * 3 個在 `candidateOf`：區塊照檔案的順序放進去，排序不改變順序；差異保持順序、一個區塊的段是連續的，範圍不會重疊。
  * 2 個是型別裡的 `true`、`false`，執行時不存在。
  * 3 個是行的種類的名字換成空字串：名字只跟彼此比，仍然不同。
* `syncFolder` 的 1 個：`edit.block_id` 一定是這個檔的區塊，`block === undefined` 不會成立。
* `preview.ts` 的 1 個：`translatedMarkdown` 只在譯文不是 null 時呼叫，`?? ''` 用不到。
* `report.ts` 的 4 個：前後的區塊是 null 時選的範本沒有那個欄位，欄位的值用不到。
* `vault.ts` 的 1 個：`readFileSync` 的 `'utf8'` 換成空字串會回傳 Buffer，同樣的位元組算出同樣的 SHA-256。

本機結果：`npm test` 78 個測試檔通過、1 個跳過，2,044 個測試通過、5 個跳過；`npm run spec` 384 個斷言都成立，也都看過失敗；`npm run typecheck` 通過；`npm run licenses` 299 個套件沒有違規。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| 比對與反推（`tests/core/sync.test.ts`） | 舊程式沒有 `sync.ts`；上面的單一變異都殺掉或列為等價；回歸表的 9 個反例在改規則前都寫到別的區塊 |
| 人工譯文（`tests/core/human.test.ts`） | 舊程式沒有 `human.ts`；單一變異都殺掉 |
| `tome sync` 與擋下會蓋掉它的地方（`tests/cli/sync.test.ts`） | 舊程式沒有 `sync` 指令，結束碼 2；`tome verify` 的條件與套回的那一行用手寫的變異拿掉後失敗 |
| 遷移（`tests/core/store.test.ts`） | 舊的 `book.db` 停在第 13 版、`series.db` 停在第 2 版，沒有 `unit.human`、`sync_change` 與 `human` |
| S-16（`tests/cli/entities.test.ts`） | `rename.ts` 改過的行的單一變異都殺掉，舊程式會替換人工譯文 |
| 報告、狀態與輸出（`tests/core/report.test.ts`、`tests/core/vault.test.ts`、`tests/cli/batch.test.ts`） | 舊程式沒有回收不了的一節與人工譯文的數量；單一變異殺掉或列為等價 |
