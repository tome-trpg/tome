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
- 翻譯核心的基礎：將 `document` 層轉成翻譯單位、遮蔽與還原骰子等內容，以及與 LLM 交換譯文的標籤協定。
- `tome probe` 可依規則包在 `pack.yaml` 宣告的 `suggest` 建議適用的規則包。僅為建議，不會自動套用。
- `tome.yaml` 新增選用的 `target_lang`，預設為 `zh-TW`。
- 不消耗 token 的譯文驗證：檢查標記、佔位符、數字、鎖定譯名、簡體字與長度，確定有誤才重新送出，疑似中國大陸用語只列入報告。
- 譯後自動排版：修正全形標點、引號與中英文之間的空白，不影響骰子等遮蔽內容。
- 翻譯記憶：相同內容不重複計費，換用其他模型時也會沿用。
- `tome verify`：以已儲存的回應重新驗證譯文，不消耗 token。
- 模型資料 `providers/anthropic.yaml`，格式為 `tome-provider/1`。不在清單上的模型無法使用，價目表查證滿 60 天時會警告。
- `tome estimate`：在本機估算翻譯費用，不連網。可用 `--budget` 設定預算、`--chapters` 限定章節、`--confirm` 確認估價。估算的比例尚未以實際用量校準。
- `tome translate --dry-run`：組出所有請求但不送出。
- `tome.yaml` 新增 `translator_model`、`fallback_model` 與個資清單 `pii`。清單是空的時候，`tome doctor` 與 `tome estimate` 會警告。
- `tome estimate --realtime` 與 `tome translate --dry-run --realtime`：以即時模式的價格估算。模式、`fallback_model`、規則包或 `source_lang` 變更後需要重新確認估價。
- `tome provider list`：列出 TOME 知道怎麼呼叫的模型與即時、批次價格。不連網，不需要 API 金鑰，也不需要工作區。清單不代表推薦。
- 個資閘門：請求送出前掃描完整內容，符合 `pii` 清單時不會送出，也不會在訊息中列出符合的文字。`book.yaml` 的 `pii_exceptions` 只免除例外完整涵蓋的文字，比例外長的清單項目仍會攔截。`tome translate --dry-run` 使用相同的檢查。清單項目少於 3 個字元時，`tome doctor` 與 `tome estimate` 會警告。
- 對外請求一律經過單一模組，只能連往供應商設定檔的端點，並在 `book.db` 留下外送紀錄，內容僅有雜湊、供應商、模型、大小與時間。
- `tome preview`：在 `books/<名稱>/review/` 產生原文與譯文對照，每章一個檔案，只存放於本機。
- `tome status`：顯示翻譯單位的進度、已花費用與預算，以及送出後尚未收回的批次。只讀取本機資料，不連網，其他指令執行中也能使用。
- 批次翻譯的流程：相鄰章節合併成一批，每批送出前檢查預算與個資，送出前先記錄，中斷後再執行一次即可收回已送出的批次，不會重複付費。送出時供應商出錯或沒有回應，也是等下次執行時確認，不會原地重送。結果收回後刪除供應商端的資料。`tome batch status`、`collect`、`cancel` 用來查詢、收回與取消批次。
- `tome translate`：使用自己的 Anthropic API 金鑰翻譯，預設以批次送出，加上 `--realtime` 則逐一送出，`--retry-failed` 重試未通過驗證、遭拒答與被個資閘門擋下的單位。沒有設定金鑰時會先停止，不連網。批次模式已用實際的 API 翻譯過，即時模式尚未。
- `tome provider test`：確認金鑰可用，並以供應商回報的模型資料對照 TOME 的模型清單，不消耗 token。
- 連線供應商時，`ANTHROPIC_` 開頭的環境變數換不掉 TOME 使用的金鑰、端點與 API 版本，也無法開啟 TOME 沒有選用的 beta 功能。
- 刪除供應商端的批次資料時，供應商找不到該批次就視為已刪除，不再重試，並提醒換過金鑰時到原本的帳號確認。
- 跑得久的指令會顯示進度：`tome extract` 啟動解析引擎前先說明，引擎 30 秒沒有回應時說明仍在執行，組裝文件前也會提示；`tome add`、`tome probe` 開始探測時顯示頁數；`tome translate` 開始時顯示模式與請求數；連線供應商需要重試時，顯示幾秒後重試與第幾次。進度只輸出到 stderr，不影響 `--json`。
- `tome translate` 與 `tome batch collect` 完成時，提示以 `tome preview` 查看譯文。

### 變更

- 未指定 `--system` 的書籍一律使用內建規則包 `generic`。升級後，已解析的書籍在下次執行 `tome extract` 時會重新組裝一次 `document` 層，解析引擎不會重新執行。
- `tome probe` 的判斷規則有所更新，已探測的書籍下次會重新探測。
- 頁面解析失敗的訊息會顯示引擎的結束狀態，Windows 的原生崩潰同時列出十六進位代碼，方便判斷原因。引擎的錯誤輸出依然不保留。
- `zh-TW` 的風格指南不再提及神祇，代名詞一律依實體卡（記錄專有名詞譯名、性別與代名詞的資料）的設定。
- 使用者文件與 CLI 訊息改為正式的技術文件寫法，並新增簡體字與中國大陸用語檢查。
- `tome extract` 的頁數進度改為依時間顯示：第一頁、距離上一行滿 5 秒，以及最後一頁，不再固定每 10 頁。
- `zh-TW` 的長度下限從 0.3 放寬為 0.2。第一次實際翻譯時，自然的譯文有低於 0.3 而被重送的情形。這個值目前只有一本小說、一個模型的數據。
- 估價、試算、翻譯完成與 `tome status` 的單位數使用同一種說法，並列出不需翻譯、原樣保留的單位數，`--json` 也新增 `kept` 欄位。
- 每個請求最多 40 個翻譯單位，`max_tokens` 也為每個單位多留空間。規則書表格的短格子不會再讓回覆被截斷、整個請求重送。這兩個數字依第一次實際翻譯的紀錄提出，尚未再次驗證。
- `tome translate`、`tome batch collect` 完成時、翻譯中的進度與 `tome status` 的單位數，改為 `--chapters` 範圍內的數字，與估價一致；範圍外尚未完成的單位另列一行。`--json` 的 `total`、`kept`、`done` 等欄位也改為範圍內的數字，並新增 `outside`、`chapters`，`tome status` 另新增 `scope`。結束碼的意思也跟著改變：範圍外留下的未通過驗證、遭拒答或被個資閘門擋下的單位，不再使 `tome translate` 與 `tome batch collect` 回傳 1。
- `book.db` 的帳本記錄每個請求回覆的 `stop_reason` 與 `max_tokens`，用來區分回覆被截斷還是漏掉段落。既有的工作區開啟時會自動升級，舊紀錄的這兩欄是空值。

### 修正

- `tome add --as con` 這類 Windows 保留名稱現在會回報名稱不合法，不再造成內部錯誤。
- 損毀的書籍資料不再阻擋 `tome add`，改為列在執行結果中。
- 損毀的 `probe.json` 會回報為檔案損毀，不再要求使用者回報 TOME 的問題。
- 規則包正規表示式的時間限制改以 CPU 時間計算，機器忙碌時，不再把正常的表示式判定為逾時。
- Docling 環境的 `pillow`、`certifi`、`setuptools` 升級至已修正安全通報的版本。
- 解析失敗的頁次與 `glossary.yaml` 的筆數改為從 1 起算。規則包 ID 不合法與 YAML 語法錯誤有各自的訊息，缺少參數時的名稱與 `--help` 一致，訊息不再顯示內部代號。
- 路徑檢查處理環境變數中的長串反斜線時，耗時不再隨長度急遽增加。
- 位置參數過多時，訊息會說明收到幾個、指令只接受幾個，並提醒含有空格的路徑要加引號，例如沒加引號的 PDF 路徑。訊息不會顯示參數的內容。
