---
id: ADR-0103
status: accepted
date: 2026-11-02
depends-on: [ADR-0035, ADR-0036, ADR-0037, ADR-0040, ADR-0041, ADR-0067, ADR-0081, ADR-0099, ADR-0102]
amends: [ADR-0041]
---

# ADR-0103：成本與請求的細節

## 脈絡

brief 017 開工前比對 ADR-0099 與白皮書 §5.7、§8.1，留下這些沒定的細節：提示放哪裡，`tome-provider/1` 的欄位，估價怎麼算，`--confirm` 的規則，`--chapters` 的寫法。

下列決定都由維護者在 2026-11-02 從問題介面選定。提示與風格指南由維護者逐字審過，接進請求的就是審過的文字。

估價的數字全部是**提案**，白皮書的 3 字元 1 token 與 1.2 倍來自附錄 A，思考的 1.5 倍是假設，都沒有量過，M4 的 `tome trial` 才校準（H-13）。

## 決定

**提示**

1. 指令放 `prompts/translate.md`，隨 npm 包發送。風格指南留在目標語言設定檔，`persona_and_tone.md`、`few_shots.md` 留在規則包，角色的 `style` 放 `roles.yaml`。核心不放文字。
2. `system` 依序是指令、風格指南、規則包的文風與範例，這三段同一本書不變。`user` 依序是 `<context>`、`<glossary>`、`<roles>` 與 `<s>`，沒有內容的區塊不出現，書本文字先跳脫。全書提要與活躍實體要等 M3。

**模型資料**

3. `providers/anthropic.yaml` 的格式是 `tome-provider/1`，隨 npm 包發送。頂層有 `id`、`verified`、`retention_days`、`estimate`、`models`。模型有 `id`、`effective`、`price`、`thinking`、`fallback`，Haiku 5.5 另有 `long_prompt`。
4. 官方價目頁沒有生效日，`effective` 填查證日。
5. `thinking.mode` 是 `none`（不能關，不送 `thinking`，送 `effort`）、`between_tools`、`disabled`。能關思考的模型不送 `effort`。`none` 的模型帶 `output_factor`，值 1.5，是提案。
6. `fallback.server` 記下有沒有伺服器端回退。Opus 5.5、Fable 5.1 官方頁沒有逐一寫明，先寫 `true`，由 018 的 `tome provider test` 確認。
7. 不在表上的模型回 `model.unknown`，結束碼 2。沒設 `translator_model` 回 `model.missing`，結束碼 2。查證滿 60 天時警告，結束碼不變。

**估價**

8. 字元數除以 `chars_per_token`，輸出乘 `output_ratio`，再乘思考的 `output_factor`，最後乘 `1 + retry_margin`。區間是這個數字乘 `low` 與 `high`。預設用 Batch 的價格。
9. 顯示資料保留時間、模型、單位數、字元數、請求數、美元區間與預算。

**請求**

10. 一個請求約 6,000 字元，帶約 800 字元上文，都是常數。同組單位不拆，單一組超過時自成一個請求。請求不跨章。
11. 上文取同一章前面看得到的文字，佔位符拿掉，只留最後 800 字元，再跳脫。它只用來理解語意，不用翻譯，所以開頭可能從句子中間開始。
12. `max_tokens` 是預估輸出乘 `output_factor` 再取 2 倍，下限 1,024。思考也吃 `max_tokens`。

**預算**

13. `book.yaml` 加 `budget_usd`，單位是美元，`--budget` 寫進去。
14. `tome estimate <book> [--budget <美元>] [--chapters <範圍>] [--confirm]`。`--confirm` 在 `stage` 記下內容指紋：範圍內全部的單位、模型、價格、範圍、預算、提示。任何一項變了就要重新確認。單位算全部，不是還沒翻的，所以翻到一半中斷時續跑不用重新確認。
15. 沒有預算時仍顯示估價，`--confirm` 回 1。估價的上限超過預算時，`--confirm` 回 1，不記錄。
16. `checkBudget` 檢查已花加進行中加這次的上限不得超過預算（ADR-0081 第 2 項）。017 只有函式與測試，018、019 呼叫。

**費用帳本**

17. `book.db` 的遷移第 4 版加 `ledger`，每個單位一列，依字元數分攤（ADR-0081 第 12 項）：`id`、`request_id`、`unit_id`、`model`、`mode`、`input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_write_tokens`、`cost_usd`、`created_at`。

**範圍**

18. `--chapters` 的寫法是 `3`、`1-3`、`1,3,5`，編號是 `document.sections` 頂層的順序，從 1 起算，存進 `book.yaml` 的 `chapters`，之後沿用。區塊依章節的起始區塊歸章，所以同名章節也分得開。第一章之前的區塊只在沒有指定範圍時算進去。沒有章節的書整本算一章。
19. `tome translate <book> --dry-run` 組出所有請求，檢查前綴穩定度與估價，不連網。沒帶 `--dry-run` 時回報 `translate.not_ready`，018 才有。個資閘門在 018 接上。估價與試算只算 `PENDING`、`QUEUED`、`STALE` 的單位，`FAILED_QA` 這類要等人處理，`IN_FLIGHT` 已經送出去了。

**設定**

20. 修改 ADR-0041 第 2 項：M2 只做 `tome.yaml` 的 `translator_model`、`fallback_model`，依區塊角色覆寫排到 M4，要等試翻才知道值不值得。
21. 個資清單是 `tome.yaml` 的 `pii`，範本寫出來，例外是 `book.yaml` 的 `pii_exceptions`。清單空的時候，`tome doctor` 與 `tome estimate` 警告。
22. `tome doctor` 拿掉 `prices.pending`，改回報價目表的查證日。

**命名**

23. 模組是 `src/core/provider.ts`、`src/core/prompt.ts`、`src/core/request.ts`、`src/core/estimate.ts`、`src/core/budget.ts`、`src/core/ledger.ts`。
24. 新的代碼是 `model.missing`、`model.unknown`、`document.missing`、`chapters.invalid`、`budget.invalid`、`translate.not_ready`、`estimate.*`、`dry_run.*`、`prices.ok`、`prices.stale`、`pii.empty`。

## 驗證

<!-- @assert-present file="providers/anthropic.yaml,prompts/translate.md,schemas/tome-provider-1.schema.json,src/core/provider.ts,src/core/prompt.ts,src/core/request.ts,src/core/estimate.ts,src/core/budget.ts,src/core/ledger.ts" -->
<!-- @assert-count target="package.json" symbol="providers" min="1" comments="include" reason="第 3 項：模型資料隨 npm 包發送" -->
<!-- @assert-count target="package.json" symbol="prompts" min="1" comments="include" reason="第 1 項：提示隨 npm 包發送" -->
<!-- @assert-absence target="src/core/doctor.ts" symbol="prices.pending" reason="第 22 項：價目表已經有了" -->

## 後果

第一次估價誤差可能很大，所有比例都沒有量過。價目表要隨發版維護，查證滿 60 天會警告。沒帶 `--dry-run` 的 `tome translate` 在 018 之前沒有作用。依角色選模型要等 M4，這之前全書只能用一個模型。

## 替代方案

**提示寫在程式裡**：核心不放文字，改提示也要動程式；**估價用真的 token 計數 API**：開跑前就把書送出去（ADR-0035）；**`max_tokens` 不算思考**：Opus 5.5 與 Fable 5.1 關不掉思考，輸出會被截斷，重送要花錢；**沒有預算也能確認**：跟 ADR-0035 的必填上限不一致；**依章節標題比對區塊**：同名章節分不開；**M2 就依角色覆寫模型**：沒有試翻資料，不知道值不值得；都否決。

## Open Questions

- [ ] 估價的比例與思考的 `output_factor` 都要等試翻量過（H-13）。
- [ ] Opus 5.5、Fable 5.1 的伺服器端回退要由 018 的 `tome provider test` 確認。
