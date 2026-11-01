---
id: ADR-0101
status: accepted
date: 2026-11-02
depends-on: [ADR-0059, ADR-0090, ADR-0091]
amends: [ADR-0085]
---

# ADR-0101：回報引擎的結束狀態

## 脈絡

`docling (windows-2025)` 有間歇失敗，36 次裡原因不明的有 3 次，最近一次的 findings 是 `extract.pages_failed`，兩頁都是 `engine_crashed`。轉接器接住了每頁的例外，所以是行程層級的崩潰，而回報裡沒有結束碼，查不下去。ADR-0085 第 5 項寫失敗只回報頁碼與原因代碼。

下列決定都由維護者在 2026-11-02 選定，要先補結束碼再開 016。

## 決定

1. 修改 ADR-0085 第 5 項：失敗回報頁碼、原因代碼與引擎的結束狀態。stderr 仍然不存也不印。結束狀態不含書本文字。
2. `extract.pages_failed` 加參數 `exit`，值是 `引擎名:結束狀態`，有多個引擎時用逗號隔開，只列有失敗頁的引擎。訊息顯示它，`--json` 的 `params` 看得到。
3. 結束狀態的寫法：

| 情況 | 值 |
| :--- | :--- |
| 結束碼 | `3`、`0` |
| 大於 `0xFFFF` 或負數 | 同時列十六進位，`3221225477 (0xC0000005)` |
| 訊號 | `signal SIGSEGV` |
| 逾時 | `timeout` |
| 找不到指令 | `not_found` |
| 沒有結束碼也沒有訊號 | `unknown` |

4. 正常結束但有頁失敗時照樣顯示，寫成 `docling:0`，不另開訊息代碼。
5. 原因代碼維持 ADR-0090 第 6 項，不新增。

## 驗證

<!-- @assert-count target="src/core/process.ts" symbol="export function describeExit" expected="1" reason="第 3 項：結束狀態的寫法集中一處" -->
<!-- @assert-count target="src/core/extract.ts" symbol="describeExit(" expected="1" reason="第 2 項：回報帶結束狀態" -->

## 後果

下次 Windows 間歇失敗時看得到結束碼，但結束碼只能分辨原生崩潰、記憶體不足這類大方向，看不到是哪一行。stderr 不保留的代價沒有變。`exit` 的值是英文代碼，跟 `pages` 的原因代碼一樣，給人看也給機器讀。

## 替代方案

**保留 stderr 的尾端**：無法保證不含書本文字；**新增 `native_crash` 這類原因代碼**：ADR-0090 的原因代碼描述 TOME 看到的情況，結束碼已經夠分辨；**結束碼 0 時不顯示 `exit`**：要另開一則訊息；**只在 Windows 列十六進位**：判斷條件變成依平台分支，數字本身就看得出來；都否決。
