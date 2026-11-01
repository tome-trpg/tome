---
status: active
date: 2026-11-01
type: defect
wave: 4
affectedFiles:
  - CHANGELOG.md
  - briefs/**
  - docs/WHITEPAPER.md
  - src/core/pack-lint.ts
  - src/core/patterns.ts
  - tests/core/patterns-timer.test.ts
  - vitest.config.ts
protectedFiles:
  - .github/**
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CLAUDE.md
  - docs/adr/**
  - docs/research/**
  - languages/**
  - package-lock.json
  - package.json
  - schemas/**
---

# 007 — 規則包正則的限時不被機器負載影響

## Intent

這個回合結束時，機器再忙，正常的規則包模式也不會被 `runPatterns` 判成超時，失控的模式仍然會被終止並回報是哪個模式。限時改成算 worker 用掉的 CPU 時間，從 worker 開始跑正則才起算，機器忙碌時等 CPU 的時間與模組載入的時間都不算。`main` 的 Windows 測試因此不再隨機失敗。使用者機器忙時 `tome system lint` 不會誤判，M2 的遮蔽走同一個 `runPatterns`，也不會把正常的段落當成失控。這是 brief 004 留下的缺陷，不是新決定。

## Negative Scope

- 不開始 brief 005 與 006 的工作。
- 不動 `zh-TW.yaml`、`TARGET_LANGUAGE`，那兩件留在 brief 005 與 M2。
- 不改 worker 的協定與 `pattern-worker.ts`，不加相依，不改 CI。
- 不用放寬數字解決：把 500 毫秒改大只是讓機率變小。
- 不改最低 Node 版本。`worker.cpuUsage()` 要 Node 24.6，更舊的 24.x 退回牆鐘。

## Not Empowered

- ADR 的決定不能改。ADR-0049 寫的是限時，這裡改的是怎麼量，不是要不要限時。
- 公開 repo 的文件寫「維護者」，不寫人名。
- 檔案用一般的寫入工具改，不用 Bash 或腳本繞過寫入掛勾。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run build`、`npm run licenses` 在本機都通過
- [ ] `specs` 與 `test` 兩條工作流程在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [x] 新的測試在舊程式上會失敗：慢啟動、等不到 CPU 的情況都能重現
- [x] 失控的模式仍然被終止，回報是哪個模式，正常的模式不因機器忙而失敗，`lint` 與 `test` 兩條路徑都涵蓋
- [x] 在壓力下重新量過，H-16 的敘述照實更新

## The Defect, Measured

2026-11-01，參考機器，Node 24.22.1。`main` 的 run 41244371336 與 PR #8 的 run 41244432083 第一次都在 `test (windows-2025)` 失敗，`tests/core/pack.test.ts` 把正常的模式報成 `pack.slow_regex`。

本機要把負載壓到比 CI 重才穩定重現：`node` 綁在一個邏輯處理器上，旁邊 12 個空迴圈的行程綁在同一個處理器。這時舊程式的 `tests/core/pack.test.ts` 有 7 個測試失敗（把測試逾時放寬到 120 秒，排除逾時的影響），其中 `testPack` 走的是 1 秒的預設限時，所以不只 `lint` 的 500 毫秒受影響。

一個正常的模式跑完它的對抗輸入，各階段的時間：

| 階段 | 閒置 | 壓力，原始碼（`.ts`） | 壓力，建置結果（`.js`） |
| :--- | ---: | ---: | ---: |
| `new Worker` 到 `online` | 約 24 毫秒 | 900 到 1,200 毫秒 | 930 到 1,120 毫秒 |
| `online` 到第一個訊息 | 5 到 33 毫秒 | 1,280 到 1,770 毫秒 | 250 到 280 毫秒 |
| 第一個訊息到完成 | 0 到 2 毫秒 | 0 到 31 毫秒 | 0 到 30 毫秒 |

原因有兩層：

1. `worker.once('online', arm)` 太早開始計時，`online` 之後腳本還沒載入。原始碼路徑的 Node 要先剝除 TypeScript 型別，這段就超過 500 毫秒，測試正好走這條路。
2. 限時量的是牆鐘。移開起算點只解決第一層：機器忙時，執行緒排不到 CPU 的時間也算進去，正常模式還是可能超時。

`worker.cpuUsage()` 在 worker 卡在正則裡時照樣立刻回答，實測 CPU 時間隨牆鐘成長，所以可以從主執行緒量。

修正之後，同樣的壓力下連跑三次 `tests/core/pack.test.ts` 與 `tests/core/patterns.test.ts`，48 個測試全過，舊程式是 7 個失敗。`tests/core/patterns-timer.test.ts` 用假的 worker 重現慢啟動與等不到 CPU，寫好時先在舊程式上跑過，11 個裡 7 個失敗，失控的那 4 個兩邊都通過。

代價：失控模式被終止的牆鐘時間會隨負載拉長。閒置時約 1.06 到 1.12 秒，上面的壓力下要 15 到 18 秒，用掉的 CPU 仍是 1 秒。

`lint` 的 500 毫秒不動，現在也算 CPU 時間。修正不需要放寬它：上面的壓力下，正常模式從第一個訊息到完成也只要 0 到 31 毫秒。比實際執行嚴一倍是有用的餘裕，規則包作者的機器可能比使用者快，同一個限時的話，剛好過關的模式到了較慢的機器就會被終止。`tests/core/patterns-timer.test.ts` 釘住這個差距：用掉 800 毫秒 CPU 的模式，`lint` 判失敗，實際執行照常跑完。

測試框架預設每個測試 5 秒的逾時也是牆鐘，用真 worker 的測試在忙碌的 CI 上會撞到，所以 `vitest.config.ts` 放寬成 30 秒。這是測試的設定，主程式的限時沒有放寬。
