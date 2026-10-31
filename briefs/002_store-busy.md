---
status: active
date: 2026-11-01
type: defect
wave: 1
affectedFiles:
  - briefs/**
  - docs/research/2026-10-31-landscape.md
  - src/cli/messages/zh-TW.json
  - src/core/errors.ts
  - src/core/store.ts
  - tests/core/store.test.ts
protectedFiles:
  - .github/**
  - .spec-brief.json
  - .spec-graph.json
  - .spec-guard.json
  - .spec-harness.json
  - CLAUDE.md
  - docs/WHITEPAPER.md
  - docs/adr/**
  - package-lock.json
  - package.json
---

# 002 — 鎖等滿之後回報 store.busy

## Intent

這個回合結束時，資料庫的鎖等滿 `busy_timeout` 還拿不到，回的是新的 `store.busy`，使用者知道是別的行程占著，不會以為檔案壞了去刪它。開檔、遷移與開檔之後的讀寫都一樣。順便拿掉 `docs/research/2026-10-31-landscape.md` 裡的本機路徑，公開 repo 不放本機路徑。

## Negative Scope

- 不改等待時間，還是 5 秒。
- 不動其他錯誤的分類，檔案真的壞掉仍是 `store.corrupt`。
- 不新增指令，不動 CLI 的路由。
- 研究文件只拿掉本機路徑。`seekers-journal` 這個名稱留著，ADR 不改寫歷史。
- 不改其他 repo。

## Not Empowered

- ADR 的決定不能改。`store.busy` 跟其他資料庫錯誤一樣回結束碼 2，由 ADR-0059 涵蓋，不用新 ADR。
- 不加相依。

## Invariants

- [x] `npm run spec`、`npm run typecheck`、`npm test`、`npm run build`、`npm run licenses` 在本機都通過
- [x] 新的測試在舊程式上會失敗
- [x] `store.busy` 有訊息，訊息帶路徑

<!-- @assert-count target="src/cli/messages/zh-TW.json" symbol="store.busy" expected="1" comments="include" reason="每個錯誤代碼都有訊息" -->

- [x] 研究文件沒有本機路徑

<!-- @assert-absence target="docs/research" symbol="C:\Repos" comments="include" reason="公開 repo 不放本機路徑" -->

## The Defect, Measured

2026-11-01，Node 24.22.1。讓另一條連線持有 `BEGIN EXCLUSIVE`，把 `busy_timeout` 設成 50 毫秒，`PRAGMA journal_mode = WAL` 與 `BEGIN IMMEDIATE` 都丟出 `errcode: 5`、`errstr: 'database is locked'`。

`connect` 與 `openStore` 把所有不是 `TomeError` 的錯誤都轉成 `store.corrupt`，所以等滿之後回報的是檔案壞了。開檔之後的 `run`、`get`、`all`、`transaction` 不轉換，原始錯誤一路傳到 CLI，變成 `cli.internal`。

新的測試在舊程式上都失敗：開檔與遷移回 `store.corrupt`，開檔之後的寫入是原始的 `database is locked`。
