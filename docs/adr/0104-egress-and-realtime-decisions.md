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

6. 比對前兩邊都做 NFKC、不分大小寫、連續空白視為一個。比對字串，不用正規表示式。`pii_exceptions` 做同樣的正規化，命中例外的那一段不算。
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

## 驗證

<!-- @assert-count target="src/core/egress/client.ts" symbol="redirect: 'error'" expected="1" reason="第 4 項：轉址當成失敗" -->
<!-- @assert-count target="providers/anthropic.yaml" symbol="endpoint: https://api.anthropic.com" expected="1" comments="include" reason="第 3 項：白名單是設定檔的端點" -->
<!-- @assert-count target="tests/core/egress.test.ts" symbol="egress.denied" min="4" reason="ADR-0099 第 25 項：連到白名單以外的主機時測試失敗" -->

## 後果

022 合併之前，使用者打 `tome translate --realtime` 不會真的送出。閘門比對的是子字串，清單項目寫得太短就會誤判，要靠警告與 `pii_exceptions` 處理。拒答一路對半拆，單位多的請求可能要付好幾次錢，預算要算進去。

## 替代方案

**整個 018 等到 11-03**：M2 要停約兩天；**閘門用正規表示式**：使用者寫的清單不該被當成模式，還多一種逾時要處理；**先換模型再對半拆**：一個問題段落會讓整個請求改用別的模型；**用伺服器端回退**：Batch 不支援，要維護兩條路；**重送不附原因**：模型不知道哪裡錯，容易犯同樣的錯。

## Open Questions

- [ ] 重試的次數與退避秒數要等真實請求量過。
- [ ] 外送紀錄沒有清理期限，要不要隨交付一起刪，等 M3 的 vault 再決定。
