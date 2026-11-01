---
status: archived
date: 2026-11-01
type: feature
wave: 6
affectedFiles:
  - .github/dependabot.yml
  - CHANGELOG.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - engines/docling/engine.yaml
  - schemas/tome-engine-1.schema.json
  - src/**
  - tests/**
protectedFiles:
  - .github/workflows/**
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CLAUDE.md
  - docs/research/**
  - engines/docling/main.py
  - engines/docling/pyproject.toml
  - engines/docling/uv.lock
  - languages/**
  - package-lock.json
  - package.json
integrity: sha256-5ffe0af981411388053714e705040d05af5b89a5e709a4e04f9f845cc761b386
---

<!-- spec-brief:banner -->
> **Archived 2026-11-01.**
> 引擎可以在 engine.yaml 的 license.proprietary 宣告環境裡的專有元件，裝完會提示，Docling 宣告 Intel oneMKL。uv 的 patch 冷卻期改成 14 天，跟 exclude-newer 一致。
> Merged in pull request [#16](https://github.com/tome-trpg/tome/pull/16).
> Recorded at commit `b1a58a2`: 13 files changed, +233 −11.
> The body below describes the tree before execution and is not maintained.
<!-- /spec-brief:banner -->

# 008 — 引擎的專有元件提示與 uv 的冷卻期

## Intent

這個回合結束時，引擎能在 `engine.yaml` 宣告環境裡的專有元件，TOME 裝完會照實提示。Docling 宣告 Intel oneMKL，因為它在 CPU 版與 CUDA 版的 Windows、Linux wheel 裡都量到了，而 CPU 版是預設安裝，ADR-0085 第 10 項沒有涵蓋。提示靠宣告，不靠核心認得廠商，所以不帶這些元件的引擎不會誤報。同時把 Dependabot 的 uv 冷卻期對齊 `exclude-newer = "14 days"`：第一次週更量到 7 天冷卻提出的版本會被鎖定檔擋下，每週都會失敗。

## Negative Scope

- 不做 document 層、組裝或字元守恆。brief 006 由主 session 通知才開。
- 不提示 LGPL 的函式庫，ADR-0085 的 Open Questions 維持待決。
- 不改鎖定檔、轉接器或 Python 相依。
- 不處理 Dependabot 開的 PR，也不動安全更新要手動開 `exclude-newer-package` 例外這件事。
- 不把 `--gpu` 的提示改成宣告式，`engine.gpu_license` 維持原樣。

## Not Empowered

- ADR-0087 沒寫到的選型、命名、範圍、政策不能自己定成 `accepted`，要先問。
- 核心不能寫廠商或引擎的名字，文字留在 `zh-TW.json`。
- 公開 repo 的文件寫「維護者」，不寫人名。
- 檔案用一般的寫入工具改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併。CI 全綠就回報 PR 連結與 head commit。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run build`、`npm run licenses` 在本機都通過
- [x] `specs`、`test` 兩條工作流程在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [x] `src/` 沒有寫死 Intel，提示只來自 `engine.yaml` 的宣告
- [x] 沒有宣告的引擎裝完不提示，有測試看過

## Acceptance Criteria

- [x] `engine.yaml` 可以寫 `license.proprietary`，schema 擋得下空清單與不是字串的內容
- [x] `tome engine add docling` 裝完提示 Intel oneMKL，CPU 版與 CUDA 版都一樣，安裝失敗或已經裝好時不提示
- [x] `.github/dependabot.yml` 的 uv 區塊 `default-days`、`semver-patch-days` 是 14，檔案開頭的註解寫清楚原因
- [x] ADR-0087 記下維護者的決定、Dependabot 第一次跑的結果與 Linux wheel 的量測，修改 ADR-0077 與 ADR-0085
- [x] 白皮書與 `CHANGELOG.md` 照實更新

**Accepted debt**：白皮書的 ADR 索引這個回合不加 ADR-0087，主 session 的 brief 010 正在改那一段，合併後再補一列。

## Measured

- Linux 的 oneMKL 是看 `libtorch_cpu.so` 的字串與符號，沒有實際執行。
- `engine.yml` 在 `6b02ba2` 的 attempt 1，`docling` 兩個平台都失敗，沒有重跑。`tests/engine/docling.test.ts` 要求執行紀錄的授權與 `engine.yaml` 完全相同，多了 `proprietary` 就不相等。這個測試要設 `TOME_ENGINE_HOME` 才跑，推送前沒有在本機跑。執行紀錄只記程式與權重的授權，所以改成比這兩項。同一次日誌裡，兩個平台都印出了 Intel oneMKL 的提示。
- Dependabot 失敗的三個安全更新不在這個回合處理。第 3 項的冷卻期是預防，沒有修到它們。
