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

審查 PR 時又多兩件：CUDA 版的授權只審了 CPU 版，實作時定的幾項細節也沒有先問。

下列第 1 到 8 項由維護者在 2026-11-01 從問題介面選定，第 9 項的細節也由維護者接受。第 10、11 項是維護者在審查時選定的。

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

**授權**

10. CUDA 版比照 LC-2：使用者自行安裝、獨立行程，所以允許 `--gpu` 下載，TOME 不隨附。審查結果記在下面的「CUDA 版的授權審查」。`--gpu` 裝完的訊息多一句，說 CUDA 元件是 NVIDIA 專有授權，文字在 `zh-TW.json`，核心只回代碼 `engine.gpu_license`。

**實作時定的細節**

11. 下列六項沒有先問就做了，維護者審查時接受：
    * 門檻比剩餘 VRAM，不比總量，取 1,024 MB。量到的峰值是 819 MB，見量測一節。
    * 協定多兩個入口：`<引擎指令> --version`，版本一律問引擎；`<引擎指令> --prepare --data <目錄>`，安裝時下載權重，`engine.yaml` 不必寫安裝指令。
    * `source` 路徑的雜湊取前 16 字元，完整的 64 字元會超過 Windows 的 260 字元。
    * 一本書同時只跑一個流程，用書資料夾裡的 `book.lock`，持有者已經不在時接手。
    * `tome-probe/1` 多一個選用的 `engine`，`PROBE_VERSION` 升到 3，引擎一變就重新探測。
    * 鍛造器多一個 `blocks` 案例，讓引擎測試有表格、圖與頁尾可看。

## 量測

都在參考機器（RTX 4060 Laptop 8 GB）上量，用合成 PDF，**已驗證**的範圍只到這裡，商業書**還沒量**。

| 項目 | 結果 |
| :--- | :--- |
| 套件 | Docling 2.140.0，torch 2.14.1，鎖定檔 131 個套件。CPU 版環境 105 個，依套件中繼資料沒有 GPL、AGPL 或非商業授權。中繼資料看不到的函式庫見「CUDA 版的授權審查」 |
| 磁碟 | CPU 版環境 1.1 GB，CUDA 版 3.5 GB，權重 367 MB |
| VRAM 峰值 | 2、12、30 頁的書分別多占 819、819、809 MB，不隨頁數增加。門檻取整到 1,024 MB |
| CPU 版 | 30 頁雙欄文字 61 秒；12 頁、每頁 3 個表格 170 秒，都含啟動 |
| CUDA 版 | 同樣兩本 45 秒、69 秒，都含啟動 |

門檻比的是剩餘 VRAM，不是總量：參考機器閒置時桌面就占 1,608 MB。

同一份合成 PDF，Windows 與 Ubuntu 的文字完全相同，角色有一處不同：第 2 頁的圖說在 Ubuntu 判成 `paragraph`。原因**還沒查**，合成 PDF 用的是沒嵌入的基本字型，可能是渲染不同，也可能是模型在邊界上。所以角色是模型的判斷，不是轉接器的契約，轉接器保證的是字都在。

**還沒驗證**：

* Dependabot 對 `exclude-newer = "14 days"` 與 `conflicts` 的實際行為。上面只驗了 uv 本身，要等第一次週更才看得到。
* Linux 上的 CUDA 版。只有鎖定檔驗過，Windows 才實際跑過。鎖定檔裡 Linux 的 CUDA 相關套件多約 2.5 GB。
* 執行時有沒有嘗試連網。`engine.yml` 在 Ubuntu 上拿掉網路後解析成功，只證明解析不需要網路：程式吞掉的連線失敗不會讓測試失敗，所以不能證明它沒有嘗試連線。Windows 沒有拿掉網路，只有環境變數。鎖定檔裡沒有常見的遙測套件（sentry、opentelemetry、posthog 之類），這是看套件名稱，不是看行為。

## CUDA 版的授權審查

2026-11-01 審查 `uv.lock` 裡 `--extra gpu` 的全部套件：Windows 105 個，Linux x86_64 121 個，合計 124 個。Windows 讀參考機器裝好的環境，Linux 讀鎖定檔指向的 wheel，沒有實際安裝。標籤不等於內容，所以也看了 wheel 裡的授權文字與函式庫檔名，但沒有逐一稽核二進位檔。這是工程上的閱讀，不是法律意見。

**專有授權**。這些只在 Linux 是獨立套件：

| 條款 | 套件 |
| :--- | :--- |
| CUDA Toolkit EULA，文字相同 | `nvidia-cublas`、`nvidia-cuda-cupti`、`nvidia-cuda-nvrtc`、`nvidia-cuda-runtime`、`nvidia-cufft`、`nvidia-cufile`、`nvidia-curand`、`nvidia-cusolver`、`nvidia-cusparse`、`nvidia-nvjitlink`、`nvidia-nvshmem-cu13` |
| NVIDIA SDK 授權 | `nvidia-cudnn-cu13`、`nvidia-cusparselt-cu13` |

**標籤與內容不一致**：

| 套件 | 標的授權 | 實際 |
| :--- | :--- | :--- |
| `torch`（Windows） | Apache-2.0 等寬鬆授權，沒提 NVIDIA | 整包 CUDA 都在 wheel 裡，見下一段 |
| `torchvision` | BSD | CUDA 版兩個平台都帶 NVIDIA 的 `nvjpeg`，Linux 另帶 `libcudart`。Windows 的 CPU 版沒有 |
| `triton`（Linux） | MIT | wheel 帶 NVIDIA 的 `libcupti`、`libnvperf_host`，沒附 NVIDIA 的條款 |
| `nvidia-nccl-cu13` | `LicenseRef-NVIDIA-Proprietary` | 授權文字是 BSD-3-Clause 形式，比標籤寬 |
| `nvidia-nvtx` | Other/Proprietary | 授權文字是 Apache-2.0 WITH LLVM-exception，比標籤寬 |

**Windows 的 `torch` wheel 帶專有元件。** Windows 沒有任何 `nvidia-*` 套件，CUDA 包在 wheel 裡：`torch/lib` 與 `torchvision` 共 27 個 NVIDIA 的 DLL，2.12 GB，依檔名對應到上表的 cuBLAS、cuDNN、cuFFT、cuSOLVER、cuSPARSE、cuRAND、NVRTC、nvJitLink、CUPTI、CUDA runtime 與 nvJPEG，只有 `nvToolsExt64_1.dll`（NVTX）是寬鬆授權。其中 15 個的版本資訊寫 NVIDIA Corporation。wheel 的中繼資料沒有提到它們，附的 95 份授權文字裡也沒有 CUDA EULA 或 NVIDIA SDK 授權。Linux 的 `torch` wheel 不帶這些函式庫，靠相依拉進上表的套件。

**沒標授權**：`cuda-toolkit`。wheel 只有三個中繼資料檔，沒有程式，只用相依拉進 NVIDIA 的套件，本身沒有東西要授權。

**Intel 的元件，CPU 版也有。** Windows 的 `torch` 不論 CPU 版或 CUDA 版都帶 `libiomp5md.dll`、`libiompstubs5md.dll`，版本資訊是 Intel OpenMP，`torch.__config__.show()` 也列出 oneMKL。wheel 沒附它們的授權文字。PyPI 上的 `intel-openmp` 與 `mkl` 都標成專有授權，條款分別是 Intel 的開發工具 EULA 與 Intel Simplified Software License；wheel 裡的版本是不是這兩份條款，沒有查證。Linux 的 wheel 檔名看不出來，也沒跑過。

**中繼資料看不到的函式庫，CPU 版也有**：

| 套件 | 內含 | 授權 |
| :--- | :--- | :--- |
| `shapely` | GEOS | LGPL-2.1 |
| `opencv-python-headless` | FFmpeg | LGPL-2.1 |
| `pywin32`（Windows） | `adodbapi` | LGPL-2.1 |
| `numpy`、`scipy` | GCC 執行期 | GPL-3.0-or-later WITH GCC-exception-3.1 |
| `docling-parse`（Windows）、`torch`（Linux） | GCC 執行期 | 同上 |

**其餘的標籤都是寬鬆授權**，上面那張表內含的函式庫除外。平台沒註明的表示兩邊都有：

* MIT（55 個）：annotated-doc、annotated-types、anyio、attrs、beautifulsoup4、charset-normalizer、colorlog、docling、docling-core、docling-ibm-models、docling-parse、docling-slim、et-xmlfile、faker、filelock、filetype、h11、jsonref、jsonschema、jsonschema-specifications、langcodes、latex2mathml、markdown-it-py、marko、mdurl、mpire、openpyxl、pluggy、polyfactory、pyclipper、pydantic、pydantic-core、pydantic-settings、pylatexenc、python-docx、python-oxmsg、python-pptx、pyyaml、referencing、rich、rpds-py、rtree、semchunk、setuptools、six、soupsieve、tabulate、tree-sitter、tree-sitter-c、tree-sitter-javascript、tree-sitter-python、tree-sitter-typescript、typer、typing-inspection、urllib3。
* BSD（25 個）：click、colorama（Windows）、dill、fsspec、httpcore、httpx、idna、jinja2、lxml、markupsafe、mpmath、multiprocess、networkx、olefile、omegaconf、pandas、psutil、pygments、python-dateutil、python-dotenv、scipy、shapely、sympy、websockets、xlsxwriter。
* Apache-2.0（14 個）：accelerate、cuda-bindings（Linux）、cuda-pathfinder（Linux）、doclang、hf-xet、huggingface-hub、mail-parser、opencv-python-headless、rapidocr、requests、safetensors、tokenizers、transformers、tzdata（Windows）。
* 其他寬鬆授權（11 個）：certifi（MPL-2.0）、defusedxml（PSF-2.0）、numpy（BSD-3-Clause 等）、packaging（Apache-2.0 或 BSD-2-Clause）、pillow（MIT-CMU）、pypdfium2（BSD-3-Clause、Apache-2.0 與其相依的授權）、pywin32（PSF-2.0，Windows）、regex（Apache-2.0 AND CNRI-Python）、shellingham（ISC）、tqdm（MPL-2.0 AND MIT）、typing-extensions（PSF-2.0）。

**判讀**：

* 沒有看到 AGPL、非商業或 OpenRAIL 類授權。GPL 只有帶例外條款的 GCC 執行期。
* `engines/docling/` 只有轉接器與鎖定檔，TOME 不散布上面任何一個套件，所以用不到 CUDA EULA 的再散布條款。條款約束的是下載的人，這就是第 10 項要提示的原因。
* 第 10 項只決定了 CUDA 版。Intel 的元件與 LGPL 的函式庫在預設的 CPU 版裡也有，列在 Open Questions。

## 驗證

<!-- @assert-count target="engines/docling/pyproject.toml" regex="true" symbol="exclude-newer = .14 days." expected="1" comments="include" reason="第 1 項：冷卻期用相對期間" -->
<!-- @assert-count target=".github/dependabot.yml" symbol="package-ecosystem: uv" expected="1" reason="ADR-0084 第 10 項：Dependabot 加 uv" -->
<!-- @assert-count target=".github/dependabot.yml" regex="true" symbol="- '@spec-family/\*'" expected="1" reason="ADR-0082 第 21 項：維護者自己的工具不受冷卻期限制" -->
<!-- @assert-count target="src/core/process.ts" symbol="keepStderr = false" expected="1" reason="第 5 項：預設不留 stderr" -->
<!-- @assert-absence target="src/core/extract.ts" symbol="keepStderr" reason="第 5 項：引擎的 stderr 不留" -->
<!-- @assert-count target="engines/docling/main.py" regex="true" symbol="revision.: .[0-9a-f]{40}" expected="2" reason="第 6 項：權重釘在 commit" -->
<!-- @assert-absence target="engines/docling/main.py" symbol="docling-tools" comments="include" reason="第 6 項：不用會讓權重飄掉的工具" -->
<!-- @assert-count target="engines/docling/pyproject.toml" symbol=">=3.13,<3.14" expected="1" reason="第 7 項：釘 Python" -->
<!-- @assert-absence target="src" glob="*.ts" regex="true" symbol="[Dd]ocling" reason="Docling 走同一套協定，沒有特權（白皮書 §5.3）" -->
<!-- @assert-absence target="languages" symbol="神祇" reason="ADR-0023：遊戲概念不進語言設定檔" -->
<!-- @assert-count target="package.json" regex="true" symbol="engines.," expected="1" reason="ADR-0071：轉接器隨 npm 包發送" -->
<!-- @assert-count target="src/cli/messages/zh-TW.json" symbol="engine.gpu_license" expected="1" reason="第 10 項：--gpu 裝完要提示 NVIDIA 專有授權" -->
<!-- @assert-count target="src/core/engine.ts" symbol="finding('engine.gpu_license'" expected="1" reason="第 10 項：提示由核心回代碼，文字留在訊息檔" -->
<!-- @assert-present file="engines/docling/engine.yaml,engines/docling/main.py,engines/docling/pyproject.toml,engines/docling/uv.lock,schemas/tome-engine-1.schema.json,tests/fixtures/SOURCES.yaml" -->

## 後果

改到 `engines/` 的 PR 多一條不是必要檢查的工作流程，要看結果才知道。Docling 自己換模型時，轉接器的 commit 要手動跟著確認。`--gpu` 只在 Windows 實際跑過。相對期間讓重鎖的結果隨日期改變，但安裝走 `--frozen`，不受影響。授權審查是這份鎖定檔的快照，沒有自動檢查，鎖定檔更新就要重看。

## 替代方案

**維持固定截止日**：Dependabot 只能當提醒，ADR-0077「安全更新不等」做不到；**005 只有核心函式**：`engine.yml` 走不到真實指令；**開放任意安裝指令**：add 一個資料夾就等於執行它的指令；**`engine.yml` 只跑 Ubuntu**：torch 的 wheel 兩邊不同；**不下載 CUDA 版**：GPU 路徑沒跑過就發布；**stderr 存到書的目錄**：無法保證不含書本文字；**用 `docling-tools`**：權重會飄；都否決。

## Open Questions

* 引擎多久沒有事件就終止：目前是 10 分鐘，提案，沒有在真實書籍上量過。
* 大檔逐頁呼叫的額外成本：Docling 每頁呼叫一次 `convert`，每次都重新算整個檔案的雜湊、重新載入。合成 PDF 很小，看不出這個成本，**還沒量**。
* CPU 版裡 Intel 的元件與 LGPL 的函式庫要不要也提示：第 10 項只決定了 CUDA 版。
