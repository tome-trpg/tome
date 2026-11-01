# Changelog

## Unreleased

還沒有發佈任何版本。

### 新增

- `tome init`、`tome doctor`、`tome provider auth set`，訊息是繁中，支援 `--json` 與結束碼 0、1、2。
- `tome-ir/1`、`tome-pack/1` 的 JSON Schema 與驗證。
- 狀態庫：`book.db`、`series.db` 的資料存取層與單向遷移。
- 金鑰存進作業系統憑證庫，`TOME_ANTHROPIC_API_KEY` 可以覆蓋。
- 測試工作流程、相依授權檢查、`npm audit`，以及擋下違規相依與連網呼叫的斷言。
- `tome add` 登記一本書並探測，加密的 PDF 一律拒絕；`tome probe` 回報文件結構、頁面類型與 GPU。
- 測試用的合成 PDF 鍛造器，repo 不放 PDF。
- 語言設定檔 `languages/source/en.yaml`、`languages/target/zh-TW.yaml`，格式是 `tome-lang/1`。
- `tome system new`、`list`、`lint`、`test`，規則包的正則在 worker thread 裡限時執行。
- `tome probe` 用來源語言的字母分布抓出字元合法但對應錯的文字層。
- 解析引擎協定 `tome-engine/1`，以及 `tome engine add`、`list`、`remove`。`tome engine add docling` 用 uv 建環境，預設 CPU 版，加 `--gpu` 裝 CUDA 版，裝完會提示 CUDA 元件是 NVIDIA 專有授權，TOME 不隨附。環境裡其他的專有元件由引擎在 `engine.yaml` 的 `license.proprietary` 宣告，裝完一樣提示，Docling 宣告 Intel oneMKL。
- `tome extract` 把原生文字頁交給引擎，存成 `source` 層，中斷後從沒做完的頁接著做。組裝與字元守恆還沒做。
- `tome probe` 記下每頁要交給哪個引擎，`tome doctor` 檢查引擎啟動得了。

### 變更

- `zh-TW` 的風格指南不再提神祇，代名詞只依實體卡。

### 修正

- `tome add --as con` 這類 Windows 保留名稱現在回報名稱不合法，不再變成內部錯誤。
- 一本壞掉的書不再擋住 `tome add`，改成回報發現。
- 壞掉的 `probe.json` 回報成檔案損壞，不再要使用者回報 TOME 的問題。
- 規則包正則的限時改算 CPU 時間，機器忙時正常的模式不再被判成超時。
