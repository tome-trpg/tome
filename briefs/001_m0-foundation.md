---
status: active
date: 2026-11-01
type: feature
wave: 1
affectedFiles:
  - .claude/settings.json
  - .github/workflows/**
  - .gitignore
  - .mcp.json
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CHANGELOG.md
  - CLAUDE.md
  - CONTRIBUTING.md
  - README.en.md
  - README.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/0014-adopt-spec-tools.md
  - docs/adr/0016-dependency-license-policy.md
  - docs/adr/0034-api-key-storage.md
  - docs/adr/0039-single-egress.md
  - docs/adr/0082-*.md
  - docs/adr/0083-*.md
  - package-lock.json
  - package.json
  - schemas/**
  - src/**
  - tests/**
  - tools/check-licenses.ts
  - tsconfig.build.json
  - tsconfig.json
  - vitest.config.ts
protectedFiles:
  - .github/ISSUE_TEMPLATE/**
  - LICENSE
  - NOTICE
  - SECURITY.md
  - docs/research/**
  - tools/npm-placeholder/**
---

# 001 — M0 基礎

## Intent

這個回合結束時，repo 有一個能建置、能測試的 TypeScript 主程式骨架，白皮書路線圖 M0 的閘門全部就位，但還沒有任何翻譯功能。核心寫成函式庫（`src/core`），CLI 只是外面一層（`src/cli`），依 [ADR-0028](../docs/adr/0028-cli-first-library-core.md)。`tome init`、`tome doctor`、`tome provider auth set` 三個指令能用，訊息是繁中，集中在資料檔，有 `--json` 與結束碼 0、1、2（[ADR-0059](../docs/adr/0059-cli-conventions.md)）。`tome-ir/1`、`tome-pack/1` 有公開的 JSON Schema 與驗證。狀態庫、金鑰存放、測試工作流程、相依授權檢查與對外連網的斷言都到位，之後的階段不用再補閘門。這一輪的選型與命名記在 [ADR-0082](../docs/adr/0082-m0-toolchain-and-conventions.md)。

## Negative Scope

- 不開始 M1：沒有解析、Docling、`tome probe`、`tome add`、規則包內容、語言設定檔。
- 沒有任何網路請求。`src/core/egress/` 這一輪不建立，斷言先排除這條路徑。
- 沒有翻譯、遮蔽、驗證、估價、供應商 SDK。
- `tome provider auth` 只做 `set`；`list`、`test` 與 `delete` 不在範圍內。
- 不在 `book.db`、`series.db` 建業務資料表，只有遷移機制與 `tome_meta`。
- 不放任何商業書籍內容、PDF 或金鑰，測試資料全部是合成文字。
- 不改 `C:\Repos\specs`、`seekers-journal` 或其他 repo。

## Not Empowered

- 除了白名單裡的四份 ADR 回填 `## 驗證` 與勾選 `## Open Questions`，既有 ADR 的決定不能改寫，要改就新增 ADR。
- 相依只收 ADR-0016 與 ADR-0043 的白名單授權，不能為了過檢查而放寬白名單。
- 選型、命名、範圍、政策不能自己決定，白皮書沒寫清楚的要問維護者。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run build`、`npm run licenses` 在本機都通過
- [x] `specs` 與 `test` 兩條工作流程在 Windows 與 Ubuntu 的 CI 都通過
- [x] Action 釘在 commit，簽出不保留 token，安裝用 `--ignore-scripts`，公開 repo 的 CI 沒有金鑰

<!-- @assert-absence target=".github/workflows" regex="true" symbol="^\s*-?\s*uses:\s+[^@\s]+@(?![0-9a-f]{40}\b)" comments="include" reason="Action 一律釘在 commit" -->
<!-- @assert-absence target=".github/workflows" regex="true" symbol="\$\{\{\s*secrets\." comments="include" reason="公開 repo 的 CI 不放金鑰" -->

- [x] 相依版本釘死，直接相依都過了 ADR-0077 的冷卻期，例外在 ADR-0082 寫明

<!-- @assert-absence target="package.json" regex="true" symbol="\"[^\"]+\":\s*\"[\^~]" comments="include" reason="版本釘死" -->

- [x] 金鑰、本機路徑與商業內容都沒有進 repo，推送前掃描過
- [x] H-14 有實測結果，寫回白皮書與 ADR-0034 的 Open Questions
- [x] ADR-0014、ADR-0016、ADR-0034、ADR-0039 的 Open Questions 已關閉
- [x] 白皮書附錄 B 的「目前階段」已更新，已實作的項目標成「已實作」並附路徑與測試

## Acceptance Criteria

- [x] `tome init` 在 git repo 內的路徑回結束碼 1，偵測到同步資料夾時警告，已初始化時重跑回 0 且不覆蓋
- [x] `tome doctor` 依 ADR-0082 的分級回報，`--json` 的外層是 `tome-cli/1`
- [x] `tome provider auth set anthropic` 只從隱藏輸入或 stdin 讀金鑰，金鑰不出現在任何輸出

  隱藏輸入只用假的 TTY 測過（`tests/cli/read-secret.test.ts`），沒有在真的終端機上驗證。
- [x] `tome-ir/1` 與 `tome-pack/1` 拒絕未知欄位，規則包指定不了連線端點或金鑰
- [x] 狀態庫開 WAL，`user_version` 單向遷移，資料庫比程式新時拒絕開啟，開錯種類時拒絕開啟
- [x] spec-guard 斷言擋得下：`core` 依賴 `cli`、對外出口模組以外的連網、名單上的 AGPL 與 GPL 套件，`spec-guard prove` 看過每條斷言失敗
- [x] 相依授權檢查讀 `package-lock.json`，白名單以外或沒有授權欄位的相依讓 CI 失敗
