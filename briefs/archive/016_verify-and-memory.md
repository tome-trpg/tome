---
status: archived
date: 2026-11-02
type: feature
wave: 15
affectedFiles:
  - CHANGELOG.md
  - README.en.md
  - README.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - languages/**
  - package-lock.json
  - package.json
  - schemas/**
  - src/**
  - tests/**
protectedFiles:
  - .github/**
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CLAUDE.md
  - docs/research/**
  - engines/**
  - systems/**
integrity: sha256-b7d33447e35b4252587e788ccee45ccc3f43dc63f697ff97e93d27b33b87b3b1
---

<!-- spec-brief:banner -->
> **Archived 2026-11-02.**
> M2 的第二個回合：零 token 驗證、譯後排版、翻譯記憶、單位狀態機與 tome verify。混入簡體字沿用 repo 的判定，字表移成語言資料，OpenCC 只用在只報告的用語檢查。
> Merged in pull request [#44](https://github.com/tome-trpg/tome/pull/44).
> Recorded at commit `eead5e2`: 33 files changed, +2515 −61.
> The body below describes the tree before execution and is not maintained.
<!-- /spec-brief:banner -->

# 016 — 驗證與翻譯記憶

## Intent

這個回合結束時，LLM 回傳的譯文能用不花 token 的驗證判斷能不能用：標記對應、佔位符、數字守恆、鎖定譯名、混入簡體字、長度過短會重送，其餘只列報告。通過的譯文經譯後排版，還原成最後的文字。譯文存進翻譯記憶，相同內容不用再付一次。單位有狀態機與 `book.db` 的資料表，`tome verify` 用存下來的回應重跑驗證。這是 M2 的第二個回合（ADR-0099），依據是 ADR-0060、ADR-0099 與 ADR-0102。017 的請求與 018 的即時模式都接在這些函式上。

## Negative Scope

- 不連網，不組請求，不估價。
- 不做機翻腔訊號、代名詞與實體卡不符、輸出的標題與表格結構，都排到 M3（ADR-0102）。
- 不做人工譯文，`DONE` 不變 `STALE` 的例外到 M3 才有。
- 不用 OpenCC 判定混入簡體字，它只用在不重送的用語檢查（ADR-0102）。
- 不放商業書的內容。範例與測試都用合成文字。

## Not Empowered

- ADR-0099、ADR-0102 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。放進 PR 說明不算問。
- 核心不含遊戲知識，也不依語言代碼分支，字表都是語言資料。
- `zh-TW` 的風格指南不動，它要在 017 交維護者審。
- 公開文件寫「維護者」，不寫人名，也不引用簡體字。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，CI 全綠就回報 PR 連結與 attempt 1 的結果。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過
- [x] `specs`、`test` 在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] 訊息與 `--json` 只有數字，不含書本文字
- [x] 核心沒有寫死語言，字表只有一份，測試工具與核心共用
- [x] 只有 `src/core/opencc.ts` 碰 `opencc-js`，有斷言把關

## Acceptance Criteria

- [x] 重送的六類檢查都有測試：標記、佔位符、數字、譯名、簡體字、長度
- [x] 合成的繁體長文判定結果是零，正確的譯文不會變成 `FAILED_QA`
- [x] 譯後排版不動佔位符，`1,000`、`3:00` 不被改壞
- [x] 狀態機用 fast-check 做 model-based 測試，非法轉換會丟錯
- [x] 翻譯記憶命中後重跑驗證，不過就當沒命中，只有驗證通過的譯文才進
- [x] `tome verify` 不花 token，不動 `attempts`，結束碼符合 ADR-0102
- [x] `<new-term>`、`<flag>` 存進 `issue`
- [x] 白皮書的成熟度標籤、§6.2 的狀態圖、附錄 B、CHANGELOG 更新，ADR-0099 的斷言補進「驗證」

## Measured

2026-11-02，Windows 參考機器。只用合成文字。

- 合成的繁體長文約 300 字，含皇后、茶几、核准、云云，以及後來、準備、復活這類容易誤判的詞，判定結果是零。這是合成文字，真實譯文的誤判率要等第一次翻譯才看得到。
- `state.ts` 與 `opencc.ts` 是先寫的，測試寫好後用改壞的版本確認過會失敗。這一步也查出 model-based 測試太弱：隨機事件大多不合法，走不到 `STALE` 之後。改成只走合法轉換，序列拉長到 200，再確認改壞時會失敗。非法轉換由另一個測試逐一檢查。
- OpenCC 的 `twp` 比 `tw` 多的只有 `TWPhrases`，用 `Trie.matchPrefix` 拿得到逐字的詞，不用比對差異。
- 片語表的誤報率沒有量，它只報告，不影響重送。
- 審查抓到四個會默默出錯的地方：規則包壞掉時譯名驗證被略過、網址的 `://` 被換成全形、英寸記號被當成引號、`allowed_words` 太窄。修 `allowed_words` 時另外查出例外詞裡不在 Big5 的字仍會被算，判定改成兩項都用拿掉例外詞之後的文字。
- 數字守恆的代價：`1st` 譯成「第一」會判 `number_missing`。017 的提示要明確要求保留阿拉伯數字。
- 新相依 `opencc-js` 1.4.2 用在用語檢查，只有 `src/core/opencc.ts` 碰它，依據是 ADR-0099 第 16 項。2026-08-22 上架，授權 `MIT AND Apache-2.0`，字典資料另有第三方授權聲明，也是 Apache-2.0，沒有相依，也沒有安裝腳本。程式本身沒有逐行審過。
