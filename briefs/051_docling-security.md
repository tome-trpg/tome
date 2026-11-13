---
status: active
date: 2026-11-14
type: defect
wave: 51
affectedFiles:
  - CHANGELOG.md
  - briefs/**
  - docs/adr/**
  - engines/docling/pyproject.toml
  - engines/docling/uv.lock
protectedFiles:
  - .github/**
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CLAUDE.md
  - README.en.md
  - README.md
  - docs/WHITEPAPER.md
  - docs/research/**
  - engines/docling/engine.yaml
  - engines/docling/main.py
  - languages/**
  - package-lock.json
  - package.json
  - prompts/**
  - providers/**
  - schemas/**
  - src/**
  - systems/**
  - tests/fixtures/SOURCES.yaml
---

# 051 — docling 環境的安全更新

## Intent

這個回合結束時，Docling 環境鎖定的 `soupsieve` 是 4.0.0 以上，Dependabot 警示 #44 在合併後關閉。`soupsieve` 3.0.3 有 GHSA-mmhr-3c5m-f64f（CVE-2026-126190）：後代組合子的比對時間隨巢狀深度多項式成長，幾 KB 的 HTML 就能讓 CPU 忙上數十秒。它是 `beautifulsoup4` 4.15.0 的相依，`beautifulsoup4` 只要求 `soupsieve>=1.6.1`，沒有上限，擋住修正版的是 `exclude-newer = "14 days"`：4.0 在 2026-11-03 上架，還不滿 14 天。ADR-0077 第 2 項寫安全更新不等，所以照 ADR-0088 第 2 項對 `certifi`、`setuptools` 的做法，用 `exclude-newer-package` 對 `soupsieve` 開 `7 days` 的例外，只重鎖這一個套件，Docling 與其他套件都不動。決定寫成 ADR-0137。

## The Defect, Measured

2026-11-14，`origin/main` 在 `b65caa4`。重現方式跟回合 009 相同：讀 `engines/docling/uv.lock` 的每個版本在 PyPI JSON API 上的 `vulnerabilities` 與 `yanked`。131 個套件裡，有通報的只有一個，沒有被撤回的版本。

| 套件 | 鎖定 | 通報 | 修正版 | 為什麼沒有自動升上去 |
| :--- | :--- | :--- | :--- | :--- |
| `soupsieve` | 3.0.3 | GHSA-mmhr-3c5m-f64f，high | 4.0.0 | 4.0 在 2026-11-03 上架，`exclude-newer = "14 days"` 擋下 |

`soupsieve` 在 PyPI 上 4.0 以後的版本：

| 版本 | 上架（UTC） | 撤回 | 通報 | `7 days` 的例外看得到 |
| :--- | :--- | :--- | :--- | :--- |
| 4.0 | 2026-11-03 14:28 | 否 | 無 | 是 |
| 4.0.1 | 2026-11-04 16:36 | 否 | 無 | 是 |
| 4.1 | 2026-11-10 01:59 | 否 | 無 | 否 |

所以重鎖會取 4.0.1。

## Negative Scope

- 不升 Docling、`docling-core`、`beautifulsoup4`、torch 或其他套件，模型行為與 ADR-0085 的量測都不動。
- 不改轉接器、`engine.yaml`、TypeScript 或工作流程。
- 不拿掉 `certifi`、`setuptools` 的例外，也不回答 ADR-0088 的 Open Questions。
- 不改白皮書與 README：回合 046 正在改。白皮書 §9 的 ADR 索引這個回合不加 ADR-0137。
- 不處理 Dependabot 開的 PR。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定成 `accepted`，要先問 Manager，由 Manager 轉問維護者。
- 公開 repo 的文件寫「維護者」，不寫人名。
- 檔案用一般的寫入工具改，不用 Bash 或腳本繞過寫入掛勾。鎖定檔由 `uv lock` 產生。
- 不合併，不封存。CI 全綠就回報 Manager PR 編號與 head commit。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [ ] `specs`、`test`、`engine` 在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [x] 重鎖只動 `soupsieve`，其他版本都不變
- [x] 鎖定檔裡沒有任何套件還有 PyPI 列出的通報

## Acceptance Criteria

- [x] `uv.lock` 的 `soupsieve` 是 4.0.0 以上
- [x] 確認過 4.0.x 跟 `beautifulsoup4` 4.15.0、Python 3.13 相容，版本沒有被撤回
- [x] 真的安裝 CPU 版跑過 `tests/engine`，鍛造的文字都在
- [x] 新版本的授權看過，寫進 ADR-0137
- [x] ADR-0137 記下依據、量測與沒有驗證的部分
- [x] `CHANGELOG.md` 照實更新

## Measured

- 2026-11-14，Windows 參考機器。`uv lock --upgrade-package soupsieve`（uv 0.13.7）只動 `soupsieve`：3.0.3 → 4.0.1，鎖定檔另外多一行例外。重鎖後 130 個來自套件索引的版本在 PyPI 上都沒有通報。
- 本機：`npm run spec`（468 條斷言，含 ADR-0137 的 3 條）、`npm run typecheck`、`npm test`（2318 個通過、5 個略過）、`npm run licenses`（299 個套件，0 個違規）都通過。
- 本機引擎：`tome engine add docling` 裝到暫存工作區 45 秒，CPU 版；`tests/engine` 的 2 個測試通過，170 秒。CUDA 版沒有重新安裝，理由寫在 ADR-0137。
- 這份通報在 PDF 流程碰不碰得到，沒有驗證，只粗查過 `bs4` 的匯入位置。

**Accepted debt**：白皮書 §9 的 ADR 索引這個回合不加 ADR-0137，回合 046 正在改白皮書，合併後再補一列。
