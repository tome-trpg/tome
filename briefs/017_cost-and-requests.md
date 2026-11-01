---
status: active
date: 2026-11-02
type: feature
wave: 16
affectedFiles:
  - CHANGELOG.md
  - README.en.md
  - README.md
  - briefs/**
  - docs/WHITEPAPER.md
  - docs/adr/**
  - languages/**
  - package.json
  - prompts/**
  - providers/**
  - schemas/**
  - src/**
  - systems/**
  - tests/**
protectedFiles:
  - .github/**
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CLAUDE.md
  - docs/research/**
  - engines/**
  - package-lock.json
---

# 017 — 成本與請求

## Intent

這個回合結束時，TOME 能在本機組出送給 Anthropic 的完整請求，不連網就算出花費的區間。模型資料放在 `providers/anthropic.yaml`，提示是維護者審過的文字，靜態前綴位元組一致。`tome estimate` 顯示估價、資料保留時間與預算，`--confirm` 記下確認，`--chapters` 限定範圍，`tome translate --dry-run` 組出所有請求但不送出。預算檢查與費用帳本就位。018 的即時模式與 019 的 Batch 都接在這些函式上，依據是 ADR-0035、ADR-0037、ADR-0040、ADR-0099 與 ADR-0103。

## Negative Scope

- 不連網，不打真的 API，不加 `@anthropic-ai/sdk`。這個回合沒有任何會送出書本文字的路徑。
- 不做個資閘門，018 才有。這個回合只在清單空的時候警告。
- 不開提示快取（ADR-0099 第 5 項）。靜態前綴維持位元組一致，由測試把關。
- 不做依角色覆寫模型，排到 M4（ADR-0103）。
- 不做 Batch 的分批，019 才有。
- 不改提示與風格指南的文字，維護者審過的就是定稿。

## Not Empowered

- ADR-0099、ADR-0103 沒寫到的選型、命名、範圍、政策不能自己定，要先問 Manager。放進 PR 說明不算問。
- 估價的數字都是提案，不能寫成已量測。
- 核心不放給人看的文字，提示放資料檔。
- 公開文件寫「維護者」，不寫人名。
- 檔案用 Write 與 Edit 改，不用 Bash 或腳本繞過寫入掛勾。
- 不合併，CI 全綠就回報 PR 連結與 attempt 1 的結果。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run licenses` 在本機都通過
- [x] 新的測試先在舊行為上失敗過
- [x] 改到 `src/core/extract.ts` 的提交，推送前清掉暫存工作區的書，在本機真的跑過 `tests/engine`
- [x] `specs`、`test`、`engine` 在 Windows 與 Ubuntu 的 CI 第一次跑就通過，沒有靠重跑
- [x] `CodeQL` 檢查的 conclusion 是 success，annotations 沒有新警示
- [x] 訊息與 `--json` 只有數字與模型 ID，不含書本文字
- [x] 這個回合沒有連網，有測試把關

## Acceptance Criteria

- [x] `providers/anthropic.yaml` 通過 `tome-provider/1`，價格是官方價目頁 2026-11-02 的數字
- [x] 不在表上的模型拒絕執行，查證滿 60 天時警告
- [x] 提示與風格指南跟維護者審過的文字一字不差
- [x] 靜態前綴在不同請求之間位元組一致，有測試
- [x] 請求不跨同組單位，上文不跨章，書本文字進提示前都跳脫
- [x] 思考參數依模型送對，`max_tokens` 算進思考
- [x] `tome estimate` 顯示區間、保留時間與預算，`--confirm` 的規則符合 ADR-0103
- [x] `--chapters` 依章節範圍限定單位，存進 `book.yaml`
- [x] `tome translate --dry-run` 組出請求不送出
- [x] `checkBudget` 與費用帳本有測試，花費依字元數分攤
- [x] `tome doctor` 與 `tome estimate` 在個資清單空的時候警告
- [x] 白皮書的成熟度標籤、附錄 B、CHANGELOG 更新，ADR-0099 的斷言補進「驗證」

## Measured

2026-11-02，Windows 參考機器。沒有連網，沒有用到金鑰。

- 價格讀官方價目頁，頁面沒有生效日與更新日期，所以 `effective` 填查證日。Sonnet 5.5 的快取讀取重查過是 $0.10，頁面註明是基礎價的 0.05 倍；$0.20 是 Opus 5.5 與 Sonnet 5 的數字。
- 016 留下的數字守恆代價已進提示：`1st` 譯成「第一」會判 `number_missing`，指令與風格指南都要求保留阿拉伯數字。
- `budget`、`estimate`、`ledger`、`provider` 的測試與程式同一批寫，沒有先失敗過，事後用改壞的版本確認過會失敗。其他模組的測試是先在模組不存在時失敗過。
- 自查時抓到三個會默默出錯的地方，都先寫了失敗的測試才修：估價把 `FAILED_QA` 這類等人處理的單位算進去；指紋只算還沒翻的單位，翻到一半就要重新確認；找不到供應商時訊息把錯的 ID 當成支援的清單。
