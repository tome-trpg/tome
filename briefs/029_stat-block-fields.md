---
status: active
date: 2026-11-08
type: feature
wave: 29
affectedFiles:
  - CHANGELOG.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - schemas/tome-pack-1.schema.json
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
  - schemas/tome-book-1.schema.json
  - schemas/tome-engine-1.schema.json
  - schemas/tome-ir-1.schema.json
  - schemas/tome-lang-1.schema.json
  - schemas/tome-overrides-1.schema.json
  - schemas/tome-probe-1.schema.json
  - schemas/tome-provider-1.schema.json
  - stryker.config.mjs
  - systems/**
---

# 029 — 數值塊欄位化與合成測試包

## Intent

這個回合結束時，規則包 `roles.yaml` 的 `fields` 是標籤的清單（每項是「語言 → 標籤」，跟詞條的 `source` 同一種寫法），段落區塊判到有 `fields` 的角色時，整個單位扣掉標籤、鎖定的實體卡、數字、佔位符與標點後一個字母都不剩，就在本機用詞條的譯名產生譯文、走跟模型回覆同一條驗證，不送 LLM；這些單位另外算數，不混進「原樣保留」。新的合成測試規則包 `tests/fixtures/packs/stat-fixture` 是虛構的遊戲系統，全部自己寫、登記在來源清單；`tome system test` 能驗欄位化，`tome system lint` 提醒沒有譯名的標籤。H-15 只在合成包上算數字，不當證據。

細節由維護者在 2026-11-08 選定（共用筆記 `brief-029-questions.md` 的 14 項：第 2 項選 (A)，命名 `stat-fixture` 與 `fields.ts`，其餘照建議），寫成 ADR-0121。

## Negative Scope

- 不做 `d100-orc` 與真書的 H-15 量測（M4）、表格的欄位化、部分欄位化、欄位結構的檢查。
- 不改 `generic`、不改任何提示、不改其他 schema。
- 不處理批次中改代名詞的問題（維護者併進 030）。
- 合成包只放自己寫的內容，不用任何商業書或特定遊戲的屬性名稱；不放 PDF。
- 不寫入維護者的工作區，不對真的 API 發請求，不在本機跑 Stryker。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。實作時冒出的新細節寫進共用筆記 `brief-029-details.md`。
- 寫給維護者的理由要先對照程式與 ADR 原文。
- 核心不放給人看的文字。
- 成熟度照實寫：合成包的數字不是 H-15 的證據。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [x] 本機單一變異的小工具對改過的函式跑過一輪，存活的補上測試或說明是等價變異

  270 個變異，沒有存活，10 個等價變異寫在 Measured。
- [ ] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑
- [ ] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] 訊息、`--json` 與紀錄都不含書本文字

  `tests/cli/fields.test.ts` 確認估價的輸出不含本機的譯文與名字，lint 的提醒不印標籤。

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0121（`amends: [ADR-0100, ADR-0051]`）
- [x] `fields` 改成標籤清單，schema 原地改，`sample-pack` 一起改
- [x] 整塊對得上的數值塊在本機產生譯文、走同一條驗證、不送 LLM，每次組請求重算
- [x] 欄位化的單位另外算數，不混進「原樣保留」
- [x] `tests/fixtures/packs/stat-fixture`：虛構的遊戲系統，每個檔案登記在 `SOURCES.yaml`
- [x] `tome system test` 的 `fielded`、`tome system lint` 的缺譯名提醒
- [x] 合成包上算出的整塊對上比例寫進 ADR-0121，寫明不是 H-15 的證據
- [x] 白皮書與 CHANGELOG 更新

  實作時多出的 16 項細節寫在共用筆記 `brief-029-details.md`，維護者全部照建議選定（第 1 項欄位之間用全形空白與全形標點），寫進 ADR-0121。

## Measured

2026-11-08（UTC），Windows 參考機器。

**合成包上的數字**（不是 H-15 的證據）：`stat-fixture` 的 8 個測試案例，判到數值塊的 7 個，整塊對上、在本機翻好的 4 個；另外 3 個是故意設計成要送 LLM 的。CLI 測試的合成書 3 個單位，欄位化 1 個、送出 2 個。真書沒有量。

**本機單一變異的小工具**（不是 Stryker）：用 `@babel/parser` 對改過的行產生變異，一次套一個到複本，只跑對應的測試檔，不吃滿 CPU。

| 檔案 | 變異 | 殺掉 | 存活 | 等價 |
| :--- | ---: | ---: | ---: | ---: |
| `src/core/fields.ts` | 148 | 143 | 0 | 5 |
| `src/core/units.ts`（寫進 `book.db` 的部分） | 52 | 52 | 0 | 0 |
| `src/core/pack-test.ts`、`src/core/pack-lint.ts`（`fielded` 與缺譯名提醒） | 70 | 65 | 0 | 5 |

第一輪存活 48 個：多數補了測試（粗體標籤的空白、兩邊是數字的分號與句點、句首的空白、只有名字的段落、批次中與模型翻好的單位的 `<pc>` 位置、沒寫 `fielded` 的案例、第一個來源語言不是英文的規則包、多語言的標籤），4 個來自程式裡 3 處多餘的判斷，改寫掉了；`testPack` 原本的比對與角色檢查 18 個，第一輪只跑了欄位化的測試，改跑 `tests/core/pack.test.ts` 與 `tests/cli/system.test.ts` 都殺掉。剩下的 10 個是等價變異：

* `fields.ts`：數字判斷的兩個備用字串（`?? ''` 換成任何不含數字的字都一樣）；`<new-term>`、`<flag>` 不會出現在遮蔽後的文字裡；片段的 `id` 沒有用到；不需要 LLM 的單位沒有字母、換不到詞。
* `pack-test.ts`：沒有 `fielded` 案例時提早回傳（不回傳也是空的）；規則包一定有來源語言（schema 要求），`'en'` 的備用值走不到；沒判到角色時的 `'paragraph'` 換成什麼都沒有欄位；遮蔽的逾時在前面跑全部模式時已經先回傳，走不到。

本機結果：`npm test` 70 個測試檔通過、1 個跳過，1,782 個測試通過、5 個跳過；`npm run spec` 336 個斷言都成立，也都看過失敗；`npm run licenses` 299 個套件沒有違規。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| 欄位化（`tests/core/fields.test.ts`）、寫進 `book.db`（`tests/core/units.test.ts`） | 舊程式沒有 `fields.ts`、沒有 `fielded` 欄；上面的單一變異都殺掉 |
| `fields` 的 schema（`tests/core/schema.test.ts`） | 舊的 schema 只收名稱，新的四個拒絕案例在舊 schema 下有的會通過 |
| 遷移第 11 版（`tests/core/store.test.ts`） | 舊程式的版本是 10 |
| CLI（`tests/cli/fields.test.ts`） | 舊程式會把數值塊送出、沒有 `units.fielded`、`tome system test` 不認得 `fielded` |
