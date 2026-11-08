---
status: active
date: 2026-11-08
type: feature
wave: 28
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

# 028 — 審定與詞庫

## Intent

這個回合結束時，`tome glossary review <book>` 會把要人審的實體卡寫成工作區裡的 `books/<slug>/glossary-review.yaml`，維護者改完再跑一次，`decision` 填了 `lock` 或 `reject` 的列就套用；出現次數乘類別權重未達 5、也沒有性別、代名詞、`keep_source` 的提議自動鎖定並記下是自動的；翻譯回報的 `<new-term>` 收進同一個佇列；027 沒拿到提議的詞由人填。`tome glossary import <book> <csv>` 把使用者自己的譯名直接鎖定。`entity` 多了 `locked`、`rejected`、`import`、`new_term` 與誰決定、何時決定、上一個譯名。翻譯還不用實體卡，那是 037；S-16 也移到 037。

細節由維護者在 2026-11-08 選定（共用筆記 `brief-028-questions.md` 的 16 項、答覆在 `brief-028-answers.md`），寫成 ADR-0119。

## Negative Scope

- 不做 S-16 與實體卡進翻譯（037）；028 只記下 `previous_target`。
- 不做 `tome glossary why`（不在 M3）、系列詞庫與跨書共用、審定檔裡連到 vault。
- 不改 Pass 0 的兩份提示與 `prompts/translate.md`，不改 schema 與語言設定檔。
- 不擋 `tome translate`；「還有要人審的詞時停下」是 032 的 `tome run` 關卡。
- 不放商業書的內容，測試只用合成的詞；審定檔裡的書本文字只留在工作區，訊息只印數量、列號與欄位名。
- 不寫入維護者的工作區，不對真的 API 發請求。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。實作時冒出的新細節寫進共用筆記 `brief-028-details.md`。
- 寫給維護者的理由要先對照程式與 ADR 原文。
- 核心不放給人看的文字：審定檔的說明與段落標題放訊息檔。
- 成熟度照實寫：分級審定的門檻是提案。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [x] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑

  `6864c57`、`3a98329`、Manager 審查後的修正 `8b5f78b`、`f76d287`、`e9ebdfa` 的 `specs`、`test` 在 Windows 與 Ubuntu 都是第一次跑就通過。
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示

  `e9ebdfa` 的 `CodeQL` 是 success、0 個 annotation，三個 `Analyze` 都在 attempt 1 通過。之前的四個 commit 各有一個 `Analyze` 在 init 下載 `codeql-bundle-v2.27.4` 時拿到 HTTP 504 而失敗，是基礎設施的錯，沒有掃描，**都沒有重跑**：`6864c57` 與 `8b5f78b` 是 `actions`，`3a98329` 與 `f76d287` 是 `javascript-typescript`；那四次的 `CodeQL` 都是 neutral、0 個 annotation。其餘 `Analyze` 工作的 notice 是 `ubuntu-latest` 要換成 Ubuntu 26 的執行環境通知。
- [x] 訊息、`--json` 與紀錄都不含書本文字

  `tests/cli/glossary.test.ts` 確認 `tome glossary review` 與 `import` 的輸出不含原文、譯名與上下文，填錯的值也不回顯。

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0119，記下 S-16 移到 037
- [x] `book.db` 遷移第 10 版：`decided_by`、`decided_at`、`previous_target`
- [x] `tome glossary review` 寫出與讀回審定檔，只套用填了 `decision` 的列，驗證人填的內容
- [x] 分級審定：要人審的條件，其餘自動鎖定並記下 `auto`
- [x] `<new-term>` 收進佇列，`failed` 的詞由人填，`skipped` 可以救回
- [x] `tome glossary import` 的 CSV，手寫解析，直接鎖定
- [x] `tome status` 多一行實體卡的數量
- [x] 白皮書與 CHANGELOG 更新

  實作時多出的 17 項細節寫在共用筆記 `brief-028-details.md`，維護者全部照建議選定，寫進 ADR-0119。第 8 項「有性別或代名詞」照字面算，是提案，等真的 Pass 0 再跟門檻一起調。

## Measured

2026-11-08（UTC），Windows 參考機器。

**候選詞的出現次數**：開工前在 `book1` 的 `document.json` 複本上用 ADR-0118 的規則挖詞，只印數字，跑完刪掉複本，沒有寫入維護者的工作區：744 個候選詞，出現 3 次以上 385 個、5 次以上 207 個、10 次以上 97 個、20 次以上 40 個，只出現 1 次 142 個。數字寫在 ADR-0119，是門檻 5 的參考。這本書沒有真的 Pass 0 提議，類別、性別與代名詞的分布量不到，所以實作後沒有再量；要人審的比例**沒有量測**。

本機結果：`npm test` 67 個測試檔通過、1 個跳過，1,688 個測試通過、5 個跳過（Manager 審查後的兩次修正之後）；`npm run spec` 311 個斷言都成立，也都看過失敗；`npm run licenses` 299 個套件沒有違規。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| 審定與匯入（`tests/cli/glossary.test.ts`） | 舊程式沒有 `tome glossary` 指令 |
| CSV 解析（`tests/core/csv.test.ts`） | 舊程式沒有 `csv.ts` |
| 分級審定的門檻 | `REVIEW_THRESHOLD` 改成 6，權重的兩個測試失敗，再改回來 |
| 上一個譯名 | 記 `previous_target` 的條件改成永遠不成立，1 個失敗，再改回來 |
| 有問題的列照人填的樣子寫回 | 改成一律用 `book.db` 的內容重寫，1 個失敗，再改回來 |
| 人改壞的卡不自動鎖定 | 拿掉這個條件，1 個失敗，再改回來 |
| 沒填 `decision` 的修改留在檔案裡、不自動鎖定 | Manager 審 PR 68 時找到的錯：修正前的程式 2 個失敗（改的譯名被 `book.db` 蓋掉；影響低於門檻時被自動鎖定）。修正後通過 |
| 沒改的列照舊從 `book.db` 重寫 | 正規化時空字串不當成空值，1 個失敗（換一種寫法的空值被當成有改），再改回來 |
| `CORE_ROLES` 跟 schema 的 `coreRole` 相同（`tests/core/schema.test.ts`） | 拿掉 `furniture`，1 個失敗，再改回來 |
| 跟上次寫進審定檔的內容比（`review_written`） | Manager 審 `8b5f78b` 時、維護者選的做法：修正前的程式 3 個失敗（遷移沒有這一欄；匯入的譯名沒出現在檔案裡；兩邊都改了沒有提醒）。修正後通過。拿掉「人沒動就照 `book.db` 重寫」，1 個失敗；不印提醒，1 個失敗；照人填的樣子寫回的列也記成上次寫出的內容，下一次就不再提醒，1 個失敗；都再改回來 |
| 遷移第 10 版（`tests/core/store.test.ts`） | 舊程式的版本是 9 |
