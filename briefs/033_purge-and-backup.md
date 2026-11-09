---
status: active
date: 2026-11-09
type: feature
wave: 43
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

# 033 — tome purge 與 tome backup

## Intent

這個回合結束時，`tome purge <書>` 先列出要刪的東西並記下指紋（結束碼 0），`--confirm` 時清單跟上次列的相同才刪：`books/<slug>/`、系列記憶裡這本書的項目（沒有別的書時刪整個系列資料夾）、加 `--vault` 時 vault 裡 TOME 寫的檔與因此變空的資料夾。還有沒收回或沒取消的批次時不刪；已收回、遠端刪除失敗的批次先在遠端刪掉，有一筆刪不掉就整個不刪。`tome backup <書>` 把兩個資料庫（一致的複本）、`book.yaml`、`overrides.yaml`、document 層與探測結果照工作區的目錄排進一個新資料夾，附 `manifest.json`，不含 PDF、source 層、vault、`tome.yaml` 與金鑰。

細節由維護者在 2026-11-09 選定（共用筆記 `brief-033-questions.md`：第 3 項兩步確認，第 4 項清乾淨才刪，第 5 項只刪 TOME 寫的檔，第 7 項資料庫加 document 層，其餘照建議），寫成 ADR-0128。

## Negative Scope

- 不做還原指令、不刪整個工作區、引擎、金鑰、PDF 與備份。
- 不動 TOME 沒寫過的 vault 檔案。
- 不加遷移、不加相依；不動變異測試的模組。
- 測試只在暫存的合成工作區跑，遠端刪除用假的供應商；不在維護者的工作區、書、vault 與 `C:\Repos\tome-books` 上跑任何刪除。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。實作時冒出的新細節寫進共用筆記 `brief-033-details.md`。
- 寫給維護者的理由要先對照程式與 ADR 原文。
- 核心不放給人看的文字：訊息放訊息檔。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [x] 本機單一變異的小工具對改過的行跑過一輪，存活的補上測試或說明是等價變異
- [x] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] 訊息、`--json` 與紀錄都不含書本文字

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0128（`amends: [ADR-0058, ADR-0113]`），結掉 ADR-0104 的外送紀錄保留期
- [x] `tome purge <書>` 兩步確認，刪書的資料夾與系列記憶，`--vault` 只刪 TOME 寫的檔
- [x] 還有沒收回或沒取消的批次時不刪；遠端殘留先刪，刪不掉就整個不刪；沒有殘留時不連網
- [x] `tome backup <書>` 照工作區的目錄排出資料庫的一致複本、設定與 document 層，附 `manifest.json`
- [x] 白皮書與 CHANGELOG 更新

## Measured

2026-11-09（UTC+8），Windows 參考機器。測試只在暫存的合成工作區跑（`library()`），遠端刪除用假的供應商；沒有在維護者的工作區、書、vault 與 `C:\Repos\tome-books` 上跑任何刪除，也沒有對真的 API 發請求。

**本機單一變異的小工具**（不是 Stryker）：用 `@babel/parser` 對改過的行產生變異，一次套一個到複本，只跑對應的測試檔（`purge.ts` 跑 `tests/cli/purge.test.ts`，`backup.ts` 跑 `tests/cli/backup.test.ts`，CLI 的兩個指令兩個都跑）。`findings.ts`、`errors.ts` 只加代碼，`workspace.ts` 只改型別，沒有產生變異。

| 檔案 | 變異 | 殺掉 | 逾時 | 存活 | 等價 |
| :--- | ---: | ---: | ---: | ---: | ---: |
| `src/core/purge.ts` | 166 | 161 | 3 | 0 | 2 |
| `src/core/backup.ts` | 63 | 63 | 0 | 0 | 0 |
| `src/cli/run.ts`（`purge` 與 `backup` 兩個指令） | 31 | 31 | 0 | 0 | 0 |

第一輪（`purge.ts` 170 個、`backup.ts` 66 個、CLI 32 個）存活 23 個。補的測試：清單的指紋存在 `stage` 表的 `purge-list`；系列資料夾在、資料庫不在時列清單不建立資料庫；刪空資料夾要先刪下層（`deep/a.md` 排在 `deep/er/` 前面）；TOME 沒寫過檔時原本就空的 vault 資料夾不刪；兩個指令沒給書名；建不了的目的地（名稱太長）不說成「已經存在」；遠端刪除失敗時的退避用轉接層給的等待。拿掉的寫法（變異改了也一樣的）：遠端殘留的列不再轉成字串陣列；vault 的檔直接雜湊位元組（`tome assemble` 寫的是 UTF-8，結果相同）；一定存在的資料夾刪除時不加 `force`（系列資料夾、書的資料夾、寫到一半的備份）；`manifest.json` 寫在剛建立的資料夾，不加 `wx`；`pathFindings` 的平台跟 `inspectPath` 一樣預設這台機器，CLI 不再寫 `io.platform ?? process.platform`。寫到一半的備份刪不乾淨（`recursive: false`）那個變異，工具報存活的其實是同一行的 `force`；手動套上 `recursive: false` 時測試失敗。

逾時的 3 個算抓到：一個是遠端刪除失敗時改用真的等待，重試的退避超過工具的 30 秒；兩個是刪空資料夾時往上找上層的迴圈條件，改了就停不下來。

等價的 2 個：刪 vault 裡 TOME 寫的檔時的 `force: true`（改成 `{}` 或 `false`）。那個檔是同一個指令剛列出來、確定在的，只有列出之後到刪除之前被別的程式刪掉時才不同；留著，這種時候照樣刪完其他的。

本機結果：`npm test` 81 個測試檔通過、1 個跳過，2,104 個測試通過、5 個跳過；`npm run spec` 414 個斷言都成立，也都看過失敗；`npm run typecheck` 通過；`npm run licenses` 299 個套件沒有違規。

| 測試 | 怎麼確認會失敗 |
| :--- | :--- |
| `tome purge`（`tests/cli/purge.test.ts`）、`tome backup`（`tests/cli/backup.test.ts`） | main（06a4559）沒有這兩個指令，回 `cli.unknown_command`；上面的單一變異都殺掉或列為等價 |
| 清單變了不刪 | 「沒加 `--confirm` 或指紋不同就重新列出」那個條件的變異都被殺掉：沒列過、多了人工譯文、加不加 `--vault`、vault 的檔被改過、翻好的單位數變了，各有一步 |
| 遠端刪不掉就整個不刪 | `removed.left > 0` 的變異被殺掉：假供應商刪除回 500 時本機的書還在、遠端的批次沒刪 |
| 只刪 TOME 寫的檔 | vault 測試放了使用者的檔、使用者的子資料夾、原本就空的資料夾與 TOME 寫在子資料夾裡的檔；刪檔與刪空資料夾那幾行的變異都被殺掉或逾時，只剩上面的 2 個等價 |
| 備份寫到一半失敗時刪掉目的地 | 手動把清除改成 `recursive: false`，測試失敗（目的地還在） |
