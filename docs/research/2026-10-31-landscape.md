# 外部事實查證：LLM 供應商、PDF 工具、授權與法務（2026-10-31）

* **用途**：[白皮書](../WHITEPAPER.md)的佐證。這些事實半年內就會變，引用時請看日期，做重大決策前重查一次。
* **查法**：一律讀原始頁面（供應商文件、授權全文、法條）。標 ✓ 的項目由主工作階段再讀一次原文核對；其餘由查證代理讀原始頁面後整理，沒有逐字複核。「未確認」表示在原始來源找不到，不是不存在。
* **這不是法律意見**。法務的部分只整理事實，判斷由人來做。
* 價格單位都是美元／百萬 token（$/MTok）。

## 一、LLM 供應商

### 1.1 模型與價格

| 供應商 | API id（定位） | 輸入 | 快取讀 | 快取寫 | 輸出 | Batch 輸入／輸出 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Anthropic ✓ | `claude-opus-5-5` | 4 | 0.20 | 5 分鐘 5／1 小時 8 | 20 | 2／10 |
| Anthropic ✓ | `claude-sonnet-5-5` | 2 | 0.10 | 2.50／4 | 10 | 1／5 |
| Anthropic ✓ | `claude-haiku-5-5`（prompt ≤ 100k；超過 5 倍價） | 0.10 | 0.01 | 0.125／0.20 | 0.50 | 0.05／0.25 |
| Anthropic | `claude-fable-5-1`（最高階） | 10 | 0.25 | 12.50／20 | 50 | 5／25 |
| OpenAI | `gpt-6-astra`（旗艦） | 10 | 1.00 | 30 分鐘 12.50／12 小時 25 | 50 | 5／25（快取 0.50） |
| OpenAI | `gpt-6.1-sol` | 2 | 0.10 | 2.50／5 | 10 | 1／5（快取 0.05） |
| OpenAI | `gpt-6-luna`（最便宜） | 0.10 | 0.01 | 0.125／0.25 | 0.50 | 0.05／0.25（快取 0.005） |
| Gemini | `gemini-4-argon`（旗艦） | 2；2026-12-01 起 4 | 0.10；之後 0.20（僅隱式） | 不支援顯式快取 | 10；之後 20 | 1／5；之後 2／10 |
| Gemini | `gemini-3.8-flash` | 0.75；2027-01-01 起 1.50 | 0.075；之後 0.15 | 儲存 0.50；之後 1.00（每 MTok‧小時） | 3.75；之後 7.50 | 0.375／1.875 |
| Gemini | `gemini-3.5-flash-lite` | 0.30 | 0.03 | 儲存 1.00（每 MTok‧小時） | 2.50 | 0.15／1.25（快取 0.02） |
| DeepSeek | `deepseek-flash` | 尖峰 0.30／離峰 0.15 | 0.006／0.003 | 無 | 1.20／0.60 | 無 Batch |
| DeepSeek | `deepseek-v4-pro` | 1.32／0.66 | 0.044／0.022 | 無 | 3.96／1.98 | 無 Batch |

* DeepSeek 尖峰是週一到週五 UTC 01:00–04:00 與 06:00–10:00，中國國定假日除外，其餘時段半價。
* OpenRouter 上 Anthropic、OpenAI 的價格與原廠相同，`google/gemini-3.8-flash` 列 0.825／4.125，與 Google 不同。儲值手續費比例未確認。
* Anthropic 的 Batch 快取價是推算值：文件說倍率會與 Batch 折扣相乘，價目表沒有另列。
* Anthropic 自 Claude 4.7 起的 tokenizer，同一段文字約多 30% token，**token 數不能跨供應商比較**。

來源：[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)、[OpenAI pricing](https://developers.openai.com/api/docs/pricing.md)、[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing.md.txt)、[DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing)、[OpenRouter models](https://openrouter.ai/api/v1/models)

### 1.2 Prompt caching 機制

| 供應商 | 機制與參數 | 最低 token | TTL 與計費 | 來源 |
| :--- | :--- | :--- | :--- | :--- |
| Anthropic | 顯式 `cache_control:{type:"ephemeral"}`，可加 `ttl:"1h"` | 5.x 系列 512；Opus 4.6/4.5、Haiku 4.5 為 4,096 | 預設 5 分鐘，命中時免費續期；寫入 1.25 倍（5 分鐘）或 2 倍（1 小時）；讀取 0.1 倍（Opus／Sonnet 5.5 為 0.05 倍） | [文件](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| OpenAI | GPT-5.6 起預設隱式，或 `prompt_cache_options.mode:"explicit"` 加 `prompt_cache_breakpoint`；更早的模型用 `prompt_cache_key`、`prompt_cache_retention` | 1,024（可見 token） | `"30m"` 寫入 1.25 倍；`"12h"` 寫入 2.5 倍（僅 Responses API） | [文件](https://developers.openai.com/api/docs/guides/prompt-caching.md) |
| Gemini | 預設隱式；顯式 `cachedContents.create` 後以 `cached_content` 引用（Beta） | 隱式：Argon、3.8 Flash 等 4,096，2.5 系列 2,048；Flash-Lite 與顯式快取的最低值未公布 | 顯式預設 1 小時，另收儲存費；**Argon 之後不支援顯式** | [文件](https://ai.google.dev/gemini-api/docs/generate-content/caching.md.txt) |
| DeepSeek | 自動磁碟快取，無參數，由 `usage.prompt_cache_hit_tokens` 回報 | 未公布 | 無寫入費；數小時到數天內清除；明說不保證 100% 命中；第二次請求後才落盤，第三次才可能命中 | [文件](https://api-docs.deepseek.com/guides/kv_cache) |
| OpenRouter | 轉交原廠機制；黏性路由閒置 10 分鐘失效；Gemini 只用最後一個斷點 | 依原廠（它的 Gemini 段落與 Google 現況不符） | 依原廠 | [文件](https://openrouter.ai/docs/guides/best-practices/prompt-caching.md) |

### 1.3 快取與 Batch 併用

| 供應商 | 結論 | 來源 |
| :--- | :--- | :--- |
| Anthropic | 折扣可疊加，但命中是盡力而為，文件列的觀測值是 30–98%。建議用相同的 `cache_control` 區塊與 1 小時 TTL。Batch 內不能用 `max_tokens:0` 預熱；條目要等第一個回應開始後才存在；改 `output_config.format` 會讓快取失效 | [文件](https://platform.claude.com/docs/en/build-with-claude/batch-processing) |
| OpenAI | 價目表列出 Batch 的快取價，但 Batch 請求是否實際命中，兩份指南都沒寫（未確認） | [pricing](https://developers.openai.com/api/docs/pricing.md) |
| Gemini | Batch 請求可逐筆帶 `cached_content`；命中計費的說法在 Batch 文件與價目表之間不一致 | [文件](https://ai.google.dev/gemini-api/docs/batch-api.md.txt) |
| OpenRouter | 走 Anthropic Batch 時，同批次內的快取寫入不保證彼此可見，建議 1 小時 TTL 或先用同步請求預熱 | [文件](https://openrouter.ai/docs/guides/best-practices/prompt-caching.md) |

### 1.4 Batch API

| 供應商 | 折扣與時限 | 上限 | 結果保留 | 來源 |
| :--- | :--- | :--- | :--- | :--- |
| Anthropic | 50%；多數 1 小時內完成，24 小時到期 | 100,000 筆或 256 MB | 29 天，不適用 ZDR | [文件](https://platform.claude.com/docs/en/build-with-claude/batch-processing) |
| OpenAI | 50%；只有 `24h` | 50,000 筆、200 MB，一檔一模型 | 30 天，不適用 ZDR | [文件](https://developers.openai.com/api/docs/guides/batch.md) |
| Gemini | 50%；目標 24 小時，48 小時到期 | 內嵌 20 MB 或 JSONL 2 GB；100 個並行工作 | 6 週 | [文件](https://ai.google.dev/gemini-api/docs/batch-api.md.txt) |
| OpenRouter | 約 50%；**有 Batch**（`POST /api/v1/batches`） | 200 MB，一批一模型；不能取消 | 30 天，不適用 ZDR | [文件](https://openrouter.ai/docs/guides/features/batch-api.md) |
| DeepSeek | 無 Batch；替代方案是離峰半價 | — | — | [文件](https://api-docs.deepseek.com) |

### 1.5 資料使用

| 供應商 | 結論 | 來源 |
| :--- | :--- | :--- |
| Anthropic | 未經同意不用於訓練；預設不保留內容，但 Fable 5.1 等 Covered Models 需保留 30 天；Batch 保留 29 天 | [文件](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) |
| OpenAI | API 資料不用於訓練；濫用監控紀錄最長 30 天；`/v1/batches` 不適用 ZDR | [文件](https://developers.openai.com/api/docs/guides/your-data.md) |
| Gemini | **免費層的內容會用於改善產品，也可能有人工審閱**（EEA、瑞士、英國除外）；付費層不會 | [條款](https://ai.google.dev/gemini-api/terms) |
| DeepSeek | **隱私政策（2026-02-10）寫明資料用於訓練並存放於中國**，找不到 API 例外承諾，應視為可被訓練 | [政策](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html) |
| OpenRouter | 預設不存 prompt；可逐請求要求 `provider:{zdr:true}`、`data_collection:"deny"`；ZDR 不能與 Batch 併用 | [文件](https://openrouter.ai/docs/guides/features/zdr.md) |

### 1.6 結構化輸出與拒答訊號

| 供應商 | 結構化輸出 | 拒答訊號 |
| :--- | :--- | :--- |
| Anthropic | `output_config.format`，Batch 可用；改動會讓快取失效；拒答時可能不符 schema | HTTP 200 加 `stop_reason:"refusal"`；**Batch 裡 `result.type` 仍是 `succeeded`**，要自己檢查並重送 |
| OpenAI | `json_schema`，Batch 可用 | `refusal` 欄位；`finish_reason:"content_filter"` |
| Gemini | `response_schema`，Batch 有範例 | `promptFeedback.blockReason`；`finishReason` 為 SAFETY、PROHIBITED_CONTENT、RECITATION 等 |
| DeepSeek | 只有 `json_object`，不受 schema 約束 | `finish_reason:"content_filter"` |
| OpenRouter | `json_schema`；Batch 內未確認 | `finish_reason:"content_filter"` 加 `native_finish_reason`；審查阻擋回 HTTP 403 |

來源：[Anthropic refusals](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)、[OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs.md)、[Gemini API](https://ai.google.dev/api/generate-content)、[DeepSeek JSON mode](https://api-docs.deepseek.com/guides/json_mode)、[OpenRouter errors](https://openrouter.ai/docs/api/reference/overview.md)

### 1.7 LiteLLM

* **供應鏈事件**：2026-03-24，PyPI 上的 `litellm` 1.82.7、1.82.8 被植入惡意程式，竊取環境變數、SSH 金鑰與雲端憑證；1.82.8 用 `.pth` 檔在每次啟動 Python 時執行。1.82.6 以前與 1.83.0 以後是乾淨的。來源：[官方說明](https://docs.litellm.ai/blog/security-update-march-2026)、[GHSA-5mg7-485q-xm76](https://github.com/advisories/GHSA-5mg7-485q-xm76)
* **抽象會漏**：OpenAI 格式的 Batch 只涵蓋 OpenAI、Azure、Vertex、Bedrock、Mistral、vLLM、xAI，不含 Anthropic Message Batches、Gemini AI Studio、DeepSeek；Gemini 上的 `cache_control` 會被轉成 `cachedContents`，關掉隱式快取並產生儲存費。來源：[batches](https://docs.litellm.ai/docs/batches)、[prompt caching](https://docs.litellm.ai/docs/completion/prompt_caching)

### 1.8 本機推論（RTX 4060 Laptop 8 GB）

第一版預設只走 API，本機模型不測試也不承諾（[ADR-0025](../adr/0025-api-first-local-unpromised.md)）。下面的資料留作紀錄。

大小來自 Hugging Face 上的 GGUF。**沒有找到 zh-TW 翻譯品質的評測，排名未確認。**

| 模型 | 授權 | 大小 | 說明 |
| :--- | :--- | :--- | :--- |
| `tencent/Hy-MT2-7B` | Apache-2.0 | Q4_K_M 4.62 GB，放得下 | 翻譯專用，33 語含 zh-Hant；模型卡提到依賴 llama.cpp PR #22836，是否影響 Q4_K_M 未確認 |
| `Qwen/Qwen3.5-9B` | Apache-2.0 | 5.68 GB，放得下 | 201 語 |
| `google/gemma-4-12B-it-qat` | Apache-2.0 | 6.98 GB，偏緊 | |
| `google/translategemma-12b-it` | Gemma 條款 | 社群 GGUF 7.3 GB，邊緣 | 翻譯專用 |
| `taide/Gemma-3-TAIDE-12b-Chat-2602` | TAIDE 條款（gated，內文未讀） | 12B 級 | 台灣本地模型 |

| Runtime | OpenAI 相容端點 | 前綴快取 |
| :--- | :--- | :--- |
| llama.cpp `llama-server` | 有 | `cache_prompt` 預設開啟，另有 `--cache-reuse` |
| Ollama | 有，原生 Windows | 文件未說明 |
| LM Studio | 有 | 文件未說明 |
| vLLM | 有，但**不支援原生 Windows**，要 WSL 或社群分支 | `enable_prefix_caching` |

### 1.9 標籤協定與佔位符的前例

查證時間 2026-10-31，由查證代理讀原始頁面整理。

| 對象 | 事實 | 來源 |
| :--- | :--- | :--- |
| Hy-MT2-7B | 模型卡有術語、背景、風格、分隔符與結構化資料範本；沒有多段請求，也沒點名標籤語法；沒有預設 system prompt；`zh-Hant` 是繁體中文 | [模型卡](https://huggingface.co/tencent/Hy-MT2-7B) |
| TranslateGemma | 只支援 User、Assistant 角色；內容 MUST 恰好一個項目，含 `source_lang_code`、`target_lang_code`；輸入上限 2K token；是否接受 zh-TW 未說明；標籤處理未說明 | [模型卡](https://huggingface.co/google/translategemma-12b-it) |
| BabelDOC | 在 `il_translator.py` 裡，佔位符對不上只記 debug log，幻覺佔位符會被移除；單段佔位符超過 40 個時關閉該段的 rich text。引擎模組未讀，重試是否在別處未確認 | [il_translator.py](https://github.com/funstory-ai/BabelDOC/blob/main/babeldoc/format/pdf/document_il/midend/il_translator.py) |
| PDFMathTranslate v1 | 公式佔位符 `{v0}`；越界的標記直接略過，全檔沒有檢查遺失的邏輯；只有公式的片段不送翻譯。v2 未讀 | [converter.py](https://github.com/PDFMathTranslate/PDFMathTranslate/blob/main/pdf2zh/converter.py) |
| XLIFF 2.1 | `ph` 是獨立代碼，`pc` 是成對的跨距代碼，`mrk` 是註記，術語用 `mrk type="term"`；`canReorder`、`canCopy`、`canDelete` 限制編輯行為 | [XLIFF 2.1](https://docs.oasis-open.org/xliff/xliff-core/v2.1/os/xliff-core-v2.1-os.html) |
| TEaR | 翻譯、評估、修正三步。GPT-3.5 時代的結果：En-Zh 人工偏好修正版的比例是 32.2%；未說明成本 | [arXiv 2402.16379](https://arxiv.org/abs/2402.16379) |
| TransAgents | 多代理文學翻譯，dd-BLEU 較低但 Gemba-DA 與人工偏好較高；論文提到執行時間與成本都有明顯開銷（只看到摘要，未逐字核對） | [arXiv 2405.11804](https://arxiv.org/abs/2405.11804) |

## 二、PDF 解析工具

### 2.1 版面與 OCR 引擎

| 工具（版本，日期） | 程式授權 | 權重授權 | 本機適用性 |
| :--- | :--- | :--- | :--- |
| Docling 2.145.0（2026-10-29） | MIT | Apache-2.0／CDLA-Permissive-2.0 | Windows、CUDA、Python 3.13 都有；閱讀順序程式碼沒有直書或 RTL 邏輯；預設 OCR 是 RapidOCR |
| RapidOCR 3.10.0 | Apache-2.0 | Apache-2.0 | ONNX，`onnxruntime-gpu` 有 cp313 Windows wheel |
| PaddleOCR 3.7.0 | Apache-2.0 | Apache-2.0 | PaddleOCR-VL-1.6（0.9B，OmniDocBench 96.34）可在 Windows 用 `transformers` 引擎；GPU wheel 要從 Paddle 自家 index 裝 |
| MinerU 4.1.3（2026-10-30） | Apache-2.0 加額外條款 | 新權重 Apache-2.0；MinerU2.5-2509 標 AGPL-3.0 | 2026 年 3–4 月授權改了四次；standard 層需 8 GB VRAM |
| Marker 2.1.0／Surya 0.23.0 | Apache-2.0（舊版 GPL） | **修改版 OpenRAIL-M** | 2.x 改用 VLM，需 Docker+vLLM 或 llama.cpp；`--use_llm` 預設走 Gemini |
| dots.ocr／dots.mocr（3B） | MIT | MIT | 偏 vLLM 工具鏈，VRAM 未確認 |
| olmOCR、Chandra OCR 2、DeepSeek-OCR | — | — | 8 GB 放不下或不適用 |

OmniDocBench、olmOCR-bench 都以英文、中文為主。**除了 YomiToku 與 NDLOCR-Lite，找不到任何引擎對日文直書、韓文或假名標音的獨立評測。**

來源：[Docling](https://github.com/docling-project/docling)、[RapidOCR](https://github.com/RapidAI/RapidOCR)、[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)、[MinerU](https://github.com/opendatalab/MinerU)、[Marker](https://github.com/datalab-to/marker)、[Surya](https://github.com/datalab-to/surya)、[OmniDocBench](https://github.com/opendatalab/OmniDocBench)

### 2.2 低階 PDF 函式庫

| 函式庫 | 授權 | 逐字 bbox／字型／大小 | 直書 |
| :--- | :--- | :--- | :--- |
| PyMuPDF 2.0 | **AGPL-3.0 或 Artifex 商業授權** | 有（`rawdict`） | `wmode` |
| pypdfium2 5.14.0 | Apache-2.0／BSD-3 | `get_charbox`；字型資訊與 `FPDFText_HasUnicodeMapError` 要走原始綁定 | PDFium 內有直書邏輯 |
| pdfminer.six 20260107 | MIT | `LTChar` 有 | `detect_vertical` 預設關閉；無對應字元時輸出 `(cid:N)` |
| pdfplumber 0.11.10 | MIT | 有，含 `mcid` | 轉交 pdfminer |
| pikepdf 10.17.0 | MPL-2.0 | 不抽文字；可讀字型字典、ToUnicode、結構樹 | — |
| docling-parse 7.24.2 | MIT | 有字型名，字級要從矩形推算 | `TextDirection` 沒有直書值 |

### 2.3 日文 OCR 與假名標音

| 工具 | 授權 | 直書 | 標音 |
| :--- | :--- | :--- | :--- |
| YomiToku 0.15.1 | **CC BY-NC-SA 4.0**（程式與權重） | 有 | `--ignore_ruby` |
| NDLOCR-Lite 1.2.x | CC BY 4.0，但版面骨幹受 DINOv3 授權約束 | 有，官方測過 Windows 11，CPU 可跑 | 版面模型有 `block_rubi` 類別 |
| manga-ocr 0.1.16 | Apache-2.0 | 有 | 處理假名，但只認裁切區塊，不做版面 |
| Tesseract `jpn_vert`／`kor_vert` | Apache-2.0 | 有 | 無 |

原生數位 PDF 的標音處理沒有現成函式庫。可行路徑：有標記的 PDF 直接丟棄 `RT` 結構元素（ISO 32000）；沒標記的用字級與位移規則，這段要自己寫，未經驗證。

來源：[YomiToku](https://github.com/kotaro-kinoshita/yomitoku)、[NDLOCR-Lite](https://github.com/ndl-lab/ndlocr-lite)、[manga-ocr](https://github.com/kha-white/manga-ocr)、[Tagged PDF RT](https://taggedpdfschool.pdfa.org/tags/RT)、[arXiv 2207.03960](https://arxiv.org/abs/2207.03960)

### 2.4 文字層品質判斷

Docling 的 `replace_broken_text_layer`（預設關閉）依控制字元、U+FFFD、私有區字元比例判斷，規則偏拉丁語系；錯誤但合法的漢字對應（CID／ToUnicode 壞掉）抓不到。較便宜的逐字訊號：PDFium `FPDFText_HasUnicodeMapError`、pdfminer `(cid:N)`。

來源：[text_quality.py](https://raw.githubusercontent.com/docling-project/docling/main/docling/utils/text_quality.py)、[fpdf_text.h](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_text.h)

### 2.5 授權陷阱

1. **PyMuPDF**：主程式 `import` 後，散布的組合整體受 AGPL-3.0 約束。列為 optional extra 只是沒有隨附，使用者匯入時仍是 AGPL 組合。依 FSF 的說明，以管線或命令列溝通的獨立程式通常視為兩個程式。來源：[GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html)、[Artifex](https://artifex.com/licensing)
2. **Marker／Surya 權重**：修改版 OpenRAIL-M 對營收或募資超過 500 萬美元者設限（個人與研究用途例外）；另有禁止提供競爭產品或服務的條款，PDF 抽取 CLI 可能落入；限制要往下傳遞。來源：[MODEL_LICENSE](https://github.com/datalab-to/marker)
3. **MinerU**：非標準 Apache-2.0，規模超過門檻要另取授權，線上服務要標示，違約自動終止。舊權重標 AGPL-3.0，`PDF-Extract-Kit-1.0` 沒有授權標籤。
4. **YomiToku**：非商業。**NDLOCR-Lite**：要連同 DINOv3 授權文字一起散布。**HunyuanOCR**：授權排除歐盟、英國與南韓。
5. **相依版本互斥**：Marker 要 `pillow<11`，MinerU 要 `pillow>=11`；pypdfium2 被釘在 4.30.0（YomiToku、NDLOCR-Lite）、5.10.1（pdftext）、≥5.13（MinerU）。**這些引擎裝不進同一個環境。**
6. **雲端外洩路徑**：Marker `--use_llm` 預設走 Gemini；所有引擎第一次執行都會下載權重，要離線必須先備妥。

### 2.6 Docling 文件模型與 PDF 自帶結構

查證對象是 docling-core 的 `main` 分支與目前的文件網站，沒有鎖定 Docling 2.145.0。

| 項目 | 事實 | 來源 |
| :--- | :--- | :--- |
| 區塊標籤 | `DocItemLabel` 30 個、`GroupLabel` 12 個，沒有邊欄、aside、callout 或方框文字 | [labels.py](https://raw.githubusercontent.com/docling-project/docling-core/main/docling_core/types/doc/labels.py) |
| 出處 | `ProvenanceItem` 有 `bbox`、`charspan`、`page_no`；`prov` 是清單，程式碼顯示表格可以跨頁；段落跨頁是否有多筆未確認 | [reference](https://docling-project.github.io/docling/reference/docling_document/)、[document.py](https://raw.githubusercontent.com/docling-project/docling-core/main/docling_core/types/doc/document.py) |
| 文字項目 | `TextItem` 成員有 `formatting`、`hyperlink`，**沒有列字型與字級**。`Formatting` 的欄位未逐字核對 | 同上 |
| 版本 | `DoclingDocument` 有 `schema_name` 與 `version` 欄位 | 同上 |
| 頁面範圍 | `convert()` 有 `page_range`，是否從 1 起算未確認 | [converter](https://docling-project.github.io/docling/reference/document_converter/) |
| 離線 | `docling-tools models download` 預先下載，以 `artifacts_path` 或 `DOCLING_ARTIFACTS_PATH` 指定；遠端服務要 `enable_remote_services=True` 才開，否則丟 `OperationNotAllowed` | [advanced options](https://docling-project.github.io/docling/usage/advanced_options/) |
| PDF 自帶結構 | 文件只提到用書籤推標題層級（`use_bookmarks`），該階段預設關閉；tagged 結構、連結註記、`/PageLabels` 都沒提到 | [heading levels](https://docling-project.github.io/docling/usage/heading_levels/) |

| 函式庫 | 自帶結構的讀取方式 | 來源 |
| :--- | :--- | :--- |
| pypdfium2 | `get_toc()`、`get_page_label(index)`、`is_tagged()`；連結與結構樹走原始綁定的 `FPDFLink_*`、`FPDF_StructTree_*`、`FPDF_StructElement_*` | [API](https://pypdfium2.readthedocs.io/en/stable/python_api.html)、[fpdf_doc.h](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_doc.h)、[fpdf_structtree.h](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_structtree.h) |
| pikepdf | `Page.label`、`pikepdf.models.Outline` | [models](https://pikepdf.readthedocs.io/en/latest/api/models.html) |

PDFium 標頭是 `main` 分支，不一定等於 pypdfium2 隨附的版本。

### 2.7 Obsidian Markdown 語法限制

| 項目 | 事實 |
| :--- | :--- |
| 區塊識別碼 | `^id`，只能用拉丁字母、數字與連字號；長度上限未說明 |
| 區塊位置 | 一般段落放行尾；清單、引言、callout、表格放在獨立一行，前後空行 |
| 連結 | 區塊 `[[note#^id]]`、標題 `[[note#heading]]`、顯示文字 `[[note#heading\|text]]` |
| 相容性 | 區塊參照是 Obsidian 專屬語法，在 Obsidian 之外無效 |
| 內部連結 | 不支援連到引言、callout、表格的內部 |
| 字元限制 | 含 `#`、`\|`、`^`、`:`、`%%`、`[[`、`]]` 的字串可能無法當連結 |
| Callout | `> [!type] 標題`，可巢狀、可摺疊；未知類型退回 `note` |
| 屬性 | 檔案開頭的 YAML；不支援巢狀屬性，也不支援屬性內的 Markdown |

來源：[Links](https://obsidian.md/help/links)、[Callouts](https://obsidian.md/help/callouts)、[Properties](https://obsidian.md/help/properties)

### 2.8 主程式語言選型

查證時間 2026-10-31，由查證代理讀原始頁面整理。「未說明」表示讀到的頁面沒寫，不代表不支援。

| 語言 | 函式庫 | 授權 | 事實 | 來源 |
| :--- | :--- | :--- | :--- | :--- |
| TypeScript | pdf.js（`pdfjs-dist`） | Apache-2.0 | `getOutline()`、`getPageLabels()`、`getMarkInfo()`、逐頁 `getStructTree()`、`getAnnotations()`、`getTextContent()`。`TextItem` 有 `str`、`dir`、`transform`、`width`、`height`、`fontName`、`hasEOL`，是否逐字未說明。Node 範例匯入 `pdfjs-dist/legacy/build/pdf.mjs`，範例沒用 canvas 套件 | [API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFDocumentProxy.html)、[api.js](https://raw.githubusercontent.com/mozilla/pdf.js/master/src/display/api.js)、[範例](https://github.com/mozilla/pdf.js/tree/master/examples/node) |
| TypeScript | `@hyzyla/pdfium` | MIT | PDFium 的 WASM 包裝，Node 22 以上；書籤、頁碼標籤、連結未說明 | [repo](https://github.com/hyzyla/pdfium) |
| TypeScript | opencc-js | MIT | 有 `twp`；不保證與官方 OpenCC 完全一致 | [repo](https://github.com/nk2028/opencc-js) |
| TypeScript、Rust | lindera | MIT | IPADIC、UniDic、SudachiDict；有 Node 與 WASM 綁定 | [repo](https://github.com/lindera/lindera) |
| TypeScript | `node:sqlite` | Node 內建 | Stability 1.2 Release candidate，22.5 加入 | [文件](https://nodejs.org/api/sqlite.html) |
| TypeScript | better-sqlite3 | MIT | 有預編譯檔，Windows 與 Node 24 未點名 | [repo](https://github.com/WiseLibs/better-sqlite3) |
| TypeScript | Node 單一執行檔 | — | Stability 1.1 Active development，Windows 不簽章也能執行 | [文件](https://nodejs.org/api/single-executable-applications.html) |
| Rust | pdfium-render | Apache-2.0 或 MIT | 不含 PDFium；有逐字文字、書籤、連結；頁碼標籤未說明；結構樹只有低階綁定 | [repo](https://github.com/ajrcarey/pdfium-render) |
| Rust | sudachi.rs | Apache-2.0 | README 標示 0.7 版不穩定 | [repo](https://github.com/WorksApplications/sudachi.rs) |
| C# | PdfPig | Apache-2.0 | 逐字座標與字型、書籤、超連結；頁碼標籤與 tagged 結構未說明；1.0 前 API 會變 | [repo](https://github.com/UglyToad/PdfPig) |
| Python 引擎 | uv | — | 需要時預設自動下載 Python；`uv tool install` 是否也會下載未說明 | [install](https://docs.astral.sh/uv/guides/install-python/)、[tools](https://docs.astral.sh/uv/guides/tools/) |

## 三、授權、法務與開源營運

### 3.1 出版社政策

| 出版社 | 查到的事實 | 來源 |
| :--- | :--- | :--- |
| Chaosium ✓ | Fan Material Policy（2023-10-13）限非商業；使用者要下載、安裝或執行的軟體不在範圍內，要申請 Commercial License，網頁版角色產生器例外。沒提到翻譯或 AI。外語版歸 Commercial License 處理 | [policy](https://www.chaosium.com/fan-material-policy/)、[fan use](https://www.chaosium.com/fan-use-and-licensing/) |
| Chaosium | ORC 只涵蓋 BRP:UGE。Call of Cthulhu 是保留商標，沒有開放授權。BRP ORC 文件未出現 CoC 專屬詞（bonus die、Hard success、Extreme success 都 0 筆） | [ORC](https://www.chaosium.com/orclicense/)、[ORC 文件](https://www.chaosium.com/content/orclicense/BasicRoleplaying-ORC-Content-Document.pdf) |
| Arc Dream ✓ | Publishing Guidelines 明列不允許：AI 製作的內容、重新發表、翻譯、原創小說、app 與可執行檔。限非商業。「Delta Green」只能接在主標題後 | [guidelines](https://www.delta-green.com/publishing-guidelines/) |
| Pelgrane | GUMSHOE SRD v3 是 CC BY 3.0 Unported（也有 OGL 版），署名有格式要求。**不涵蓋 Trail of Cthulhu**，該商標不在授權內；ToC 也不在 Community 計畫內，舊頁面寫授權給 Chaosium | [SRD](https://pelgranepress.com/gumshoe/files/GUMSHOESRDCC-3%20241209.docx)、[計畫](https://help.drivethrurpg.com/hc/en-us/articles/12723257925399-Pelgrane-Press-GUMSHOE-Community-Content-Guidelines) |
| Modiphius | 找不到開放授權。World Builders 不收軟體與 app，Licensed 層（含 Achtung! Cthulhu）不收生成式 AI 內容。2d20 SRD 授權文字未確認（DriveThruRPG 擋爬蟲，未繞過）。Achtung! Cthulhu 產品線 2026-05-20 起暫停 | [指南](https://help.drivethrurpg.com/hc/en-us/articles/12723219550871-Modiphius-World-Builders-Guidelines) |

這些政策規範的是「發表粉絲作品」。個人私下使用工具是否落入，上述文件沒有明講（未確認）；公開散布帶品牌的規則包則比較可能落入。

### 3.2 著作權

| 主題 | 事實 | 來源 |
| :--- | :--- | :--- |
| 想法與表達 | 美國：遊戲的想法、名稱、玩法不受保護，規則文字可能受保護；17 USC 102(b)；37 CFR 202.1(a) 排除單字與短語；Baker v. Selden；Feist 保護彙編的原創編排。台灣：§10-1 排除思想、程序、操作方法，§7 保護編輯著作 | [USCO](https://www.copyright.gov/register/tx-games.html)、[Feist](https://www.law.cornell.edu/supremecourt/text/499/340)、[著作權法](https://law.moj.gov.tw/ENG/LawClass/LawAll.aspx?pcode=J0070017) |
| 個人翻譯（台灣）✓ | §51：為個人或家庭非營利目的，在合理範圍內，以圖書館或非供公眾使用的機器重製已公開發表的著作。§63：可依 §51 利用者也可改作。§3 定義改作包含翻譯，§28 改作權專屬著作財產權人 | 同上 |
| 未決問題 | 雲端 LLM API 算不算「非供公眾使用之機器」？找不到見解（未確認） | — |
| 個人翻譯（美國） | 翻譯是衍生著作（17 USC 101、106(2)），沒有私人翻譯例外，只能走 §107 個案判斷 | [Title 17](https://www.copyright.gov/title17/92chap1.html) |
| 權利管理資訊（台灣）✓ | §80-1 禁止移除或變更權利管理電子資訊，例外只有技術限制與系統轉換；§96-1 有刑責。§3 定義包含足以確認「著作財產權人或其授權之人」及利用條件的電子資訊。**購買者姓名浮水印是否屬於此定義，未確認** | [著作權法](https://law.moj.gov.tw/ENG/LawClass/LawAll.aspx?pcode=J0070017) |
| 權利管理資訊（美國）✓ | 17 USC 1202(b) 禁止故意移除；1202(c) 的定義明確排除使用者的個人識別資訊 | [Chapter 12](https://www.copyright.gov/title17/92chap12.html) |
| 防盜拷 | 台灣 §80-2、美國 17 USC 1201 規範規避與提供規避工具 | 同上 |
| 工具責任 | 台灣 §87 第 1 項第 7 款要求有供公眾侵權的意圖並受有利益。GitHub 的 DMCA 流程：通知主張整個 repo 侵權時可能下架全部；只含工具的 repo 不屬著作權通知範圍，規則包文字則可能 | [GitHub DMCA](https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy) |
| 官方中文術語 | 直接照抄某出版社詞表或索引的風險較高；單一詞對屬短語。四款遊戲是否有官方繁中版未確認 | — |

### 3.3 公有領域測試素材

* 美國：截至 2026 年，1930 年以前首次發表的作品已進公有領域。可用：The Rats in the Walls、The Colour Out of Space、Pickman's Model、The Call of Cthulhu、The Dunwich Horror、The Silver Key。
* 尚未進美國公有領域：The Whisperer in Darkness、The Strange High House in the Mist（都要到 2027）、At the Mountains of Madness、The Shadow over Innsmouth 等 1931 年以後發表的作品。
* 台灣：Lovecraft 歿於 1937 年，保護期 1987 年屆滿。現代譯本與校訂版有自己的著作權。
* Lovecraft 的小說沒有數值塊。數值塊素材要用合成文字，或附署名的 BRP ORC、GUMSHOE SRD。

來源：[Duke CSPD](https://web.law.duke.edu/cspd/publicdomainday/2026/)、[Lovecraft bibliography](https://en.wikipedia.org/wiki/H._P._Lovecraft_bibliography)（次級來源）

### 3.4 命名

| 項目 | 狀態 | 來源 |
| :--- | :--- | :--- |
| PyPI `tome` | 已被占用（Tome Markup Language，2013 年後無更新）✓ | [PyPI](https://pypi.org/pypi/tome/json) |
| PyPI `tome-trpg`、`tome-engine` | 查證當天 404，可用 ✓；名稱要首次發佈才算保留 | 同上 |
| `tome` 指令 | JFrog `tomescripts`（Apache-2.0）的指令也叫 `tome`，還裝頂層 Python 套件 `tome`；`@tomehq/cli` 也裝 `tome` 指令 | [jfrog/tome](https://github.com/jfrog/tome)、[tomehq/tome](https://github.com/tomehq/tome) |
| 其他同名 | runebookai/tome（LLM 桌面用戶端）、ToME（Tales of Maj'Eyal） | GitHub |
| npm `tome` | 已被占用（A modern wiki with minimal external dependencies，1.0.7）✓ | `npm view` |
| npm `tome-trpg` | 查證當天查無此套件 ✓；要首次發佈才算保留 | `npm view` |

### 3.5 同類工具

| 工具 | 授權 | 特點 |
| :--- | :--- | :--- |
| BabelDOC／PDFMathTranslate | AGPL-3.0 | 保留公式與版面，CSV 詞彙表，快取 |
| bilingual_book_maker | MIT | 電子書雙語，詞彙表，續跑 |
| Calibre Ebook Translator | GPL-3.0 | 快取，多種 LLM |
| TransAgents／TEaR | Apache-2.0／未確認 | 多代理文學翻譯；翻譯、評估、修正循環的研究 |

CAT 標準：XLIFF 2.1（inline `ph`、`pc`、`mrk`、Glossary 模組）、TMX 1.4b、TBX 3.0（ISO 30042:2019）。

**空缺**（從各專案 README 推論，非窮舉）：沒看到針對單一遊戲系統的規則包、能辨識數值塊的佔位保護，也沒看到 TMX、TBX、XLIFF 的雙向支援。

來源：[BabelDOC](https://github.com/funstory-ai/BabelDOC)、[bilingual_book_maker](https://github.com/yihong0618/bilingual_book_maker)、[XLIFF 2.1](https://docs.oasis-open.org/xliff/xliff-core/v2.1/os/xliff-core-v2.1-os.html)

### 3.6 GitHub 與 PyPI 營運

| 項目 | 事實 | 來源 |
| :--- | :--- | :--- |
| PyPI Trusted Publishing | OIDC，不用長期 token，產生的 token 15 分鐘失效；pending publisher 不保留名稱 | [文件](https://docs.pypi.org/trusted-publishers/) |
| 發佈證明 | `pypa/gh-action-pypi-publish` 搭配 Trusted Publishing 預設產生 PEP 740 attestations | [文件](https://docs.pypi.org/attestations/) |
| Rulesets | 公開 repo 的 GitHub Free 可用 | [文件](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) |
| Push protection | 公開 repo 的使用者層級預設開啟；repo 層級預設關閉 | [文件](https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection) |
| Immutable releases | 2025-10-28 GA；鎖住 tag 與資產 | [文件](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) |
| 細粒度 token 權限 | Rulesets、environments、immutable releases 開關要 Administration；重跑 workflow 要 Actions write；push、merge PR、建 release 要 Contents write；Workflows 列為動 `.github/workflows` 的附加權限（實際拒絕行為文件沒明寫） | [文件](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) |
| token 預填網址 ✓ | `settings/personal-access-tokens/new` 接受 `name`、`description`、`target_name`、`expires_in`（1–366 或 `none`）與各權限參數；`workflows` 只有 `write` 一種值 | [文件](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) |
| npm Trusted Publishing | GitHub Actions 走 OIDC，不用長期 token；需要 npm 11.5.1、Node 22.14 以上與 `id-token: write`；公開 repo 與公開套件自動產生 provenance；只支援 GitHub 託管的 runner；新設定要在 2 天內完成首次發佈 | [文件](https://docs.npmjs.com/trusted-publishers) |

### 3.7 spec 工具

| 項目 | 事實 |
| :--- | :--- |
| 版本 ✓ | npm 的 `@spec-family/spec-brief` 0.12.0、`spec-graph` 0.21.0、`spec-guard` 0.30.0、`spec-harness` 0.22.0，都是 MIT，沒有執行期相依 |
| 需求 ✓ | Node 22 以上；spec-harness 另需 spec-brief 0.12.0、Claude Code 2.1.139、git 2.31 |
| 語言 ✓ | 正文可用任何語言。狀態字、關係與義務標題只讀英文，中文的已於 spec-graph 0.11.0 移除 |
| 編號 ✓ | spec-graph 不把單字母前綴當編號家族，`D-7` 這種寫法檢查不到，`ADR-0007` 可以 |
| 語言支援 ✓ | spec-guard 的 import 斷言涵蓋 Python、TypeScript、Rust、C# |
| 前例 ✓ | `seekers-journal` 是繁中 repo，四個工具都採用；決策紀錄在它的 ADR-0002 |

來源：`C:\Repos\specs` 的原始碼文件與 `npm view`。
