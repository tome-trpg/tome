---
id: ADR-0106
status: accepted
date: 2026-11-02
depends-on: [ADR-0077, ADR-0099, ADR-0103, ADR-0104]
amends: [ADR-0104]
---

# ADR-0106：SDK 冷卻期先做的部分

## 脈絡

`@anthropic-ai/sdk` 0.137.0 要到 2026-11-03 22:23 UTC 才過冷卻期（ADR-0077），brief 022 在那之前不能開工。維護者決定這段時間先做不需要 SDK 的部分。

修 ADR-0104 第 41 項時，順著查了哪些東西會改變送出的內容。`book.yaml` 的 `source_lang` 也是：`termsFor(pack, source_lang)` 決定 `<glossary>` 列哪些詞條，但它不在內容指紋裡。只有 `keep_source` 的詞條會讓遮蔽後文字變，其他詞條只改 `<glossary>`，指紋不變。目前 `languages/source/` 只有 `en`，`tome add --source-lang` 指到別的語言會被拒絕，所以只有手改 `book.yaml` 才碰得到。

下列決定都由維護者在 2026-11-02 選定。

## 決定

**回合**

1. 修改 ADR-0104 第 1 項：新增 brief 023，範圍是 `source_lang` 進內容指紋與 `tome provider list`，`tome provider list` 從 022 移到 023。022 留下 SDK、Anthropic 轉接層、`fast-sha256` 的例外、`tome provider test` 與 `tests/contract/`。順序變成 023、022、019、020。

**內容指紋**

2. 修改 ADR-0104 第 41 項：`source_lang` 進內容指紋，只改它也要重新確認估價。

**`tome provider list`**

3. 列模型，每個模型一行，前面一行是供應商，最後一行是價目表的查證日。使用者要這個指令的時機，是不知道 `translator_model` 能填什麼。第一行寫明這不是推薦，尚未經過盲評，批次的說法跟 `estimate.done` 一致：

   ```text
   anthropic：端點 https://api.anthropic.com，批次資料最多在供應商端保留 29 天。以下是 TOME 知道怎麼呼叫的模型，不是推薦，尚未經過盲評。
   claude-opus-5-5：即時 $4.00／$20.00，批次 $2.00／$10.00（每百萬 token，輸入／輸出）。
   claude-haiku-5-5 的 prompt 超過 100000 token 時，改為即時 $0.50／$2.50，批次 $0.25／$1.25。
   anthropic 的價目表查證日為 2026-11-02。
   ```

4. 快取價格、`thinking`、`fallback.server`、`estimate` 都不列：M2 沒開快取，思考倍數與估價比例沒量過，伺服器端回退有兩個值還沒確認，TOME 也不用它。`effective` 只放 `--json`，目前都等於查證日。
5. 資料只來自 `providers/anthropic.yaml`，不讀 `tome.yaml`，不標示目前選用的模型，也不讀憑證庫。還沒 `tome init` 也能用，選模型的時候就看得到。金鑰狀態看 `tome doctor`，選用的模型看 `tome estimate`。
6. `--json` 用 `data.providers`，比照 `data.engines`、`data.packs`。每個供應商有 `id`、`endpoint`、`verified`、`retention_days`、`models`，每個模型有 `id`、`effective`、`price`，有長 prompt 價格時才有 `long_prompt`。`price` 只有 `input`、`output`、`batch_input`、`batch_output`，單位是美元／百萬 token。`--json` 是給機器讀的約定，一開始窄一點，之後要加欄位不會弄壞人。
7. 順序照 `providers/anthropic.yaml`，不依價格或字母排序，排序看起來像推薦。金額用 `tome estimate` 的格式。
8. 新的發現是 `provider.listed`、`provider.model`、`provider.long_prompt`，查證日與過期警告沿用 `prices.ok`、`prices.stale`。價目表過期時層級是 warn，結束碼仍是 0，跟 `tome doctor` 一樣。實作在 `src/core/provider.ts` 的 `listProviders`，核心只回資料，文字在 `src/cli/messages/zh-TW.json`。

## 驗證

<!-- @assert-count target="src/core/request.ts" symbol="book.config.source_lang," expected="1" reason="第 2 項：source_lang 進內容指紋" -->
<!-- @assert-count target="src/cli/run.ts" symbol="path: ['provider', 'list']" expected="1" reason="第 3 項：tome provider list" -->
<!-- @assert-count target="src/cli/messages/zh-TW.json" symbol="不是推薦，尚未經過盲評" expected="1" comments="include" reason="第 3 項：寫明清單不是推薦" -->
<!-- @assert-absence target="src/core/provider.ts" symbol="readWorkspaceConfig" reason="第 5 項：不讀 tome.yaml" -->

## 後果

手改 `book.yaml` 的 `source_lang` 之後要重新確認估價。指紋的輸入多一項，已經確認過的書在升級後要重新確認一次，TOME 還沒發佈，影響只有開發中的工作區。

`tome provider list` 看不到快取價格與思考倍數，這些數字量過之後要再決定列不列。Opus 5.5、Fable 5.1 關不掉思考，思考也算輸出，只看清單的單價會低估費用，`tome estimate` 有算進去。

## 替代方案

**等 022 一起做**：這段時間沒有回合在跑，兩件事都不需要 SDK；**`source_lang` 維持不進指紋**：只有手改才碰得到，但確認過的估價就不是實際送出的內容；**列出設定檔的全部欄位**：沒量過的數字會被當成事實，`--json` 也會多一堆之後改不掉的鍵；**標示目前選用的模型**：要讀 `tome.yaml`，還沒 `tome init` 就不能用；**依價格排序**：看起來像推薦。

## Open Questions

- [ ] 指紋的輸入現在是一份寫在 `planBook` 裡的清單，新增會改變請求內容的設定時要記得補，還沒有測試能抓到漏列。
