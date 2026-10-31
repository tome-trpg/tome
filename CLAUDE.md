# TOME

TRPG Omnilingual Markdown Engine：把使用者自己擁有的 TRPG 書在本機解析，用使用者自己的 LLM API 金鑰翻成繁體中文。主程式是 TypeScript，Node 24 以上。

開工先讀 [docs/WHITEPAPER.md](docs/WHITEPAPER.md) 的執行摘要與 §9 的 ADR 索引。目前的階段見附錄 B 的路線圖。白皮書已定案，之後的改動走 ADR。

## 不可違反

1. **repo 裡不放任何商業書籍的內容。** 包含原文、譯文、截圖與 PDF，測試、文件、Issue 都一樣。需要範例就用合成文字，公開素材要在來源清單登記授權與雜湊（ADR-0061）。
2. **PDF 與頁面影像不離開本機。** 對外網路請求只走對外出口模組，其他程式不得自己連網（ADR-0039）。
3. **金鑰不進 repo、紀錄與報告**，引擎子行程也不繼承（ADR-0034）。紀錄檔不含書本文字（ADR-0059）。
4. **主程式的相依只收 MIT、Apache-2.0、BSD、ISC、MPL-2.0**（ADR-0016、ADR-0043）。AGPL、GPL、非商業、OpenRAIL 類引擎不隨附。
5. **引擎核心不含遊戲知識。** 遊戲概念都由規則包宣告（ADR-0023），規則包只能是資料（ADR-0044）。

## 決策

**選型、命名、範圍、政策都要先問維護者。** 不要把機器上裝了什麼、或別的專案怎麼做，當成限制寫進文件。推論出來的前提是提案，不是事實。

* 決策寫成 ADR，放 `docs/adr/`，格式見 ADR-0021。正文繁體中文，front matter 用英文。
* 決策改變時新增一份 ADR，用 `amends` 或 `supersedes` 指向舊的，不改寫歷史。
* 待決事項放在 `## Open Questions` 之下。
* 主張要帶成熟度標籤。沒量測的數字不能寫成已實作，假說沒驗證就不能標成已實作（ADR-0068）。

## 指令

```bash
npm ci --ignore-scripts
npm run spec
npm run typecheck
npm test
npm run licenses
```

`npm run spec` 跑 spec-guard、`prove`、`cites`、spec-graph、spec-brief 與 `premises`，全綠才能推送。`npm test` 不需要金鑰，`npm run licenses` 查全部相依的授權（ADR-0043、ADR-0083）。

`node src/cli/main.ts` 不用建置就能跑 CLI。程式放 `src/core`（函式庫）與 `src/cli`（外層），核心不放給人看的文字。新相依要過 ADR-0077 的冷卻期，主程式的原生套件要先審過（ADR-0083）。

用 `npx` 時一律寫完整套件名並加 `--no-install`，例如 `npx --no-install @spec-family/spec-guard`。不要寫 `npx spec-guard`，也不要寫 `npx tome`：npm 上的 `tome` 是別人的套件。

## 流程

* 每個實作回合先寫 brief，放 `briefs/`，分支名稱是 `claude/brief-<編號>-<名稱>`。結束前跑 `npx --no-install @spec-family/spec-harness audit`。
* 程式走 PR，用 merge commit，CI 通過後由代理人合併（ADR-0072、ADR-0082）。
* `v*` 標籤只有維護者能推，發佈要維護者用 2FA 核准（ADR-0069）。
* 相依與 Action 釘死版本。Latest ≠ Newest，新版本要過冷卻期（ADR-0077）。
* commit 訊息用英文，寫清楚為什麼。
