---
id: ADR-0039
status: accepted
date: 2026-11-01
depends-on: [ADR-0019]
---

# ADR-0039：對外請求走單一模組

## 脈絡

G-5 要求合規是結構，不是紀律。個資閘門與端點白名單只要漏一個呼叫點，就是外流。

## 決定

1. 所有對外網路請求 MUST 走單一模組，其他程式不得自己連網。
   2026-11-14 由 ADR-0138 第 2、3 項修改：審定網頁的本機伺服器 `src/cli/review/server.ts` 可以 import `node:http`，只拿 `createServer`、只聽 `127.0.0.1`，不呼叫 `http.request`、`http.get`；其他模組照舊。import 的斷言移到 ADR-0138。
2. 個資閘門與端點白名單都在這裡。
3. 本機留外送紀錄，只記內容雜湊、供應商、模型、大小與時間。
4. OpenRouter 一律送 `data_collection: deny`。

## 驗證

<!-- @assert-absence target="src" exclude="src/core/egress/**" regex="true" symbol="\b(fetch|WebSocket|EventSource|XMLHttpRequest)\s*\(" reason="全域的連網 API 也一樣" -->

## 後果

多一層，但斷言可以把關。

## 替代方案

**閘門照做，不限制模組**：要靠紀律，漏一個就是外流；否決。

## Open Questions

- [x] `src/` 建立時加上 spec-guard 斷言，擋下對外模組以外的連網呼叫。2026-11-01 完成。M0 完全不連網，`src/core/egress/` 要到 M2 才建立（ADR-0082）。
