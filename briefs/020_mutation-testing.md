---
status: active
date: 2026-11-07
type: feature
wave: 21
affectedFiles:
  - .github/workflows/mutation.yml
  - .gitignore
  - CONTRIBUTING.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - package-lock.json
  - package.json
  - stryker.config.mjs
  - tests/**
  - tools/check-licenses.ts
protectedFiles:
  - .github/ISSUE_TEMPLATE/**
  - .github/dependabot.yml
  - .github/pull_request_template.md
  - .github/workflows/engine.yml
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
  - prompts/**
  - providers/**
  - schemas/**
  - src/**
  - systems/**
---

# 020 — 變異測試

## Intent

這個回合結束時，Stryker 能對 ADR-0063 的六個關鍵模組跑變異測試：遮蔽還原、驗證、翻譯記憶鍵、預算、對外出口、狀態機。`@stryker-mutator/core` 與 `@stryker-mutator/vitest-runner` 釘 10.1.1，連同間接相依都過了 14 天冷卻期（ADR-0077、ADR-0099 第 18 項），兩個有弱點的間接相依用限定範圍的 `overrides` 換成修補版。開發相依的授權多放行 BlueOak-1.0.0 與 CC-BY-4.0，主程式的白名單不變（ADR-0099 第 17 項）。變異測試只在 GitHub Actions 跑：`.github/workflows/mutation.yml` 每週排程加手動觸發，一個模組一個 job。第一次實測在這個回合的 PR 上跑，分數門檻由它的數字決定（ADR-0063 第 3 項）。這是開發工具，不改主程式的行為。

細節由維護者在 2026-11-07 決定，寫在 ADR-0110：共用筆記 `brief-020-questions.md` 的 13 項全部照建議。維護者另外決定 Stryker 不在本機跑，第一次實測也一樣，並裁定這個回合只能改 `.github/workflows/mutation.yml` 這一個 workflow 檔，`.github/` 底下其他檔案照樣受保護。

## Negative Scope

- 不改 `src/` 的程式行為。變異測試找到的弱點，補測試或列成待辦，不在這個回合改程式。
- 不把變異測試放進每次 CI（ADR-0063 第 2 項），也不在維護者的電腦上跑。
- 不為了殺掉存活的變異補測試，只記數量（ADR-0110）。
- 不擴大到六個模組以外。
- 不放寬主程式的授權白名單。
- 不放商業書的內容，範例與測試都用合成文字。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。放進 PR 說明不算問，實作時冒出的新決定也照樣寫進共用筆記。
- 寫給維護者的理由要先對照程式、套件原始碼與 ADR 原文。
- 成熟度照實寫：門檻與執行時間只有量過的數字才寫成已實作（ADR-0068）。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，也不自己封存。CI 第一次跑完全綠就回報 Manager，等審查說可以封存才在回合分支上封存。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses`、`npm audit --audit-level=moderate` 在本機都通過
- [ ] `specs`、`test` 在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [ ] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] 新加的套件版本都上架滿 14 天，安全修正除外，例外寫明

## Acceptance Criteria

- [x] 維護者的決定寫成 ADR-0110，`amends` 指向 ADR-0063 與 ADR-0099 第 18 項，覆寫的理由與拿掉的條件寫明
- [x] `@stryker-mutator/core` 與 `@stryker-mutator/vitest-runner` 釘 10.1.1，`npm audit --audit-level=moderate` 沒有弱點
- [x] 開發相依放行 BlueOak-1.0.0 與 CC-BY-4.0，主程式照樣擋下，有測試
- [x] `stryker.config.mjs` 跑六個模組的 8 個檔案，跟 workflow 的 matrix 一致，有測試
- [x] `.github/workflows/mutation.yml` 有排程、手動觸發與限定路徑的 `pull_request`，一個模組一個 job
- [ ] 第一次實測在 PR 上跑完，6 個模組的分數、存活與逾時數、每個 job 的時間寫進 ADR-0110
- [ ] 門檻照維護者的規則加進設定，再跑一次確認過得了
- [x] 白皮書 §7.3、§8.4、附錄 B 與 CONTRIBUTING 更新

## Measured

2026-11-07（UTC），Windows 參考機器。Stryker 沒有在本機跑，下表只有不跑 Stryker 就量得到的部分，變異測試的數字要等 CI。

| 檢查 | 怎麼確認會失敗 |
| :--- | :--- |
| `npm audit --audit-level=moderate` | 加進 Stryker、還沒加覆寫時，5 個 moderate 弱點：`minimatch`、`qs`，以及因為依賴它們而被列出的 3 個套件 |
| 新增套件版本的冷卻期 | 直接安裝時，37 個間接相依未滿 14 天。改用 `--before` 之後，未滿 14 天的只剩兩個安全修正版本 |
| `npm run licenses` 與 `tests/tools/check-licenses.test.ts` | 放行之前回報 3 個開發相依：`caniuse-lite`（CC-BY-4.0）、`minimatch`、`@isaacs/nonrecursive-glob-match`（BlueOak-1.0.0） |
| `tests/tools/mutation.test.ts` | 故意從 workflow 的對外出口拿掉 `anthropic.ts`，1 個失敗，再改回來 |
