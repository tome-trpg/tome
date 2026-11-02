---
id: ADR-0104
status: accepted
date: 2026-11-02
depends-on: [ADR-0017, ADR-0034, ADR-0035, ADR-0036, ADR-0038, ADR-0039, ADR-0044, ADR-0055, ADR-0062, ADR-0077, ADR-0099, ADR-0102, ADR-0103]
amends: [ADR-0038, ADR-0099]
---

# ADR-0104：對外出口與即時模式的細節

## 脈絡

brief 018 開工前比對 ADR-0099、ADR-0017、ADR-0038、ADR-0039 與白皮書 §5.7、§8.2，留下這些沒定的細節：SDK 還不能加的時候回合怎麼切，對外出口的形狀，個資閘門怎麼比對，重試、拒答與截斷怎麼處理，重送要不要附上原因。

`@anthropic-ai/sdk` 0.137.0 要到 2026-11-03 22:23 UTC 才過冷卻期（ADR-0077），整個回合等下去 M2 要停約兩天。

下列決定都由維護者在 2026-11-02 從問題介面選定。重試的次數與秒數都是**提案**，沒有量過，要等真實請求才知道合不合適。

## 決定

**回合**

1. 修改 ADR-0099 第 1 項：018 拆成兩個 brief。018 是對外出口、個資閘門、外送紀錄、假供應商、重試、拒答、`tome translate --realtime` 的流程與 `tome preview`。022 是 SDK、Anthropic 轉接層、`fast-sha256` 的例外、`tome provider list`、`tome provider test` 與 `tests/contract/`。019 的 Batch 也要 SDK，所以順序是 018、022、019、020。

**對外出口**

2. `src/core/egress/` 有 `gate.ts`（個資閘門）與 `client.ts`（`fetch` 包裝），轉接層 `anthropic.ts` 在 022 才有。對外只有 `guardedFetch`，依序檢查主機、掃描序列化後的完整請求本文、寫外送紀錄，都過了才送。
3. 白名單是 `providers/anthropic.yaml` 的 `endpoint`，規則包碰不到這個檔（ADR-0044）。測試的本機伺服器用函式參數注入，不開環境變數，使用者改不了端點。
4. 轉址當成失敗，否則會離開白名單。`Request` 物件與不是字串的本文不送：沒看過的內容不能算掃描過。
5. 外送紀錄是 `book.db` 的 `egress` 表，遷移第 5 版，欄位是 `id`、`content_hash`、`provider`、`model`、`bytes`、`created_at`。`content_hash` 是請求本文的 SHA-256。紀錄在送出之前寫，因為請求送到一半失敗時，內容可能已經離開這台機器。

**個資閘門**

6. 比對前兩邊都做 NFKC、不分大小寫、連續空白視為一個。比對字串，不用正規表示式。`pii_exceptions` 做同樣的正規化。例外只免除它完整蓋住的命中：比對位置，命中落在某個例外的範圍內才不算，比例外長的項目照樣命中。購買者跟 NPC 同名時，把名字加進例外不會放過浮水印上的全名。
7. 比對的是解開 JSON 與標籤跳脫之後的文字，否則換行與 `&amp;` 會讓比對落空。
8. 清單項目少於 3 個字元時，`tome estimate` 與 `tome doctor` 警告，太短會誤判。
9. 命中時整個請求的單位標成 `BLOCKED`，流程停下，回報命中幾次，不列出命中的文字，因為那就是個資。`issue` 記下命中位置，只留在工作區（DC-1）。
10. `tome translate --dry-run` 用同樣的內容檢查閘門，命中時結束碼 1。它什麼都不送，所以不動單位狀態。

**重試**

11. 只重試 429、5xx 與網路錯誤，最多 5 次，退避 1、2、4、8、16 秒，有 `retry-after` 時用它。其他 4xx 不重試。M2 的即時模式一次一個請求，不併發，不另外做 RPM 限流。

**拒答**

12. 修改 ADR-0038 第 3 項，順序以白皮書 §5.7 為準：請求被拒時對半拆，用原模型重送，拆到單一單位還被拒，有 `fallback_model` 就改送，都不行就是 `REFUSED`。先對半拆才找得出有問題的單位，其他單位照常用原模型完成。
13. 即時與 Batch 都由 TOME 自己重送，不用伺服器端的 `fallbacks`。Batches API 不支援這個參數，兩條路用同一套程式，帳本也算得準。代價是快取失效，M2 沒開快取。
14. 拒答的請求也寫帳本，官方寫部分類別要付費。每次重送都過 `checkBudget`。`stop_details.category` 存進 `issue`，交付報告看得到。

**截斷**

15. `stop_reason` 是 `max_tokens` 時對半拆重送，算一次 `attempts`，不用同樣大小再送一次。沒得拆就是 `FAILED_QA`。

**重送**

16. 重送時，失敗的原因放在 `user` 的 `<s>` 前面，用 `<feedback>` 包住，每個原因是一個 `<problem id="…">`。原因只有說明，不放譯文。
17. 重送與對半拆時，同組的其他單位當上下文帶上。

**流程**

18. `tome translate --realtime` 沒有確認估價時結束碼 1。之後每個請求依序檢查預算、掃描個資、送出並寫 `egress`、收回並寫 `response` 與 `ledger`、驗證，通過的進翻譯記憶，失敗的回 `QUEUED`，直到沒有 `PENDING`、`QUEUED` 的單位。送出前先查翻譯記憶，命中的不送。超過預算就停，保留進度。
19. 沒帶 `--realtime` 也沒帶 `--dry-run` 時維持 `translate.not_ready`，019 才有 Batch。

**估價模式**

20. `tome estimate --realtime` 用即時價格估價，跟 `tome translate --realtime` 同一個字。`tome translate --dry-run --realtime` 也一樣。
21. 模式不存進 `book.yaml`。確認時模式進指紋，模式對不上就回報 `translate.not_confirmed`，訊息寫明要用哪個旗標重新確認。

**`tome preview`**

22. 產生 `books/<slug>/review/`，每章一個檔，`01.md`、`02.md`，第一章之前的內容是 `00.md`，沒有章節的書是 `01.md`。每段是 `<!-- block_id -->`、原文、`> 譯文`。
23. 狀態不是 `DONE` 的單位只有原文，並標明狀態。`BLOCKED` 的單位不放原文（白皮書 §6.2）。訊息只有檔案數與路徑。

**假供應商**

24. `tests/helpers/fake-provider.ts` 是本機 HTTP 伺服器，先說 Anthropic Messages，腳本化拒答、漏佔位符、429、5xx、截斷。ADR-0062 寫三種協定，M2 只有一種。

**沒有 SDK 的這段時間**

25. 流程先寫好，轉接層是介面 `LLMProvider`，由呼叫端注入。CLI 的 `Io` 多一個測試用的 `llm`，沒注入時 `tome translate --realtime` 維持 `translate.not_ready`，022 才接上真的轉接層，使用者看到的行為這段時間不變。

**續跑與重試額度**

26. `tome translate --retry-failed` 在 018 一起做。沒有它，使用者處理完個資也無法續跑。
27. `attempts` 只算模型回了譯文的次數，含截斷。拒答不算，否則對半拆幾次就用完額度，跟品質無關。429、5xx 與網路錯誤也不算。
28. `tome translate --realtime` 開始時先收尾：`RECEIVED` 的回應已經存了，直接重跑驗證，不重送。`IN_FLIGHT` 回到 `QUEUED` 重送，即時模式沒有遠端批次可認。這一筆可能付過錢，但單位還沒驗證，符合 Q-7 只保證已驗證單位不重付。

**重送的內容**

29. 同組的其他單位放進 `<context>`，排在上文前面，一起受 800 字元上限，超過時留前面的部分，表頭才留得住。提示那句話不夠精確，但不用改審過的文字。
30. `<feedback>` 的句子放 `prompts/feedback.yaml`，算進 `prompt_hash`，核心不放文字。七種重送代碼的句子由維護者審過：

| 代碼 | 句子 |
| :--- | :--- |
| `number_missing` | `A number from the source is missing: {numbers}` |
| `placeholder_mismatch` | `A placeholder is missing or repeated.` |
| `tag_error` | `The tags in this unit are not valid.` |
| `unit_missing` | `This unit was missing from your reply.` |
| `term_missing` | `Use the locked translation of {term}: {target}` |
| `script_mixed` | `Simplified Chinese was found: {found}` |
| `too_short` | `The translation is too short. Translate everything.` |

31. `prompts/translate.md` 的 Input 段加一句 `<feedback> lists what was wrong with your last attempt at a unit, by id. Fix those problems in this attempt.`，其他審過的文字不動。

**模組與代碼**

32. 模組是 `src/core/llm.ts`（介面與重試）、`src/core/translate.ts`（流程）、`src/core/preview.ts`。新的發現是 `pii.too_short`、`translate.provider_failed`，`issue.code` 多 `pii_hit`、`refused`、`truncated`。
33. `translate.done` 用同一個代碼回報成果，有單位卡住時層級是 fail，結束碼 1。

**實作前補定的細節**

34. `--retry-failed` 放回佇列時 `attempts` 歸零，否則 `FAILED_QA` 再失敗一次就直接放棄。`BLOCKED` 走 `release`，`FAILED_QA`、`REFUSED` 走 `retry`。放回之後還是要過確認估價、預算與閘門。
35. 請求有回覆時，那個請求的單位都算一次 `attempts`，回覆漏掉的單位也算，否則模型一直漏同一段就永遠跑不完。拒答與 429 仍然不算。
36. 存進資料庫的 `STALE` 開始時跟 `RECEIVED` 一樣，用存下來的回應重跑驗證，不重送。估價把它算進去的現況不動。
37. `fallback_model` 進內容指紋，改了要重新確認：它決定內容會不會送到另一個模型，也影響費用。設了表上沒有的模型時，開跑前就回 `model.unknown`，不等到被拒才發現。
38. 估價與試算回覆的 `data` 多 `mode` 欄位，`--json` 才看得出這個估價是哪個模式。

**轉接層的介面**

39. 修改白皮書 §5.7 的提案：轉接層只回 `outcome`、`requestId`、`text` 與 `usage`，拒答多帶 `category`，錯誤帶 `status` 與 `retryAfter`。解析與判斷拒答、截斷的函式放在核心，每個協定不用各寫一次，019 的 Batch 共用，`succeeded` 但 `stop_reason` 是 `refusal` 的情況才不會漏。多一個 `sdkVersion`，翻譯記憶要存。018 只有 `send`，Batch 的方法 019 再加。

**翻譯記憶**

40. 輪到一個請求時才查那個請求的 `PENDING` 單位，不在開頭一次查完。同一本書後面重複的段落，才吃得到前面剛翻好的記憶。命中的從請求拿掉，整個請求都命中就不送。估價不因此改變，它本來就是上限。
41. `prompt_hash` 是靜態前綴加上 `prompts/feedback.yaml` 全文的 SHA-256，`pack_hash` 是規則包繼承鏈解析後內容的 SHA-256，不含路徑，`sdk_version` 由轉接層提供。內容指紋用同樣的 `prompt_hash` 與 `pack_hash`，所以 `prompts/feedback.yaml` 或規則包改了都要重新確認估價：詞條與角色風格不在靜態前綴裡，卻會改變實際送出的內容。
42. 翻譯記憶命中時寫一列 `response`，`attempt` 是 0，`model` 取記憶裡的模型，文字是記憶裡的片段，`tome verify` 才驗得到。續跑時重跑驗證的 `RECEIVED` 單位用當下的雜湊寫進記憶，不為了它在 `response` 加欄位：提示或規則包在中斷期間變了的話，指紋會變，要重新確認。

**對半拆與截斷**

43. 對半拆依單位數，前半多一個。截斷時已經完整的 `<s>` 也不用，不寫 `response`。截斷的回應與拒答一定要寫 `ledger`，否則預算少算已經付的錢。
44. 截斷的單位不留在 `RECEIVED`：續跑時 `RECEIVED` 要讀存下來的回應，這裡沒有。`receive` 之後的 `fail` 或 `give_up` 在同一個交易走完。請求有多個單位時，到上限的單位變 `FAILED_QA`，其他單位照常拆。

**旗標與訊息**

45. `--retry-failed` 沒帶 `--realtime` 時跟 `tome translate` 一樣回 `translate.not_ready`，019 才有 Batch。`--dry-run --retry-failed` 回 `cli.bad_args`：默默略過的話，試算的數字沒算到要重試的單位。022 接上真的轉接層之前，`tome --help` 不列翻譯用的 `--realtime` 與 `--retry-failed`，`tome estimate --realtime` 與 `tome preview` 會列。
46. `translate.not_confirmed` 的參數是 `book`、`flags`，`translate.provider_failed` 是 `status`，沒有收到回應時是 `-`，非 429 的 4xx 不重試，一樣走這個代碼，訊息不放回應內容。`pii.too_short` 是 `entries`，列清單第幾項，從 1 算起，不列內容。`translate.done` 是 `done`、`total`、`blocked`、`failed`、`refused`、`left`、`spent`。`preview.done` 是 `files`、`path`。
47. 每完成一個請求，在 stderr 印已完成的單位數，不影響 `--json` 的 stdout。

**`tome preview` 的細節**

48. 重建時依檔名規則刪 preview 產生的 `.md`，不遞迴，不刪整個資料夾。章節變少時舊檔要清掉，使用者放在裡面的其他檔案要留著。
49. 標明狀態用 `> [!untranslated] FAILED_QA`，只放狀態代碼，核心不放給人看的文字。`BLOCKED` 只有 `<!-- block_id -->` 與 `> [!untranslated] BLOCKED`。還沒有任何單位時是 `preview.done`，0 個檔案，不算錯。表格每個儲存格一段，跟單位一樣，不重組成表格。

## 驗證

<!-- @assert-count target="src/core/egress/client.ts" symbol="redirect: 'error'" expected="1" reason="第 4 項：轉址當成失敗" -->
<!-- @assert-count target="providers/anthropic.yaml" symbol="endpoint: https://api.anthropic.com" expected="1" comments="include" reason="第 3 項：白名單是設定檔的端點" -->
<!-- @assert-count target="tests/core/egress.test.ts" symbol="egress.denied" min="4" reason="ADR-0099 第 25 項：連到白名單以外的主機時測試失敗" -->
<!-- @assert-count target="src/core/llm.ts" symbol="BACKOFF_SECONDS: readonly number[] = [1, 2, 4, 8, 16]" expected="1" reason="第 11 項：退避 1、2、4、8、16 秒" -->
<!-- @assert-count target="src/core/workspace.ts" symbol="MIN_PII_CHARS = 3" expected="1" reason="第 8 項：清單項目少於 3 個字元時警告" -->
<!-- @assert-count target="src/core/translate.ts" symbol="'requeue', 'block'" expected="1" reason="第 9 項：閘門命中時單位標成 BLOCKED" -->
<!-- @assert-count target="prompts/translate.md" symbol="<feedback> lists what was wrong" expected="1" comments="include" reason="第 31 項：提示說明重送的原因" -->
<!-- @assert-count target="src/core/preview.ts" symbol="state === 'BLOCKED'" expected="1" reason="第 23 項：BLOCKED 的單位不放原文" -->
<!-- @assert-count target="src/core/translate.ts" symbol="UPDATE unit SET attempts = 0" expected="1" reason="第 34 項：--retry-failed 放回佇列時 attempts 歸零" -->
<!-- @assert-count target="src/core/request.ts" symbol="fallback?.id ?? null" expected="1" reason="第 37 項：fallback_model 進內容指紋" -->
<!-- @assert-count target="src/core/request.ts" symbol="promptHash(prefix)," expected="1" reason="第 41 項：prompts/feedback.yaml 進內容指紋" -->
<!-- @assert-count target="src/core/request.ts" symbol="packHash(pack)," expected="1" reason="第 41 項：規則包進內容指紋" -->
<!-- @assert-absence target="src/core/egress/gate.ts" symbol="replaceAll" reason="第 6 項：例外比對位置，不把文字蓋掉" -->
<!-- @assert-count target="src/core/translate.ts" symbol="'receive', 'fail'" expected="1" reason="第 44 項：截斷的單位不留在 RECEIVED" -->
<!-- @assert-count target="src/core/translate.ts" symbol="'receive', 'give_up'" expected="1" reason="第 44 項：截斷的單位不留在 RECEIVED" -->
<!-- @assert-absence target="src/core/preview.ts" symbol="recursive: true, force: true" reason="第 48 項：不刪整個資料夾" -->

## 後果

022 合併之前，使用者打 `tome translate --realtime` 不會真的送出。閘門比對的是子字串，清單項目寫得太短就會誤判，要靠警告與 `pii_exceptions` 處理。拒答一路對半拆，單位多的請求可能要付好幾次錢，預算要算進去。

## 替代方案

**整個 018 等到 11-03**：M2 要停約兩天；**閘門用正規表示式**：使用者寫的清單不該被當成模式，還多一種逾時要處理；**先換模型再對半拆**：一個問題段落會讓整個請求改用別的模型；**用伺服器端回退**：Batch 不支援，要維護兩條路；**重送不附原因**：模型不知道哪裡錯，容易犯同樣的錯；**開頭一次查完翻譯記憶**：同一本書後面重複的段落吃不到；**`prompts/feedback.yaml` 不進指紋**：句子改了也不用重新確認，估價確認過的內容就不是實際送出的內容；**整個 `review/` 刪掉重建**：使用者放在裡面的檔案會不見；**先把例外從文字蓋掉再比對**：短的例外會連比它長的個資一起蓋掉，全名就送出去了。

## Open Questions

- [ ] 重試的次數與退避秒數要等真實請求量過。
- [ ] 外送紀錄沒有清理期限，要不要隨交付一起刪，等 M3 的 vault 再決定。
