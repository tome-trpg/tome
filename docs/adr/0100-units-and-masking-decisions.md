---
id: ADR-0100
status: accepted
date: 2026-11-02
depends-on: [ADR-0008, ADR-0010, ADR-0011, ADR-0023, ADR-0026, ADR-0046, ADR-0049, ADR-0051, ADR-0056, ADR-0099]
---

# ADR-0100：單位與遮蔽的細節

## 脈絡

brief 015 開工前比對 ADR-0099 與白皮書，留下 12 項沒定的細節：目標語言沒有設定的地方，沒指定 `--system` 的書用哪個規則包，`generic` 放什麼，哪些區塊要翻，標籤協定的錯誤怎麼算，`tome probe` 依什麼資料建議規則包。

下列決定都由維護者在 2026-11-02 從問題介面選定。

## 決定

**設定**

1. `tome.yaml` 加選填的 `target_lang`，範本寫出來。沒設時用核心的預設值 `zh-TW`。M2 不做單書覆寫，`tome system lint` 沒有工作區時用預設值。
2. 沒指定 `--system` 的書一律用 `generic`，`tome extract` 也載入它。已解析的書會重新組裝一次 document 層，引擎不重跑。隱含的根找不到時回報 `pack.parent_missing`。

**`generic`**

3. 放在 `systems/generic/`，授權 Apache-2.0，隨 npm 包發送，CI 跑 `tome system lint --public` 與 `tome system test`。
4. 遮蔽模式有兩個：`dice`（`1D100`、`2d6+1`、`1/1D6`、`D100`、`d%`、`1d4+1d6`）與 `page_ref`（`p.42`、`pp. 42-45`）。
5. 角色是 `stat_block`、`handout`、`read_aloud`、`gm_note`，都不寫 `detect`，偵測留給子包。
6. 實體類別是 `person`、`deity`（祂）、`creature`（牠）、`place`、`organization`、`item`（它）、`skill`、`spell`。
7. `glossary.yaml` 是空的。角色的 `style`、`persona_and_tone.md`、`few_shots.md` 會進提示，留到 017 與提示一起審。

**單位**

8. 產生單位的區塊：`title`、`heading`、`paragraph`、`list_item`、`sidebar`、`caption`、`footnote`、表格的每個儲存格、規則包角色。`furniture`、`toc`、`index`、`credits`、`figure` 不產生，沒有文字的區塊與儲存格也不產生。
9. 015 只做記憶體裡的函式，不寫 `book.db`。`unit` 表在 016 跟狀態機一起加。單位欄位是 `unit_id`、`block_id`、`role`、`group`、`section`、`source`、`masked`、`placeholders`、`needs_llm`。`group` 用區塊的 `group`，表格用 `block_id`。
10. 遮蔽後不含任何字母（`\p{L}`）的單位不送 LLM，原樣輸出。這比白皮書的「全是佔位符」寬，只有數字與標點的儲存格也不送。

**遮蔽**

11. 重疊時起點較前的優先，同起點取較長的，再相同時取規則包順序在前的。佔位符編號在單位內從 1 起算，依出現順序。
12. 015 就遮蔽規則包詞庫裡 `keep_source: true` 的詞條，`kind` 是 `keep_source`。比對用字串搜尋，不用正規表示式，同一段程式 016 驗譯名時共用。`match` 的預設值是區分大小寫、全字。
13. 單書的額外模式排到 M3。`book.yaml` 在 M2 只加個資例外。

**標籤協定**

14. 文字跳脫 `&`、`<`、`>`，屬性值另跳脫 `"`。
15. 解析只認 `<s>`、`<ph/>`、`<pc>`、`<new-term>`、`<flag>`。未知標籤、沒成對、巢狀錯誤與未跳脫的 `<` 都算協定錯誤，016 當成重送。回應裡沒跳脫的 `&` 當成字面字元，不算錯。
16. `<new-term source="原文">譯文</new-term>` 與 `<flag reason="原因">譯文</flag>` 包在 `<s>` 裡，還原時留內文。
17. `<pc>` 的序列化與解析都做，遮蔽不產生。

**`tome probe` 建議規則包**

18. `pack.yaml` 加選填的 `suggest: { keywords: [...], patterns: [...] }`，`patterns` 指向 `use: detect` 的模式，`tome system lint` 檢查引用。
19. 關鍵詞全字、不分大小寫，模式在 worker 裡跑。分數是有關鍵詞的頁數加有模式命中的頁數。
20. 至少 3 頁才建議。這個門檻是提案，等商業書量過。取最高分的一個，同分依 ID，`generic` 不參與。
21. `ir/probe.json` 加 `suggested_pack`，只有 ID 與頁數。`PROBE_VERSION` 改成 4，指紋加入各包 `suggest` 的雜湊。
22. 書已有 `system` 時不顯示。訊息只有 ID 與頁數，寫明要自行用 `--system` 指定。
23. `suggest` 的模式會跑在每一頁上，不能吃掉 Q-9 的預算，所以 `tests/perf/probe-budget.test.ts` 要涵蓋有 `suggest` 的情況。

**命名**

24. 模組是 `src/core/units.ts`、`src/core/mask.ts`、`src/core/tags.ts`。

## 驗證

<!-- @assert-present file="systems/generic/pack.yaml,systems/generic/LICENSE,systems/generic/NOTICE,src/core/units.ts,src/core/mask.ts,src/core/tags.ts" -->
<!-- @assert-count target="package.json" symbol="systems" min="1" comments="include" reason="第 3 項：內建規則包隨 npm 包發送" -->
<!-- @assert-count target=".github/workflows/test.yml" symbol="system lint systems/generic --public" expected="1" comments="include" reason="第 3 項：內建規則包由 CI 把關" -->
<!-- @assert-absence target="src/core/pack-lint.ts" symbol="TARGET_LANGUAGE" reason="第 1 項：目標語言是參數" -->

## 後果

已解析的書在升級後會重新組裝一次，不花 token。`generic` 沒有偵測規則，所以只用它的書不會判出數值塊。回應裡的未跳脫 `&` 放行，代價是分不出 LLM 本來想寫的是實體參照還是字面字元。`tome probe` 多跑一輪模式，耗時要由效能預算看著。

## 替代方案

**目標語言寫進 `book.yaml`**：M2 只承諾 zh-TW，每本書都要多一個欄位；**沒指定 `--system` 就不載入規則包**：骰子不會遮蔽；**`generic` 內建數值塊偵測**：不同系統的數值塊長相不同，誤判會蓋過核心角色；**只有字面全是佔位符才不送**：純數字的格子也要花 token；**015 就建 `unit` 表**：狀態機在 016 才定，先建的欄位會白改一次；**回應裡沒跳脫的 `&` 算錯**：重送要花錢；**建議規則包另開資料檔**：多一個檔名要維護；**`generic` 也參與建議**：它本來就一律載入；都否決。

## Open Questions

- [ ] 建議規則包的 3 頁門檻，要等商業書量過才定案。
