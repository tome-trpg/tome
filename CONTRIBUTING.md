# 參與 TOME

設計與理由在[白皮書](docs/WHITEPAPER.md)，每個決策在 [docs/adr](docs/adr)。

## 最重要的一條

**不要在 Issue、PR、測試或規則包裡放任何商業書籍的文字或譯文。** 這包含截圖與「只是一小段」的引用。

回報解析或翻譯問題時，請用自己寫的合成範例重現。公開 repo 也 MUST NOT 有任何 PDF。

## 環境

Node 24 以上。

```bash
npm ci --ignore-scripts
npm run spec
```

`npm run spec` 檢查文件與 ADR。用 `npx` 時一律寫完整套件名，例如 `npx --no-install @spec-family/spec-guard`，不要只寫指令名。

## 改文件

決策寫成 ADR，放在 `docs/adr/`，格式見 [ADR-0021](docs/adr/0021-document-conventions.md)。決策改變時新增一份 ADR，不改寫歷史。

## 規則包

規則包只能是資料，不能含程式，格式見[白皮書 §5.8](docs/WHITEPAPER.md#58-system-pack-規格)。公開的規則包只收開放內容與合成文字，譯名不得抄自任何官方中文版，也 MUST NOT 暗示官方背書。

## 授權

你的貢獻依 Apache-2.0 授權，不需要另外簽 CLA。規則包目錄依各自的授權。
