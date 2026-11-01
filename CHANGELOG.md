# 變更紀錄

本文件記錄 TOME 各版本中與使用者及貢獻者有關的變更。

## 尚未發布

除了用來保留套件名稱的預留版本 0.0.0，目前尚未發布任何版本。

### 新增

- 指令 `tome init`、`tome doctor`、`tome provider auth set`。訊息使用繁體中文，並支援 `--json` 與結束碼 0、1、2。
- `tome-ir/1`、`tome-pack/1` 的 JSON Schema 與驗證。
- 狀態資料庫：`book.db`、`series.db` 的資料存取層與單向遷移。
- API 金鑰存放於作業系統憑證庫，也可用環境變數 `TOME_ANTHROPIC_API_KEY` 覆寫。
- 測試工作流程、相依套件授權檢查、`npm audit`，以及阻擋違規相依套件與網路呼叫的斷言。
- `tome add`：登記書籍並執行探測，一律拒絕加密的 PDF。
- `tome probe`：回報文件結構、頁面類型與 GPU 資訊；依來源語言的字母分布，找出字元本身有效、但對應到錯誤文字的文字層；並記錄每頁交由哪個解析引擎處理。
- 測試用的合成 PDF 產生器。儲存庫中不存放任何 PDF。
- 語言設定檔 `languages/source/en.yaml`、`languages/target/zh-TW.yaml`，格式為 `tome-lang/1`。
- `tome system new`、`list`、`lint`、`test`。規則包的正規表示式在 worker thread 中限時執行。
- 解析引擎協定 `tome-engine/1`，以及 `tome engine add`、`list`、`remove`。`tome engine add docling` 以 uv 建立環境，預設安裝 CPU 版，加上 `--gpu` 則安裝 CUDA 版。安裝 CUDA 版後會提示 CUDA 元件屬於 NVIDIA 專有授權，不隨 TOME 提供。
- 解析引擎可在 `engine.yaml` 的 `license.proprietary` 宣告環境內的專有元件，安裝完成後會提示。Docling 宣告了 Intel oneMKL。
- `tome extract`：將原生文字頁交給解析引擎，結果存為 `source` 層，中斷後可從未完成的頁面繼續。
- `tome extract` 接著組裝 `document` 層（`ir/document.json`）：還原閱讀順序、區分邊欄、接回跨欄與跨頁的段落、合併跨頁表格，並判定規則包宣告的角色。
- 字元守恆檢查：缺字超過門檻的頁面標示為失敗，不會進入翻譯。
- `overrides.yaml`（`tome-overrides/1`）：可手動修改區塊角色、順序，以及合併、拆分、略過區塊與遮蔽文字，重新解析後仍然有效。
- `tome doctor` 檢查解析引擎能否啟動。
- 內建規則包 `generic`，提供骰子與頁碼參照的遮蔽規則，以及常見的區塊角色與實體類別。
- 翻譯核心的基礎：將 `document` 層轉成翻譯單位、遮蔽與還原骰子等內容，以及與 LLM 交換譯文的標籤協定。翻譯功能尚未提供。
- `tome probe` 可依規則包在 `pack.yaml` 宣告的 `suggest` 建議適用的規則包。僅為建議，不會自動套用。
- `tome.yaml` 新增選用的 `target_lang`，預設為 `zh-TW`。

### 變更

- 未指定 `--system` 的書籍一律使用內建規則包 `generic`。升級後，已解析的書籍在下次執行 `tome extract` 時會重新組裝一次 `document` 層，解析引擎不會重新執行。
- `tome probe` 的判斷規則有所更新，已探測的書籍下次會重新探測。
- 頁面解析失敗的訊息會顯示引擎的結束狀態，Windows 的原生崩潰同時列出十六進位代碼，方便判斷原因。引擎的錯誤輸出依然不保留。
- `zh-TW` 的風格指南不再提及神祇，代名詞一律依實體卡（記錄專有名詞譯名、性別與代名詞的資料）的設定。
- 使用者文件與 CLI 訊息改為正式的技術文件寫法，並新增簡體字與中國大陸用語檢查。

### 修正

- `tome add --as con` 這類 Windows 保留名稱現在會回報名稱不合法，不再造成內部錯誤。
- 損毀的書籍資料不再阻擋 `tome add`，改為列在執行結果中。
- 損毀的 `probe.json` 會回報為檔案損毀，不再要求使用者回報 TOME 的問題。
- 規則包正規表示式的時間限制改以 CPU 時間計算，機器忙碌時，不再把正常的表示式判定為逾時。
- Docling 環境的 `pillow`、`certifi`、`setuptools` 升級至已修正安全通報的版本。
- 解析失敗的頁次與 `glossary.yaml` 的筆數改為從 1 起算。規則包 ID 不合法與 YAML 語法錯誤有各自的訊息，缺少參數時的名稱與 `--help` 一致，訊息不再顯示內部代號。
- 路徑檢查處理環境變數中的長串反斜線時，耗時不再隨長度急遽增加。
