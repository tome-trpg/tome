---
status: archived
date: 2026-11-01
type: feature
wave: 3
affectedFiles:
  - .github/workflows/test.yml
  - CHANGELOG.md
  - README.en.md
  - README.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/0084-*.md
  - languages/**
  - package.json
  - schemas/**
  - src/**
  - tests/**
protectedFiles:
  - .github/dependabot.yml
  - LICENSE
  - NOTICE
  - SECURITY.md
  - docs/research/**
  - package-lock.json
  - tools/**
integrity: sha256-0c64a3b4340853b55bc0f80c1f5db254cec324ecf4c29d09b28389bcb86af7d1
---

<!-- spec-brief:banner -->
> **Archived 2026-11-01.**
> 路線圖 M1 的第二個回合：語言設定檔 tome-lang/1、tome probe 的語言訊號、tome system new、list、lint、test，規則包的正則在 worker thread 裡限時執行。另外修了 brief 003 審查找到的問題。
> Merged in pull request [#7](https://github.com/tome-trpg/tome/pull/7).
> Recorded at commit `e7ec9b9`: 49 files changed, +2405 −56.
> Relative links were rewritten to resolve from `briefs/archive/` (3); no other word changed.
> The body below describes the tree before execution and is not maintained.
<!-- /spec-brief:banner -->

# 004 — 語言設定檔與規則包工具

## Intent

這個回合結束時，來源與目標語言都是資料檔：`languages/source/en.yaml`、`languages/target/zh-TW.yaml`，格式是 `tome-lang/1`（[ADR-0084](../../docs/adr/0084-m1-parsing-decisions.md)），引擎核心不依語言代碼分支（[ADR-0009](../../docs/adr/0009-target-language-data.md)）。`tome probe` 用來源語言的資料判斷「字元合法但對應錯」的文字層，把 H-10 剩下的部分驗完。規則包工具到位：`tome system new`、`list`、`lint`、`test`，規則包的正則都在 worker thread 裡限時執行（[ADR-0049](../../docs/adr/0049-pack-regex-safety.md)、H-16）。內建規則包要到 M2 才有，所以這一輪用測試專用的合成規則包驗證，CI 也跑它。

順便修 brief 003 審查找到的問題：README 的現況、白皮書第 36 行的實測說明、`tome add --as con` 在 Windows 變成內部錯誤、一本壞掉的書擋住所有 `tome add`、壞掉的 `probe.json` 被當成 TOME 的錯誤。這些都不是新決定。

這一輪沒有新相依。

## Negative Scope

- 不跑解析引擎，沒有 document 層。正規化、斷字還原與接段的資料這一輪只進設定檔並過 schema，用它們的程式在 brief 006。
- 規則包角色判定只做判定函式與 `tome system test`，接進組裝步驟在 brief 006。
- 不寫內建規則包：`generic` 在 M2，`d100-orc` 在 M4。
- 不做 `tome system init`（0.1.0 之後），不做 `tome glossary why`（M3）。
- `tome probe` 不建議規則包（M2），不做 `tome status`（M2）。
- 目標語言設定檔只有資料，用語檢查表留空，OpenCC 的部分在 M2。
- 沒有翻譯，不連網，不放任何商業書籍內容、PDF 或金鑰，不改其他 repo。

## Not Empowered

- 既有 ADR 的決定不能改寫。ADR-0084 只回填 `## 驗證`。
- 不加相依，不放寬任何授權白名單。
- 主程式不依語言代碼分支，語言的知識都在 `languages/`。
- 引擎核心不含遊戲知識：必要聲明的清單是授權知識，測試用的數值塊只在 `tests/`。
- 公開 repo 的文件寫「維護者」，不寫人名。
- 選型、命名、範圍、政策不能自己決定，做到一半發現的當下問。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run build`、`npm run licenses` 在本機都通過
- [x] `specs` 與 `test` 兩條工作流程在 Windows 與 Ubuntu 的 CI 都通過
- [x] 建置後的 `dist` 也跑得起 worker：CI 用建置出來的程式跑 `tome system lint` 與 `test`
- [x] 規則包的文字與語言資料不進訊息：發現只帶檔名、ID 與數字
- [x] 金鑰、本機路徑與商業內容都沒有進 repo，推送前掃描過
- [x] H-10、H-16 有實測結果，寫回白皮書，沒測到的不標成已驗證

## Acceptance Criteria

- [x] `tome-lang/1` 有 schema，`en` 與 `zh-TW` 都過驗證，語言代碼找不到時回報，不靜默退回
- [x] 字元合法但對應錯的 ToUnicode 判得出 `broken_text`，正常的英文與短頁面不會被誤判
- [x] `tome add --source-lang`、`--system` 指到不存在的語言或規則包時回報
- [x] `tome system new` 的骨架過得了 `lint` 與 `test`
- [x] `tome system list` 列出內建與工作區的規則包，同 ID 時本機優先
- [x] `tome system lint` 查 schema、繼承、參照、危險正則與非資料檔；`--public` 另查 `LICENSE`、`NOTICE`、必要聲明與測試
- [x] 災難性的正則被 worker 限時擋下，回報是哪個模式，主程式沒有卡住
- [x] `tome system test` 驗證模式抓得到的字串與判定出的角色，不花 token
- [x] `README.md`、`README.en.md` 寫出現有的指令
- [x] 白皮書的實測說明符合現況，Q-9 仍是目標
- [x] `tome add --as con` 回 `store.bad_id`，保留名稱的檢查在 `assertSafeId`
- [x] 一本壞掉的 `book.yaml` 或多餘的資料夾不擋住 `tome add`，回報成發現
- [x] 壞掉的 `probe.json` 回報成檔案損壞，不是內部錯誤
