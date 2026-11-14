---
id: ADR-0138
status: accepted
date: 2026-11-14
depends-on: [ADR-0027, ADR-0028, ADR-0034, ADR-0039, ADR-0054, ADR-0055, ADR-0059, ADR-0068, ADR-0082, ADR-0119, ADR-0120, ADR-0127, ADR-0130, ADR-0135]
amends: [ADR-0039, ADR-0119, ADR-0127]
---

# ADR-0138：審定網頁、審定門檻與下一步

## 脈絡

ADR-0130 把回合 047 排成審定介面：第一版除了 CLI，還有一個審實體卡的本機網頁，只接受本機位址的連線（第 3、4 項）；先只審實體卡（第 5 項）；審定門檻不再把 `gender: none` 與跟類別預設相同的代名詞算成要人審（第 6 項）；`tome status` 指出下一步（第 16 項）。M3 收尾時 book1 改 YAML 審 332 筆花了約 2 小時，這是第一版每個使用者都要過的關卡。045 的試翻實測另外找到 `tome run` 停下時，接著要跑的 `tome run` 漏了 `--trial` 與 `--realtime`。

幾個前提：

* ADR-0039 的斷言擋下 `src/core/egress/` 以外 import `node:http`、`node:net` 等，也擋下整個 `src` 呼叫 `fetch`、`WebSocket`、`EventSource`、`XMLHttpRequest`（含 `.js` 檔）。
* 核心只回傳英文代碼與參數，`src` 的 `.ts` 不放中文；子行程只經過 `src/core/process.ts`（ADR-0082）。
* 沒有常駐服務，每本書同時只跑一個流程（ADR-0054）。
* `package.json` 的 `files` 只發佈 `dist` 與資料目錄，`tsc` 只輸出 `.ts` 編出的檔。

開工前的 12 項問題寫在共用筆記 `brief-047-questions.md`，維護者在 2026-11-14 選定：第 3 項伺服器與網頁放 `src/cli/review/`（外層），其餘照建議，另外指定頁面的中文放訊息檔、開瀏覽器經過 `src/core/process.ts`。實作時的細節寫在 `brief-047-details.md`。

## 決定

**網頁與伺服器**

1. **前端手寫**：HTML、CSS 與原生 JavaScript，不用框架、不用建置步驟、不加任何相依（問題第 1 項）。
2. **伺服器用 `node:http`**，只聽 `127.0.0.1`，埠號讓系統挑；每次啟動產生 24 位元組的隨機權杖（base64url 32 個字元），放在網址路徑的第一段，對不上就回 404（問題第 2 項）。
   * `Host` 必須是 `127.0.0.1:<埠號>`，不對回 421，擋 DNS rebinding；寫入的請求（POST）的 `Origin` 必須是 `http://127.0.0.1:<埠號>`，沒有或不對回 403，擋別的網站代送；不開 CORS。
   * 只收表單格式（`application/x-www-form-urlencoded`），其他回 415；超過 64 KiB 回 413。
   * 每個回應都帶 `Cache-Control: no-store` 與 `Content-Security-Policy: default-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`，另加 `X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`。`default-src` 管不到表單送去哪、誰能把頁面嵌進去，多的三項補上（實作細節）。`Referrer-Policy` 不能用 `no-referrer`：瀏覽器照 Fetch 的規定，這時表單的 `Origin` 送 `null`，自己的表單會被 Origin 的檢查擋下；這是在瀏覽器裡實際點過才找到的。
3. **伺服器與網頁放 `src/cli/review/`**，卡片的讀寫與驗證留在核心（`src/core/glossary.ts` 的 `reviewOnWeb` 與 `ReviewSession`）（問題第 3 項，維護者選了替代方案）。頁面的中文放 `src/cli/messages/zh-TW.json` 的 `review_page`，由伺服器組進頁面，`src/cli/review/` 不寫中文。**修改 ADR-0039 的斷言**：`node:http` 只對 `src/cli/review/server.ts` 放行，而且只 import `createServer`；`node:https`、`node:net`、`fetch` 等照樣禁止；另加斷言：只聽 `127.0.0.1`、不呼叫 `http.request` 與 `http.get`。
4. **指令是 `tome glossary review <書> --web`**，前景執行，Ctrl+C 結束（問題第 4 項）。在 stderr 印網址，經過 `src/core/process.ts` 打開預設瀏覽器（CLI 注入的 `runTool`）：Windows 用 `rundll32 url.dll,FileProtocolHandler <網址>`，不經過 `cmd`，網址裡的符號不會被當成指令；macOS 用 `open`；其他用 `xdg-open`。不等它回來（有些平台的瀏覽器開著就不回來），打不開時印一行請人手動開。`--no-open` 不開。`tome run` 停在審定時建議 `--web`，`glossary.pending` 也是；YAML 的用法寫在 `--help`。
5. **YAML 審定檔照舊能用，`book.db` 是唯一的依據**（問題第 5 項）。網頁啟動時先照 `tome glossary review` 讀回審定檔、套用填了 `decision` 的列、收 `<new-term>`、自動鎖定、寫出；開著時每個決定直接寫進 `book.db`；結束時照 `book.db` 重寫審定檔，記下 `review_written`（ADR-0119 第 7 項）。審定檔讀不懂時不開網頁（`glossary.file_invalid`）。實作細節：
   * 網頁上決定過的卡，審定檔裡照人填的樣子留著的那一列不再留，網頁的決定比較晚。其他沒套用的列照舊留著。
   * 網頁開著時審定檔被改過（內容跟啟動時寫出的不同），結束時不覆寫，印 `glossary.web_file_changed`（warn），請人再跑一次 `tome glossary review` 讀回。人改的不會不見；資料庫在網頁上改過的卡，下次讀回時照 ADR-0119 第 7 項分得出誰改的。
6. **網頁上的鎖定與拒絕都記 `decided_by: human`**，跟審定檔裡人填的一樣，不加新的值（問題第 6 項）。
7. **書本文字只在本機的連線上傳**，不寫進瀏覽器的儲存（問題第 7 項）。搜尋的字可能是書本文字，網址會留在瀏覽紀錄，所以篩選條件用表單送給伺服器、存在記憶體裡，Ctrl+C 就沒了；決定之後的轉址只帶分頁、編號與 S-16 的數量（實作細節）。訊息、`--json` 與紀錄只有數量與編號。
8. **功能**（問題第 8 項）：
   * 三個分頁照審定檔的三段：待人審（照影響由大到小）、已鎖定、不是專有名詞。
   * 每張卡顯示原文、出現次數、來源、出現的句子；可改譯名、類別、性別、代名詞、語域、`keep_source` 與比對條件（大小寫、整個詞、角色勾選）；鎖定與拒絕。
   * 驗證跟審定檔用同一個 `checkCard`（ADR-0119 第 8 項）。不合時那張卡照人填的樣子放回去，標出欄位、聚焦在它上面（HTTP 422），什麼都不改。譯名欄是必填，類別、性別、代名詞是下拉選單。
   * 鎖定已鎖定卡的新譯名時當下做 S-16（ADR-0120），頁面上說換了幾處。
   * 搜尋原文或譯名（不分大小寫），篩類別（含沒有類別）與有沒有提議。
   * 鍵盤：`j`、`↓` 下一張，`k`、`↑` 上一張，`l` 鎖定，`x` 拒絕，`e` 編輯譯名，`/` 搜尋；欄位裡 `Enter` 鎖定、`Esc` 離開欄位。決定之後聚焦在下一張，最後一張就往前一張。
   * 不做一次鎖定全部（ADR-0055 第 3 項的關卡）、校稿、報告與 `overrides`。

   **頁面由伺服器組好，表單送回本機的伺服器，瀏覽器不另外連線**（實作細節）。ADR-0039 的 `fetch` 等斷言掃整個 `src`，含網頁的腳本；用表單，頁面就沒有任何連網的 API，那一條斷言不用改。腳本只處理鍵盤與聚焦，沒有腳本也能用。代價是驗證在送出時才做。
9. **網頁開著的整段時間拿著書的鎖**（ADR-0054 第 5 項），同一本書的其他指令這段時間不能跑；`tome status` 不拿鎖，照樣能看（問題第 9 項）。

**審定門檻**

10. **修改 ADR-0119 第 9 項**（ADR-0130 第 6 項，問題第 10 項）：`gender: none` 與跟類別預設相同的代名詞不算要人審。預設代名詞照規則包繼承鏈由子到父找類別的 `default_pronoun`，跟 `review_weight` 的找法相同；`person` 沒有預設，有代名詞照樣要人審；沒有類別的卡有代名詞也要人審。門檻 5 不變。新的規則從下一次 `tome glossary review`（或網頁啟動）起套用到還在 `proposed` 的卡，符合的自動鎖定，`decided_by` 是 `auto`；已鎖定、已拒絕的卡不動。
    * **量測**（成熟度：已量測）：2026-11-14 在 book1 的 `book.db` 唯讀暫存複本上量，只印數字，量完刪掉。858 張卡：已鎖定 653（人審 332、自動 321）、略過 205。人審的 332 張裡，舊規則要人審 331 張，新規則 290 張，**少 41 張**，都是代名詞跟類別預設相同；只因 `gender: none` 而少的 0 張。人審的卡裡出現次數乘權重不到 5 的有 167 張。

**下一步**

11. **`tome status` 多印一行下一步**（`status.next`、`status.next_failed`、`status.next_assemble`），`--json` 的 `data.next` 是 `{ step, command }`；順序跟 `tome run` 的關卡相同（ADR-0130 第 16 項，問題第 11 項）：

    | 狀態 | 下一步（`step`） |
    | :--- | :--- |
    | 還沒解析乾淨 | `tome extract <書>`（`extract`） |
    | Pass 0 還沒估價、還有候選詞沒送，或 Pass 0 的批次沒收回 | `tome scan-terms <書> --confirm`（`scan`） |
    | 還有待人審的卡 | `tome glossary review <書> --web`（`review`） |
    | 還沒有翻譯單位，或沒確認過翻譯的估價 | `tome estimate <書> --confirm`（`estimate`） |
    | 有翻譯的批次沒收回 | `tome batch collect <書>`（`collect`） |
    | 範圍內還有要送的單位 | `tome translate <書>`（`translate`） |
    | 範圍內有沒翻成的單位 | `tome translate <書> --retry-failed`，或直接輸出（`retry`，只是提醒） |
    | 都好了 | `tome assemble <書>`，之後 `tome report <書>`（`assemble`） |

    最近一次確認的估價是即時模式、而且沒有沒收回的批次時，`scan-terms`、`estimate`、`translate` 帶 `--realtime`。`tome status` 照舊不拿鎖、不連網，**也不重新估價**，只看 `book.db` 記下的（實作細節）：解析乾淨做完才記的 `document`、Pass 0 估價時記的 `scan-estimate`、確認估價時記的 `estimate`，與卡、單位、批次的狀態。所以確認之後內容又變了（例如又鎖定了卡），`tome status` 看不出估價過期，會說 `tome translate`，`tome translate` 會擋下、請人重新確認；Pass 0 的提要沒送成時也看不出。`--trial` 不存檔（ADR-0135），試翻不在這個順序裡。
12. **修改 ADR-0127 第 3 項**：`run.stopped` 多一個參數 `rerun`，是接著要跑的 `tome run`，帶上這次的 `--trial` 與 `--realtime`（兩個都不存進 `book.yaml`），訊息改用它；`--json` 的 `data` 多一個 `rerun`，沒停在關卡時是 null（問題第 12 項）。審定的關卡建議 `tome glossary review <書> --web`（第 4 項）。

**發佈與測試**

13. **靜態的 CSS 與 JS 寫成 `src/cli/review/assets.ts` 的字串常數**，跟程式一起由 `tsc` 編出、隨 `dist` 發佈；不改 `package.json` 的 `files`，沒有建置步驟，發佈的就是審過的原始碼（成熟度：已實作）。
14. **測試**：伺服器用 vitest 起真的本機伺服器測（`tests/cli/review-web.test.ts`），用 `node:http` 自己組 `Host` 與 `Origin`；頁面的 HTML 與篩選另外測（`tests/cli/review-page.test.ts`）。不加瀏覽器自動化的相依；鍵盤的腳本沒有自動測試。2026-11-14 執行的 session 用合成的書在桌面版的內建瀏覽器（Chromium）點過一次：鍵盤移動、編輯、鎖定、拒絕、搜尋、驗證沒過的標示與聚焦、結束時重寫審定檔都照預期。點的時候找到兩個自動測試沒抓到的錯，已修正並補上測試：`Referrer-Policy: no-referrer` 讓表單的 `Origin` 變成 `null`、被自己擋下（第 2 項）；驗證沒過的頁面在 `cards/<id>/lock` 送回來，相對的網址接錯地方，改成頁面裡的網址都從權杖寫起。維護者自己再點一次（Open Questions）。

15. **變異測試**（成熟度：已量測）。`mutation-lines` 在 CI 跑了四輪，每一次 attempt 1 都成功；各輪的 run id、範圍與每個存活的分類寫在共用筆記 `brief-047-details.md`。
    * 第一輪（`8258bca`，5 次）：範圍寫成整段，連帶掃到沒改的舊程式。74.15、73.21、85.77、78.10、65.94。
    * 第二輪（`5fce54a`，5 次）：補了測試、刪掉走不到的分支，只跑改過的行。93.75、92.74、98.91、94.93、97.76。
    * 第三輪（`1722eb4`，3 次）：第一輪掃到、沒改的舊行，比照 045（ADR-0135 第 18 項）也補了測試。90.12、95.00、98.18。
    * 第四輪（`abc791e`，3 次）：第二、三輪能殺的行，加上 `FieldContext` 改的行。100、100、100。

    剩下的存活都分類過，沒有能殺的：
    * **等價**：`policyOf` 的 `kind ?? ''` 換成別的字串（類別名照 schema 只有小寫英數與 `-`、`_`，查不到任何類別）；審定檔也替已鎖定的卡算上下文（`locked` 段不寫 `seen_in`，只差效能）；沒有 Content-Type 時的預設字串（都不是表單，同樣回 415）；`request.resume()`（回應結束時 Node 自己丟掉沒讀的本文）；`collectNewTerms` 的 `detail === null`、讀不懂時的 `catch`、`found.size === 0`（後面照樣跳過或回 0）；`matchOf` 一律寫 `roles: undefined`（YAML 不寫 undefined 的鍵，其他地方用 `?? []`）。
    * **走不到**：上下文的 `?.` 與 `?? []`（啟動時對三段的卡都算過）；`COUNT(*)` 的 `?.count`；`split` 的 `[0]?.`；請求的 `url ?? '/'` 與路徑的預設值；送出之後的 `headersSent` 分支；`listen` 的 `error`（在 `127.0.0.1` 聽系統挑的埠不會失敗）；S-16 的 `value ?? ''`；語域欄的 `marks('register', …)`（表單送來的一定是字串）。
    * **測不出來**：`reviewLocked` 的 `finally` 裡的 `store.close()`。連線沒關要等 GC 才放掉，Linux 上刪暫存檔不受影響，沒有可觀察的行為。
    * **刪掉的分支**（行為不變，共 7 處）：`policyOf` 查 `Map` 之前的 null 判斷、`nextAfter` 對不在這一頁的編號的特例、聚焦編號的整數判斷、埠號的保底值、空搜尋的判斷、`checkbox` 的預設參數（`5fce54a`），與一律是 true 的 `FieldContext.focus`（`abc791e`）。

## 驗證

<!-- @assert-import-absence target="src" exclude="src/core/egress/**" module="node:https node:http2 node:net node:tls node:dgram node:dns https http2 net tls dgram dns undici axios node-fetch got ky ws @anthropic-ai/sdk openai @google/genai" reason="ADR-0039：對外連線與供應商 SDK 只能在對外出口模組（從 ADR-0039 移來，node:http 另外一條）" -->
<!-- @assert-import-absence target="src" exclude="src/core/egress/** src/cli/review/server.ts" module="node:http http" reason="第 3 項：node:http 只放行審定網頁的伺服器" -->
<!-- @assert-count target="src" symbol="from 'node:http';" expected="1" reason="第 3 項：整個 src 只有一行 import node:http" -->
<!-- @assert-count target="src/cli/review/server.ts" symbol="import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';" expected="1" reason="第 3 項：只拿 createServer，不拿 request、get" -->
<!-- @assert-absence target="src" regex="true" symbol="\bhttp\.(request|get)\s*\(" reason="第 3 項：不呼叫 http.request、http.get" -->
<!-- @assert-count target="src" symbol=".listen(" expected="1" reason="第 2 項：只有一處開始聽" -->
<!-- @assert-count target="src/cli/review/server.ts" symbol="server.listen(0, '127.0.0.1'," expected="1" reason="第 2 項：只聽 127.0.0.1，埠號由系統挑" -->
<!-- @assert-count target="src/cli/review/server.ts" symbol="const token = randomBytes(24).toString('base64url');" expected="1" reason="第 2 項：每次啟動一個隨機權杖" -->
<!-- @assert-count target="src/cli/review/server.ts" symbol="if (request.headers.host !== `${HOST}:${port}`) throw new Refused(421);" expected="1" reason="第 2 項：Host 不對就擋" -->
<!-- @assert-count target="src/cli/review/server.ts" symbol="if (request.headers.origin !== `http://${HOST}:${port}`) throw new Refused(403);" expected="1" reason="第 2 項：寫入的 Origin 不對就擋" -->
<!-- @assert-count target="src/cli/review/server.ts" symbol="'Cache-Control': 'no-store'," expected="1" reason="第 2 項：回應不快取" -->
<!-- @assert-count target="src/cli/review/server.ts" symbol="default-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" expected="1" reason="第 2 項：頁面不載入外部的東西" -->
<!-- @assert-absence target="src" symbol="Access-Control-Allow" reason="第 2 項：不開 CORS" -->
<!-- @assert-count target="src/cli/review/server.ts" symbol="'Referrer-Policy': 'same-origin'," expected="1" reason="第 2 項：no-referrer 會讓表單的 Origin 變成 null" -->
<!-- @assert-absence target="src/cli/review" regex="true" symbol="\b(localStorage|sessionStorage|indexedDB|cookie)\b" reason="第 7 項：書本文字不進瀏覽器的儲存" -->
<!-- @assert-count target="src/cli/review/web.ts" symbol="void options.tool(command, args, options.env)" expected="1" reason="第 4 項：瀏覽器經過 process.ts 的執行器打開" -->
<!-- @assert-count target="src/cli/review/web.ts" symbol="if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };" expected="1" reason="第 4 項：Windows 不經過 cmd" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="return withBookLock(options.home, options.slug, () => reviewLocked(options, options));" expected="1" reason="第 5、9 項：先讀回審定檔，網頁開著時拿著書的鎖" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="lock(store, row, checked.card, 'human');" expected="2" reason="第 6 項：審定檔與網頁的鎖定都記 human" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="const unchanged = !existsSync(path) || readFileSync(path, 'utf8') === written;" expected="1" reason="第 5 項：網頁開著時審定檔被改過就不覆寫" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="(row.gender !== null && row.gender !== 'none') ||" expected="1" reason="第 10 項：gender: none 不算要人審" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="(row.pronoun !== null && row.pronoun !== policy.pronounOf(row.class)) ||" expected="1" reason="第 10 項：跟類別預設相同的代名詞不算要人審" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="row.occurrences * policy.weightOf(row.class) >= REVIEW_THRESHOLD" expected="1" reason="ADR-0119 第 9 項：出現次數乘權重（從 ADR-0119 移來）" -->
<!-- @assert-count target="src/core/glossary.ts" symbol="if (needsHuman(row, policy) || row.target === null || touched.has(row.id)) continue;" expected="1" reason="ADR-0119 第 7、9 項：要人審的、沒譯名的、人改壞的不自動鎖定（從 ADR-0119 移來）" -->
<!-- @assert-count target="src/core/status.ts" symbol="if (progress.review > 0) return { step: 'review', command: `tome glossary review ${book} --web` };" expected="1" reason="第 11 項：下一步建議網頁" -->
<!-- @assert-count target="src/core/pipeline.ts" symbol="if (reviewed.findings.length > 0) return gate('review', `tome glossary review ${slug} --web`);" expected="1" reason="第 4、12 項：tome run 停在審定時建議網頁" -->
<!-- @assert-count target="src/core/pipeline.ts" symbol="finding('run.stopped', 'warn', { book: slug, command, rerun })" expected="1" reason="第 12 項：接著要跑的 tome run 帶上 --trial 與 --realtime" -->

測試只用合成的詞（`tests/cli/review-web.test.ts`、`tests/cli/review-page.test.ts`、`tests/cli/glossary.test.ts`、`tests/cli/status-next.test.ts`、`tests/core/status.test.ts`、`tests/cli/tome-run.test.ts`），確認訊息與 `--json` 不含原文、譯名與上下文。

## 後果

審實體卡不必再一筆一筆找、打字：照影響排好、就地驗證、一鍵鎖定。YAML 審定檔照舊能用，大量貼上或習慣改檔的人不受影響，兩邊用同一套驗證與 S-16。`node:http` 進了 `src`，但只在一個檔、只能開伺服器、只聽本機位址，斷言把關。網頁不連外、不存東西，書本文字跟審定檔一樣只在這台電腦上。代價是伺服器端組頁面：每次決定都重新載入整頁，驗證要送出才做；三百多張卡一次組好，沒有分頁。

`tome status` 說得出下一步，指令多的代價（ADR-0055 的後果）小一些；它不重新估價，看不出確認後過期的估價，要等 `tome translate` 擋下。

## 替代方案

* **小型的元件函式庫或 React、Vue 加建置工具**：寫元件比較順，但每個套件都要過授權、冷卻期與供應鏈的審查，還要建置步驟。
* **頁面用 `fetch` 跟伺服器拿資料、送決定**：不用每次重新載入，但 ADR-0039 的 `fetch` 斷言要為網頁的腳本開例外，「其他程式不得自己連網」就多一個要靠人看的地方。
* **CSS 與 JS 放獨立的檔**：好編輯，但要改受保護的 `package.json` 的 `files`，發佈的內容多一個要對的地方。
* **伺服器放在核心的獨立模組**（問題第 3 項的建議）：維護者選了外層，核心照舊是不連網、不開伺服器的函式庫（ADR-0028）。
* **固定埠號、不用權杖**：網址好記，但本機任何程式與網頁都能讀寫這本書的實體卡。
* **新指令 `tome review <書>`**、**網頁取代 YAML**、**網頁當 YAML 檔的編輯器**、**`decided_by` 加 `web`**：見問題第 4 到 6 項。
* **把 `--trial` 與模式存進 `book.yaml`**：牽動 ADR-0127 與 ADR-0135，範圍大。

## Open Questions

- [ ] 維護者用合成的書在自己的瀏覽器實際點一次：鍵盤、聚焦、表單、淺色與深色。執行的 session 只在內建瀏覽器的深色模式點過（第 14 項）。
- [ ] 三百多張卡一次組好的頁面在瀏覽器裡夠不夠快，要不要分頁；等 book1 這類的書實際用過再定。
- [ ] `tome status` 要不要重新估價，才看得出確認後過期的估價；現在不拿鎖、不寫 `book.db` 的做法下做不到。
