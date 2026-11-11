---
id: ADR-0131
status: accepted
date: 2026-11-12
depends-on: [ADR-0063, ADR-0077, ADR-0109, ADR-0110, ADR-0117, ADR-0129, ADR-0130]
---

# ADR-0131：對外出口的變異測試補強與 Windows 測試卡住的調查

## 脈絡

ADR-0130 第 11 項把 M4 的第一個回合（041）定成只補測試，比照 036：殺 `anthropic.ts` 的存活變異、量逾時的設定、處理 Windows 上 `test` 卡住，不動 `src`。

`main` 最近一次的變異測試是 run 42583693624（`03d55a2`，2026-11-09）。對外出口 256 個變異：殺掉 184、逾時 33、存活 37、沒被測試涵蓋 2，分數 **84.77**（門檻 80，ADR-0110 第 9 項）。`03d55a2` 到 041 開工時的 `1530941`，`src/core/egress/` 與它專屬的測試都沒有改過。

| 檔案 | 變異 | 殺掉 | 逾時 | 存活 | 沒涵蓋 |
| :--- | ---: | ---: | ---: | ---: | ---: |
| `anthropic.ts` | 126 | 92 | 2 | 30 | 2 |
| `client.ts` | 51 | 40 | 7 | 4 | 0 |
| `gate.ts` | 79 | 52 | 24 | 3 | 0 |

Windows 上的 `test (windows-2025)` 在 `main` 的 `acef6c3`（run 42649992786）有 20 個測試 30 秒逾時、11 個暫存資料夾刪不掉（ADR-0129 第 10 項）。

開工前的事實與建議寫在共用筆記 `brief-041-questions.md`，7 項由維護者在 2026-11-12 全部照建議選定。

## 決定

**範圍**

1. 041 只改測試、測試的輔助程式與開發設定，不改 `src/**` 與 `.github/**`（ADR-0130 第 11 項）。對外出口三個檔案沒偵測到的 39 個變異都對照過程式與 SDK 0.137.0 的原始碼，**沒有一個揭露程式的錯**。其他模組的存活變異不在這個回合。

**沒偵測到的變異**

2. 補測試殺掉 33 個，編號是 Stryker 報告裡的變異 ID：

   | 位置 | 變異 | 個數 | 補的測試 |
   | :--- | :--- | ---: | :--- |
   | `anthropic.ts` `FORWARDED` | 拿掉 `^`（2）、拿掉 `$`（3） | 2 | 名稱只是開頭或結尾像白名單的標頭不轉送 |
   | `anthropic.ts` `openTelemetry` | `false` 換 `true`（16） | 1 | 程序裡有全域的 tracer provider 時，也不向它取 tracer（第 4 項） |
   | `anthropic.ts` `retryAfter` | 條件換 true、`&&` 換 `\|\|`、`seconds >= 0` 換 true、`>=` 換 `>`（28、30、31、32） | 4 | `retry-after` 是 0 時讀成 0，是 -1 時讀成 null |
   | `anthropic.ts` `resultLines` | 拿掉 `filter`、條件換 true、`trim()` 拿掉、`''` 換字串（64、67、70、71） | 4 | 結果檔有空行與只有空白的行 |
   | `anthropic.ts` `id` | 換成空字串（75） | 1 | 轉接層的 `id` 是 `anthropic` |
   | `anthropic.ts` `collectBatch` | 查批次沒拿到回應時照樣往下走（88） | 1 | 查批次那一步的本文斷線時，說沒有收到回應，下次照樣收得到 |
   | `anthropic.ts` `collectBatch` | 沒有 `results_url` 照樣下載（90）、錯誤訊息換成空字串（94） | 2 | 批次還沒結束就收結果，丟出帶批次 ID 的錯，什麼都不下載 |
   | `anthropic.ts` `collectBatch` | 下載結果的 `Accept` 拿掉或換空（95、96、97） | 3 | 下載結果時的 `Accept` 是 `application/binary` |
   | `anthropic.ts` `listBatches` | 第一頁也帶 `after_id`（107） | 1 | 第一頁的查詢字串不帶 `after_id`，連空的也不帶 |
   | `anthropic.ts` `anthropicHost` | `endpoint`、`sleep` 的條件與物件（119–126） | 8 | 給了才有這兩個欄位，沒給就只有 `connect` |
   | `client.ts` `EgressBlocked` | 代碼、`count` 參數、名稱換掉（128、129、130） | 3 | 擋下時的代碼、參數與名稱 |
   | `gate.ts` `coverage` | `reach[at] ?? 0` 換 `&& 0`（196） | 1 | 同一個位置開始的例外，長的在前、在後都取最長的 |
   | `gate.ts` `scanText` | 拿掉空例外的過濾（209、212） | 2 | 例外只有空白時忽略它 |

   107 號：變異會送出 `after_id=`（SDK 的 `stringifyQuery` 把 null 寫成空值），假供應商把空字串當成沒有，原本的測試看不出來。

   209、212 號：空字串的 `indexOf` 一直回字串的長度，`occurrences` 停不下來，位置清單長到超過陣列的上限，丟出 `RangeError: Invalid array length`（本機約 1.6 秒）。所以是殺掉，不是逾時。

3. 走不到或等價的 6 個不硬殺：

   * `anthropic.ts` 的 `headers?.get` 換 `headers.get`（19）、`value === undefined` 換 false（26）：SDK 的 `APIError.generate` 在沒有狀態碼或沒有標頭時回 `APIConnectionError`，所以走到 `retryAfter` 的錯誤一定有標頭，`get` 只回字串或 null。
   * `anthropic.ts` 的 `&&` 換 `||`（44）、`status !== undefined` 換 true（45）：狀態碼是 undefined 的 `APIError` 只有連線錯誤（前一個分支已經處理）與 `APIUserAbortError`，後者只在請求帶 `signal` 時丟出，TOME 不帶。其他會丟到這裡的錯誤（`SyntaxError`、`RangeError`、`TomeError`）都沒有 `status`。
   * `anthropic.ts` 的 `() => null` 換 `() => undefined`（102）：下一行不論拿到哪個都回 null。
   * `client.ts` 的 `sent?.model` 換 `sent.model`（137）：本文是 `null` 時，變異丟的 `TypeError` 被下一行的 `catch` 接住，結果一樣是空字串（ADR-0110 第 9 項）。

**測試的輔助程式與相依**

4. 開發相依加 `@opentelemetry/api`，釘 1.10.0。它是 SDK 的必要相依，本來就在 lockfile 與主程式的相依樹裡，版本相同，沒有多裝任何程式；2026-10-20 上架，已過冷卻期（ADR-0077）；授權 Apache-2.0。測試用它註冊全域的 tracer provider，模擬使用者用 `NODE_OPTIONS` 掛了 OpenTelemetry 的自動插樁。ADR-0109 第 2 項的斷言守的是原始碼裡有 `openTelemetry: false,`，這個測試守的是行為。
5. 假供應商（`tests/helpers/fake-provider.ts`）補三個地方：
   * 處理函式丟錯時回 400（`invalid_request_error`），跟真的 API 收到壞掉的請求一樣。原本請求會一直掛到 SDK 的 10 分鐘逾時：`anthropic.ts` L144 的兩個變異（81、82）把批次請求變成 `[undefined]` 或 `[{}]`，假供應商讀不懂就掛住，測試在 30 秒逾時。ADR-0110 把它們歸成「跑得慢但會結束」，對照之後其實是假供應商卡住。改了之後它們幾秒內就被殺掉，對外出口少 2 個會浮動的逾時。
   * `calls` 記查詢字串（第 2 項的 107 號）。
   * 查詢批次時，可以讓前幾次在送出標頭與一半的本文之後斷線，跟 `cutResults` 同一個做法（第 2 項的 88 號）。
6. 本機確認的方式照 ADR-0117 第 3 項：一支 Node 小工具（放 scratchpad，不進 repo）把程式與測試複製到暫存資料夾，`node_modules` 用目錄連結，依 Stryker 報告裡每個變異的位置與替換字串，一次套一個到複本，只跑 `tests/core/anthropic.test.ts` 或 `tests/core/egress.test.ts`。結束碼不是 0 算殺掉，超過時限算逾時。它不是 Stryker，每個變異約 1.3 秒。
   * 用 `1530941` 的測試：39 個存活，81、82 號逾時，跟 run 42583693624 相同。
   * 用這個回合的測試：殺掉 35 個（第 2 項的 33 個，加上 81、82 號），存活的 6 個就是第 3 項的清單。每一個殺掉的變異，失敗的都是為它補的那個測試；81、82 號是批次的幾個既有測試在幾秒內失敗。

**預估與實測**

7. 預估分數照 Stryker 的算法（逾時算偵測到）：(217 + 33) / 256 = **97.66**。CI 的實測見第 8 項。

**逾時設定**

8. （待 CI 實測後補上：A、B 各兩次的分數、殺掉、逾時、存活與 job 時間，以及 `ignoreStatic` 用同一批報告算的分數。）
9. （待維護者看過數字後補上決定。）

**Windows 上 `test` 卡住**

10. 原本的假設是「一個測試卡住，同一個檔案後面的都被拖累」，修法方向是每個測試各用自己的假供應商與假引擎。對照程式，**本來就是這樣**：`tests/cli/batch.test.ts`、`tests/cli/translate.test.ts` 每個測試各自 `startFakeProvider`，測試結束就關；假引擎每次解析都是新的子行程。
11. `acef6c3` 的日誌依每個測試的時間排回時間軸：
    * 從各檔案的開始時間推算，vitest 在 Windows 開了 3 個 worker，`extract`、`batch`、`translate` 三個檔案分在三個 worker。
    * 三個檔案在 16:02:12 左右**同時變慢**，在 16:06:37 到 16:06:43 **同時恢復**。中間這 4 分半，三個 worker 裡正在跑的測試全部逾時，之後的測試回到正常的 1 到 7 秒。
    * 逾時的測試裡，有幾個不連網，也不跑真的引擎：`extract.test.ts` 的 "reports an engine that went quiet or cannot start" 與 "reports a book it does not know" 的引擎是注入的假函式，只建工作區（鍛造 PDF、`init`、`add`），也超過 30 秒。
    * 同一份程式在 PR 上的 `126e78c`（run 42648972212）三個檔案是 34、112、143 秒；`acef6c3` 是 345、410、449 秒。
    * 2026-10-31 到 2026-11-11 的 255 次 Windows `test`，單元測試這一步超過 6 分鐘的只有這一次（607 秒）；Ubuntu 255 次最長 118 秒。

    三個獨立的行程同時變慢、同時恢復，比較像整台 runner 停住，不像某個測試拖累同檔案後面的測試。日誌沒有 CPU、記憶體與磁碟的紀錄，根本原因查不到，標成「未驗證」。
12. 11 個 `EPERM` 都跟在逾時後面：逾時的測試還在背景跑，開著暫存資料夾裡的檔案，`onTestFinished` 的 `rmSync` 就刪不掉。Windows 上資料夾裡還有開著的檔案時刪不掉，Linux 可以。它是逾時的結果，不另外處理；吞掉它的話，以後真的有檔案沒關好，Windows 上就看不到了。
13. 不改測試的行為。不加重試：在同一次執行裡重跑換綠燈，跟「CI 以 attempt 1 為準」衝突。不拉長時限：4 分半的停頓會超過任何合理的時限，拉長只會遮掉真的卡住。不減少 worker：沒有證據會有用，Windows 的 CI 會更慢。
14. 加一個只在逾時時才出聲的診斷：`vitest.config.ts` 的 `setupFiles` 載入 `tests/setup/timeouts.ts`。測試因為逾時失敗時，往 stderr 印一行 `[timeout diagnostics]`，有這個測試的牆鐘時間、這個 worker 在這段時間用掉的 CPU 時間、整台機器的 CPU 忙碌比例與 CPU 數、事件迴圈最長的延遲、系統剩下的記憶體與 worker 的常駐記憶體。讀法：
    * worker 的 CPU 接近牆鐘時間：測試自己在忙。
    * worker 的 CPU 遠小於牆鐘、整台機器很忙：別的行程占著 CPU。
    * 兩者都低、事件迴圈的延遲很長：worker 沒被排到，像整台 runner 停住。
    * 剩下的記憶體很少：可能在換頁。

    下次再發生時，從 CI 的日誌讀這幾行，再決定要不要改測試或 workflow。

## 驗證

<!-- @assert-count target="package.json" regex="true" symbol="@opentelemetry/api.: .1\.10\.0" expected="1" comments="include" reason="第 4 項：開發相依釘 1.10.0" -->
<!-- @assert-count target="tests/core/anthropic.test.ts" symbol="asks no tracer provider for a tracer, even one the process has set up" expected="1" reason="第 4 項：有全域的 tracer provider 也不取 tracer" -->
<!-- @assert-count target="tests/helpers/fake-provider.ts" symbol="invalid_request_error" expected="1" reason="第 5 項：讀不懂的請求回 400，不讓它掛著" -->
<!-- @assert-count target="vitest.config.ts" symbol="setupFiles: ['tests/setup/timeouts.ts']" expected="1" comments="include" reason="第 14 項：逾時診斷" -->
<!-- @assert-present file="tests/setup/timeouts.ts,tests/setup/stall.ts,tests/setup/stall.test.ts" -->

## 後果

對外出口的存活變異只剩走不到或等價的 6 個，分數到不了 100。假供應商不再讓讀不懂的請求掛著，測試寫錯時會在幾秒內失敗，不是等 30 秒逾時。開發相依多一個 `@opentelemetry/api`，SDK 升版時要一起看版本是否相同。

Windows 的停頓沒有修，下次發生時 `test` 照樣會失敗，CI 照樣以 attempt 1 為準；差別是日誌裡會有判斷原因的讀數。

## 替代方案

否決了下列做法：

* **只殺 `anthropic.ts` 的**：`client.ts` 與 `gate.ts` 在同一個模組、同一個門檻，每個只要一兩個斷言。
* **`openTelemetry` 的變異不殺，只靠 ADR-0109 的斷言**：斷言守的是寫法，不是「有全域 provider 時也不送 span」這件事。
* **測試直接 import `@opentelemetry/api`，不寫進 `package.json`**：用了沒宣告的套件，SDK 哪天拿掉它，測試會壞。
* **硬殺走不到或等價的變異**：要在測試裡偽造 SDK 不會產生的錯誤，測的是寫法。
* **順便改 `src` 消掉等價變異**：這個回合不改 `src/**`。
* **Windows 加重試、拉長時限或減少 worker**：見第 13 項。
* **Windows 吞掉暫存資料夾的 `EPERM`**：見第 12 項。
* **在本機跑 Stryker**：不在維護者的電腦上跑長時間的工作（ADR-0110）。

## Open Questions

- [ ] Windows 上 runner 整台停住的根本原因（第 11 項），等下次發生時讀第 14 項的診斷。
