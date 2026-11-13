---
status: archived
date: 2026-11-12
type: feature
wave: 49
affectedFiles:
  - CHANGELOG.md
  - README.en.md
  - README.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - src/cli/messages/zh-TW.json
  - src/cli/run.ts
  - src/core/batch.ts
  - src/core/estimate.ts
  - src/core/findings.ts
  - src/core/index.ts
  - src/core/ledger.ts
  - src/core/llm.ts
  - src/core/pipeline.ts
  - src/core/report.ts
  - src/core/request.ts
  - src/core/store.ts
  - src/core/translate.ts
  - src/core/trial.ts
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
  - languages/**
  - package-lock.json
  - package.json
  - prompts/**
  - providers/**
  - schemas/**
  - src/core/budget.ts
  - stryker.config.mjs
  - systems/**
integrity: sha256-164514ef37855bd0368dde1d01f5655ba000d2db0feb69c1d9ec694efe1fd781
---

<!-- spec-brief:banner -->
> **Archived 2026-11-13.**
> Merged in pull request [#84](https://github.com/tome-trpg/tome/pull/84).
> Recorded at commit `19cd0fa`: 40 files changed, +2657 −98.
> The body below describes the tree before execution and is not maintained.
<!-- /spec-brief:banner -->

# 045 — 試翻

## Intent

這個回合結束時，TOME 有試翻：`tome trial <書>` 在 `--chapters` 範圍內平均間隔挑約 10% 的請求（最少 5 個、最多 30 個，數字用模擬再定）先翻，用帳本的實際 token 校準這本書的估價，再到確認估價的關卡。`tome run --trial` 過了審定就停下來請使用者確認試翻的估價。試翻的譯文照一般翻譯驗證，通過就是 `DONE`，主翻譯跳過它們。

校準是每本書、每個模型、每個模式各一筆的兩個倍數（輸入、輸出），存在 `book.db` 的新表（遷移第 15 版），有校準時才進估價的指紋。重送的餘裕照舊用供應商設定檔的 0.25。

試翻一律開提示快取，量命中率：斷點只有一個，在靜態前綴的結尾；批次用 1 小時、即時用 5 分鐘。命中率高過損益兩平點時，這本書的主翻譯才開快取，估價照命中率算前綴的價錢；沒試翻就不開。帳本照實際的 TTL 計算快取寫入的價錢，也分得出試翻的花費。

Q-6 有了算法：實際的翻譯花費 ÷ 校準後估價的中間值 − 1，含重送與回退，不含 Pass 0 與試翻。`estimate` 表記下中間值與有沒有校準，`tome report` 印出來。

細節由維護者在 2026-11-12 全部照建議選定（共用筆記 `brief-045-questions.md` 的 11 項），寫成 ADR-0135。

## Negative Scope

- 不做人工改動回饋成風格範例，排到 0.1.0 之後（第 8 項）。
- 不預熱快取（第 5 項）。不改提示（`prompts/**`）、請求的組法、重送的規則與預算的檢查（`budget.ts`）。
- 不改供應商設定檔與 schema：重送的餘裕、比例、價錢都照舊。
- 不做批次併發、串流、依區塊角色選模型，不改長度的門檻，不把重送併成一個請求（第 10 項）。
- 不讀書本內容。模擬只用工作區的唯讀暫存複本、只印數字，量完刪掉。測試只用合成的文字。
- 本機不跑變異測試，改過的行在回合分支上 dispatch `mutation-lines`。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。實作時冒出的新細節寫進共用筆記 `brief-045-details.md`。範圍放不下時先停下來問，不自己拆。
- 寫給維護者的理由要先對照程式、量測與文件的原文。
- 核心不放給人看的文字：訊息放訊息檔，核心只回代碼與數字（ADR-0082 第 9 項）。
- 主張要帶成熟度，沒量測的不能寫成已實作（ADR-0068）；文件只寫數字，不寫書名與內文（ADR-0059）。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠、變異測試跑完就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過

  2262 個測試通過，461 個斷言都成立、每一條都看過它失敗，299 個套件、0 違規。補完變異測試之後（`c5f07ca` 加上第 18 項）是 2318 個測試、465 個斷言。
- [x] 新的測試先在舊行為上失敗過

  新的測試放在改程式之前（`d320d70`）跑，28 個失敗，`tests/core/trial.test.ts` 整個載不進來（沒有 `trial.ts`）；之後補的遷移第 15 版測試在舊程式上也會失敗（沒有那幾張表）。護欄有兩個：估價不給校準與快取時跟原本相同、請求不開快取時 `system` 照舊是字串，在舊程式上也會通過。
- [x] `mutation-lines` 跑過改過的行，存活的變異補上測試，或說明為什麼等價

  都是 attempt 1、成功，數字與等價的理由在 ADR-0135 第 18 項。第一次（`66868c6`，run 43244988054）75.47；第二次（`ab404e7`，run 43246371705）88.57；`24f887d` 的一次（run 43271730856）怕超過 130 分鐘、3 分鐘後取消；補測試後（`4656d54`）範圍跟第一次相同、拆成 6 個 run，95.42；估價的指紋釘成固定值之後（`c5f07ca`）重跑 `request.ts` 的兩段，最後 96.24，剩下的 37 個都是等價的。其中一個存活的變異查出程式跟第 12 項不一致，改成命中率要高於損益兩平點才開快取（`24f887d`）。
- [x] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑

  每次推送都是 attempt 1 就通過：`66868c6`（specs 43244994232、test 43244994743）、`ab404e7`（43246354060、43246353990）、`24f887d`（43271740461、43271740645）、`4656d54`（43273672249、43273672167）、`4f3306b`（43280923120、43280923107）、`c5f07ca`（43425193609、43425193789）。
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示

  `4656d54` 與 `c5f07ca` 的 `CodeQL` 都是 success、0 個 annotation。三個 Analyze 工作各有 1 個 annotation，是 GitHub 說 `ubuntu-latest` 要換成 Ubuntu 26 的通知，不是警示。
- [x] 沒有試翻的書，請求與估價跟改之前相同：不帶 `cache_control`，估價不變

  `tests/cli/trial.test.ts`「sends the prefix as plain text for a book with no trial」；估價的金額不變，`tome estimate` 多一行 `estimate.uncalibrated` 提示可以試翻。
- [x] 訊息、`--json` 與紀錄都不含書本文字

  新的代碼只帶數量、金額、百分比與指令；`tests/cli/trial.test.ts` 確認輸出不含合成的句子。

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0135，白皮書 §9 的索引加一列
- [x] 模擬的結果寫進 ADR-0135，試翻的大小依它定案

  樣本內（ADR-0134 的估價器）與樣本外的替代（044 之前的估價器）分開寫。
- [x] `tome trial [--confirm] [--budget] [--realtime]` 比照 `tome scan-terms`；試翻計入預算，譯文留下
- [x] `tome run --trial` 過了審定就停下，結束碼 0；已有校準就跳過；`--trial` 不存進 `book.yaml`
- [x] 校準存進 `book.db` 的新表，估價套用它，有校準時進指紋
- [x] 試翻的請求帶 `cache_control`，命中率記下來；過損益兩平點時主翻譯才開快取，估價照命中率算
- [x] 帳本照實際的 TTL 計價，分得出試翻的花費
- [x] `estimate` 表記中間值與有沒有校準，`tome report` 印出 Q-6
- [x] 白皮書、README 與 CHANGELOG 更新
