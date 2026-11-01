---
status: active
date: 2026-11-01
type: feature
wave: 5
affectedFiles:
  - .github/**
  - CHANGELOG.md
  - README.en.md
  - README.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - engines/**
  - languages/target/zh-TW.yaml
  - package.json
  - schemas/**
  - src/**
  - tests/**
  - tools/**
protectedFiles:
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CLAUDE.md
  - docs/research/**
  - languages/source/**
  - package-lock.json
---

# 005 — 引擎協定與 Docling

## Intent

這個回合結束時，TOME 能透過 `tome-engine/1` 把 `native` 頁交給獨立行程的解析引擎，把結果存成不可變的 `source` 層。`tome engine add docling` 用 uv 建出獨立環境與模型，`list`、`remove` 管理它，`tome doctor` 回報引擎狀態，`tome probe` 記下每頁要交給哪個引擎。Docling 走同一套協定，沒有特權，主程式不依賴任何引擎套件，執行時離線。平常的 CI 用錄好的引擎輸出測協定，改到 `engines/` 時才真的安裝 Docling 跑合成 PDF。這是路線圖 M1 的第三個回合（ADR-0084），document 層與字元守恆留給 brief 006。

## Negative Scope

- 不做組裝、接段、閱讀順序、規則包角色判定、`overrides`、字元守恆，那是 brief 006。
- 不做翻譯、遮蔽、估價、供應商 SDK，不做 M2 的任何東西。
- 不處理 `scan`、`broken_text`、`image_only` 頁：0.1.0 只處理 `native` 頁，其他列入報告。
- 不放 PDF、商業書的內容或截圖。錄好的引擎輸出只來自合成 PDF。
- 不把 Python 帶到 Docling 轉接器之外。

## Not Empowered

- ADR-0084 沒寫到的選型、命名、範圍、政策不能自己定成 `accepted`，要先問。
- 主程式的相依不能加引擎套件（LC-1、LC-2），引擎子行程不能繼承金鑰（ADR-0034）。
- 公開 repo 的文件寫「維護者」，不寫人名。
- 檔案用一般的寫入工具改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併。CI 全綠就回報 PR 連結與 head commit。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run build`、`npm run licenses` 在本機都通過
- [x] `specs`、`test` 兩條工作流程在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [x] `tests/` 用假引擎與錄好的輸出涵蓋協定：成功、單頁失敗、引擎當掉、輸出不合 schema，都不需要 Docling
- [x] 引擎子行程拿不到金鑰，有測試看過它真的被過濾
- [x] 測試素材都在來源清單登記授權與雜湊，未登記的讓 CI 失敗（PC-2）
- [x] `src/` 沒有寫死 Docling，它走同一套協定

## Acceptance Criteria

- [x] `tome engine add docling` 預設裝 CPU 版，`--gpu` 才裝 CUDA 版，偵測到 NVIDIA 時提示（ADR-0084 第 11 項）
- [x] `tome engine list`、`remove` 與 `tome doctor` 的引擎檢查可用
- [x] 改到 `engines/` 時 `engine.yml` 安裝 Docling 跑合成 PDF，輸出通過 `tome-ir/1` 驗證
- [x] Docling 的程式授權與權重授權都留下紀錄（LC-3）
- [x] `languages/target/zh-TW.yaml` 的第四句只說代名詞依實體卡（ADR-0023）
- [x] `.github/dependabot.yml` 加上 uv，`@spec-family/*` 用 `exclude` 排除在 npm 的冷卻期之外（ADR-0082 第 21 項），檔案開頭的註解寫清楚
- [x] 白皮書與 `CHANGELOG.md` 照實更新，沒量過的數字不寫成已實作

## Measured

2026-11-01，參考機器，Docling 2.140.0，合成 PDF。數字與判讀在 ADR-0085，白皮書 §5.3 有摘要。

- 本機實測沒有 `HF_HUB_OFFLINE` 以外的網路隔離。真正拿掉網路的是 `engine.yml` 的 Ubuntu 工作，本機 Windows 沒有隔離。
- `engine.yml` 在 `bfbe939` 的 attempt 1，`docling (ubuntu-24.04)` 失敗。測試釘住了版面模型的判斷：第 2 頁的圖說在 Ubuntu 判成 `paragraph`，Windows 是 `caption`，文字相同。沒有重跑，測試改驗每段鍛造的文字都在，比原本嚴格。兩個平台為什麼判得不同還沒查。
- Dependabot 對 `exclude-newer = "14 days"` 的實際行為沒驗證，只驗了 uv 0.13.6。
- 商業書沒量。H-5、H-7、H-8、H-9 都還是假說。
