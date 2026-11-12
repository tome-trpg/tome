---
id: ADR-0134
status: accepted
date: 2026-11-12
depends-on: [ADR-0035, ADR-0037, ADR-0059, ADR-0068, ADR-0103, ADR-0104, ADR-0114, ADR-0118, ADR-0129, ADR-0130, ADR-0133]
amends: [ADR-0103, ADR-0114]
---

# ADR-0134：估價器補上每個單位的標籤、靜態前綴與重送的餘裕

## 脈絡

ADR-0129 第 7 項量到估價器在第一次送出上低估約 24%：輸入比估價器的假設多 25%，輸出多 23%。輸出多的部分跟 ADR-0114 Open Questions 說的「估價沒算每個單位的標籤」一致；輸入多的原因當時量不到，因為請求內容沒有存。重送多了第一次送出的 59%，估價只留 10%。ADR-0130 第 9 項把校準分成兩步：先補估價器已知的缺口，再用 045 的試翻校準。

這個回合用 M3 當時的程式（`aa8f624`）在工作區的唯讀暫存複本上重建第一次送出的請求，跟帳本逐個請求對上，用最小平方法擬合。規則書 191 個請求對上 190 個，公有領域 13 個全對上。量測只印數字，量完刪掉。

| | 規則書（批次） | 公有領域（即時） |
| :--- | :--- | :--- |
| 單位數 | 2,245 | 115 |
| 輸入：實際對估價器 | 533,458 對 426,764（多 25%） | 55,228 對 49,369（多 11.9%） |
| 輸出：實際對估價器 | 121,495 對 98,749（多 23%） | 28,519 對 27,792（多 2.6%） |
| 輸出的擬合 | 0.384 × 原文字元 ＋ 11.4 × 單位數（R² 0.99） | 0.378 × 原文字元 ＋ 19.6 × 單位數（R² 0.95） |
| 輸入的擬合 | 1,850 ＋ 0.373 × `user` 字元 ＋ 6.4 × 單位數（R² 0.99） | 1,737 ＋ 0.334 × `user` 字元 ＋ 20 × 單位數（R² 0.98） |
| 估價器的假設 | 輸出 0.4 × 原文字元；輸入 1,457 ＋ 0.333 × `user` 字元 | 輸出 0.4 × 原文字元；輸入 1,464 ＋ 0.333 × `user` 字元 |

* **輸出的落差幾乎全是標籤**：每個單位的 `<s id="…">…</s>` 約 11 到 20 個 token。每個字元的比例（0.38）反而比估價器的 0.4 低一點。ADR-0114 當時的擬合是 0.377 ＋ 11.1 與 0.380 ＋ 16.5，對得上。
* **輸入的落差大多在靜態前綴**：前綴是 TOME 自己的英文提示加上全書提要，約 4,370 個字元，每個請求都付一次。實際約 2.4 個字元一個 token（規則書 2.36、公有領域 2.53），估價器照 3 個算。規則書的輸入約三分之二是前綴。標籤在輸入也有，每個單位約 6 到 20 個 token。
* 規則書的書本文字也比估價器的比例吃 token（每個字元 0.373 對 0.333），公有領域幾乎一樣（0.334）。這跟書有關，留給 045。

重送：ADR-0133 的最長比對拿掉誤判之後，規則書的重送從 $0.6853 剩約 $0.2840，是第一次送出的 24.6%。這是用存下的回應照新規則重驗推出來的。公有領域的重送跟最長比對無關，$0.1105，是第一次送出的 27.9%。

三種補法套回 M3 的數據（Sonnet 5.5 的價格，只是試算）。第一次送出的中間值（不含餘裕）對照實際花費：

| 補法 | 規則書 | 公有領域 |
| :--- | ---: | ---: |
| 原本 | −19.3% | −4.8% |
| 加每個單位的標籤（輸出 12、輸入 6 個 token） | −6.3% | −1.0% |
| 再加前綴的比例（每 2.4 個字元一個 token） | −0.3% | ＋1.4% |

含重送的總花費（第一次送出加上 ADR-0133 之後的重送）對照估價的中間值：

| | 規則書（實際 $1.4369） | 公有領域（實際 $0.5061） |
| :--- | :--- | :--- |
| 原本，`retry_margin` 0.1 | $1.0126（−29.5%） | $0.4143（−18.1%） |
| 標籤＋前綴，`retry_margin` 0.1 | $1.2517（−12.9%） | $0.4415（−12.8%） |
| 標籤＋前綴，`retry_margin` 0.25 | $1.4224（−1.0%），區間 $1.1379–$1.8491 | $0.5017（−0.9%），區間 $0.4014–$0.6522 |

開工前的問題與量測寫在共用筆記 `brief-044-questions.md`，6 項由維護者在 2026-11-12 全部照建議選定。

## 決定

數字都是**提案**：只有兩本書、一個模型（Sonnet 5.5），045 的試翻再依書校準（ADR-0068、ADR-0130 第 9 項）。

**翻譯的估價**

1. 修改 ADR-0103 第 8 項：翻譯請求的輸入 token ＝ 靜態前綴的字元 ÷ `prefix_chars_per_token` ＋ `user` 的字元 ÷ `chars_per_token` ＋ 單位數 × `unit_input_tokens`。
2. 修改 ADR-0103 第 8 項：翻譯請求的輸出 token ＝ 原文字元 ÷ `chars_per_token` × `output_ratio` × 思考的 `output_factor`，再加上單位數 × `unit_output_tokens`。標籤加在思考的倍數之外，跟 `max_tokens` 的寫法一樣（ADR-0114 第 2 項）。
3. `providers/anthropic.yaml` 的 `estimate` 加三個欄位，schema 跟著加，三個都必填：
   * `unit_output_tokens: 12`、`unit_input_tokens: 6`：以規則書的擬合為主（11.4、6.4），它的單位數是公有領域的 20 倍，擬合也穩。標籤怎麼切 token 跟模型的 tokenizer 有關，所以放在供應商設定檔，跟 `chars_per_token` 同一層。
   * `prefix_chars_per_token: 2.4`：兩本書的前綴是 2.36 與 2.53。前綴是 TOME 自己的提示加全書提要，不太隨書變。
4. `retry_margin` 從 0.1 改成 0.25：ADR-0133 之後，重送約是第一次送出的四分之一（規則書 24.6%、公有領域 27.9%）。
5. `max_tokens` 的 `UNIT_OUTPUT_TOKENS`（16）不改：它是上限，要比量到的寬。`chars_per_token`、`output_ratio`、`low`、`high` 不改，045 校準。

**Pass 0**

6. Pass 0（`tome scan-terms`）的估價數字不變：兩本書的實際花費都在估價下限附近或略低（$0.0437 對下限 $0.0438、$0.1713 對 $0.1786，ADR-0129），已經是高估。它的輸出是每個候選詞固定的 token，沒有單位的標籤，重送也很少；前綴的比例與 0.25 的餘裕套上去只會更高估。程式上整個提示照舊用 `chars_per_token`，餘裕改讀新欄位 `scan_retry_margin: 0.1`，schema 跟著加。

**已確認的估價**

7. `providers/anthropic.yaml` 的雜湊在翻譯與 Pass 0 的內容指紋裡（ADR-0056），改了之後每本書都要重新 `tome estimate --confirm`；還沒送出的 `tome scan-terms` 也要重新確認，估價數字不變。估價變高之後，預算檢查用的估價上限也變高，批次與即時模式都會比較早停下。CHANGELOG 照實寫明。

**變異測試**

8. 改過的檔案不在變異測試的六個模組裡，改過的行在回合分支上用 `mutation-lines` 跑（ADR-0132）。本機不跑變異測試。

## 驗證

<!-- @assert-count target="providers/anthropic.yaml" symbol="  prefix_chars_per_token: 2.4" expected="1" reason="第 3 項：靜態前綴的比例" -->
<!-- @assert-count target="providers/anthropic.yaml" symbol="  unit_input_tokens: 6" expected="1" reason="第 3 項：每個單位的標籤，輸入" -->
<!-- @assert-count target="providers/anthropic.yaml" symbol="  unit_output_tokens: 12" expected="1" reason="第 3 項：每個單位的標籤，輸出" -->
<!-- @assert-count target="providers/anthropic.yaml" symbol="  retry_margin: 0.25" expected="1" reason="第 4 項：翻譯重送的餘裕" -->
<!-- @assert-count target="providers/anthropic.yaml" symbol="  scan_retry_margin: 0.1" expected="1" reason="第 6 項：Pass 0 的餘裕照舊" -->
<!-- @assert-count target="src/core/estimate.ts" symbol="input: prefixChars / prefix_chars_per_token + userChars / chars_per_token + unit_input_tokens * units," expected="1" reason="第 1 項：前綴與 user 各用自己的比例，加上單位的標籤" -->
<!-- @assert-count target="src/core/estimate.ts" symbol="output: outputTokens(provider, model, sourceChars) + unit_output_tokens * units," expected="1" reason="第 2 項：標籤加在思考的倍數之外" -->
<!-- @assert-count target="src/core/request.ts" symbol="export const UNIT_OUTPUT_TOKENS = 16;" expected="1" reason="第 5 項：max_tokens 的額度不改" -->

## 後果

估價變高。照 M3 的數據，規則書翻譯的估價中間值約從 $1.01 變成 $1.42，公有領域約從 $0.41 變成 $0.50；含重送的實際花費都在中間值 ±1% 以內。短格子多的書加得最多：每個單位不論多短，都多算輸入 6、輸出 12 個 token。

已確認的估價全部失效，每本書都要重新確認一次（第 7 項）。預算檢查會比較早停下：預算剛好卡在舊估價上限附近的書，要提高預算才送得出去。

數字只對 Sonnet 5.5 與這兩本書量過。換模型或換書時 tokenizer 與文字都不同，045 的試翻再依書校準；規則書的書本文字每個字元的比例（0.373 對 0.333）也還沒處理。

ADR-0133 合併後，維護者在規則書的範圍內（2,550 個單位）跑了 `tome verify`：沒花錢，86 個單位改成完成，未通過從 139 個降到 53 個。再跑 `--retry-failed`，送了三批（39、18、16 個請求，救回 26、3、0 個），共救回 29 個，花 $0.22。剩下 24 個：`term_missing` 19 個（其中 14 個是鎖定譯名）、`too_short` 5 個。這次重送是上限之外追加的，量的是剩下單位的重送，不是一般翻譯的重送率，第 4 項的依據不變。

## 替代方案

否決了下列做法：

* **標籤的 token 放在程式的常數**（像 `UNIT_OUTPUT_TOKENS`）：不用改 schema，但換供應商時沒地方設。
* **輸出的標籤直接用 16**（跟 `max_tokens` 同一個數）：比量到的多約四成，會高估。
* **前綴的比例留給 045**：只補標籤時，規則書的第一次送出仍低估 6.3%；補了前綴，兩本都在 ±1.5% 以內。
* **等 `--retry-failed` 的結果再定餘裕**：那次量的是剩下單位的重送，不是一般翻譯的重送率，數字也比較窄。
* **Pass 0 也套三項**：Pass 0 的估價已經是高估，套上去會更高。
* **Pass 0 的餘裕放在程式的常數**：改它不會讓已確認的估價失效，也跟第 3 項「比例放供應商設定檔」的理由不一致。

## Open Questions

- [ ] 規則書的書本文字每個字元的 token 比估價器的比例多（0.373 對 0.333），公有領域則差不多。045 的試翻依書校準 `chars_per_token`。
- [ ] 公有領域每個單位的標籤擬合是 19.6 與 20 個 token，比規則書多，但只有 13 個請求。要更多書的數據才知道標籤的 token 跟什麼有關。
- [ ] 數字只有 Sonnet 5.5。思考關不掉的模型（Opus 5.5）標籤會不會也帶出思考，沒有數據（第 2 項）。
