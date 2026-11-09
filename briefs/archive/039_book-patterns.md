---
status: archived
date: 2026-11-09
type: feature
wave: 39
affectedFiles:
  - CHANGELOG.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - schemas/tome-book-1.schema.json
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
  - schemas/tome-engine-1.schema.json
  - schemas/tome-ir-1.schema.json
  - schemas/tome-lang-1.schema.json
  - schemas/tome-overrides-1.schema.json
  - schemas/tome-pack-1.schema.json
  - schemas/tome-probe-1.schema.json
  - schemas/tome-provider-1.schema.json
  - stryker.config.mjs
  - systems/**
integrity: sha256-dd77360347f89981cde9c7065a854c4f177c618df1c97ba134c070bd9ad6d76b
---

<!-- spec-brief:banner -->
> **Archived 2026-11-09.**
> Merged in pull request [#73](https://github.com/tome-trpg/tome/pull/73).
> Recorded at commit `b9aee8b`: 17 files changed, +641 −11.
> The body below describes the tree before execution and is not maintained.
<!-- /spec-brief:banner -->

# 039 — 單書額外模式

## Intent

這個回合結束時，`book.yaml` 可以寫選填的 `patterns`：跟規則包的 `syntax_patterns.yaml` 同一種寫法，`use` 必填、只能是 `mask`。`tome estimate` 與 `tome translate` 組單位時把書的模式併進規則包的：同一個 `id` 時書的蓋過規則包的，其他的排在規則包的前面，重疊時書的優先。組單位前先編譯、查重複的 `id` 與靜態的回溯風險，編不過或重複就停（`book.bad_pattern`），有風險只警告；執行時照舊在 worker 裡限時。有額外模式時多印一行數量。估價的指紋不另加書的模式的雜湊，因為指紋已經含每個單位遮蔽後的文字（更正 038 問題清單第 16 項）。年代、基調、偵測模式與停用規則包的模式都不做。

細節由維護者在 2026-11-09 選定（共用筆記 `brief-039-questions.md`：第 2 項 `use` 必填、只能是 `mask`，第 3 項書的優先，第 4 項 039 不做停用，其餘照建議）；實作時的細節 10 項（`brief-039-details.md`）維護者也在同一天全部照建議選定。都寫成 ADR-0124。

## Negative Scope

- 不做偵測模式、停用規則包的模式、年代與基調、實體類別的預設代名詞、`tome book lint`、保留 `book.yaml` 註解的寫回。
- 不改 `mask.ts`、`verify.ts` 與其他變異測試模組，不改提示、語言設定檔與其他 schema。
- `tome extract`、`tome system test`、`tome system lint` 照舊只看規則包。
- 測試只用合成的模式與文字；這個回合不量真書。
- 不寫入維護者的工作區，不對真的 API 發請求。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。實作時冒出的新細節寫進共用筆記 `brief-039-details.md`。
- 寫給維護者的理由要先對照程式與 ADR 原文。
- 核心不放給人看的文字：訊息放訊息檔。
- 訊息、`--json` 與紀錄只印模式的 `id` 與數量，不印正規表示式與書本文字。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [x] 本機單一變異的小工具對改過的函式跑過一輪，存活的補上測試或說明是等價變異
- [x] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] 訊息、`--json` 與紀錄都不含正規表示式、書本文字與個別檔案的路徑

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0124，寫明更正 038 問題清單第 16 項（指紋不另加雜湊）
- [x] `tome-book/1` 原地加 `patterns`：`use` 必填、只能是 `mask`，`id` 與 `kind` 用規則包的名稱規則，`flags` 只能 `i`、`m`、`s`
- [x] 合併：同一個 `id` 時書的蓋過規則包的，其他的排在前面，重疊時書的優先
- [x] 組單位前編譯與查重複的 `id`（`book.bad_pattern`，結束碼 1），靜態回溯風險只警告
- [x] 有額外模式時 `tome estimate` 與 `tome translate` 印數量，`--json` 有 `book_patterns`
- [x] 文件寫明用同一個 `id` 蓋過規則包的模式，以及寫回 `book.yaml` 時註解不會留
- [x] 白皮書與 CHANGELOG 更新

## Measured

2026-11-09（UTC+8），Windows 參考機器。這個回合沒有量真書：書的模式要使用者自己寫，測試只用合成的模式與文字。

**本機單一變異的小工具**（不是 Stryker）：用 `@babel/parser` 對改過的行產生變異，一次套一個到複本，只跑對應的測試檔，不吃滿 CPU。

| 檔案 | 測試檔 | 變異 | 殺掉 | 逾時 | 存活 | 等價 |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: |
| `src/core/book-patterns.ts`（查核與合併） | `tests/core/book-patterns.test.ts` | 24 | 24 | 0 | 0 | 0 |
| `src/core/pack-lint.ts`（`compiles`） | `tests/core/book-patterns.test.ts` | 5 | 5 | 0 | 0 | 0 |
| `src/core/request.ts`（`planBook` 的合併與檢查） | `tests/cli/estimate.test.ts` | 20 | 19 | 0 | 0 | 1 |

`translate.ts` 改的一行（`book_patterns` 放進回報）沒有產生變異，由 `tests/cli/translate.test.ts` 比對 0 與 1。第一輪存活 2 個：編不過的模式不再跑回溯檢查的 `continue`，補了一個編不過、看起來又有回溯風險的模式（`(a+)+(`）的測試後殺掉。

等價的 1 個：`planBook` 的 `if (packOnly === null)` 換成永遠不成立。`loadBookPack` 只在發現裡有 fail 時回傳 null，下一行查到 fail 一樣停下，回傳同樣的發現；這一行留著是為了讓型別收窄。

本機結果：`npm test` 75 個測試檔通過、1 個跳過，1,917 個測試通過、5 個跳過；`npm run spec` 370 個斷言都成立，也都看過失敗；`npm run typecheck` 通過；`npm run licenses` 299 個套件沒有違規。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| 查核與合併（`tests/core/book-patterns.test.ts`） | 舊程式沒有 `book-patterns.ts`；上面的單一變異都殺掉 |
| schema（`tests/core/schema.test.ts`） | 舊的 `tome-book/1` 不收 `patterns`，收下的案例會失敗 |
| 估價、試算與翻譯（`tests/cli/estimate.test.ts`、`tests/cli/translate.test.ts`） | 舊程式讀到有 `patterns` 的 `book.yaml` 就是 `config.bad_schema`，結束碼 2；`planBook` 改過的行的單一變異都殺掉或列為等價 |
