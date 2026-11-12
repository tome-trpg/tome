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

同一天維護者另外裁示：變異測試全部搬到 GitHub runner，本機不再跑。這個回合因此新增一個只能手動觸發的 workflow，輸入是要變異的檔案與行號，沿用 `stryker.config.mjs` 的設定、不套用 break 門檻；用它跑這個回合改過的行，存活的補測試或寫明是等價變異。brief 只對這一個新的 workflow 檔放寬，其他 `.github/**` 照樣受保護。

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

- [ ] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [ ] 新的測試先在舊行為上失敗過，護欄測試故意改壞程式確認會失敗
- [ ] 新的 workflow 在 GitHub runner 上跑過這個回合改過的行，存活的補上測試或說明是等價變異
- [ ] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑
- [ ] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [ ] 訊息、進度、`--json` 與紀錄都不含書本文字

## Acceptance Criteria

- [ ] 維護者的決定寫成 ADR-0132，白皮書 §9 的索引加一列
- [ ] (a) 保留期拆成自己的發現，依模式各一個代碼：批次照舊印天數，即時模式只說以供應商的政策為準；翻譯與 Pass 0 都是
- [ ] (b) `tome run` 裡代碼、等級、參數都相同的發現只留最後一次，`chapters.levels` 不論參數只留最後一次；單獨的指令不變
- [ ] (e) 批次進度每次執行從 1 算起，附上預計批數，每送一批重算；續跑等上一次的批次時說「上次送出的一批」；計數在供應商確認收到之後才加一；Pass 0 與翻譯都是
- [ ] (f) `tome report` 與交付報告分成超出上限、在區間內、低於下限、不到 1%、尚無花費、區間寬度是 0 幾種說法，交付報告的欄名改成「與估價相比」
- [ ] 白皮書 474、563、719、898、970、1069 行附近停在 M2 的文字照事實改寫，(a)(b)(e)(f) 寫進對應的「已實作」段落
- [ ] `README.md` 與 `README.en.md` 的狀態與開發進度表照 M3 的事實修正，結構不動
- [ ] CHANGELOG「尚未發布」的「變更」一節記下使用者看得到的變更
- [ ] 新增只能手動觸發的變異 workflow：輸入是檔案與行號，沿用 `stryker.config.mjs`、不套用 break 門檻、`timeout-minutes` 130、JSON 報告上傳成 artifact；決定寫進 ADR-0132（`amends` ADR-0110、ADR-0117）
