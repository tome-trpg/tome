---
id: ADR-0084
status: accepted
date: 2026-11-01
depends-on: [ADR-0007, ADR-0023, ADR-0024, ADR-0044, ADR-0049, ADR-0050, ADR-0053, ADR-0059, ADR-0071, ADR-0082, ADR-0083]
amends: [ADR-0016, ADR-0061, ADR-0077, ADR-0080, ADR-0082]
---

# ADR-0084：M1 解析的選型與範圍

## 脈絡

M1 開工前比對白皮書、ADR 與實際套件，留下 16 個沒定的項目。其中幾項是實測才發現的：

* `pdfjs-dist` 6.4.299 帶進可選的 `@napi-rs/canvas`，import 時就載入主程式行程。它的 SBOM 含 FTL、ICU、IJG、libpng-2.0、Zlib，都不在 ADR-0016 的白名單。抽文字、書籤、頁碼標籤、連結都不需要它。`overrides` 只對這個 repo 有效，管不到 `npm install -g` 的使用者。
* `pdf-lib` 1.17.1 五年沒有更新，帶進 `pako`（MIT AND Zlib），過不了 ADR-0082 第 6 項的授權檢查。
* `pdfkit` 0.20.2 的相依樹有 `tslib` 2.9.1（0BSD）與 `png-js` 2.0.0（`package.json` 沒有 `license` 欄位，LICENSE 檔是 MIT）。
* Docling 幾乎每天發版。CUDA 版 torch 的 Windows wheel 是 1,991 MB，CPU 版 124 MB。
* 白皮書 §5.1、§6.1 寫 `tome probe` 免 GPU、不載模型，解析與組裝是 `tome extract`，但附錄 B 的 M1 沒有列 `extract`。

下列決定都由維護者在 2026-11-01 回答。

## 決定

**回合**

1. M1 分四個 brief：003 鍛造與探測、004 語言設定檔與規則包工具、005 引擎協定與 Docling、006 document 層與字元守恆。
2. 一個 brief 的 PR 合併後才開下一個。

**範圍**

3. M1 加上 `tome extract`，附錄 B 跟著更新。`tome add` 登記並探測，`tome probe` 只用 pdf.js，解析、組裝與字元守恆在 `tome extract`。
4. `overrides` 的六種操作都在 M1 做：改角色、改順序、合併、拆分、略過、`redact`。格式是 `tome-overrides/1`。
5. 規則包宣告的角色在 M1 的組裝步驟判定，用測試專用的合成規則包驗證。
6. `tome engine list`、`tome engine remove`、`tome system list` 納入 M1。`tome probe` 建議規則包與 `tome status` 排到 M2。

**相依**

7. 主程式的 pdf.js 用 `unpdf`，它內含 pdf.js，沒有原生模組。不用 `pdfjs-dist`。
8. 合成 PDF 只用 `pdfkit` 鍛造，修改 ADR-0061 第 5 項。pdfkit 做不到的底層物件用它的低階介面補。
9. 開發相依的授權檢查多收 0BSD，`png-js` 2.0.0 開一個綁版本的窄例外。主程式相依的白名單不變。修改 ADR-0082 第 6 項。
10. ADR-0077 的冷卻期套用到 Python：`uv.lock` 用 `exclude-newer` 固定截止日，取鎖定當天減 14 天，Dependabot 加 uv。

**引擎**

11. `tome engine add docling` 預設裝 CPU 版，加 `--gpu` 才裝 CUDA 版，偵測到 NVIDIA 時提示。`uv.lock` 同時鎖兩種。執行時有 CUDA 且 VRAM 夠就用 GPU，否則退回 CPU。

**命名**

12. 語言設定檔放根目錄 `languages/`：`languages/source/en.yaml`、`languages/target/zh-TW.yaml`。格式是 `tome-lang/1`，schema 在 `schemas/tome-lang-1.schema.json`，隨 npm 包發送。
13. `<book>` 預設取 PDF 檔名，清掉不合法的字元。撞名時回結束碼 1，要求用 `--as <名稱>`。同一個雜湊再 `tome add` 只更新路徑（白皮書 §6.3）。

**規則包工具**

14. `tome system lint` 的危險正則檢查用手寫的啟發式，不加相依，再用對抗輸入實跑一次量時間。真正的防護仍是 worker 限時（ADR-0049）。
15. `tome system lint --public` 才查 `LICENSE`、`NOTICE` 與必要聲明。必要聲明的字串清單放資料檔，依 `pack.yaml` 的 `license` 查。

**實測**

16. 第一次實測 Docling 時可以在參考機器下載 CPU 版的套件與模型。

## 驗證

<!-- @assert-import-absence target="src" exclude="src/core/pdf.ts *.json" module="unpdf" reason="只有 PDF 模組碰 pdf.js" -->
<!-- @assert-import-absence target="src" exclude="*.json" module="pdfjs-dist pdfkit pdf-lib @napi-rs/canvas" reason="不用 pdfjs-dist，鍛造工具也不進主程式" -->
<!-- @assert-absence target="package.json" symbol="pdf-lib" comments="include" reason="第 8 項：不再用 pdf-lib" -->
<!-- @assert-count target="tools/check-licenses.ts" symbol="DEV_ONLY_ALLOWED" min="2" reason="第 9 項：0BSD 只對開發相依放行" -->
<!-- @assert-count target="tools/check-licenses.ts" symbol="DEV_LICENSE_EXCEPTIONS" min="2" reason="第 9 項：沒有授權欄位的開發相依要逐一寫明" -->

## 後果

`unpdf` 是第三方重新打包的 pdf.js，要等它跟上才拿得到 pdf.js 的修正，每次升級要確認它內含的版本。M1 的範圍多了 `tome extract`，白皮書的路線圖要跟著改。`tome-lang/1` 是第五個帶版本號的格式。ADR-0061 寫的 `pdf-lib` 只剩歷史意義。

## 替代方案

**`pdfjs-dist` 加新的授權例外**：官方套件，但原生模組進主程式行程，例外比 ADR-0083 寬，冷卻期也管不到使用者；**`pdfjs-dist` 加模組掛勾擋掉 canvas**：二進位檔還是裝到使用者機器，是取巧；**`pdf-lib`**：白名單要加 Zlib，還依賴五年沒更新的套件；**手寫 PDF 產生器**：字寬、排版、加密都要自己維護；**`tome probe` 直接跑引擎**：跟 §5.1 矛盾，Q-9 的 30 秒也達不到；**只釘版不設冷卻**：上架頭幾天的版本會進來，跟 npm 的規則不一致；**依偵測自動裝 CUDA**：使用者選不了 2 GB 的下載；都否決。
