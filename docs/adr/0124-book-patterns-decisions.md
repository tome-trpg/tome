---
id: ADR-0124
status: accepted
date: 2026-11-09
depends-on: [ADR-0044, ADR-0049, ADR-0051, ADR-0084, ADR-0100, ADR-0103, ADR-0113, ADR-0123]
---

# ADR-0124：單書的額外遮蔽模式

## 脈絡

ADR-0051 第 2 項讓單書覆寫檔調整年代、基調與額外模式；ADR-0100 第 13 項把單書的額外模式排到 M3，ADR-0113 第 11 項把 M3 的單書覆寫限在額外模式，ADR-0123 第 1 項把它從 038 拆成回合 039。

**現有程式**：`book.yaml`（`tome-book/1`）不收未知的欄位，讀檔時整份驗證，不合格就 `config.bad_schema`。規則包的模式寫在 `syntax_patterns.yaml`（`id`、`use`、`kind`、`regex`、`flags`），繼承鏈由子到父、同一個 `id` 留子包的。遮蔽只在組單位時做（`units.ts` 的 `maskSources`），組單位只有 `planBook` 呼叫，模式在 worker 裡限時跑（ADR-0049）。重疊時起點較前的優先、同起點取較長的、再相同時取列在前面的（ADR-0100 第 11 項）。正規表示式的編譯與回溯風險只在 `tome system lint` 查（ADR-0084）；翻譯時規則包的模式編不過，worker 出錯，印的是逾時的訊息。估價的指紋含範圍內每個單位遮蔽後的文字（`request.ts` 的 `planBook`）。`tome estimate --budget` 這類選項寫回 `book.yaml` 時用 `stringify` 重寫整份檔案。

開工前的 10 項問題寫在共用筆記 `brief-039-questions.md`，維護者在 2026-11-09 選定：第 2 項 `use` 必填、只能是 `mask`，第 3 項書的優先，第 4 項 039 不做停用規則包的模式，其餘照建議。實作時的細節 10 項寫在 `brief-039-details.md`，維護者在同一天全部照建議選定，包括細節第 3 項代碼原樣放進括號、第 6 項 `book_patterns` 一律有、第 7 項 `tome batch collect` 也會停；下面各項註明出自細節第幾項。

## 決定

**範圍**

1. 039 只做 `book.yaml` 的**額外遮蔽模式**。不做偵測模式（要有角色指到才有作用，書要改角色等於改規則包）、年代與基調、實體類別的預設代名詞、`tome book lint`。
2. **不能停用規則包的模式**（維護者選的）。要讓某個規則包的模式在這本書不作用，在 `book.yaml` 寫一個同 `id`、比對不到任何字的模式蓋過去。

**寫法**

3. `book.yaml` 加選填的 `patterns`，每一項跟 `syntax_patterns.yaml` 一樣是 `id`、`use`、`kind`（選填）、`regex`、`flags`（選填），**`use` 必填、只能是 `mask`**（維護者選的），模式可以在書與規則包之間直接搬。`id` 與 `kind` 用規則包的名稱規則，`flags` 只能 `i`、`m`、`s`，`g`、`u` 一律開，不收其他欄位。schema 直接寫規則，不參照 `tome-pack/1`（`system` 也是這樣；細節第 8 項）。`patterns: []` 等於沒寫（細節第 5 項）。
4. `tome-book/1` **原地改**，0.1.0 沒發佈（ADR-0115 加 `chapter_level` 的前例）。不合格時照舊 `config.bad_schema`，整本書讀不了，`use: detect` 也一樣。

**跟規則包合併**

5. **書的優先**（維護者選的）：同一個 `id` 時書的蓋過規則包的；書的模式**全部**照 `book.yaml` 的順序排在規則包的前面，蓋過規則包的那一個也搬到前面。所以起點與長度都相同時書的模式一定贏，ADR-0100 第 11 項「取列在前面的」照舊成立。規則包同一個 `id` 是 `detect` 時也被蓋過，翻譯這條路不用偵測模式，沒有影響（細節第 2 項）。
6. 合併在 `planBook` 拿到規則包之後、組單位之前做（新檔 `src/core/book-patterns.ts` 的 `withBookPatterns`），所以 `tome estimate`、`tome translate`（即時、批次、`--dry-run`）與 `tome batch collect` 都用。`verify.ts`（`loadBookPack`）、`mask.ts`、`units.ts` 不動；`tome extract`、`tome system test`、`tome system lint` 照舊只看規則包（細節第 1 項）。

**檢查**

7. 組單位前逐一查（`checkBookPatterns`）：用 `tome system lint` 的 `compiles`（`pack-lint.ts`，改成 export，內容不變）加 `g`、`u` 編譯，編不過的、同一份 `book.yaml` 裡重複的 `id`，都回報 **`book.bad_pattern`**（fail），參數是模式的 `id` 與 `reason`（`invalid_regex` 或 `duplicate_id`），代碼照 `pack.risky_regex` 的前例原樣放進訊息的括號（細節第 3 項）。重複的每一次各報一筆；`flags: ii` 過得了 schema 但編不過，報 `invalid_regex`。問題一次列完，有就不組單位、不動 `book.db`，結束碼 1（細節第 4 項）；`tome batch collect` 也停，跟規則包壞掉時一樣，修好才收得回來（細節第 7 項）。
8. 編得過的模式跑規則包 lint 的靜態檢查（`regexRisks`），有風險只警告（沿用 `pack.risky_regex`）。不跑對抗輸入：每個模式要 0.5 秒，每次估價都跑太慢；執行時照舊在 worker 裡限 CPU 時間，逾時回報 `pack.slow_regex`。

**指紋**（更正 038 問題清單第 16 項）

9. **估價的指紋不另加書的模式的雜湊**。指紋已經含範圍內每個單位遮蔽後的文字，佔位符的 `kind` 也寫在裡面：模式改了、遮蔽變了，指紋就變；改了卻沒有遮到任何字，請求也沒變，不必重新確認。038 問題清單第 16 項建議加雜湊，開工前核對程式後更正：加了只會讓沒影響的修改也要重新確認。
10. 合併後的規則包保留原本的繼承鏈，**規則包的雜湊不變**：估價的指紋與翻譯記憶存的規則包雜湊都只看規則包本身（細節第 9 項）。遮蔽後的文字變了的單位回到起點（`syncUnits`），已經翻好的也要重翻；翻譯記憶的鍵含遮蔽後的文字，不會命中；估價會列出。`tome extract` 不受影響。

**訊息**

11. `book.yaml` 有額外模式時印 **`book.patterns`**（info）「使用 book.yaml 的 N 個額外模式」，只有數量，沒有時不印；從 `planBook` 回傳，所以 `tome estimate`、`tome translate`（即時、批次、`--dry-run`）與 `tome batch collect` 都印（細節第 5 項）。`--json` 的 `data` 加 `book_patterns`（同一組指令），**一律有**，沒有時是 0，跟 `fielded`、`kept` 一樣（細節第 6 項）。訊息只帶模式的 `id` 與數量，不帶正規表示式。

**`book.yaml` 的寫回**

12. `updateBook` 不改：`tome estimate --budget` 這類選項寫回時重寫整份 `book.yaml`，`patterns` 會留著，**檔案裡的註解不會留**（`pii_exceptions` 已經是這樣），寫在白皮書。保留註解的寫法會碰到所有寫 `book.yaml` 的指令，另議。

**測試**

13. 測試只用合成的模式與文字：查核與合併的單元測試（含用 `maskSources` 確認重疊時書的優先）、schema 收什麼與擋什麼、估價與翻譯的端對端測試。推 PR 前用本機單一變異的小工具跑改過的行（細節第 10 項）。書的模式要使用者自己寫，這個回合沒有要量的真書數字。

## 驗證

<!-- @assert-count target="schemas/tome-book-1.schema.json" symbol="\"const\": \"mask\"" expected="1" reason="第 3 項：書只收遮蔽模式" -->
<!-- @assert-count target="src/core/request.ts" symbol="if (checked.some(({ level }) => level === 'fail')) return { plan: null, findings: checked };" expected="1" reason="第 7 項：編不過或重複就不組單位" -->
<!-- @assert-count target="src/core/request.ts" symbol="const pack = withBookPatterns(packOnly, bookPatterns);" expected="1" reason="第 6 項：在 planBook 組單位前合併" -->
<!-- @assert-count target="src/core/book-patterns.ts" symbol="return { ...pack, patterns: [...patterns, ...pack.patterns.filter(({ id }) => !replaced.has(id))] };" expected="1" reason="第 5 項：書的模式全部排在前面，同一個 id 蓋過規則包的" -->
<!-- @assert-count target="src/core/book-patterns.ts" symbol="reason: 'duplicate_id'" expected="1" reason="第 7 項：重複的 id" -->
<!-- @assert-count target="src/core/book-patterns.ts" symbol="reason: 'invalid_regex'" expected="1" reason="第 7 項：編不過的模式" -->
<!-- @assert-count target="src/core/book-patterns.ts" symbol="finding('pack.risky_regex', 'warn'" expected="1" reason="第 8 項：靜態回溯風險只警告" -->
<!-- @assert-count target="src/core/request.ts" symbol="scope.map(({ unit_id, masked }) => [unit_id, masked])," expected="1" reason="第 9 項：指紋含遮蔽後的文字，不另加雜湊" -->
<!-- @assert-count target="src/core/verify.ts" symbol="patterns" expected="0" comments="include" reason="第 6 項：驗證不讀書的模式" -->

## 後果

一本書用到規則包沒遮的代碼或記號時，不用為它另開規則包，寫在 `book.yaml` 就好，送出前照樣在 worker 裡限時跑。書的模式在每次估價與翻譯前檢查，編不過時指得出是 `book.yaml` 的哪一個模式，不會變成逾時的訊息；規則包的模式編不過時，翻譯時仍是逾時的訊息，要靠 `tome system lint` 先擋。

加了或改了會遮到字的模式，命中的單位要重翻，花費估價會列出，確認後才送出。寫回 `book.yaml` 的選項會丟掉檔案裡的註解。

## 替代方案

否決了下列做法：

* **不寫 `use`**：少一個欄位，但搬到規則包時要補。
* **書的模式排在規則包後面**：重疊時規則包優先，書只能補規則包沒遮到的地方。
* **`disable_patterns`**：寫法直接，但超出 ADR-0113 第 11 項的範圍。
* **重複的 `id` 另開 `book.duplicate_pattern`**、**代碼在 CLI 換成中文**：多一個代碼，或多一層對照。
* **組單位前跑對抗輸入**、**加 `tome book lint`**：每次估價都慢，或多一個指令。
* **指紋加書的模式的雜湊**（038 問題清單第 16 項）：沒遮到字的修改也要重新確認。
* **`book_patterns` 只在有模式時才有**：`--json` 的欄位時有時無。
* **合併放進 `loadBookPack`**：`tome verify` 也會讀書的模式，而且 `verify.ts` 是變異測試模組。

## Open Questions

- [ ] 寫回 `book.yaml` 時要不要保留註解（第 12 項）。
- [ ] 規則包的模式在翻譯時編不過，訊息仍是逾時那一句（後果）。
