---
status: active
date: 2026-11-01
type: defect
wave: 12
affectedFiles:
  - CHANGELOG.md
  - briefs/**
  - src/core/path-guard.ts
  - tests/core/path-guard.test.ts
protectedFiles:
  - .github/**
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CLAUDE.md
  - docs/**
  - engines/**
  - languages/**
  - package-lock.json
  - package.json
  - schemas/**
---

# 014 — 路徑檢查的斜線處理改成線性

## Intent

這個回合結束時，`src/core/path-guard.ts` 去掉路徑結尾斜線的耗時跟長度成正比，CodeQL 的 `js/polynomial-redos` 警示沒有理由再開著。實際風險很低，但修正只有幾行，比留下人工判定不修的紀錄好，維護者選定修掉。

## Negative Scope

- 不改路徑檢查的判定結果。
- 不動 `canonicalize` 與同步資料夾的名稱比對。
- 不處理 secret scanning，目前的 token 讀不到。

## Not Empowered

- 公開文件寫「維護者」，不寫人名。
- 檔案用一般的寫入工具改，不用 Bash 或腳本繞過寫入掛勾。
- 核心不放給人看的文字。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊的正規表示式上失敗過
- [x] `specs` 與 `test` 兩條工作流程在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑

## The Defect, Measured

CodeQL 第 1 項警示：`js/polynomial-redos`，`src/core/path-guard.ts:50`，等級 high，2026-10-31 起一直開著。這一行用 `/[\\/]+$/` 去掉結尾的斜線，遇到一長串不在結尾的斜線時，耗時接近平方成長。

2026-11-01 在 Windows 參考機器量：

| 情況 | 結果 |
| :--- | :--- |
| 只跑正規表示式，32,767 字元 | 4.5 秒 |
| 只跑正規表示式，100,000 字元 | 20 秒 |
| 走真實流程，Windows，32,767 字元 | 3 毫秒，路徑解析後剩 6 個字元 |
| `path.posix` 解析一長串 `/` | 剩 4 個字元 |
| `path.posix` 解析一長串 `\` | 沒有收掉，走得到這個正規表示式 |

輸入只來自 `OneDrive` 這類環境變數，也就是使用者自己的環境。Linux 與 macOS 的完整流程沒有實際跑過。
