---
status: active
date: 2026-11-12
type: feature
wave: 46
affectedFiles:
  - .github/workflows/mutation-lines.yml
  - CHANGELOG.md
  - README.en.md
  - README.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - src/cli/messages/zh-TW.json
  - src/cli/run.ts
  - src/core/batch.ts
  - src/core/findings.ts
  - src/core/pipeline.ts
  - src/core/report.ts
  - src/core/request.ts
  - src/core/scan.ts
  - tests/**
protectedFiles:
  - .github/ISSUE_TEMPLATE/**
  - .github/dependabot.yml
  - .github/pull_request_template.md
  - .github/workflows/engine.yml
  - .github/workflows/mutation.yml
  - .github/workflows/specs.yml
  - .github/workflows/test.yml
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
  - stryker.config.mjs
  - systems/**
---

# 042 — 小問題與過時的文字

## Intent

這個回合結束時，M3 收尾看到的四個顯示問題（ADR-0129 第 10 項的 (a)(b)(e)(f)）都修好，白皮書與 README 不再停在 M2（ADR-0130 第 10 項）：

* 即時模式的估價不再印批次的保留天數，改說以供應商的政策為準；批次模式照舊。
* `tome run` 不再把同一行印兩次。
* 批次的進度從 1 算起，附上預計的批數。
* `tome report` 與交付報告分情況說花費跟估價的關係，不再出現「落在估價區間的 199%」。

只改給人看的文字與進度，翻譯、估價、預算與批次的行為都不變，`--json` 的外層與既有欄位不變。

細節由維護者在 2026-11-12 全部照建議選定（共用筆記 `brief-042-questions.md` 的 7 項），寫成 ADR-0132。

同一天維護者另外裁示：變異測試全部搬到 GitHub runner，本機不再跑。這個回合因此新增一個只能手動觸發的 workflow，輸入是要變異的檔案與行號，沿用 `stryker.config.mjs` 的設定、不套用 break 門檻。brief 只對這一個新的 workflow 檔放寬，其他 `.github/**` 照樣受保護。042 改過的行在合併後才跑，原因是 `workflow_dispatch` 要 workflow 先在預設分支上；存活的在 043 開頭只用測試補。

## Negative Scope

- 不改估價器、預算檢查、分批的方式與重送；不改 `--json` 既有欄位的意思（`data.estimates[].position`、`data.batches` 照舊）。
- 不在供應商設定檔或 schema 加即時模式的保留天數；不改 `provider.listed` 的說法。
- 不處理 (c)、(g)（交給審定介面），不碰估價器的缺口（044）與 `tome trial`（045）。
- README 不改結構，安裝與發佈的段落留給 049。
- 不加遷移、不加表；不改提示、語言設定檔、規則包、schema 與 `stryker.config.mjs`。
- 新的 workflow 只能用 `workflow_dispatch` 觸發，不加 `pull_request` 或 `push`；不改 `mutation.yml` 與其他 `.github/**`（維護者 2026-11-12 的裁示）。
- 本機不跑變異測試，連單一變異的小工具也不跑（同一個裁示）。
- 測試只用合成的文字；不寫入維護者的工作區，不對真的 API 發請求。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。實作時冒出的新細節寫進共用筆記 `brief-042-details.md`。
- 寫給維護者的理由要先對照程式與 ADR 原文。
- 核心不放給人看的文字：訊息、進度與報告的固定文字放訊息檔，核心只回代碼與數字（ADR-0082 第 9 項）。
- 主張要帶成熟度，沒量測的不能寫成已實作（ADR-0068）；文件只寫數字，不寫書名與內文（ADR-0059）。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過

  `0e18153`：2177 個測試通過，436 個斷言都成立，299 個套件、0 違規。
- [x] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗

  把新的測試放到 `86e753a`（改程式之前）的複本上跑，29 個失敗。「沒有要送的就不印保留期」是護欄：舊程式本來就不印，本機變異把那一行改壞時它會失敗。補強的測試（等級、去重的規則、上限 0 等）是本機變異那一輪找到的存活變異，見共用筆記 `brief-042-details.md` 第 11 項。
- [ ] 新的 workflow 在 GitHub runner 上跑過這個回合改過的行，存活的補上測試或說明是等價變異

  **Delegated** 到合併之後與回合 043：`workflow_dispatch` 要 workflow 先在預設分支上才觸發得到，新 workflow 合進 main 之前，沒辦法在 042 的分支上 dispatch。維護者在 2026-11-12 選定 042 照常合併，合併後在 main 上 dispatch `mutation-lines` 跑 042 改過的行，存活的在 043 開頭只用測試補，結果寫進 043 的 ADR（ADR-0132 第 11 項）。
- [x] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑

  PR 81 的兩次推送都是 attempt 1 通過：`894256b`（run 43175907650、43175907527）與 `9a862b2`（specs run 43176416882、test run 43176416820），兩個 OS 都是。`mutation.yml` 沒有觸發。
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示

  `9a862b2` 的 `CodeQL` 是 success、0 個 annotation；三個 Analyze 各一個 annotation，都是原本就有的 ubuntu-latest 說明。
- [x] 訊息、進度、`--json` 與紀錄都不含書本文字

  新的發現與進度只帶數字與代碼；`tests/cli/estimate.test.ts` 確認估價的輸出不含書本文字。

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0132，白皮書 §9 的索引加一列
- [x] (a) 保留期拆成自己的發現，依模式各一個代碼：批次照舊印天數，即時模式只說以供應商的政策為準；翻譯與 Pass 0 都是
- [x] (b) `tome run` 裡代碼、等級、參數都相同的發現只留最後一次，`chapters.levels` 不論參數只留最後一次；單獨的指令不變
- [x] (e) 批次進度每次執行從 1 算起，附上預計批數，每送一批重算；續跑等上一次的批次時說「上次送出的一批」；計數在供應商確認收到之後才加一；Pass 0 與翻譯都是
- [x] (f) `tome report` 與交付報告分成超出上限、在區間內、低於下限、不到 1%、尚無花費、區間寬度是 0 幾種說法，交付報告的欄名改成「與估價相比」

  先比上限與下限再看位置：區間寬度是 0 時，花費高於或低於它照樣說超出或低於，只有剛好等於時才是 `-`（共用筆記 `brief-042-details.md` 第 6 項）。
- [x] 白皮書 474、563、719、898、970、1069 行附近停在 M2 的文字照事實改寫，(a)(b)(e)(f) 寫進對應的「已實作」段落

  另外在附錄 B 加「M4 已實作的項目」，CI 的表加 `mutation-lines.yml` 一列。
- [x] `README.md` 與 `README.en.md` 的狀態與開發進度表照 M3 的事實修正，結構不動
- [x] CHANGELOG「尚未發布」的「變更」一節記下使用者看得到的變更
- [x] 新增只能手動觸發的變異 workflow：輸入是檔案與行號，沿用 `stryker.config.mjs`、不套用 break 門檻、`timeout-minutes` 130、JSON 報告上傳成 artifact；決定寫進 ADR-0132（`amends` ADR-0110、ADR-0117）

  `.github/workflows/mutation-lines.yml`，workflow 名稱 `mutation-lines`，輸入 `mutate`，維護者在 2026-11-12 照提案選定。
