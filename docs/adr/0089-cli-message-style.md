---
id: ADR-0089
status: accepted
date: 2026-11-01
depends-on: [ADR-0027, ADR-0086]
amends: [ADR-0086]
---

# ADR-0089：CLI 訊息的文字規範

## 脈絡

ADR-0086 把 CLI 訊息要不要適用文字規範留成待決事項。訊息裡有「壞了」「到時再裝就好」「你自己下載」這類口語，也有「正則」這個中國大陸用語。維護者在 2026-11-01 選擇要改。

## 決定

1. ADR-0086 的第 2、3 項也適用 `src/cli/messages/zh-TW.json`，包含指令說明與工作區、規則包的範本。
2. 訊息不用「你」稱呼讀者。
3. 訊息檔也檢查常見的中國大陸用語。

## 驗證

<!-- @assert-count target="tests/tools/traditional-chinese.test.ts" symbol="src/cli/messages/zh-TW.json" expected="2" reason="第 2、3 項：訊息檔要檢查" -->

## 後果

驗訊息文字的測試要跟著改。訊息的代碼與佔位符不變，`--json` 的輸出不受影響。

## 替代方案

**維持原本的語氣**：跟使用者文件不一致，使用者最常讀到的反而是訊息；否決。
