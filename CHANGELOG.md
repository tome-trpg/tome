# Changelog

## Unreleased

還沒有發佈任何版本。

### 新增

- `tome init`、`tome doctor`、`tome provider auth set`，訊息是繁中，支援 `--json` 與結束碼 0、1、2。
- `tome-ir/1`、`tome-pack/1` 的 JSON Schema 與驗證。
- 狀態庫：`book.db`、`series.db` 的資料存取層與單向遷移。
- 金鑰存進作業系統憑證庫，`TOME_ANTHROPIC_API_KEY` 可以覆蓋。
- 測試工作流程、相依授權檢查、`npm audit`，以及擋下違規相依與連網呼叫的斷言。
