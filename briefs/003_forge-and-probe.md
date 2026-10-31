---
status: active
date: 2026-11-01
type: feature
wave: 2
affectedFiles:
  - CHANGELOG.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/0078-repository-security-settings.md
  - docs/adr/0084-*.md
  - package-lock.json
  - package.json
  - schemas/**
  - src/**
  - tests/**
  - tools/check-licenses.ts
  - tsconfig.json
protectedFiles:
  - .github/**
  - LICENSE
  - NOTICE
  - SECURITY.md
  - docs/research/**
  - tools/npm-placeholder/**
---

# 003 — 合成 PDF 鍛造與探測

## Intent

這個回合結束時，`tome add <pdf>` 能登記一本書並跑探測，加密的 PDF 一律拒絕；`tome probe <book>` 用 pdf.js 回報文件層級（加密、tagged、書籤、頁碼標籤、連結、跨頁攤開）、頁面層級（`native`、`scan`、`broken_text`、`image_only`）與環境層級（GPU、VRAM），不載入任何模型。測試用的合成 PDF 在執行時用 pdfkit 鍛造，帶生成時的標準答案，repo 裡沒有任何 PDF。這是 M1 的第一個回合，後面三個回合都建在這份探測結果與鍛造器上。

Norman 在開工前回答了 16 個決定，全部寫進 [ADR-0084](../docs/adr/0084-m1-parsing-decisions.md)。順便把已完成的手動設定寫回文件：`main` ruleset 與 CodeQL 預設設定在 2026-11-01 開好了，白皮書 §7.5 與 [ADR-0078](../docs/adr/0078-repository-security-settings.md) 的 Open Questions 要更新，immutable releases 還沒開。

這一輪新增三個相依。執行期一個：`unpdf` 1.9.1，內含 pdf.js 6.4.299，沒有原生模組，取代會把 `@napi-rs/canvas` 帶進主程式行程的 `pdfjs-dist`。開發用兩個：`pdfkit` 鍛造合成 PDF（ADR-0061），`@types/pdfkit` 是它的型別。

## Negative Scope

- 不跑解析引擎。沒有 Docling、`tome-engine/1`、`tome engine`、`tome extract`、document 層、字元守恆，那是 brief 005 與 006。
- 頁面的 `engine` 分配留到 brief 005，這一輪只有頁面類型。
- 沒有語言設定檔與規則包工具，那是 brief 004。依語言判斷文字層品質的訊號也在 004，所以「對應錯但字元合法」的 ToUnicode 這一輪抓不到，H-10 這一輪只驗字元類別。
- `--system` 只記下 ID，這一輪不檢查規則包存不存在。`tome probe` 不建議規則包（排到 M2）。
- 不做 `tome status`，不連網，沒有翻譯。
- 版面案例（雙欄、邊欄、跨頁表格、首字放大、標題轉外框、背景紋理、購買者浮水印、連字、斷字）留到 brief 006 配合 H-5、H-8 做，這一輪只鍛造探測用得到的案例。
- 不改其他 repo，不放任何商業書籍內容、PDF 或金鑰。

## Not Empowered

- 既有 ADR 的決定不能改寫，要改就新增 ADR。ADR-0078 只更新 Open Questions。
- 主程式的授權白名單不動。放寬的只有 ADR-0084 寫明的開發相依。
- ADR-0084 的 `status: accepted` 只放 Norman 回答過的 16 項。我自己選的細節寫成提案，列在白皮書的「已實作」段落或回報裡。
- 選型、命名、範圍、政策不能自己決定，做到一半發現的當下問。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run build`、`npm run licenses` 在本機都通過
- [x] `specs` 與 `test` 兩條工作流程在 Windows 與 Ubuntu 的 CI 都通過
- [x] 只有一個檔案碰 pdf.js，主程式不依賴 pdfkit

<!-- @assert-count target="src/core/pdf.ts" symbol="from 'unpdf'" expected="1" reason="pdf.js 只從這個檔案進主程式" -->

- [x] 紀錄與輸出不含書本文字：書籤標題、頁面文字只進工作區，訊息只帶數字與路徑
- [x] 金鑰、本機路徑與商業內容都沒有進 repo，推送前掃描過
- [x] 新相依過了 ADR-0077 的冷卻期，版本釘死，授權檢查通過

<!-- @assert-absence target="package.json" regex="true" symbol="\"[^\"]+\":\s*\"[\^~]" comments="include" reason="版本釘死" -->

- [x] H-10 的字元類別部分有實測結果，Q-9 有參考機器的數字，都寫回白皮書，沒測到的不標成已驗證

## Acceptance Criteria

- [x] `tome add` 拒絕加密的 PDF，回結束碼 1，包含只限制複製、不需密碼就能開啟的 PDF，也不留下書的目錄
- [x] `tome add` 記下路徑與雜湊、不複製 PDF，預設取檔名，撞名回 1 要求 `--as`，同一個雜湊再 add 只更新路徑
- [x] `tome probe` 回報 tagged、書籤、頁碼標籤、連結與跨頁攤開，以及書籤與頁碼標籤的覆蓋率（H-7）
- [x] 頁面分成 `native`、`scan`、`broken_text`、`image_only`，覆蓋掃描頁上有 OCR 隱藏文字層、掃描頁只有一行頁尾浮水印的情況
- [x] `tome probe` 回報 GPU 與 VRAM，沒有 GPU 時也回報
- [x] 輸入的內容指紋沒變就跳過，PDF 被換掉時回報不是靜默重算
- [x] 鍛造是決定性的：同一個案例產生同樣的位元組，每個案例帶標準答案
- [x] 授權檢查對開發相依多收 0BSD，`png-js` 2.0.0 的例外綁版本，主程式相依的判定不變
- [x] 400 頁的合成書有效能預算測試，CI 門檻留餘裕（ADR-0068）
