---
status: active
date: 2026-11-01
type: defect
wave: 7
affectedFiles:
  - CHANGELOG.md
  - briefs/**
  - docs/WHITEPAPER.md
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
  - docs/research/**
  - engines/docling/engine.yaml
  - engines/docling/main.py
  - languages/**
  - package-lock.json
  - package.json
  - schemas/**
  - src/**
---

# 009 — Docling 環境的安全更新

## Intent

這個回合結束時，Docling 環境鎖定的 `pillow`、`certifi`、`setuptools` 都是已修正的版本。Dependabot 第一次跑就回報這三個套件有安全更新，但都失敗了：`pillow` 12.3.0 有 39 份通報，修正版 13.0.0 被 Docling 2.140.0 這條相依的 `<13` 限制擋下；`certifi`、`setuptools` 的修正版上架未滿 14 天，被 `exclude-newer` 擋下。ADR-0077 寫安全更新不等，所以用最小的改動處理：Docling 版本不動，`pillow` 用 `override-dependencies` 蓋過限制，另外兩個用 `exclude-newer-package` 開例外。

## The Defect, Measured

2026-11-01，PR #11 合併後 Dependabot 第一次執行。重現方式是讀 `engines/docling/uv.lock` 鎖定的每個版本在 PyPI JSON API 上的 `vulnerabilities`：125 個版本裡有 3 個有通報。

| 套件 | 鎖定 | 通報 | 修正版 | Dependabot 的結果 |
| :--- | :--- | :--- | :--- | :--- |
| `pillow` | 12.3.0 | 39 份，55 筆紀錄 | 13.0.0 | 失敗，`docling-core` 2.101.1 限制 `<13` |
| `certifi` | 2026.7.22 | 1 份 | 2026.10.18 | 失敗，上架 13 天，`exclude-newer` 擋下 |
| `setuptools` | 84.0.0 | 1 份 | 84.1.0 | 失敗，上架 12 天，`exclude-newer` 擋下 |

三個工作的定義都是 `command: security`，不看 Dependabot 的冷卻期。

## Negative Scope

- 不升 Docling、`docling-core` 或 torch，模型行為與 ADR-0085 的量測都不動。
- 不改轉接器、`engine.yaml` 或 TypeScript。
- 不處理 Dependabot 開的 PR。
- 不做 document 層，brief 006 由主 session 通知才開。

## Not Empowered

- ADR 沒寫到的選型、命名、範圍、政策不能自己定成 `accepted`，要先問。
- 公開 repo 的文件寫「維護者」，不寫人名。
- 檔案用一般的寫入工具改，不用 Bash 或腳本繞過寫入掛勾。鎖定檔由 `uv lock` 產生。
- 不合併。CI 全綠就回報 PR 連結與 head commit。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [ ] `specs`、`test`、`engine` 在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [x] 重鎖只動這三個套件，其他版本都不變
- [x] 鎖定檔裡沒有任何套件還有 PyPI 列出的通報

## Acceptance Criteria

- [x] `uv.lock` 的 `pillow` 是 13.0.0 以上，`certifi` 是 2026.10.18 以上，`setuptools` 是 84.1.0 以上
- [x] 真的安裝 CPU 版與 CUDA 版跑過 `tests/engine`，鍛造的文字都在
- [x] 三個新版本的授權看過，寫進 ADR-0088
- [x] ADR-0088 記下維護者的決定、拿掉覆寫的條件與沒有驗證的部分
- [x] 白皮書與 `CHANGELOG.md` 照實更新

## Measured

- CPU 版與 CUDA 版只在 Windows 參考機器實裝，Ubuntu 看 `engine.yml`。
- Pillow 13 與 Docling 2.140.0 的組合只有合成 PDF 驗過，ADR-0085 的量測沒有重做。
- 那 39 份通報在 PDF 流程碰不碰得到，沒有驗證。

**Accepted debt**：白皮書的 ADR 索引這個回合不加 ADR-0088，主 session 的 brief 010 正在改那一段，合併後再補一列。
