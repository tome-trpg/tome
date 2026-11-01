---
id: ADR-0088
status: accepted
date: 2026-11-01
depends-on: [ADR-0077, ADR-0085]
amends: [ADR-0085]
---

# ADR-0088：Docling 環境的安全更新

## 脈絡

Dependabot 第一次跑就對 Docling 環境開了三個安全更新，都失敗了：

| 套件 | 鎖定 | 修正版 | 通報 | 為什麼失敗 |
| :--- | :--- | :--- | :--- | :--- |
| `pillow` | 12.3.0 | 13.0.0 | 39 份，PyPI 上 55 筆紀錄 | `docling-core` 2.101.1 限制 `<13`，`docling-core` 2.104.0 才放寬 |
| `certifi` | 2026.7.22 | 2026.10.18 | 1 份 | 上架 13 天，`exclude-newer` 擋下 |
| `setuptools` | 84.0.0 | 84.1.0 | 1 份 | 上架 12 天，`exclude-newer` 擋下 |

鎖定檔的 125 個套件版本逐一查過 PyPI，有通報的只有這三個。

ADR-0077 寫安全更新不等，ADR-0085 第 1 項寫要用 `exclude-newer-package` 開例外。`certifi`、`setuptools` 照做就好。`pillow` 不是冷卻期的問題，要嘛升 Docling，要嘛蓋過上游的限制。

0.1.0 還沒發布，目前只有參考機器上有這個環境。

下列決定由維護者在 2026-11-01 從問題介面選定。

## 決定

1. `[tool.uv]` 加 `override-dependencies = ["pillow>=13"]`，Docling 維持 2.140.0。升到允許 Pillow 13 的 Docling 時，這行 MUST 拿掉。
2. `certifi`、`setuptools` 用 `exclude-newer-package` 開例外，跟 `pillow` 一起重鎖。

## 量測

2026-11-01，Windows 參考機器，合成 PDF。

| 項目 | 結果 |
| :--- | :--- |
| 重鎖 | 只動這三個套件：`pillow` 13.0.0、`certifi` 2026.10.23、`setuptools` 84.2.1 |
| CPU 版 | 重新安裝，`tests/engine` 通過，鍛造的文字都在 |
| CUDA 版 | 重新安裝，`tests/engine` 通過，鍛造的文字都在，`torch.cuda.is_available()` 是 True |
| 通報 | 三個新版本在 PyPI 上都沒有通報 |
| 授權 | 跟舊版相同：`pillow` 是 MIT-CMU，`certifi` 是 MPL-2.0，`setuptools` 是 MIT |

**還沒驗證**：

* Pillow 13 與 Docling 2.140.0 的組合，只有合成 PDF 驗過，上游沒測過這個組合，商業書**還沒量**。
* 版面分析的結果跟 Pillow 12 是否完全相同，沒有逐項比對。ADR-0085 的量測沒有重做。
* 那 39 份通報在 PDF 流程碰不碰得到。Docling 的 PDF 流程粗查沒有 `Image.open`，但這不是驗證。

## 驗證

<!-- @assert-count target="engines/docling/pyproject.toml" symbol="override-dependencies = [" expected="1" reason="第 1 項：蓋過 Docling 2.140.0 對 Pillow 的限制" -->
<!-- @assert-count target="engines/docling/uv.lock" regex="true" symbol="overrides = ...name = .pillow." expected="1" reason="第 1 項：覆寫要真的進鎖定檔" -->
<!-- @assert-count target="engines/docling/pyproject.toml" symbol="exclude-newer-package = {" expected="1" reason="第 2 項：安全更新走例外" -->

## 後果

`pillow` 超出 Docling 2.140.0 宣告的範圍。Dependabot 之後提 `docling-core` 或 Docling 的 PR 時，要記得檢查第 1 項。`certifi`、`setuptools` 的冷卻期比其他套件短。

## 替代方案

**升 Docling**：沒有越過上游的限制，但 `docling-core` 2.104.0 才 9 天，整條相依都要開例外，模型行為與 ADR-0085 的量測要重做；**等 5 天再升**：不用開例外，但違反 ADR-0077；都否決。

## Open Questions

* 例外的寫法：目前用相對期間 `7 days`，取 ADR-0077 的 patch 冷卻期，是提案。固定日期過了 14 天就比全域的冷卻期更舊，反而把版本卡住，之後的安全更新會再失敗一次，所以沒有用。
* 這兩個例外要留著，還是滿 14 天後拿掉。
