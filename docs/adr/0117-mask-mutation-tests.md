---
id: ADR-0117
status: accepted
date: 2026-11-08
depends-on: [ADR-0063, ADR-0110, ADR-0116]
---

# ADR-0117：遮蔽還原的變異測試補強

## 脈絡

回合 035（ADR-0116）在 `src/core/mask.ts` 加了 `<pc>` 的處理，PR 65 合併成 `6ecb0a3` 之後，Manager 在 `main` 手動觸發 `mutation.yml`（run 42444515055）。遮蔽還原從 ADR-0110 第二次實測的 97.30（111 個變異；第一次實測是 104 個、96.15）掉到 **87.31**：323 個變異，殺掉 261、逾時 21、存活 36、沒被測試涵蓋 5。同一次的其他模組：驗證 94.66、對外出口 85.94、狀態機 97.50、翻譯記憶 94.29、預算 100。都在門檻 80 之上（ADR-0110 第 9 項），但遮蔽還原掉了將近 10 分。

維護者看過後決定，在回合 027 之前先開一個只補測試的小回合 036。開工前的問題寫在共用筆記 `brief-036-questions.md`，5 項由 Manager 在 2026-11-08 照建議同意。

## 決定

1. 036 **只改測試**，不改 `src/**`。存活的變異如果揭露了程式的錯就停下回報；等價或走不到的變異不硬殺，數量與理由記在這裡。
2. 沒偵測到的 41 個變異（存活 36、沒涵蓋 5）逐一對照 `mask.ts`，**沒有一個揭露程式的錯**。分類如下，編號是 Stryker 報告裡的變異 ID：

   **補測試殺掉 28 個**（035 加的 26 個，加上 035 之前就存活的 2 個）：

   | 位置 | 變異 | 個數 | 補的測試 |
   | :--- | :--- | ---: | :--- |
   | `sameLink` | 函式變空、條件換成 true 或 false、`&&` 換 `\|\|`、`===` 換 `!==`（48–53、56、57） | 8 | 整單位的連結：每段相同才提出來；頁不同、網址不同、一段有一段沒有時各自留在 `<pc>` |
   | `sharedStyle` | 共同標記不過濾、選擇性串接拿掉、`every` 換 `some`、比較函式變空、連結的條件與物件（75、77、81、84、86、87、89、91、92） | 9 | 第一段的標記其他段沒有、某段只有連結沒有標記、三段裡一段連結不同、只有一段連結從頭蓋到尾 |
   | `residual` | 沒有標記的段的 `[]` 換成字串（96） | 1 | 同上，只有連結的段 |
   | `shrink` | `range.start >= to` 換 false、`range.end <= to` 換 `<`、`range.start <= from` 換 true（117、127、129） | 3 | `<ph>` 在樣式之後、`<ph>` 剛好在樣式的結尾、`<ph>` 蓋到樣式的尾巴但前面還有字 |
   | `planFormats` | 「縮完還有字母數字」換 true、`> 0` 換 `>= 0`（171、172） | 2 | 縮完只剩標點的範圍不送 `<pc>` |
   | `restoreSegments` | 排序拿掉、比較函式變空、`-` 換 `+`（263–265） | 3 | 譯文裡 `<pc>` 的順序跟原文相反 |
   | 035 之前就有 | 錯誤訊息換成空字串（247）、`isWholeWord` 的 `Math.max` 換 `Math.min`（299） | 2 | 檢查錯誤訊息；詞條前面只有一個字母 |

   **等價或走不到的 13 個**（035 加的 12 個，加上 035 之前就有的 1 個）：

   * `sharedStyle` 的「連結是 undefined」換 false（90）：`styleOf` 會拿掉 undefined 的連結，結果一樣。
   * `shrink` 的 `range.start >= to` 換 `>`、`range.end <= from` 換 `<`、`range.start <= from` 換 `<`、`range.end >= to` 換 `>`（115、118、131、135）：邊界剛好相等時，兩種寫法算出同一個範圍，或範圍都被整個蓋住而變空。
   * `trimmed` 的 `?? ''` 換成字串（145、154，沒涵蓋）：`from < to` 時索引一定在文字裡，走不到；換成的字串也不是空白。
   * `planFormats` 的兩個 `return []` 換成 `["Stryker was here"]`（164、176）：`mergeRuns` 會先濾掉沒有起訖的項目。
   * `maskText` 排序的 `left.order - right.order` 換 `+`（205）：陣列排序是穩定的，切點本來就依「先關、再開、`<ph>` 最後」的順序放進去，同一個位置的先後不靠這個比較。
   * `unitRuns` 對不到樣式的編號（281 條件換 false、283 沒涵蓋）：沒有樣式的範圍不加標記，攤平後一樣。036 補了一個測試涵蓋這條路，283 由沒涵蓋變成存活。
   * `foldCase` 的 `toLowerCase` 換 `toUpperCase`（288，035 之前就有）：原文與詞條兩邊用同一個函式，只有長 s（`ſ`）這類罕見字元結果不同。
3. 本機確認的方式：一支 Node 小工具（放 scratchpad，不進 repo）把 worktree 的 `src`、`tests` 與設定複製到暫存資料夾，`node_modules` 用目錄連結，一次套一個變異到複本的 `mask.ts`，只跑 `tests/core/mask.test.ts`，結束碼不是 0 就算殺掉，跑完刪掉複本。它不是 Stryker，每個變異約 1.3 秒。新測試加上去之前 41 個都存活，加上去之後殺掉 28 個、存活 13 個，存活的就是上面的等價清單。正式的分數用 `workflow_dispatch` 在回合分支上跑 `mutation.yml`。

   2026-11-12 由 ADR-0132 第 8 項修改：本機不再跑變異測試，這支小工具也不跑；六個關鍵模組照樣在回合分支上跑 `mutation.yml`，其他改過的行用 `mutation-lines.yml`。
4. 預估分數：Stryker 把逾時算成偵測到，(261 + 21 + 28) / 323 = **95.98**。
5. **CI 實測**：2026-11-08，`182e930`，用 `workflow_dispatch` 在回合分支上跑 `mutation.yml`（run 42447828630），條件跟 ADR-0110 的實測相同。分數是下載各 job 的 JSON 報告算的：

   | 模組 | 分數 | 變異數 | 殺掉 | 逾時 | 存活 | 沒被測試涵蓋 | job 時間 |
   | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
   | 遮蔽還原 | **95.67** | 323 | 292 | 17 | 12 | 2 | 15.4 分 |
   | 預算 | 100.00 | 9 | 9 | 0 | 0 | 0 | 3.7 分 |
   | 狀態機 | 97.50 | 40 | 36 | 3 | 1 | 0 | 8.2 分 |
   | 翻譯記憶 | 94.29 | 35 | 29 | 4 | 2 | 0 | 6.9 分 |
   | 驗證 | 94.66 | 356 | 323 | 14 | 16 | 3 | 28.4 分 |
   | 對外出口 | 85.94 | 256 | 184 | 36 | 34 | 2 | 28.5 分 |

   * 遮蔽還原比預估少 0.31：28 個都殺掉了，沒偵測到的 14 個是上面的 13 個，加上 169 號。169 號是 `planFormats` 的 `end > start` 換 `>=`，相等時字母數字一定是 0，條件照樣不成立，是等價的；在 run 42444515055 裡它逾時，算成偵測到，這次存活。另有 3 個由逾時變成殺掉（101、165、167）。逾時會隨 runner 的時間變動（ADR-0110）。
   * 其他 5 個模組的分數與 run 42444515055 相同；對外出口的三個檔案是 `anthropic.ts` 76.19、`client.ts` 94.12、`gate.ts` 96.20。

## 驗證

<!-- @assert-count target="tests/core/mask.test.ts" symbol="gives the whole unit a link only when every run has the same one" expected="1" reason="第 2 項：sameLink 與 sharedStyle 的連結" -->
<!-- @assert-count target="tests/core/mask.test.ts" symbol="keeps only the marks every run has, and copes with a run that has none" expected="1" reason="第 2 項：sharedStyle 的標記與只有連結的段" -->
<!-- @assert-count target="tests/core/mask.test.ts" symbol="cuts the <pc> before a placeholder that sticks out past its end" expected="1" reason="第 2 項：shrink" -->
<!-- @assert-count target="tests/core/mask.test.ts" symbol="lists the <pc> offsets by id, whatever order the translation put them in" expected="1" reason="第 2 項：restoreSegments 的排序" -->

## 後果

遮蔽還原的分數回到 95.67，`<pc>` 的行為都有測試釘住：整單位的樣式怎麼提出來、`<pc>` 碰到 `<ph>` 時怎麼縮、譯文裡的位置依編號排。剩下 14 個等價或走不到的變異，分數不會到 100；以後改 `mask.ts` 時，若拿掉走不到的 `?? ''` 或排序裡多餘的比較，等價變異會跟著少。

## 替代方案

否決了下列做法：

* **順便改程式消掉等價變異**：這個回合不改 `src/**`，等價變異不影響行為。
* **硬殺等價變異**（例如用私有函式的測試）：測的是寫法，不是行為。
* **不在本機確認，直接靠 CI 的 mutation**：一次約 25 分鐘，沒殺到的要再推一次。
* **在本機跑 Stryker**：不在維護者的電腦上跑長時間的工作（ADR-0110）。
* **結果補在 ADR-0116 後面**：ADR-0116 已經合併，不改寫歷史。

## Open Questions

- [ ] 13 個等價變異裡走不到的程式（`trimmed` 的 `?? ''`、`maskText` 排序的 `order`），下次因為別的原因改 `mask.ts` 時一起看要不要拿掉（第 2 項）。
