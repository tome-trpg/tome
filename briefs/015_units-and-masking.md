---
status: active
date: 2026-11-02
type: feature
wave: 13
affectedFiles:
  - .github/workflows/test.yml
  - CHANGELOG.md
  - README.en.md
  - README.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - package.json
  - schemas/**
  - src/**
  - systems/**
  - tests/**
protectedFiles:
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CLAUDE.md
  - docs/research/**
  - engines/**
  - languages/**
  - package-lock.json
---

# 015 — 單位與遮蔽

## Intent

這個回合結束時，`document` 層能轉成翻譯單位，規則包的遮蔽規則能把骰子、頁碼參照與 `keep_source` 詞條換成佔位符，書本文字跳脫後組成 `<s>` 標籤，LLM 的回應能解析回來並還原成原文的樣子，往返由 fast-check 把關。內建規則包 `generic` 就位，沒指定 `--system` 的書一律用它。`tome probe` 依規則包的 `suggest` 資料建議規則包。`src/core/pack-lint.ts` 的目標語言改成參數。這是 M2 的第一個回合（ADR-0099），後面的驗證、請求與對外出口都接在這些函式上，依據是 ADR-0099 與 ADR-0100。

## Negative Scope

- 不寫 `book.db`：`unit` 表在 016 跟狀態機一起加。
- 不做驗證、翻譯記憶、請求組成、估價，也不連網。
- 不寫 `generic` 的角色 `style`、`persona_and_tone.md`、`few_shots.md`，這些會進提示，在 017 交維護者審。
- 不做單書的額外模式，排到 M3（ADR-0100）。
- 不產生 `<pc>`，要等 M3 的 `runs`（ADR-0099 第 9 項）。
- 不放商業書的內容。範例與測試都用合成文字。

## Not Empowered

- ADR-0099、ADR-0100 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。放進 PR 說明不算問。
- 核心不含遊戲知識，也不依語言代碼分支，遮蔽規則都來自規則包。
- 規則包的正規表示式只在 worker 裡執行（ADR-0049）。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，CI 全綠就回報 PR 連結與 attempt 1 的結果。

## Invariants

- [ ] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [ ] 新的測試先在舊行為上失敗過
- [ ] 改到 `src/core/extract.ts` 的提交，推送前在本機真的跑過 `tests/engine`
- [ ] `specs`、`test`、`engine` 在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [ ] 訊息與 `--json` 只有規則包 ID 與數字，不含書本文字
- [ ] 核心沒有寫死語言或遊戲概念

## Acceptance Criteria

- [ ] `generic` 通過 `tome system lint --public` 與 `tome system test`，CI 也跑建置結果
- [ ] 沒指定 `--system` 的書用 `generic`，`tome extract` 也載入它
- [ ] `lintPack` 的目標語言是參數，`tome.yaml` 的 `target_lang` 選填，預設 `zh-TW`
- [ ] 哪些區塊產生單位符合 ADR-0100，`furniture` 不產生
- [ ] 遮蔽再還原回到原樣，含 `<`、`&`、`</s>` 的文字也一樣，有 fast-check 測試
- [ ] 書本文字關不掉 `<s>`，有測試
- [ ] 標籤解析回報未知標籤、沒成對與巢狀錯誤，`<new-term>`、`<flag>` 解析得出來
- [ ] `tome probe` 建議規則包，門檻與結果符合 ADR-0100，書已有 `system` 時不顯示
- [ ] `tests/perf/probe-budget.test.ts` 涵蓋有 `suggest` 的情況
- [ ] 白皮書的成熟度標籤、附錄 B、CHANGELOG 更新，ADR-0099 的斷言補進「驗證」
