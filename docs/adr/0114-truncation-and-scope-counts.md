---
id: ADR-0114
status: accepted
date: 2026-11-08
depends-on: [ADR-0029, ADR-0034, ADR-0059, ADR-0068, ADR-0103, ADR-0107, ADR-0111, ADR-0112, ADR-0113]
amends: [ADR-0103, ADR-0111]
---

# ADR-0114：截斷、單位數上限與範圍內的數字

## 脈絡

ADR-0113 第 2、3 項把 M2 留下的問題排進 M3 的第一個回合 025：存回覆的 `stop_reason`、加每個請求的單位數上限，數字依 ADR-0112 的資料提案。同一個回合也處理 ADR-0112 的另外兩個 Open Question：範圍內與整本書的單位數說法，以及 `tome add` 收到多餘參數時的訊息。

ADR-0112 第 5 項說規則書有 497 個單位所在的請求「有回覆、有計費，回覆裡卻沒有它的段落」，因為 `book.db` 沒有存 `stop_reason`，無法確定是截斷還是漏段。其實不用 `stop_reason` 也分得出來：被截斷的回覆，輸出 token 會剛好等於請求的 `max_tokens`。

025 的執行 session 在 2026-11-08 唯讀維護者的兩個 `book.db`，腳本只印數字，沒有讀原文或譯文，Manager 驗算過：

* 每個請求的輸出 token 是 `ledger` 各列的合計。`ledger.ts` 依字元分攤時無條件捨去、最後一份拿餘數，合計等於原值。
* `max_tokens` 照 `src/core/request.ts` 當時的公式重算：預估輸出乘 `output_factor` 再取 2 倍，下限 1,024（ADR-0103 第 12 項）。Sonnet 5.5 沒有 `output_factor`，約等於原文字元的 0.8 倍。
* 單位的第 k 筆帳本就是第 k 次嘗試，兩次翻譯都沒有拒答。第 k 次有沒有段落看 `response` 有沒有 `attempt = k` 的列。

規則書計費的請求 207 個（含重送）：

| | 請求數 | 計費的單位次數 |
| :--- | ---: | ---: |
| 輸出 token 剛好等於 `max_tokens`，回覆裡 0 個段落 | 10 | 900 |
| 沒有截斷，少了 1 個段落 | 1 | 1 |
| 完整回覆 | 196 | 2,297 |

第一輪的 174 個請求裡有 4 個被截斷（120、63、161、152 個單位）。截斷後對半拆，8 個半份裡又有 6 個被截斷（60、31、81、80、76、76 個單位），拆成四分之一才翻完。被截斷兩次的 404 個單位，就是 ADR-0112 的「計費 3 次、只有 1 筆回應」；只截斷一次的兩個半份 92 個，加上少了段落的 1 個，就是「計費 2 次、只有 1 筆回應」的 93 個。公有領域那次 15 個請求，沒有截斷，也沒有少段落。

原因是每個單位的 `<s id="…">…</s>` 在輸出也要 token，`max_tokens` 只看原文字元。196 個完整回覆用最小平方法擬合，輸出 token 約是 0.377 × 原文字元 + 11.1 × 單位數；公有領域是 0.380 × 字元 + 16.5 × 單位數。每個單位 15 到 27 個字元的短格子，標籤比譯文還吃 token。161、152 個單位的請求都在第一輪：短格子到章節結束都還沒碰到 6,000 字元的上限。單位數上限單獨治不了，一個 31 個單位的請求也被截斷過，它的輸出比擬合值多 30% 以上。

成熟度：從帳本推算，不是 `stop_reason` 的原值；一本規則書、一篇小說、一個模型（Sonnet 5.5）、批次。

細節與每一項的依據寫在共用筆記 `brief-025-questions.md`，11 項由維護者在 2026-11-08 全部照建議選定。實作時又多了 8 項細節，寫在 `brief-025-details.md`。

## 決定

**截斷**

1. 推翻 ADR-0112 第 5 項的「無法確定是截斷還是漏段」：M2 規則書的重送是 `max_tokens` 截斷，不是漏段。ADR-0112 的 Open Question 1 由這份 ADR 結案。
2. 修改 ADR-0103 第 12 項：`max_tokens` 是預估輸出乘 `output_factor`，**加上每個單位 16 token**，再取 2 倍，下限 1,024。16 是 `src/core/request.ts` 的常數 `UNIT_OUTPUT_TOKENS`，是**提案**，取兩本書擬合值的較大者。
   * 用 16 重算，196 個完整回覆最多用到新上限的 69%，原本的公式最多 92%。10 個被截斷的請求，新上限是當時的 1.85 到 4.1 倍。
   * `max_tokens` 只是上限，計費看實際產生的 token，所以花費、估價與內容指紋都不變。估價的輸出同樣沒算標籤，這個回合不改（Open Questions）。
3. 修改 ADR-0103 第 10 項：每個請求除了約 6,000 字元，**最多 40 個單位**，是 `src/core/request.ts` 的常數 `REQUEST_UNITS`，是**提案**。
   * 同一組照舊不拆，一組超過 40 個單位時自成一個請求，跟字元上限一樣（ADR-0029 第 1 項）。規則書有 7 組超過 40 個單位，最大 230 個，那組在 M2 一次就翻完，輸出 7,652 token，上限 11,075。
   * 重送也用同一個上限，對半拆不變。
   * 第 2 項修好之後，上限的作用是限制出事時的範圍：截斷或拒答時，整個請求都要對半拆重送。用規則書第一輪的 174 個請求模擬，上限 40 多 17 個請求。擬合帳本的輸入 token，每個請求的固定開銷約 1,300 token，多出來的約 22,000 輸入 token，Sonnet 5.5 批次約 $0.02；M2 的重送花了 $0.1691。公有領域那次每個請求最多 17 個單位，不受影響。
   * 請求變多，估價會多一點。內容指紋不含請求的切法，已經確認過的估價不會失效，送出前照舊每批或每個請求檢查預算。
4. 修改 ADR-0103 第 17 項：`book.db` 的遷移第 7 版在 `ledger` 加 `stop_reason`（API 回的原值）與 `max_tokens`，同一個請求的每一列都一樣，舊的列是 NULL。
   * 存在 `ledger`，不存在 `response`：`response` 只有段落不是空的單位才有列，截斷時完全不存，最需要的截斷與漏段都記不到。`ledger` 是每個有回覆的請求都寫，含截斷與拒答，即時與批次走同一條路。
   * 即時模式存送出的 `max_tokens`。批次收回時用送出時的那些單位重算，送出後有單位離開計畫或狀態不再是 `IN_FLIGHT`，就存 NULL，不記可能錯的數字。送出的值沒有另外存。
   * `stop_reason` 是 API 的列舉值，不是書本文字（ADR-0059）。
   * `tome status` 與報告不顯示它的統計，只存下來。

**範圍內的數字**

5. 修改 ADR-0111 第 8 項：`tome translate`、`tome batch collect` 完成的訊息、翻譯中的進度與 `tome status` 的數字都是**範圍內**的，範圍是 `book.yaml` 的 `chapters`；沒設範圍時就是整本書，跟原本一樣。
   * 第一次翻譯時，估價的「要送出」加「不需翻譯」就等於完成訊息的「共」。ADR-0112 那次是 2,274 加 276 等於 2,550，原本的完成訊息寫的是整本書的 2,579。
   * `translate.done` 與 `status.units` 的文字不變。完成訊息只在範圍內有卡住的單位（`BLOCKED`、`FAILED_QA`、`REFUSED`）時是 fail，結束碼 1。
6. 設了範圍，而範圍外有狀態不是 `DONE` 的單位時，接著印 `scope.outside`（info）：「以上是 --chapters {chapters} 範圍內的數字。範圍外另有 {outside} 個翻譯單位尚未完成，要翻譯請以 tome estimate {book} --chapters <範圍> 調整範圍。」換過範圍之後，舊範圍留下的 `FAILED_QA` 也算在 `outside`。`--retry-failed` 照舊只重試範圍內的。
7. `tome status` 設了範圍時讀 `ir/document.json`，用 `planBook` 同一套 `chapterMap` 與 `parseChapters` 判斷章節，照舊不拿書的鎖。
   * 單位表的 `section` 存的是書籤標題的路徑，是書本文字，不能拿來判斷。回合 026 要改章節的判定（ADR-0113 第 7 項），每次從 `document.json` 算，就跟 `planBook` 一致，不用遷移資料庫。
   * `document.json` 不見了，照整本書算，不印 `scope.outside`。範圍跟現在的章數對不上時，跟 `tome estimate` 一樣回 `chapters.invalid`，結束碼 2。
   * 讀檔的時間沒有量過。
8. `--json` 的欄位：
   * `tome translate`、`tome batch collect`：`total`、`kept`、`done`、`blocked`、`failed`、`refused`、`left` 是範圍內的數字，新增 `outside`（沒設範圍時是 0）與 `chapters`（範圍字串，沒有套用時是 null）。
   * `tome status`：`units` 照舊是整本書各狀態的原值；`kept` 改成範圍內，跟訊息的數字相同；新增 `scope`，放訊息裡的數字：`chapters`、`total`、`kept`、`done`、`in_flight`、`blocked`、`failed`、`refused`、`left`、`outside`。
   * `tome-cli/1` 的外層不變（ADR-0082 第 11 項）。`total` 等欄位的意思改變，0.1.0 還沒發佈，寫進 CHANGELOG。

**多餘的參數**

9. 位置參數比指令接受的多時，不再回 `cli.bad_args`，改回兩個新代碼，結束碼照舊是 2，所有指令共用：
   * `cli.extra_arguments`：「{command} 只接受 {expected} 個參數，這次收到 {received} 個。路徑含有空格時，請用引號括住整個路徑。請以 tome --help 查看用法。」
   * `cli.no_arguments`：「{command} 不接受參數，這次收到 {received} 個。請以 tome --help 查看用法。」
   * `{command}` 是指令本身的字，帶 `tome` 前綴，例如 `tome add`，不是使用者打的值。
10. **不回顯**多出來的值，`--json` 也一樣。`tome provider auth set anthropic <金鑰>` 會讓金鑰成為多出來的參數（ADR-0034），PDF 的路徑也常含書名。`cli.bad_args` 的其他用法（選項缺值、`--dry-run` 配 `--retry-failed`）照舊。

**文件**

11. 白皮書 §5.6、§5.7、§8.1 裡「還沒有 LLM 呼叫」「沒有對真的 API 發過請求」這類過時的句子，照 ADR-0112 更新。即時模式確實還沒對真的 API 跑過，那一句不改。

## 驗證

<!-- @assert-count target="src/core/store.ts" symbol="ALTER TABLE ledger ADD COLUMN stop_reason TEXT;" expected="1" reason="第 4 項：帳本存 stop_reason" -->
<!-- @assert-count target="src/core/store.ts" symbol="ALTER TABLE ledger ADD COLUMN max_tokens INTEGER;" expected="1" reason="第 4 項：帳本存 max_tokens" -->
<!-- @assert-count target="src/core/translate.ts" symbol="stop_reason: result.stopReason," expected="1" reason="第 4 項：即時與批次都經過 charge 記進帳本" -->
<!-- @assert-count target="src/core/batch.ts" symbol="const limit = live.length === sent.sent ? maxTokens(plan.provider.profile, model, units) : null;" expected="1" reason="第 4 項：批次收回時重算，單位不全就存 NULL" -->
<!-- @assert-count target="src/core/request.ts" symbol="export const UNIT_OUTPUT_TOKENS = 16;" expected="1" reason="第 2 項：每個單位 16 token 的額度" -->
<!-- @assert-count target="src/core/request.ts" symbol="const expected = outputTokens(provider, model, charsOf(units)) + UNIT_OUTPUT_TOKENS * units.length;" expected="1" reason="第 2 項：額度加在取 2 倍之前" -->
<!-- @assert-count target="src/core/estimate.ts" symbol="return (sourceChars / chars_per_token) * output_ratio * (model.thinking.output_factor ?? 1);" expected="1" reason="第 2 項：估價不變" -->
<!-- @assert-count target="src/core/request.ts" symbol="export const REQUEST_UNITS = 40;" expected="1" reason="第 3 項：每個請求最多 40 個單位" -->
<!-- @assert-count target="src/core/request.ts" symbol="current.length + group.length > REQUEST_UNITS" expected="1" reason="第 3 項：整組移到下一個請求，同一組不拆" -->
<!-- @assert-count target="src/core/status.ts" symbol="outside: units.filter(({ inScope, state }) => !inScope && state !== 'DONE').length," expected="1" reason="第 6 項：範圍外沒完成的另算" -->
<!-- @assert-count target="src/core/translate.ts" symbol="...outsideFindings(run.slug, chapters, outside)," expected="1" reason="第 6 項：完成訊息後面說明範圍外" -->
<!-- @assert-count target="src/core/status.ts" symbol="...outsideFindings(slug, chapters, scoped.outside)," expected="1" reason="第 6 項：tome status 也說明範圍外" -->
<!-- @assert-count target="src/cli/run.ts" symbol="if (positionals.length > command.positionals) throw extraArguments(command, positionals.length);" expected="1" reason="第 9 項：多餘的參數有自己的代碼" -->
<!-- @assert-count target="src/cli/messages/zh-TW.json" symbol="路徑含有空格時，請用引號括住整個路徑。" expected="1" comments="include" reason="第 9 項：提醒路徑加引號" -->

## 後果

規則書的短格子不會再因為 `max_tokens` 被截斷，這是依兩本書的帳本推算的，要等下一次真實翻譯確認；之後的請求都會存 `stop_reason` 與 `max_tokens`，看得出每個請求離上限多近。請求數會多一點，規則書約多 10%，多出來的輸入花費約 $0.02。

完成訊息、進度與 `tome status` 跟估價用同一套範圍，範圍外沒送出的單位另一行說明。`tome status` 設了範圍時要多讀 `document.json`，大書會多花一點時間，沒有量過。翻譯在範圍外留著 `FAILED_QA` 的書，結束碼從 1 變成 0，範圍外的狀況要看 `scope.outside`。

多餘參數的訊息說得出收到幾個、只接受幾個，但不寫是哪幾個值，使用者要自己對照。

## 替代方案

否決了下列做法：

* **只加單位數上限、不改 `max_tokens`**：數字要壓到 30 以下，31 個單位的請求仍被截斷過，沒有保證。
* **`OUTPUT_ROOM` 從 2 提高**：短格子的請求仍可能不夠，長段落的請求卻放得太寬。
* **單位數上限 30、50、60**：30 多 24 個請求，50、60 出事時的範圍較大。40 個單位時，每個單位 26 字元以下的短格子擬合值最多約 930 token，就算沒有第 2 項也在 1,024 的下限內。
* **`stop_reason` 存在 `response`**：截斷時沒有列。**新開一張 `request` 表**：多一張表與白皮書的表格，查詢要多一次 join。
* **批次送出時在 `batch_unit` 存 `max_tokens`**：準確，但遷移要多改一張表；單位都還在時重算的值相同。
* **數字維持整本書，只把範圍外的從「尚未完成」拆出來**：範圍外已經完成的單位仍算在「共」裡，跟估價對不上。
* **單位表加 `chapter` 欄位**：不用讀 `document.json`，但 026 改章節判定時要跟著處理。
* **回顯多出來的值，`provider auth set` 例外**：多一個特例，路徑裡的書名也會進 `--json`。**只有 `tome add` 加提示**：其他指令照舊看不出原因。

## Open Questions

- [ ] 估價的輸出沒算每個單位的標籤，短格子多的書會低估輸出。兩次第一輪的花費都在估價區間內（ADR-0112 第 6 項），要等 M4 的 `tome trial` 校準（ADR-0103）。
- [ ] `UNIT_OUTPUT_TOKENS` 16 與 `REQUEST_UNITS` 40 只有一本規則書、一篇小說、Sonnet 5.5、批次的數據，下一次真實翻譯後用帳本的 `stop_reason` 與 `max_tokens` 再看一次。
