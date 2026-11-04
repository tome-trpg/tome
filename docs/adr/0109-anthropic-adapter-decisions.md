---
id: ADR-0109
status: accepted
date: 2026-11-03
depends-on: [ADR-0032, ADR-0034, ADR-0039, ADR-0062, ADR-0077, ADR-0099, ADR-0103, ADR-0104, ADR-0107, ADR-0108]
amends: [ADR-0099, ADR-0103, ADR-0104, ADR-0107]
---

# ADR-0109：Anthropic 轉接層的細節

## 脈絡

brief 022 要接上 `@anthropic-ai/sdk` 0.137.0。這個版本在 2026-11-03 22:23 UTC 過了 14 天冷卻期（ADR-0077），轉接層要實作 018 與 019 定的 `LLMProvider`。開工前比對 ADR-0099、ADR-0103、ADR-0104、ADR-0107、ADR-0108，還有這些細節沒定：SDK 怎麼包錯誤、讀哪些環境變數、非串流請求的上限、金鑰從哪裡來、`tome provider test` 怎麼做、契約測試放哪裡。

2026-11-03 讀了 0.137.0 的原始碼，查到下列事實：

* 注入的 `fetch` 丟出的錯誤會被包成 `APIConnectionError`，原本的錯誤放在 `cause`（`src/client.ts:1564`）。
* 就算明確傳了 `apiKey` 與 `baseURL`，SDK 還是會讀幾個環境變數：`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_WEBHOOK_SIGNING_KEY`、`ANTHROPIC_LOG`、`ANTHROPIC_OPEN_TELEMETRY*`，以及關不掉的 `ANTHROPIC_CUSTOM_HEADERS`。`ANTHROPIC_CUSTOM_HEADERS` 排在金鑰標頭之後，所以能蓋掉 `X-Api-Key`。`ANTHROPIC_LOG=debug` 會把含本文的請求印到主控台。
* 沒有明確設 `timeout` 時，`max_tokens` 大於 21,333 的非串流請求會在送出前丟錯（`src/client.ts:1871-1883`）。
* `batches.results` 會先查一次批次拿 `results_url`，再下載那個網址。
* beta 的 Models API 回 `allowed_fallback_models`、`capabilities` 與 `deprecated_at`。
* 相依樹共 8 個套件，跟 ADR-0099 記的一樣。

同一天讀了 platform.claude.com 的 errors、batch-processing、pricing、refusals-and-fallback、models overview，以及 API 參考的 batches retrieve、models、beta models list：

* 即時模式收到 5xx、529、逾時或串流中途出錯，會不會計費，文件都沒寫。
* 批次結果的 `errored`、`canceled`、`expired` 不計費。
* `results_url` 只有範例，主機是 `api.anthropic.com`，文件沒保證主機。
* 伺服器端回退沒有逐模型的清單，只寫明 Haiku 5.5 沒有。

這些事實與每一項的建議寫在共用筆記 `brief-022-questions.md`。下列決定由維護者在 2026-11-03 從問題介面選定，14 項全部照建議。轉接層只跟本機的假供應商跑過，沒有對真的 API 發過請求。

## 決定

**錯誤與連線**

1. SDK 包起來的錯誤由轉接層解開：
   * `APIConnectionError` 的 `cause` 是 `TomeError`（含 `EgressBlocked`）時，丟出 `cause`。
   * 其他 `APIConnectionError`，包括逾時，回 `status: null`。
   * 有狀態碼的 `APIError` 回 `status`，`retryAfter` 讀 `retry-after` 標頭的秒數。
   * 其他錯誤照樣丟出。
2. 修改 ADR-0099 第 24 項的做法：client 明確傳下列參數，SDK 會讀的 `ANTHROPIC_*` 環境變數一個都不影響送出的請求：
   * `apiKey`、`authToken: null`、`webhookKey: null`、`baseURL`、`fetch`
   * `maxRetries: 0`、`timeout`、`logLevel: 'off'`、`openTelemetry: false`

   `ANTHROPIC_CUSTOM_HEADERS` 關不掉，所以分兩層處理：
   * 轉接層包一層 `fetch`，只轉送 `accept`、`content-type`、`user-agent`、`x-stainless-*`、`anthropic-version`、`anthropic-beta`、`x-api-key`。
   * `defaultHeaders` 明確帶 `X-Api-Key` 與 `anthropic-version`，大小寫不同的同名標頭也以 TOME 給的為準。
3. 照 SDK 的預設送 `User-Agent` 與 `x-stainless-*`。白皮書 §8.2 寫明：除了請求本文，還會送出作業系統、CPU 架構與 Node 版本。不含金鑰，也不含書本文字。
4. client 明確設 `timeout`，值是 600,000 毫秒，跟 SDK 預設的 10 分鐘相同，SDK 就不會在送出前因為 `max_tokens` 大而丟錯。超過 10 分鐘的請求會被中斷，當成沒有收到回應，照 ADR-0104 第 11 項重試。M2 不做串流，等 M4 試翻量過請求時間再決定。

**轉接層與 CLI**

5. 轉接層與金鑰：
   * `src/core/egress/anthropic.ts` 匯出 `anthropicHost(key, options)`。
   * `LLMHost.connect` 改成 `connect(fetcher, endpoint)`，`endpoint` 給 SDK 組網址，能不能連仍由 `guardedFetch` 的白名單決定。
   * `sdkVersion` 讀 SDK 的 `VERSION`。
   * 金鑰由 CLI 照 ADR-0034 的順序取得：先看環境變數 `TOME_ANTHROPIC_API_KEY`，再看憑證庫。要連網的指令一開始先取金鑰，沒有就回 `key.missing`，憑證庫不能用就回 `keyring.unavailable`，都在開書之前，也不連網。這些指令是：
     * `tome translate`，不含 `--dry-run`
     * `tome batch status|collect|cancel`
     * `tome provider test`
   * 轉接層用動態 `import()` 延後載入，不連網的指令不用載入 SDK。
   * `Io.llm` 只給測試注入。
6. 修改 ADR-0104 第 25、45 項與 ADR-0107 第 1 項：`translate.not_ready` 拿掉。下列指令都接上真的轉接層：
   * 不帶 `--realtime` 的 `tome translate`
   * `--realtime`
   * `--retry-failed`
   * `tome batch status|collect|cancel`
7. `tome --help` 列出：
   * `tome provider test`
   * `tome translate <名稱>` 與 `--realtime`、`--retry-failed`
   * `tome batch status|collect|cancel`
8. Batch 的方法用 SDK 的 `messages.batches`：
   * `list` 每頁 20 個，用 `after_id` 翻頁，`has_more` 是 false 就停。
   * `collectBatch` 照文件先查一次批次拿 `results_url`，再下載它，JSONL 全部讀完再交給核心的 `batchItem`，所以外送紀錄多一列大小 0 的紀錄。第 20 項定案之前用 SDK 的 `results(id)`，它內部也是先查再下載；第 20 項要自己讀本文，`results(id)` 是 `async` 函式，拿不到 `asResponse()`，所以改用 `api.get` 下載同一個網址。

**`tome provider test` 與測試**

9. 修改 ADR-0103 第 6 項的做法：`tome provider test` 只用 Models API，不送 Messages 請求，不消耗 token。
   * 對 `providers/anthropic.yaml` 的每個模型，帶 beta 標頭 `server-side-fallback-2026-07-01` 查 `GET /v1/models/{id}`。
   * 對照四件事：支不支援 Batch、思考參數、`allowed_fallback_models` 跟 `fallback.server` 對不對得上、`deprecated_at`。
   * 對不上回 warn，不改設定檔。
   * 401 回 `key.rejected`，404 回 `provider.model_unavailable`，其他錯誤重試完回 `provider.test_failed`。
   * 這個指令沒有書，請求也沒有本文，所以不寫外送紀錄，白名單照樣檢查。

   合併之後由維護者用自己的金鑰跑一次，結果寫進 M2 收尾的 ADR。
10. 修改 ADR-0099 第 26 項的做法：
    * `npm test` 不含 `tests/contract/`，另外有 `npm run test:contract`。沒有金鑰就整個跳過，CI 不跑。
    * 內容有三項：
      * Models API 的對照。
      * 一個 Haiku 5.5 的合成文字即時請求，約 300 個 token。
      * 一批 2 個請求的批次，只有設了 `TOME_CONTRACT_BATCH=1` 才跑。
11. `fast-sha256` 1.3.0 照 ADR-0099 第 15 項，在 `tools/check-licenses.ts` 開綁套件、版本與授權的窄例外，三者有一個不同就擋下。
12. ADR-0099 第 14 項的斷言改成檢查 `package.json` 釘 0.137.0。
13. `tests/core/anthropic.test.ts` 用真的 SDK、經過 `guardedFetch` 打本機的假供應商，測每個方法與第 1、2、4 項的護欄。CLI 的即時與批次各有端對端測試，用真的轉接層。現有的流程測試照舊用 `fakeHost`。假供應商補上 `results_url`、Models API 與收到的標頭。

**不放進 022 的**

14. 下列事項都不在這個回合：
    * 串流。
    * 依處理時間調整輪詢間隔、併發送出多批。
    * 升 SDK 1.x。
    * 第一次真實翻譯，由維護者在合併之後執行（ADR-0099 第 29 項）。

**實作時補定的細節**

實作時冒出的細節寫在共用筆記 `brief-022-details.md`，維護者在 2026-11-03 選定。第 20 項改成替代方案，其餘照建議。

15. 新訊息的文字見 `src/cli/messages/zh-TW.json`，照 ADR-0086、ADR-0089：`key.rejected`、`provider.tested`、`provider.model_unavailable`、`provider.no_batch`、`provider.thinking_mismatch`、`provider.fallback_mismatch`、`provider.deprecated`、`provider.test_failed`。CLI 訊息不稱呼讀者，`provider.model_unavailable` 寫「這把金鑰所屬的帳號」。
16. `tome provider test` 的錯誤另開 `provider.test_failed`（參數 `status`），不沿用 `translate.provider_failed`，後者寫的是保留進度、稍後續跑，這個指令沒有進度。
    * 404 回 `provider.model_unavailable`，接著查下一個模型。
    * 401 回 `key.rejected`，其他錯誤重試完回 `provider.test_failed`。這兩種都直接停下，換一個模型查也會一樣。
17. `LLMProvider` 加 `describeModel(id)`，回 `ModelFacts`：`id`、`batch`、`thinking`（`disabled` 與 `between_tools`）、`fallback`（`allowed_fallback_models` 有沒有東西）、`deprecatedAt`，不知道的是 null。解析 Models API 的 `modelFacts` 放 `src/core/provider-test.ts`，因為 `src/core/llm.ts` 有 ADR-0107 第 19 項的斷言。`capabilities` 是 null 時不比對 Batch 與思考參數。
18. `tome provider test` 的 `--json` 的 `data` 是 `provider` 與 `models`。每個模型有 `id`、`available`、`batch`、`thinking`、`fallback`、`deprecated_at`，放供應商回報的原值，對不對得上由 findings 表示。
19. `retry-after` 只讀秒數，HTTP 日期格式或負數當成沒有，照 ADR-0104 第 11 項的秒數退避。
20. 轉接層的每個方法都用 `asResponse()` 取回應、自己讀本文。讀本文時斷線，SDK 丟出的錯誤沒有包起來（SDK 的 `internal/parse.ts` 直接呼叫 `response.json()`），所以這一步的錯誤當成沒有收到回應，回 `status: null`，跟 5xx、逾時一樣交給 `withRetry`。解析 JSON 與其他程式錯誤照樣丟出。
    * `send` 會原地重送，可能多付一次，列在 Open Questions。
    * `collectBatch` 再下載一次，不會多付。
    * `submitBatch` 收到 200 之後本文斷線時，照 ADR-0108 不重試、留著意圖紀錄，下次用 `list` 認回。
    * 帳本的 `request_id` 是本文裡的訊息 ID，不是 `request-id` 標頭，自己讀本文也照樣有。
21. 測試用的 `adapterHost` 是真的轉接層與 SDK，一律連到假供應商，端點只決定白名單。白名單是正式的端點時，連到本機會被擋下，請求不會送到供應商。
22. 兩份 README 的「開發進度」加上「確認金鑰與模型資料」與「翻譯」，翻譯寫明尚未以實際的 API 翻譯過，「翻譯與輸出」改成「輸出」。CHANGELOG 加上 `tome translate`、`tome provider test` 與環境變數三條，拿掉「翻譯功能尚未提供」這類句子。
23. 測「沒有金鑰」的測試明確拿掉 `TOME_ANTHROPIC_API_KEY`：測試的環境帶著 `process.env`，開發者本機設了金鑰時會拿到真的金鑰。
24. 修改 ADR-0107 第 15 項：刪除遠端資料收到 404 就當成已經刪除，寫入 `deleted_at`，之後不再重試，當次回報 `batch.delete_not_found`（warn，參數 `id`）。其他狀態碼照舊回 `batch.delete_failed`，下次執行再試。
    * 原因：上次的刪除其實成功、只是沒收到回應（連線在標頭之前斷，或第 20 項的本文斷線）時，之後每次都會收到 404，`deleted_at` 永遠寫不進去，每次執行都警告，`tome status` 也一直顯示沒刪。這是審查第 20 項時 Manager 查程式發現的，維護者在 2026-11-03 決定。
    * 前提：404 也可能是換了金鑰，資料其實還在原本的帳號。訊息因此寫明要到原本的帳號確認，TOME 不會再刪。

## 驗證

<!-- @assert-present file="src/core/egress/anthropic.ts,src/core/provider-test.ts,tests/core/anthropic.test.ts,tests/contract/anthropic.test.ts" -->
<!-- @assert-count target="src/core/egress/anthropic.ts" symbol="if (error.cause instanceof TomeError) throw error.cause;" expected="1" reason="第 1 項：解開 SDK 包起來的閘門與白名單錯誤" -->
<!-- @assert-count target="src/core/egress/anthropic.ts" symbol="authToken: null," expected="1" reason="第 2 項：不讀 ANTHROPIC_AUTH_TOKEN" -->
<!-- @assert-count target="src/core/egress/anthropic.ts" symbol="logLevel: 'off'," expected="1" reason="第 2 項：不讀 ANTHROPIC_LOG，不印請求" -->
<!-- @assert-count target="src/core/egress/anthropic.ts" symbol="openTelemetry: false," expected="1" reason="第 2 項：不讀 ANTHROPIC_OPEN_TELEMETRY" -->
<!-- @assert-count target="src/core/egress/anthropic.ts" symbol="defaultHeaders: { 'X-Api-Key': key, 'anthropic-version': API_VERSION }," expected="1" reason="第 2 項：ANTHROPIC_CUSTOM_HEADERS 蓋不掉金鑰與版本" -->
<!-- @assert-count target="src/core/egress/anthropic.ts" symbol="if (FORWARDED.test(name)) headers.set(name, value);" expected="1" reason="第 2 項：只轉送允許的標頭" -->
<!-- @assert-count target="src/core/egress/anthropic.ts" symbol="maxRetries: 0," expected="1" reason="ADR-0099 第 23 項：SDK 不重試" -->
<!-- @assert-count target="src/core/egress/anthropic.ts" symbol="const TIMEOUT_MS = 600_000;" expected="1" reason="第 4 項：明確設 10 分鐘的逾時" -->
<!-- @assert-count target="src/cli/run.ts" symbol="await import('../core/egress/anthropic.ts')" expected="1" reason="第 5 項：轉接層延後載入" -->
<!-- @assert-count target="src/cli/run.ts" symbol="finding('key.missing', 'fail', { provider: 'anthropic', env })" expected="1" reason="第 5 項：沒有金鑰就停下" -->
<!-- @assert-absence target="src" symbol="translate.not_ready" comments="include" reason="第 6 項：translate.not_ready 拿掉" -->
<!-- @assert-count target="src/cli/messages/zh-TW.json" symbol="batch collect <名稱>" expected="1" comments="include" reason="第 7 項：tome --help 列出 tome batch" -->
<!-- @assert-count target="src/cli/messages/zh-TW.json" symbol="provider test " expected="1" comments="include" reason="第 7 項：tome --help 列出 tome provider test" -->
<!-- @assert-count target="src/core/egress/anthropic.ts" symbol="const { results_url: url } = JSON.parse(found)" expected="1" reason="第 8 項：從 results_url 下載" -->
<!-- @assert-count target="src/core/egress/anthropic.ts" symbol="const FALLBACK_BETA = 'server-side-fallback-2026-07-01';" expected="1" reason="第 9 項：Models API 帶 beta 標頭" -->
<!-- @assert-absence target="src/core/provider-test.ts" symbol=".send(" reason="第 9 項：tome provider test 不送 Messages 請求" -->
<!-- @assert-count target="src/core/provider-test.ts" symbol="record: () => undefined" expected="1" reason="第 9 項：沒有書，不寫外送紀錄" -->
<!-- @assert-count target="vitest.config.ts" symbol="'tests/contract/**'" expected="1" reason="第 10 項：npm test 不含契約測試" -->
<!-- @assert-count target="package.json" regex="true" symbol="test:contract.: .vitest run --mode contract" expected="1" comments="include" reason="第 10 項：npm run test:contract" -->
<!-- @assert-count target="tools/check-licenses.ts" symbol="'fast-sha256@1.3.0': 'Unlicense'," expected="1" reason="第 11 項：綁版本的窄例外" -->
<!-- @assert-count target="src/core/provider-test.ts" symbol="finding('provider.test_failed', 'fail', { status: String(error.status ?? '-') })" expected="1" reason="第 16 項：provider test 的錯誤另開代碼" -->
<!-- @assert-count target="src/core/egress/anthropic.ts" symbol="const response = await call.asResponse();" expected="1" reason="第 20 項：本文自己讀" -->
<!-- @assert-count target="src/core/egress/anthropic.ts" symbol="return NO_RESPONSE;" expected="1" reason="第 20 項：讀本文時斷線當成沒有收到回應" -->
<!-- @assert-count target="src/core/batch.ts" symbol="if (error !== null && error.status !== 404) {" expected="1" reason="第 24 項：刪除收到 404 當成已經刪除" -->

## 後果

使用者用自己的金鑰就能翻譯，即時與批次都走同一個轉接層。這些都只跟本機的假供應商跑過，第一次真實翻譯要等維護者在合併之後執行。

SDK 會送出作業系統、CPU 架構與 Node 版本。單一單位超大時，非串流請求可能跑超過 10 分鐘而被中斷重試。`tome provider test` 只能查 Models API 有回報的欄位。契約測試這個回合沒有執行過。

## 替代方案

否決了下列做法：

* **接受 `ANTHROPIC_CUSTOM_HEADERS` 並寫進文件**：使用者的環境變數能換掉送出的金鑰，帳單會落到別的帳號。
* **拿掉 `x-stainless-*`、換掉 `User-Agent`**：偏離官方 SDK 的行為，供應商除錯時少了資訊。
* **即時模式改用串流**：回應路徑不同，中途出錯也要另外處理。
* **`max_tokens` 封頂在 21,333**：超大單位的譯文會被截斷，對半拆也拆不開單一單位。
* **自己組 `results` 的網址**：少一個請求，但文件沒有保證這個網址形式。
* **送一個帶伺服器端回退參數的極小 Messages 請求**：會花錢，也違反 ADR-0099 第 6 項的斷言。
* **工作區另開一份外送紀錄**：多一個檔案，裡面只有幾列大小 0 的紀錄。
* **契約測試放在 `npm test`**：本機設了金鑰時，跑測試就會花錢。

## Open Questions

- [ ] 即時模式收到 5xx、529、請求被中斷（含超過 10 分鐘的逾時），或本文讀到一半斷線時，會不會計費？官方文件沒寫。這些都原地重送，供應商已經計費時會多付一次，重試行為先不改（維護者 2026-11-02、2026-11-03 的決定）。
- [ ] `results_url` 的主機是不是 `api.anthropic.com`？文件只有範例。主機不同時，第一次真實批次會在收回時回 `egress.denied`。這個前提跟 H-17 一樣，要等第一次真實批次確認。
- [ ] H-17：伺服器端的列表會不會晚於建立的回應出現，要等第一次真實批次確認（ADR-0107）。
- [ ] Opus 5.5、Fable 5.1 的伺服器端回退，要等維護者跑 `tome provider test`（ADR-0103 第 6 項）。
- [ ] 刪除收到 404 時，資料是真的刪掉了，還是在換金鑰之前的帳號？TOME 分不出來，只能回報 `batch.delete_not_found` 請使用者確認（第 24 項）。
