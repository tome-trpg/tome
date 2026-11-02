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

## 驗證

<!-- @assert-count target="src/core/request.ts" symbol="book.config.source_lang," expected="1" reason="第 2 項：source_lang 進內容指紋" -->
<!-- @assert-absence target="package.json" symbol="@anthropic-ai/sdk" comments="include" reason="第 1 項：023 不加 SDK" -->

## 後果

手改 `book.yaml` 的 `source_lang` 之後要重新確認估價。指紋的輸入多一項，已經確認過的書在升級後要重新確認一次，TOME 還沒發佈，影響只有開發中的工作區。

## 替代方案

**等 022 一起做**：這段時間沒有回合在跑，兩件事都不需要 SDK；**`source_lang` 維持不進指紋**：只有手改才碰得到，但確認過的估價就不是實際送出的內容。

## Open Questions

- [ ] 指紋的輸入現在是一份寫在 `planBook` 裡的清單，新增會改變請求內容的設定時要記得補，還沒有測試能抓到漏列。
