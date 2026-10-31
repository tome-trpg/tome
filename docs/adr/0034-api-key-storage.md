---
id: ADR-0034
status: accepted
date: 2026-11-01
---

# ADR-0034：API 金鑰存放

## 脈絡

金鑰常駐環境變數或放明文檔都容易外流，舊專案就是常駐環境變數。Node 沒有內建憑證庫，`@napi-rs/keyring` 的文件也沒提 Windows（H-14）。

## 決定

1. `tome auth set` 把金鑰存進作業系統憑證庫。
2. 環境變數可以覆蓋，給 CI 使用。
3. Windows 支援實測不可行時，退回環境變數。
4. 引擎子行程 MUST NOT 繼承金鑰，金鑰 MUST NOT 出現在紀錄與報告裡。

## 後果

多一個原生相依。

## 替代方案

**只用環境變數**：金鑰常駐環境；**工作區的 `.env`**：明文檔，工作區一備份就跟著外流；都否決。

## Open Questions

- [ ] 實測 `@napi-rs/keyring` 在 Windows 憑證管理員的行為。
