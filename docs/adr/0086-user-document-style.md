---
id: ADR-0086
status: accepted
date: 2026-11-01
depends-on: [ADR-0003, ADR-0021, ADR-0074]
---

# ADR-0086：使用者文件的文字規範

## 脈絡

維護者審視 README 後認為使用者文件太口語，要求改成專業、文件化，同時淺顯易懂的寫法；繁體中文要通順流暢，而且不該出現簡體中文的地方絕對不能出現。

人工校對擋不住之後的修改，所以簡體字要有自動檢查。

## 決定

1. 使用者文件是 `README.md`、`README.en.md`、`CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`，以及 Issue 與 PR 範本。白皮書與 ADR 是設計紀錄，不適用第 2、3 項。
2. 使用者文件語氣專業、內容明確，初次接觸的讀者也要看得懂。不用口語與俚語，稱呼讀者用「使用者」，不用「你」。
3. 使用者文件用台灣慣用的繁體中文與技術用語，不用中國大陸用語。
4. 尚未實作的功能要標明是設計目標或規劃項目。
5. 全部受版控的文字檔不得有簡體字。漢字要在標準 Big5 之內，Big5 也收錄的簡體字形另外列表，都由測試檢查。需要刻意收錄簡體字的檔案，要在測試的例外清單裡列出路徑與理由。使用者文件另外檢查常見的中國大陸用語。

## 驗證

<!-- @assert-present file="tests/tools/traditional-chinese.test.ts" -->
<!-- @assert-count target="README.md" symbol="零遙測" expected="1" reason="ADR-0074：零遙測的承諾寫進 README" -->
<!-- @assert-count target="README.en.md" symbol="No telemetry" expected="1" reason="ADR-0074：英文版也要有" -->

## 後果

新增的文字裡如果有 Big5 以外的漢字，測試會失敗，要在例外清單裡說明理由。中國大陸用語的字表只擋得到表上的詞，文句是否通順也檢查不出來，這些仍靠校對。第 5 項用的是 Node 內建的 `TextDecoder`，不多一個相依。

## 替代方案

**用 OpenCC 檢查**：多一個相依，而且繁簡同形的字一樣要另外判斷；**只靠人工校對**：之後的修改擋不住；都否決。

## Open Questions

* CLI 訊息 `src/cli/messages/zh-TW.json` 要不要也適用第 2、3 項。
