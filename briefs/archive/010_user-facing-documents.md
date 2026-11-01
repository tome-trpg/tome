---
status: archived
date: 2026-11-01
type: feature
wave: 8
affectedFiles:
  - .github/ISSUE_TEMPLATE/**
  - .github/pull_request_template.md
  - CHANGELOG.md
  - CONTRIBUTING.md
  - README.en.md
  - README.md
  - SECURITY.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - tests/tools/**
protectedFiles:
  - .github/workflows/**
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CLAUDE.md
  - docs/research/**
  - engines/**
  - languages/**
  - package-lock.json
  - package.json
  - schemas/**
  - src/**
integrity: sha256-0789ee4e288b899e27257371bc503198d0d264eca09a3b351839d2c0368c1f6d
---

<!-- spec-brief:banner -->
> **Archived 2026-11-01.**
> Merged in pull request [#19](https://github.com/tome-trpg/tome/pull/19).
> Recorded at commit `ade8eae`: 11 files changed, +444 −121.
> The body below describes the tree before execution and is not maintained.
<!-- /spec-brief:banner -->

# 010 — 使用者文件的文字規範

## Intent

這個回合結束時，使用者會讀到的文件都是專業、文件化且淺顯易懂的寫法：`README.md`、`README.en.md`、`CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`，以及 Issue 與 PR 範本。繁體中文通順流暢，用語是台灣慣用的技術用語。受版控的文字檔不再可能悄悄混進簡體字，因為測試會擋下。維護者認為現有文件太口語，而且明確要求不該出現簡體中文的地方絕對不能出現，所以這個回合把要求寫成 ADR-0086，並用測試守住。

## Negative Scope

- 不改 `src/`，CLI 訊息 `src/cli/messages/zh-TW.json` 的語氣不在這個回合。
- 不改白皮書與既有 ADR 的內文，白皮書只加 ADR 索引的列：ADR-0086，以及同時合併的 ADR-0087、0088。
- 不新增功能宣稱：README 只寫 `main` 上真的有的狀態，設計目標要標明是目標。
- 不加相依。檢查用 Node 內建的 `TextDecoder`，不加 OpenCC。

## Not Empowered

- 不移除 ADR-0074 要求寫進 README 的零遙測承諾，也不移除 ADR-0003 要求的英文版 README。
- 公開文件寫「維護者」，不寫人名。
- 檔案用一般的寫入工具改，不用 Bash 或腳本繞過寫入掛勾。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] `specs` 與 `test` 兩條工作流程在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑

**Accepted debt**：`4d75912` 的 `test` 在 attempt 1 失敗過一次，檢查抓到 brief 自己引用的簡體字。沒有重跑，改掉後 `c7e3781` 的 attempt 1 全綠，rebase 到最新的 `main` 後的 head 也以 attempt 1 為準。
- [x] 檢查先在壞樣本上失敗過：放進簡體字與繁簡同形的誤用字，測試真的會擋

## Acceptance Criteria

- [x] README 的中文與英文版結構相同，功能表標明是設計目標，進度表與 `main` 的指令一致
- [x] 全部受版控的文字檔沒有簡體字
- [x] 使用者文件沒有常見的中國大陸用語，`repo` 這類口語改成正式用詞
- [x] 文字由沒看過改寫過程的人校對過
- [x] `CONTRIBUTING.md` 寫清楚文字規範，ADR-0086 記下決定

## Measured

- 第一版檢查只看 Big5，樣本測試當場抓到漏洞：「體」的簡體字形也在 Big5 裡。補上 Big5 也收錄的簡體字形之後，全 repo 仍是零筆。
- CI 第一次在 `test` 失敗，抓到的正是這個 brief：上面這句原本直接寫出那個字。本機沒抓到，因為檢查看的是受版控的檔案，當時 brief 還沒 commit。檢查因此要在 `git add` 之後跑。
- 字表取自 Windows 的繁簡對照，77 個字裡 台、准、划 這類繁體也常用的字不列，所以不是完整清單。
- CLI 訊息 `src/cli/messages/zh-TW.json` 不在這個回合，訊息裡仍有 `正則` 這類用語。
