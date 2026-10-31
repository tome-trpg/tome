---
id: ADR-0061
status: accepted
date: 2026-11-01
depends-on: [ADR-0001]
---

# ADR-0061：測試語料與合成 PDF 鍛造

## 脈絡

PC-1 不准商業書進 repo，日文直書也沒有公開評測。`pdfkit` 能排版，`pdf-lib` 補底層物件，後者讀不出頁面文字，不能當驗證基準（[佐證 §3.9](../research/2026-10-31-landscape.md#39-測試工具與語料)）。

## 決定

1. repo MUST NOT 有任何 PDF，合成檔在測試時產生。
2. 公開素材下載後驗證雜湊，不進 repo。
3. 本機商業書只在本機測試，結果不公開。
4. 每個素材 MUST 在來源清單登記授權與雜湊值，未登記的讓 CI 失敗。
5. 用 `pdfkit` 與 `pdf-lib` 鍛造，驗證基準用生成時的標準答案。

## 後果

頁碼標籤與壞 ToUnicode 能否做出來，文件沒提，要實作時驗證。

## 替代方案

**把公開 PDF 放進 repo**：repo 變大，也模糊了「repo 沒有 PDF」這條簡單的規則；否決。
