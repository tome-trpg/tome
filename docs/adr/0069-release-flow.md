---
id: ADR-0069
status: accepted
date: 2026-11-01
---

# ADR-0069：發佈流程：標籤、暫存、2FA 核准

## 脈絡

npm 的 Trusted Publishing 不需要長期 token，`npm stage publish` 把版本放進暫存區，要人用 2FA 核准才發佈。spec 工具已經這樣做，比 GitHub Environment 的審核多一道 2FA（[佐證 §3.10](../research/2026-10-31-landscape.md#310-組織與發佈)）。

## 決定

1. 發佈由 `v*` 標籤觸發，只有維護者能推標籤。
2. 標籤指的 commit MUST 在 `main` 上，標籤、`package.json`、`CHANGELOG.md` 三者一致。
3. 打包後列出內容並檢查大小，拒絕 PDF、資料庫與測試資料進入 npm 包。
4. 用 `npm stage publish` 暫存，維護者用 2FA 執行 `npm stage approve` 才發佈。
5. repo 與 secrets 都沒有 npm token。
6. 手動觸發的演練不花版本號。

## 後果

每次發佈要維護者動手。第一個真實標籤才驗證得到簽章與上傳。

## 替代方案

**GitHub Environment 核准後直接發佈**：沒有 2FA 那一道；**從電腦手動發佈**：沒有 provenance；都否決。
