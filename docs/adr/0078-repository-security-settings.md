---
id: ADR-0078
status: accepted
date: 2026-11-01
---

# ADR-0078：repo 的安全設定與文件

## 脈絡

token 沒有 Administration 權限，這些設定要維護者在網頁上開。公開 repo 也要有授權與安全政策文件。

## 決定

1. repo 根目錄有 `LICENSE`、`NOTICE`、`README.md`、`README.en.md`、`SECURITY.md`、`CONTRIBUTING.md`、`CHANGELOG.md`。
2. 開啟機密掃描與 push protection、私下回報漏洞、`v*` 標籤的 ruleset。
3. 有程式碼後開 CodeQL，第一版之前開 immutable releases。
4. npm Trusted Publishing 驗證可用後，發佈權限改成要求 2FA 並禁用 token。

## 驗證

<!-- @assert-present file="LICENSE,NOTICE,README.md,README.en.md,SECURITY.md,CONTRIBUTING.md,CHANGELOG.md,.github/dependabot.yml" -->

## 後果

push protection 與 immutable releases 是否免費，文件沒明寫，要看設定頁。

## 替代方案

**只靠紀律**：金鑰與版本被竄改的代價太高；否決。

## Open Questions

- [x] 維護者在網頁上開好機密掃描、push protection、私下回報漏洞與 `v*` 標籤的 ruleset（2026-11-01）。
- [ ] 有程式碼後開 CodeQL，第一版之前開 immutable releases。
