---
status: active
date: 2026-11-14
type: feature
wave: 52
affectedFiles:
  - CHANGELOG.md
  - README.en.md
  - README.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - docs/evals/**
  - providers/anthropic.yaml
  - src/cli/messages.ts
  - src/cli/messages/zh-TW.json
  - src/cli/review/**
  - src/core/batch.ts
  - src/core/prompt.ts
  - src/core/provider-test.ts
  - src/core/provider.ts
  - src/core/request.ts
  - src/core/translate.ts
  - tests/**
  - tools/eval.ts
  - tools/eval/**
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
  - schemas/**
  - src/core/egress/**
  - src/core/process.ts
  - src/core/store.ts
  - stryker.config.mjs
  - systems/**
---

# 048 — 盲評

## Intent

這個回合結束時，維護者能用自己的金鑰在自己的電腦上跑完盲評：`tools/eval.ts` 從公開的 ORC 文件與 The Call of Cthulhu 照角色分層隨機挑 100 段黃金段落（種子固定），先試算、總估價超過 30 美元就不送，再照產品的翻法（同一套提示、上下文、詞條、驗證、重送、帳本與外送紀錄）跑 6 組：Haiku 5.5、Sonnet 5.5 關思考、Sonnet 5.5 開思考、Sonnet 5.5 中文指令、Opus 5.5、Fable 5.2，全部批次；`FAILED_QA` 淘汰並列淘汰率。評分沿用 047 的本機網頁與安全設計，隨機排序、隱藏組別，按 1 到 5 評，分次評完，10 段重複題檢查前後一致。結果只把數字與可重現的設定寫進 `docs/evals/`，段落只放索引；Q-8 用 050 要用的那一組算。供應商檔補上 Fable 5.2。開思考與中文指令只給評測用，不開放給使用者、不進設定檔。決定寫成 ADR-0139（ADR-0065、ADR-0130 第 5、14、22 項的細節，維護者 2026-11-14 回答的 11 項）。盲評是 Q-8 與範本建議組合的依據，也回答 H-2、H-13、H-18。

## Negative Scope

* 執行 session 不呼叫真的 API、不花錢；需要維護者跑的步驟一條指令一個區塊寫給 Manager。
* 不放商業書的任何內容；黃金段落的原文、譯文、分數的原始檔都不進 repo，`docs/evals/` 只放數字、設定與段落索引。
* 開思考與中文指令不出現在 CLI、`tome.yaml`、`book.yaml` 或 schema；供應商檔與 schema 不為它們改。
* 不加任何相依，不用 Python；統計手寫。
* 不改產品的提示（`prompts/translate.md`）；中文指令的譯文只放評測的資料夾。
* 不在維護者的筆電上跑變異測試或長時間吃滿所有核心的工作；ORC 文件的解析由維護者自己跑。

## Not Empowered

* 評分頁的中文字樣、中文指令的譯文、`tome init` 範本的字樣，在維護者審過之前不 commit。
* `prompts/**`、`schemas/**`、`src/core/egress/**`、`src/core/process.ts`、`src/core/store.ts`、`systems/**`、`languages/**`、workflow 與 `package.json`；要改時先停下來問。
* 新相依；要加先問。

## Invariants

- [ ] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [ ] 新的測試先在舊程式上失敗過
- [ ] 評測用的選項（開思考、換指令、一段一個請求）只有 `tools/` 用得到，`src/cli/` 沒有任何地方傳它們，有斷言把關
- [ ] ADR-0039、ADR-0082、ADR-0138 的斷言照舊成立：`node:http` 只在 `src/cli/review/server.ts`、只聽 `127.0.0.1`，子行程只經過 `process.ts`，`src` 的 `.ts` 沒有中文
- [ ] 訊息、`--json`、紀錄與 `docs/evals/` 只有數字、編號與雜湊，沒有書本文字
- [ ] 評分頁、中文指令與範本的字樣經維護者審過
- [ ] `mutation-lines` 跑過改過的行，存活的變異補上測試，或說明為什麼等價
- [ ] `specs`、`test` 在 CI 第一次跑就通過，沒有靠重跑
- [ ] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示

## Acceptance Criteria

- [ ] ADR-0139 寫下維護者的 11 項回答、Fable 5.2 的價格來源與 `tome provider test` 的結果、評測工具的做法，成熟度照 ADR-0068 標
- [ ] `providers/anthropic.yaml` 有 Fable 5.2，Fable 5.1 留著
- [ ] `tools/eval.ts` 的挑段落、試算、送出、評分、出報告，都用假供應商與合成的書測過
- [ ] 評分頁照 047 的安全設計，隨機排序、隱藏組別、鍵盤 1 到 5、可以分次評、重複題
- [ ] 維護者跑完盲評，`docs/evals/` 有這次的數字，ADR-0139 寫下 Q-8 與 H-2、H-13、H-18 的結果
- [ ] `tome init` 範本的建議組合改成指向盲評的結果
- [ ] 白皮書、CHANGELOG 跟著改
