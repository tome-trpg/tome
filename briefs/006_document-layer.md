---
status: active
date: 2026-11-01
type: feature
wave: 11
affectedFiles:
  - CHANGELOG.md
  - README.en.md
  - README.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - engines/docling/main.py
  - schemas/**
  - src/**
  - tests/**
protectedFiles:
  - .github/**
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CLAUDE.md
  - docs/research/**
  - engines/docling/engine.yaml
  - engines/docling/pyproject.toml
  - engines/docling/uv.lock
  - languages/**
  - package-lock.json
  - package.json
---

# 006 — document 層與字元守恆

## Intent

這個回合結束時，`tome extract` 把 `source` 層組裝成通過 `tome-ir/1` 驗證的 `document` 層：閱讀順序正確，邊欄走 `aside` 不打斷正文，跨欄、跨邊欄、跨頁的段落接回來，跨頁表格併成一張，規則包宣告的角色判定完成，章節與頁碼對照就位。`overrides.yaml` 的六種操作在重新解析後仍然有效，對不到的會回報。每頁做字元守恆檢查，缺字超過門檻的頁標成失敗、不進翻譯，有測試證明它真的會失敗。這是路線圖 M1 的最後一個回合（ADR-0084），結束時 PDF 能變成乾淨的 IR。

## Negative Scope

- 不做行內 `runs`（粗體、斜體、連結目標），排到 M3。
- 不自動判定 `index`、`credits`，先靠 `overrides` 或規則包。
- 不做編輯 `overrides.yaml` 的指令，手寫。
- 不從版面推斷標題層級與印刷頁碼。
- 不做 OCR，不處理 `scan`、`broken_text`、`image_only` 頁，這些頁列為 `skipped`。
- 不做翻譯、遮蔽、估價或 M2 的任何東西。
- 不放商業書的內容、PDF 或截圖。實測結果只寫數字，不寫書名與內容。

## Not Empowered

- ADR-0092 沒寫到的選型、命名、範圍、政策不能自己定成 `accepted`，要先問。放進 PR 說明不算問。
- 核心不含遊戲知識，也不依語言代碼分支，語言規則都來自語言設定檔。
- 公開 repo 的文件寫「維護者」，不寫人名。
- 檔案用一般的寫入工具改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併。CI 全綠就回報 PR 連結與 head commit。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run build`、`npm run licenses` 在本機都通過
- [x] 改到引擎的提交，推送前在本機真的跑過 `tests/engine`
- [x] `specs`、`test`、`engine` 在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [x] 紀錄與訊息不含書本文字，`--json` 的 `params` 只有數字與區塊 ID
- [x] `document` 層能由 `source` 與 `overrides` 重建，相同輸入得到相同結果
- [x] 核心沒有寫死語言或遊戲概念

## Acceptance Criteria

- [x] `tome add` 加 `tome extract` 把合成 PDF 變成通過 `tome-ir/1` 驗證的 `document` 層
- [x] 字元守恆在丟字時失敗，有測試證明，失敗的頁不進 `blocks`
- [x] 跨欄邊欄的閱讀順序正確，段落跨過邊欄接回來，用真的 Docling 驗過
- [x] `overrides` 的六種操作都有測試，對不到區塊的會回報
- [x] 規則包的角色用合成包驗過，正則逾時會回報是哪個模式
- [x] §8.5 列的版面案例都鍛造出來：雙欄、跨欄邊欄、跨頁表格、首字放大、標題轉外框、背景紋理、頁尾購買者浮水印、連字、斷字
- [x] H-5、H-7、H-8 的量測結果寫回白皮書，沒驗證的不標成已驗證
- [x] 附錄 B 的「目前階段」更新，已實作的項目標上路徑與測試

## Measured

2026-11-01，Windows 參考機器，Docling 2.140.0，合成 PDF。數字在 ADR-0092。

- 商業書：7 個 PDF、1,167 個原生頁，只統計數字，內文與頁面沒有離開本機。字元守恆因此改了規則，門檻由維護者定案，見 ADR-0092。1 個 PDF 加密被拒絕（PC-3）。
- 真實書籍的閱讀順序沒有驗證，只有間接指標。本機檢視檔已產生，由維護者判斷。
- `931797a` 的 `docling (windows-2025)` 在 attempt 1 失敗，結束碼 1，原因不明：當時測試沒印 findings，前後程式相同的 head 都是綠的，本機連跑 8 次輸出完全相同。沒有重跑，改成讓測試印出 findings，下次再發生看得到原因。之後的 head 第一次就全綠。
- `tome extract` 在全部沿用時不再略過授權紀錄的檢查，這是主 session 校對留下的項目，放進這個回合。
- 轉接器改了，所以 `source` 層會重新解析一次。`blocks` 的錄製輸出沒有跨框的項目，內容不變，沒有重錄。
