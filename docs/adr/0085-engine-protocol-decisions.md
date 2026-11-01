---
id: ADR-0085
status: accepted
date: 2026-11-01
depends-on: [ADR-0007, ADR-0023, ADR-0024, ADR-0034, ADR-0039, ADR-0059, ADR-0061, ADR-0064, ADR-0071, ADR-0077]
amends: [ADR-0084]
---

# ADR-0085：引擎協定與 Docling 的選型

## 脈絡

M1 的第三個回合開工前比對 ADR-0084 與實際工具，留下八個沒定的項目。其中兩項是 ADR-0084 本身要修改：

* 第 10 項寫 `exclude-newer` 用固定截止日，同時加 Dependabot 的 uv。實測 uv 0.13.6：截止日之後上架的版本一律解析失敗，`docling==2.145.0` 被擋下。Dependabot 開的 PR 重鎖時會撞到同一道牆，安全更新也一樣，兩件事不能同時成立。
* 第 16 項只同意下載 CPU 版，第 11 項的「VRAM 夠」卻沒有數字，GPU 路徑沒跑過就會發布。

另外幾項是實測才看到的：

* Docling 2.140.0 抓 layout 模型時 `revision="main"`，只有 TableFormer 釘在 v2.3.0，`docling-tools models download` 拿到的權重會飄，還多下載 164 MB 的 ONNX 版。
* Docling 的例外訊息可能帶書本文字，ADR-0059 第 5 項不准進紀錄。

下列第 1 到 8 項由維護者在 2026-11-01 從問題介面選定，第 9 項的細節也由維護者接受。

## 決定

**修改 ADR-0084**

1. 第 10 項的冷卻期改用相對期間：`exclude-newer = "14 days"`，重鎖時取當天減 14 天，不再固定截止日。安全更新用 `exclude-newer-package` 開例外。Dependabot 的 uv 不變。
2. 第 16 項加上：同意在參考機器下載 CUDA 版實測一次，「VRAM 夠」的門檻用量到的值。

**範圍**

3. `tome extract` 在 brief 005 就加，只跑引擎、存 `source` 層，brief 006 接組裝與字元守恆。

**引擎**

4. `engine.yaml` 的環境建法只收 `uv` 與 `none`。不執行任意安裝指令，路徑來源的引擎加警告。
5. 引擎的 stderr 不存也不印，失敗只回報頁碼與原因代碼。
6. 權重用 `huggingface_hub` 依鎖定的 commit 下載需要的檔案，不用 `docling-tools`。
7. Docling 轉接器的 Python 是 `>=3.13,<3.14`，沒裝時由 uv 下載，屬於 ADR-0039 的安裝例外。

**CI**

8. `.github/workflows/engine.yml` 跑 Ubuntu 與 Windows，不設必要檢查，ruleset 不變。uv 用 `astral-sh/setup-uv` v10.3.0，釘 commit。

**細節**

9. 環境放 `<工作區>/engines/<名稱>/`，uv 只在安裝時需要。`source` 層放 `ir/source/<PDF 雜湊>/<引擎>/<版本>/<設定雜湊>/`。schema 一個檔 `schemas/tome-engine-1.schema.json`。`tome.yaml` 的 `engines` 由 `add`、`remove` 維護。Docling 逐頁呼叫，OCR 關閉、表格開啟。bbox 是 PDF 點，原點在左下，跟 `src/core/pdf.ts` 一致。區塊 ID 由轉接器算，組裝時重算。離線環境變數放 `engine.yaml`，核心不寫引擎的名字。`--gpu` 偵測不到 NVIDIA 回 1，不下載。來源清單放 `tests/fixtures/SOURCES.yaml`。

## 量測

都在參考機器（RTX 4060 Laptop 8 GB）上量，用合成 PDF，**已驗證**的範圍只到這裡，商業書**還沒量**。

| 項目 | 結果 |
| :--- | :--- |
| 套件 | Docling 2.140.0，torch 2.14.1，鎖定檔 131 個套件。CPU 版環境 105 個，依套件中繼資料沒有 GPL、AGPL 或非商業授權 |
| 磁碟 | CPU 版環境 1.1 GB，CUDA 版 3.5 GB，權重 367 MB |
| VRAM 峰值 | 2、12、30 頁的書分別多占 819、819、809 MB，不隨頁數增加。門檻取整到 1,024 MB |
| CPU 版 | 30 頁雙欄文字 61 秒；12 頁、每頁 3 個表格 170 秒，都含啟動 |
| CUDA 版 | 同樣兩本 45 秒、69 秒，都含啟動 |

門檻比的是剩餘 VRAM，不是總量：參考機器閒置時桌面就占 1,608 MB。

**還沒驗證**：

* Dependabot 對 `exclude-newer = "14 days"` 與 `conflicts` 的實際行為。上面只驗了 uv 本身，要等第一次週更才看得到。
* Linux 上的 CUDA 版。只有鎖定檔驗過，Windows 才實際跑過。鎖定檔裡 Linux 的 CUDA 相關套件多約 2.5 GB。
* 執行時離線的保證只到 Ubuntu 的 `engine.yml`，在沒有網路的 namespace 裡跑。Windows 靠環境變數。

## 驗證

<!-- @assert-count target="engines/docling/pyproject.toml" regex="true" symbol="exclude-newer = .14 days." expected="1" comments="include" reason="第 1 項：冷卻期用相對期間" -->
<!-- @assert-count target=".github/dependabot.yml" symbol="package-ecosystem: uv" expected="1" reason="ADR-0084 第 10 項：Dependabot 加 uv" -->
<!-- @assert-count target=".github/dependabot.yml" regex="true" symbol="- '@spec-family/\*'" expected="1" reason="ADR-0082 第 21 項：維護者自己的工具不受冷卻期限制" -->
<!-- @assert-count target="src/core/process.ts" symbol="keepStderr = false" expected="1" reason="第 5 項：預設不留 stderr" -->
<!-- @assert-absence target="src/core/extract.ts" symbol="keepStderr" reason="第 5 項：引擎的 stderr 不留" -->
<!-- @assert-count target="engines/docling/main.py" regex="true" symbol="revision.: .[0-9a-f]{40}" expected="2" reason="第 6 項：權重釘在 commit" -->
<!-- @assert-absence target="engines/docling/main.py" symbol="docling-tools" comments="include" reason="第 6 項：不用會讓權重飄掉的工具" -->
<!-- @assert-count target="engines/docling/pyproject.toml" symbol=">=3.13,<3.14" expected="1" reason="第 7 項：釘 Python" -->
<!-- @assert-count target=".github/workflows/engine.yml" symbol="astral-sh/setup-uv@1c37ad07a6a961277cf70c0d37d6f313000f5884" expected="1" reason="第 8 項：Action 釘在 commit" -->
<!-- @assert-absence target="src" glob="*.ts" regex="true" symbol="[Dd]ocling" reason="Docling 走同一套協定，沒有特權（白皮書 §5.3）" -->
<!-- @assert-absence target="languages" symbol="神祇" reason="ADR-0023：遊戲概念不進語言設定檔" -->
<!-- @assert-count target="package.json" regex="true" symbol="engines.," expected="1" reason="ADR-0071：轉接器隨 npm 包發送" -->
<!-- @assert-present file="engines/docling/engine.yaml,engines/docling/main.py,engines/docling/pyproject.toml,engines/docling/uv.lock,schemas/tome-engine-1.schema.json,tests/fixtures/SOURCES.yaml" -->

## 後果

改到 `engines/` 的 PR 多一條不是必要檢查的工作流程，要看結果才知道。Docling 自己換模型時，轉接器的 commit 要手動跟著確認。`--gpu` 只在 Windows 實際跑過。相對期間讓重鎖的結果隨日期改變，但安裝走 `--frozen`，不受影響。

## 替代方案

**維持固定截止日**：Dependabot 只能當提醒，ADR-0077「安全更新不等」做不到；**005 只有核心函式**：`engine.yml` 走不到真實指令；**開放任意安裝指令**：add 一個資料夾就等於執行它的指令；**`engine.yml` 只跑 Ubuntu**：torch 的 wheel 兩邊不同；**不下載 CUDA 版**：GPU 路徑沒跑過就發布；**stderr 存到書的目錄**：無法保證不含書本文字；**用 `docling-tools`**：權重會飄；都否決。

## Open Questions

* 引擎多久沒有事件就終止：目前是 10 分鐘，提案，沒有在真實書籍上量過。
