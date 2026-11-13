---
id: ADR-0137
status: accepted
date: 2026-11-14
depends-on: [ADR-0016, ADR-0043, ADR-0077, ADR-0085, ADR-0088]
---

# ADR-0137：Docling 環境的 soupsieve 安全更新

## 脈絡

Dependabot 在 2026-11-13 對 Docling 環境開了警示 #44，等級 high：

| 套件 | 鎖定 | 受影響 | 修正版 | 通報 |
| :--- | :--- | :--- | :--- | :--- |
| `soupsieve` | 3.0.3 | `< 4.0.0` | 4.0.0 | GHSA-mmhr-3c5m-f64f（CVE-2026-126190） |

這份通報是後代組合子（`a b`）的比對時間隨巢狀深度多項式成長，選擇器每多一個後代組合子，次方就加一。攻擊者能控制送進 Soup Sieve 的 HTML 或 XML 時，幾 KB 的文件就能讓 CPU 忙上數十秒。

`soupsieve` 是 `beautifulsoup4` 4.15.0 的相依。`beautifulsoup4` 只要求 `soupsieve>=1.6.1`，沒有上限，所以跟 ADR-0088 的 `pillow` 不同，不必蓋過上游的限制。擋住修正版的是 ADR-0085 的 `exclude-newer = "14 days"`：4.0 在 2026-11-03 上架，還不滿 14 天，跟 ADR-0088 的 `certifi`、`setuptools` 是同一種情況。

ADR-0077 第 2 項寫安全更新不等冷卻期，ADR-0085 第 1 項寫安全更新用 `exclude-newer-package` 開例外。維護者決定另開一個回合處理這則警示（回合 051），做法照 ADR-0088 第 2 項的前例。

## 決定

1. `[tool.uv]` 的 `exclude-newer-package` 加上 `soupsieve = "7 days"`，期間跟 ADR-0088 第 2 項的 `certifi`、`setuptools` 相同。只重鎖 `soupsieve`（`uv lock --upgrade-package soupsieve`），Docling 與其他套件都不動。
2. 期間是相對的，所以重鎖當天看得到的最新版本會被選上。2026-11-14 重鎖時，4.0 與 4.0.1 都已上架超過 7 天，4.1 只有 4 天，所以鎖定 4.0.1。

## 量測

2026-11-14，Windows 參考機器，合成 PDF。

| 項目 | 結果 |
| :--- | :--- |
| 重鎖 | uv 0.13.7，只動 `soupsieve`：3.0.3 → 4.0.1。鎖定檔另外多一行例外，其他 130 個套件的版本與雜湊都不變 |
| 雜湊 | 鎖定檔的 wheel 與 sdist 雜湊跟 PyPI 上 4.0.1 的 SHA-256 相同 |
| 相容 | `beautifulsoup4` 4.15.0 要求 `soupsieve>=1.6.1`，沒有上限。4.0.1 要求 Python `>=3.11.5`，環境是 3.13。4.0 標成不相容的兩項只改 `template` 與 `iframe` 內容的比對語意，沒有改函式介面 |
| 撤回 | PyPI 上 4.0、4.0.1、4.1 都沒有被撤回 |
| 通報 | 4.0.1 在 PyPI 上沒有通報。重鎖後，鎖定檔裡 130 個來自套件索引的版本逐一查過 PyPI 的 `vulnerabilities`，沒有任何通報；另一個是 TOME 自己的虛擬專案 |
| 授權 | 跟 3.0.3 相同，是 MIT：中繼資料的 `License-Expression` 是 MIT，wheel 附的 `LICENSE.md` 是 MIT 授權全文，在 ADR-0016 與 ADR-0043 的允許清單內 |
| CPU 版 | 用 `tome engine add docling` 在暫存工作區重新安裝，環境裡是 `soupsieve` 4.0.1。`tests/engine` 的 2 個測試都通過，鍛造的文字都在 |

**還沒驗證**：

* CUDA 版沒有重新安裝。`soupsieve` 是純 Python 的 `py3-none-any` wheel，CPU 版與 CUDA 版鎖定的是同一個檔案，但這是推論，不是量測。
* 這份通報在 TOME 的流程碰不碰得到。粗查環境裡的 Docling，只有 HTML、JATS、USPTO 三個後端匯入 `bs4`，轉接器 `main.py` 只設定 PDF 的轉換，但這不是驗證。
* 4.0 改了 `template` 與 `iframe` 的比對語意，對 Docling 的 HTML 後端有沒有影響沒有查。TOME 不走那條路。

## 驗證

<!-- @assert-count target="engines/docling/pyproject.toml" regex="true" symbol="soupsieve = .7 days." expected="1" reason="第 1 項：soupsieve 的安全更新走例外" -->
<!-- @assert-count target="engines/docling/uv.lock" symbol="soupsieve = { timestamp" expected="1" reason="第 1 項：例外要真的進鎖定檔" -->
<!-- @assert-count target="engines/docling/uv.lock" regex="true" symbol="soupsieve-[0-3]\." expected="0" reason="第 1 項：鎖定檔裡沒有修正版以前的 soupsieve" -->

## 後果

`soupsieve` 的冷卻期跟 `certifi`、`setuptools` 一樣比其他套件短：之後重鎖時，它上架滿 7 天的新版本就會被選上，包括 major。白皮書 §9 的 ADR 索引這次不加這一列，因為回合 046 正在改白皮書，之後補上。

## 替代方案

**例外寫成 `soupsieve = "11 days"` 或固定日期，鎖在 4.0**：只為了取到通報寫的修正版本身，4.0.1 修的是另外兩種二次時間，沒有理由避開；固定日期過了 14 天反而會把版本卡住，ADR-0088 已經否決。**升 `beautifulsoup4` 或 Docling**：`beautifulsoup4` 本身沒有限制，升它不會讓 `soupsieve` 升上去，Docling 則要重做 ADR-0085 的量測。都否決。

## Open Questions

* 跟 ADR-0088 的 Open Questions 相同：例外的期間取 `7 days` 是提案；`certifi`、`setuptools`、`soupsieve` 的例外要一直留著，還是滿 14 天後拿掉。
