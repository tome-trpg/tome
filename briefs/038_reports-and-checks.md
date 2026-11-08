---
status: active
date: 2026-11-08
type: feature
wave: 38
affectedFiles:
  - CHANGELOG.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - languages/target/zh-TW.yaml
  - schemas/tome-lang-1.schema.json
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
  - languages/source/**
  - package-lock.json
  - package.json
  - prompts/**
  - providers/**
  - schemas/tome-book-1.schema.json
  - schemas/tome-engine-1.schema.json
  - schemas/tome-ir-1.schema.json
  - schemas/tome-overrides-1.schema.json
  - schemas/tome-pack-1.schema.json
  - schemas/tome-probe-1.schema.json
  - schemas/tome-provider-1.schema.json
  - stryker.config.mjs
  - systems/**
---

# 038 — 報告與檢查

## Intent

這個回合結束時，`tome assemble` 每次都在 vault 寫 `00-交付報告.md`：覆蓋率與花費（含估價誤差）、沒翻成的單位、沒翻的頁面與圖片、不可譯旗標、只報告的檢查、全書一致性，每筆連到章節裡的區塊；`tome report <book>` 只印各項的數字。驗證多兩項只報告的檢查：代名詞與實體卡不符、機翻腔訊號，例外詞與詞表是維護者在 2026-11-09 審過的語言資料。確認估價時記下金額（`estimate` 表，翻譯與 Pass 0 分開）。批次送出時記下翻譯記憶的鍵，收回時跟目前的鍵比對，送出後改了或新鎖定了實體卡的單位不存翻譯記憶、回到待翻。單書額外模式另開 039。

細節由維護者在 2026-11-09 選定（共用筆記 `brief-038-questions.md`：第 1 項拆成 039，第 5 項開始存估價，第 9、12 項照草稿接上，第 13 項送出時記鍵，第 14 項不清，其餘照建議），寫成 ADR-0123。

## Negative Scope

- 不做單書額外模式（039）、`tome sync` 與它的報告項目（031）、抽圖、一致性的自動修正、活躍實體的代名詞檢查、年代與基調。
- 不改提示、來源語言設定檔與其他 schema；`state.ts`、`memory.ts` 預計不動。
- 交付報告有書本文字，只寫在 vault：測試只用合成的 document，量測寫到暫存資料夾、只印數字、跑完刪掉；`tome report`、訊息、`--json` 與紀錄只印數字。
- 不寫入維護者的工作區，不對真的 API 發請求。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。實作時冒出的新細節寫進共用筆記 `brief-038-details.md`。
- 語言資料（代名詞例外詞、機翻腔詞表）只能照維護者審過的草稿寫，要改先問。
- 寫給維護者的理由要先對照程式與 ADR 原文。
- 核心不放給人看的文字：報告的固定文字放訊息檔。
- 成熟度照實寫：詞表的誤報率沒有量過，只印命中次數。
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

- [x] 維護者的決定寫成 ADR-0123（`amends: [ADR-0122]`，拆出 039），語言資料寫明審過的日期
- [x] `00-交付報告.md`：各節照白皮書 §5.6，連到章節的區塊，`BLOCKED` 不放原文
- [x] `tome report <book>` 只印數字，不拿書的鎖、不寫檔
- [x] 一致性：同一個原文多種譯名、鎖定的譯名沒用上
- [x] 代名詞與實體卡不符、機翻腔訊號（只報告），例外詞與 36 列詞表照草稿
- [x] `estimate` 表（遷移第 13 版）與報告裡的估價誤差
- [x] 批次送出時記鍵、收回時比對，鍵不同不存翻譯記憶、回到待翻
- [x] `book1` 複本的量測寫進 ADR-0123，只有數字（詞表每一列的命中次數）
- [x] 白皮書與 CHANGELOG 更新

## Measured

2026-11-09（UTC+8），Windows 參考機器。

**`book1` 複本**（ADR-0115 的書 8）：複製 `document.json` 與 `book.db` 到暫存資料夾產生交付報告的資料，不寫檔、不讀 PDF，只印數字，跑完刪掉複本。未翻譯的單位 9 個、未翻譯的頁面 0、圖片 136、不可譯標記 2、疑似大陸用語 134、多出數字 51、長度過長 0、一致性的多種譯名 6 個；沒有鎖定的卡，代名詞不符與鎖定譯名沒用上量不到；產生報告 17 毫秒。機翻腔每一列命中的單位數（2,551 個翻好的單位）：第 33 列 8、第 35 列 7、第 30 列 6、第 36 列 4，第 19、21、25、29 列各 2，第 7、24、26 列各 1，其他 25 列 0，合計 37；沒看命中的句子。

**本機單一變異的小工具**（不是 Stryker）：用 `@babel/parser` 對改過的行產生變異，一次套一個到複本，只跑對應的測試檔，不吃滿 CPU。

| 檔案 | 變異 | 殺掉 | 逾時 | 存活 | 等價 |
| :--- | ---: | ---: | ---: | ---: | ---: |
| `src/core/verify.ts`（代名詞與機翻腔） | 64 | 61 | 2 | 0 | 1 |
| `src/core/report.ts`（收集與排版） | 315 | 311 | 0 | 0 | 4 |
| `src/core/report.ts`（`tome report`）、`ledger.ts`、`request.ts`（記估價） | 30 | 30 | 0 | 0 | 0 |
| `src/core/vault.ts`（交付報告與錨點） | 18 | 18 | 0 | 0 | 0 |
| `src/core/batch.ts`、`translate.ts`（批次的鍵） | 37 | 35 | 2 | 0 | 0 |
| `src/core/scan.ts`（記 Pass 0 的估價） | 2 | 2 | 0 | 0 | 0 |

逾時的 4 個都是迴圈停不下來（成對寫法的 `indexOf` 位移、`replied` 裡跳過重設），算抓到。第一輪存活 74 個：多數補了測試（交付報告的全文、一致性的兩半各自是空的、不是物件或不是文字的 `detail`、缺原文或缺譯名的新詞、提議與鎖定的卡、`failed` 的卡、每段譯文都用上的鎖定卡、`REFUSED` 的單位、只有圖片的頁、成對寫法在譯文開頭與沒有後半、在章節裡但沒有東西可寫的區塊、訊息的等級、`tome report` 的預算與花費、寬度是 0 的估價、即時模式的 `--json`）；`batch.ts` 原有的兩行用 `tests/cli/batch.test.ts` 殺掉。改了 1 處程式：未翻譯的單位的重送原因原本依區塊記，同一個表格的兩個 `FAILED_QA` 格子會拿到彼此的原因，改成依單位記。

等價的 5 個：

* `verify.ts`：`end < 0` 換成 `<= 0`，後半一定在前半之後，`end` 不會是 0。
* `report.ts`：`detail` 是 NULL 時提早回傳（不回傳時 `JSON.parse(null)` 是 null，下一行一樣回傳空的）；只看 `new_term` 的判斷（其他問題代碼的 `detail` 沒有同時有原文與譯名的）；翻好的單位才會到的 `translation ?? ''`；覆蓋率的數字轉文字（`fill` 填進去時一樣變成文字）。

本機結果：`npm test` 74 個測試檔通過、1 個跳過，1,873 個測試通過、5 個跳過；`npm run spec` 361 個斷言都成立，也都看過失敗；`npm run typecheck` 通過；`npm run licenses` 299 個套件沒有違規。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| 交付報告（`tests/core/report.test.ts`）、`tome report`（`tests/cli/report.test.ts`） | 舊程式沒有 `report.ts` 與 `tome report`；上面的單一變異都殺掉或列為等價 |
| 代名詞與機翻腔（`tests/core/verify.test.ts`） | 舊程式沒有這兩項，測試期待的 `pronoun_mismatch`、`translationese` 不會出現 |
| 批次的鍵（`tests/cli/entities.test.ts`） | 舊程式收回時照樣驗證通過、存進翻譯記憶，單位會是 `DONE` |
| 估價（`tests/cli/report.test.ts`、`tests/cli/scan.test.ts`） | 舊程式沒有 `estimate` 表 |
| 遷移第 13 版（`tests/core/store.test.ts`） | 舊程式的版本是 12 |
| 交付報告與錨點（`tests/core/vault.test.ts`） | 舊程式不寫 `00-交付報告.md`，區塊也沒有錨點 |
